#!/usr/bin/env node
import type { Element, ElementContent, Root, RootContent } from 'hast'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { CookieJar } from 'tough-cookie'
import { HttpsProxyAgent } from 'hpagent'
import { execFile } from 'node:child_process'
import { fromHtml } from 'hast-util-from-html'
import { gfmStrikethroughToMarkdown } from 'mdast-util-gfm-strikethrough'
import { gfmTableToMarkdown } from 'mdast-util-gfm-table'
import got from 'got'
import { lint } from 'markdownlint/promise'
import path from 'node:path'
import { promisify } from 'node:util'
import { toMarkdown } from 'mdast-util-to-markdown'
import { toMdast } from 'hast-util-to-mdast'

const SITE = 'https://tts.determinismsucks.net'
const API_URL = `${SITE}/w/api.php`
const OUTPUT_DIR = 'original/wiki'
/** 首页落成 readme.md，作为目录入口（与 original/readme.md 同一约定，站点侧即 /original/wiki/） */
const README_TITLE = 'Main Page'

// --from-html <dir>：跳过网络抓取，直接转换本地缓存的页面 HTML（离线回归入口，配 --html-cache 使用）
const fromHtmlDir = process.argv[2] === '--from-html' ? process.argv[3] : undefined
// --html-cache <dir>：把抓到的页面 HTML 与页面清单缓存到 <dir>，已缓存的页面直接复用（代理链路不稳时断点续跑）
const htmlCacheDir = process.argv[2] === '--html-cache' ? process.argv[3] : undefined

const execFileAsync = promisify(execFile)

// got 不读代理环境变量，这里手动接入；NO_PROXY 命中时保持直连（站点国内直连不通，本地跑真实抓取需带 HTTPS_PROXY）
const proxyUrl = process.env.HTTPS_PROXY ?? process.env.https_proxy ?? process.env.HTTP_PROXY ?? process.env.http_proxy
const noProxyList = (process.env.NO_PROXY ?? process.env.no_proxy ?? '').toLowerCase()
const targetHost = new URL(SITE).hostname
const noProxyHit = noProxyList.split(',').some((it) => {
  const pattern = it.trim()
  return (
    pattern === '*' || targetHost === pattern || targetHost.endsWith(pattern.startsWith('.') ? pattern : `.${pattern}`)
  )
})
const activeProxy = proxyUrl && !noProxyHit ? proxyUrl : undefined

const http = got.extend({
  cookieJar: new CookieJar(),
  // hpagent 的 CONNECT 隧道按 HTTP/1.1 转发，h2 协商留给直连场景
  http2: !activeProxy,
  retry: {
    limit: 5,
    // 站点侧抖动（502/504）与代理链路偶发 TLS/连接重置（ECANCELED/EPROTO，curl 报 35）
    statusCodes: [408, 429, 500, 502, 503, 504],
    errorCodes: ['ECANCELED', 'EPROTO', 'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ENETUNREACH'],
    backoffLimit: 15_000,
  },
  timeout: { request: 120_000 },
  // MediaWiki 对匿名 API 调用有速率礼仪要求：脚本按顺序串行请求，并带上可识别的 UA
  headers: { 'user-agent': 'to-the-stars-wiki-archive/1.0 (+https://github.com/liuli-moe/to-the-stars)' },
  ...(activeProxy && { agent: { https: new HttpsProxyAgent({ proxy: activeProxy }) } }),
})
if (activeProxy) {
  console.log('Proxy enabled:', activeProxy)
}

interface ApiResponse {
  error?: { code: string; info: string }
  query?: { allpages?: { title: string }[]; recentchanges?: { timestamp: string }[] }
  continue?: { apcontinue?: string }
  parse?: { text: string }
}

/** 主命名空间全部非重定向页面标题。重定向页没有正文，正文里的链接保留指向 wiki 的绝对地址 */
async function listPageTitles(): Promise<string[]> {
  const titles: string[] = []
  let apcontinue: string | undefined = undefined
  do {
    const searchParams: Record<string, string> = {
      action: 'query',
      list: 'allpages',
      apfilterredir: 'nonredirects',
      aplimit: 'max',
      format: 'json',
      formatversion: '2',
    }
    if (apcontinue) {
      searchParams.apcontinue = apcontinue
    }
    const res = await http.get(API_URL, { searchParams }).json<ApiResponse>()
    titles.push(...(res.query?.allpages ?? []).map((it) => it.title))
    apcontinue = res.continue?.apcontinue
  } while (apcontinue)
  return titles
}

/** 页面渲染 HTML（.mw-parser-output 内容主体：不含站点导航、侧栏与分类栏） */
async function fetchPageHtml(title: string): Promise<string> {
  const res = await http
    .get(API_URL, {
      searchParams: { action: 'parse', page: title, prop: 'text', format: 'json', formatversion: '2' },
    })
    .json<ApiResponse>()
  if (res.error) {
    throw new Error(`获取页面失败 ${title}: ${res.error.code} ${res.error.info}`)
  }
  if (!res.parse?.text) {
    throw new Error(`页面无渲染内容: ${title}`)
  }
  return res.parse.text
}

/** 是否有晚于本地存档的远端改动（只关心主命名空间的编辑/新建/移动删除），用于 CI 里跳过无谓的全量抓取 */
async function latestChangeSince(since: Date): Promise<Date | undefined> {
  const res = await http
    .get(API_URL, {
      searchParams: {
        action: 'query',
        list: 'recentchanges',
        rcstart: since.toISOString(),
        rcnamespace: '0',
        rctype: 'edit|new|log',
        rcprop: 'timestamp',
        rclimit: '1',
        format: 'json',
        formatversion: '2',
      },
    })
    .json<ApiResponse>()
  const change = res.query?.recentchanges?.[0]
  return change ? new Date(change.timestamp) : undefined
}

// MediaWiki 渲染产物里只服务于站点交互的节点：编辑小节链接、引用回跳箭头、页面内目录（markdown 渲染端自生成）
const DROP_CLASSES = ['mw-editsection', 'mw-empty-elt', 'mw-cite-backlink', 'toc']
const DROP_TAGS = new Set(['input', 'script', 'style'])
const HEADING_TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6'])

function absolutize(url: string): string {
  return url.startsWith('//') ? `https:${url}` : new URL(url, SITE).href
}

function hasClass(node: RootContent, name: string): boolean {
  if (node.type !== 'element') {
    return false
  }
  const { className } = node.properties
  return Array.isArray(className) && className.some((it) => it === name)
}

/** 节点首尾需要清掉的碎片：空白文本与 <br> */
function isEdgeJunk(it: ElementContent | undefined): boolean {
  return (
    it !== undefined &&
    ((it.type === 'element' && it.tagName === 'br') || (it.type === 'text' && it.value.trim() === ''))
  )
}

/** 去掉节点首尾的空白文本与 <br>：MediaWiki 常把换行留在 </a>、</td> 前（会产出 "[x ](url)"），
 *  行尾的 br 在表格单元格里会被序列化成空格（MD060），故整块清掉而不是只剪空白 */
function trimEdges(node: Element): void {
  while (node.children.length > 0 && isEdgeJunk(node.children.at(0))) {
    node.children.shift()
  }
  while (node.children.length > 0 && isEdgeJunk(node.children.at(-1))) {
    node.children.pop()
  }
  const first = node.children.at(0)
  if (first?.type === 'text') {
    first.value = first.value.replace(/^\s+/, '')
  }
  const last = node.children.at(-1)
  if (last?.type === 'text') {
    last.value = last.value.replace(/\s+$/, '')
  }
}

/** 清洗 hast：删 UI 节点、红链与页内锚点去链接化、资源地址补全为绝对地址 */
function cleanNode(node: RootContent): RootContent[] {
  if (node.type === 'comment' || node.type === 'doctype') {
    return [] // NewPP 报告等注释不是内容
  }
  if (node.type !== 'element') {
    return [node]
  }
  if (DROP_TAGS.has(node.tagName) || DROP_CLASSES.some((it) => hasClass(node, it))) {
    return []
  }
  // 展开去链接化后的子节点可能带回 doctype（实际不会出现），过滤掉以满足 Element 的子节点类型
  node.children = node.children.flatMap(cleanNode).filter((it): it is ElementContent => it.type !== 'doctype')
  const { properties } = node
  delete properties.title // MediaWiki 的 title 属性会被序列化成 markdown 链接标题，纯噪音
  if (typeof properties.src === 'string') {
    properties.src = absolutize(properties.src)
  }
  if (node.tagName === 'a') {
    const href = typeof properties.href === 'string' ? properties.href : undefined
    // 去链接化：没有可导航目标或目标无意义的链接——自链接（无 href 的当前页链接）、页内锚点
    // （引用角标 #cite_note-1、旧目录 #X）、红链（指向不存在页面的编辑地址）、图片外裹的 File: 页面链接
    if (
      href === undefined ||
      href.startsWith('#') ||
      hasClass(node, 'new') ||
      hasClass(node, 'mw-selflink') ||
      hasClass(node, 'mw-file-description')
    ) {
      return node.children
    }
    properties.href = absolutize(href)
  }
  // 表格单元格与链接文本的边缘清理：避免 "[x ](url)"、" |" 这类噪声
  if (node.tagName === 'td' || node.tagName === 'th' || node.tagName === 'a') {
    trimEdges(node)
  }
  return [node]
}

/** 让页面的最外层小节落在 h2：页面自带一级标题（= X =，如 Main Page）时整体下沉，
 *  只用更深层级（==== X ====）的页面整体上提。既给文件标题（# <Title>）让出 H1，也避免 h1→h3 这类跨级 */
function headingShift(tree: Root): number {
  let min = 7
  const walk = (node: Root | Element): void => {
    if (node.type === 'element' && HEADING_TAGS.has(node.tagName)) {
      min = Math.min(min, Number(node.tagName.slice(1)))
    }
    for (const child of node.children) {
      if (child.type === 'element') {
        walk(child)
      }
    }
  }
  walk(tree)
  return min < 7 ? 2 - min : 0
}

function applyHeadingShift(tree: Root, shift: number): void {
  const walk = (node: Root | Element): void => {
    if (node.type === 'element' && HEADING_TAGS.has(node.tagName)) {
      node.tagName = `h${Math.min(Number(node.tagName.slice(1)) + shift, 6)}`
    }
    for (const child of node.children) {
      if (child.type === 'element') {
        walk(child)
      }
    }
  }
  walk(tree)
}

/** 页面渲染 HTML → markdown 文档（含 H1 标题），保留表格/列表/引用/强调等结构 */
function htmlToMarkdown(title: string, html: string): string {
  const tree: Root = fromHtml(html, { fragment: true })
  tree.children = tree.children.flatMap(cleanNode)
  applyHeadingShift(tree, headingShift(tree))
  const markdown = toMarkdown(toMdast(tree), {
    bullet: '-',
    emphasis: '*',
    strong: '*',
    extensions: [
      // 不填充单元格、不按列宽对齐：单元格内容变化只会影响所在行，diff 稳定
      gfmTableToMarkdown({ tableCellPadding: false, tablePipeAlign: false }),
      gfmStrikethroughToMarkdown(),
    ],
  })
  const body = markdown.replace(/[^\S\n]+$/gm, '').replace(/^\n+|\n+$/g, '')
  // 空页面（正文只有注释/UI 节点）只留文件标题，避免结尾的连续空行（MD012）
  return body ? `# ${title}\n\n${body}\n` : `# ${title}\n`
}

/** 页面标题 → slug：小写 kebab（与 original/ 的 slug 规则一致），首页固定为 readme 以充当目录入口 */
function wikiSlug(title: string): string {
  if (title === README_TITLE) {
    return 'readme'
  }
  return title
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '-')
    .replaceAll(/^-+|-+$/g, '')
}

function wikiFileName(title: string): string {
  return `${wikiSlug(title)}.md`
}

/** git autocrlf 检出的工作树是 CRLF：与产物比对前归一，避免本地运行时全树误报 updated */
function normalizeEol(text: string): string {
  return text.replace(/\r\n/g, '\n')
}

interface WriteStats {
  created: string[]
  updated: string[]
  removed: string[]
  unchanged: number
}

/** 对比现有存档树（original/wiki/）做 upsert + 孤儿清理。文件身份 = 页面标题 slug：页面改名等价于删旧建新 */
async function writeWiki(pages: { title: string; markdown: string }[]): Promise<WriteStats> {
  const stats: WriteStats = { created: [], updated: [], removed: [], unchanged: 0 }
  const root = path.resolve(OUTPUT_DIR)
  await mkdir(root, { recursive: true })

  const existing = new Map<string, string>()
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.md')) {
      const content = await readFile(path.join(root, entry.name), 'utf8')
      existing.set(entry.name, normalizeEol(content))
    }
  }

  const expected = new Map<string, string>()
  const titles = new Map<string, string>()
  for (const page of pages) {
    const name = wikiFileName(page.title)
    const conflict = titles.get(name)
    if (conflict !== undefined) {
      throw new Error(`文件名冲突：${name}（${conflict} 与 ${page.title} 的 slug 相同，需要调整 wikiFileName）`)
    }
    titles.set(name, page.title)
    const note =
      page.title === README_TITLE
        ? `\n> Autogenerated by scripts/update-wiki.ts - DO NOT EDIT!\n> Content retrieved from ${SITE}/wiki/Main_Page\n`
        : ''
    expected.set(name, `${page.markdown}${note}`)
  }

  for (const [name, content] of expected) {
    const prev = existing.get(name)
    if (prev === content) {
      stats.unchanged++
    } else {
      await writeFile(path.join(root, name), content)
      ;(prev === undefined ? stats.created : stats.updated).push(name)
    }
  }
  for (const name of existing.keys()) {
    if (!expected.has(name)) {
      await rm(path.join(root, name))
      stats.removed.push(name)
    }
  }
  return stats
}

// 站点是 wiki 语法的渲染产物：表格列宽、图片无 alt、正文裸链接均为上游形态，非本脚本可控
const lintConfig = {
  default: true,
  MD001: false, // 标题跨级：上游页面本身存在 == 下直接 ==== 的小节结构，保持原样
  // 序列化器对嵌套列表固定 '-/*' 交替（且不允许两级同标记），与 MD004 的 '-/*/+' 循环不符
  MD004: false,
  MD013: false, // 行长：表格与作者长段天然长
  MD024: false, // 同名小节：同名标题在不同章节下重复是 wiki 页面结构，非书写问题
  MD028: false, // 相邻 blockquote 间的空行是转换器分块产物（同 scripts/update-source.ts）
  MD034: false, // 裸链接：页面正文里的纯 URL 文本
  MD036: false, // 整段强调：wiki 用斜体段落承载说明（如 "Canonicity: ..."），是刻意排版
  MD045: false, // 图片 alt：MediaWiki 渲染产物不带 alt（图注在相邻段落里）
  MD059: false, // 链接文本：上游大量 "here" 式链接，改写会偏离原页面
}

async function lintOutput(): Promise<void> {
  const root = path.resolve(OUTPUT_DIR)
  const files: Record<string, string> = {}
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.md')) {
      files[entry.name] = await readFile(path.join(root, entry.name), 'utf8')
    }
  }
  const results = await lint({ strings: files, config: lintConfig })
  let problems = 0
  for (const [file, errors] of Object.entries(results)) {
    for (const problem of errors) {
      problems++
      if (problems <= 20) {
        const detail = problem.errorDetail ? ` [${problem.errorDetail}]` : ''
        console.error(
          `  ${file}:${problem.lineNumber}: ${problem.ruleNames.join('/')} ${problem.ruleDescription}${detail}`,
        )
      }
    }
  }
  if (problems > 0) {
    console.error(`markdownlint failed with ${problems} problem(s)`)
    process.exit(1)
  }
  console.log('markdownlint passed')
}

/** 抓取（或读取缓存）全部页面的渲染 HTML */
async function loadPages(): Promise<{ title: string; html: string }[]> {
  if (fromHtmlDir) {
    const root = path.resolve(fromHtmlDir)
    const titles: string[] = JSON.parse(await readFile(path.join(root, 'pages.json'), 'utf8'))
    const pages: { title: string; html: string }[] = []
    for (const title of titles) {
      const html = await readFile(path.join(root, `${wikiSlug(title)}.html`), 'utf8')
      pages.push({ title, html })
    }
    console.log(`Loaded ${pages.length} cached pages from ${fromHtmlDir}`)
    return pages
  }

  const titles = await listPageTitles()
  console.log(`Found ${titles.length} pages`)
  const cacheRoot = htmlCacheDir ? path.resolve(htmlCacheDir) : undefined
  if (cacheRoot) {
    await mkdir(cacheRoot, { recursive: true })
    await writeFile(path.join(cacheRoot, 'pages.json'), JSON.stringify(titles, undefined, 2))
  }
  const pages: { title: string; html: string }[] = []
  for (const [index, title] of titles.entries()) {
    const cacheFile = cacheRoot ? path.join(cacheRoot, `${wikiSlug(title)}.html`) : undefined
    let html = cacheFile ? await readFile(cacheFile, 'utf8').catch(() => undefined) : undefined
    if (html === undefined) {
      html = await fetchPageHtml(title)
      if (cacheFile) {
        await writeFile(cacheFile, html)
      }
    }
    console.log(`  [${index + 1}/${titles.length}] ${title}`)
    pages.push({ title, html })
  }
  return pages
}

async function run(): Promise<void> {
  const pages = await loadPages()
  console.log(`Converting ${pages.length} pages to markdown`)
  const stats = await writeWiki(pages.map((it) => ({ title: it.title, markdown: htmlToMarkdown(it.title, it.html) })))
  console.log(
    `created ${stats.created.length}, updated ${stats.updated.length}, unchanged ${stats.unchanged}, removed ${stats.removed.length}`,
  )
  for (const name of [...stats.created, ...stats.updated, ...stats.removed]) {
    console.log(`  ${name}`)
  }
  await lintOutput()
}

if (!fromHtmlDir && !htmlCacheDir) {
  const { stdout } = await execFileAsync('git', ['log', '-1', '--pretty=format:%at', '--', OUTPUT_DIR]).catch(
    () => ({ stdout: '0' }), // wiki/ 尚未入 git 时（首次运行）视为极旧，必然触发抓取
  )
  const localLastUpdated = new Date(Number(stdout) * 1000)
  if (localLastUpdated.getTime() > 0) {
    console.log('Local version was updated at', localLastUpdated.toISOString())
    const remote = await latestChangeSince(localLastUpdated)
    if (!remote) {
      console.log('Up to date')
      process.exit(0)
    }
    console.log('Remote version was updated at', remote.toISOString())
  }
}

await run()
console.log('Done,', OUTPUT_DIR)