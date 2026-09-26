#!/usr/bin/env node
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { CookieJar } from 'tough-cookie'
import { HttpsProxyAgent } from 'hpagent'
// @ts-expect-error - html-to-text v10 未自带类型声明
import { convert } from 'html-to-text'
import { execFile } from 'node:child_process'
import { findAll } from 'domutils'
import got from 'got'
import { lint } from 'markdownlint/promise'
import { parseDocument } from 'htmlparser2'
import path from 'node:path'
import { promisify } from 'node:util'

const WORK_URL = 'https://archiveofourown.org/works/777002'
const OUTPUT_DIR = 'original'

// --from-file <path>：跳过网络抓取，直接从本地 markdown 走切分写盘（AO3 不可达时的本地回归入口）
const fromFile = process.argv[2] === '--from-file' ? process.argv[3] : undefined
// --dump-text <path>：抓取并保存切分输入文本（--from-file 的对偶），不写 original/
const dumpText = process.argv[2] === '--dump-text' ? process.argv[3] : undefined

const execFileAsync = promisify(execFile)

// got 不读代理环境变量，这里手动接入；NO_PROXY 命中时保持直连
const proxyUrl = process.env.HTTPS_PROXY ?? process.env.https_proxy ?? process.env.HTTP_PROXY ?? process.env.http_proxy
const noProxyList = (process.env.NO_PROXY ?? process.env.no_proxy ?? '').toLowerCase()
const targetHost = new URL(WORK_URL).hostname
const noProxyHit = noProxyList.split(',').some((it) => {
  const pattern = it.trim()
  return (
    pattern === '*' || targetHost === pattern || targetHost.endsWith(pattern.startsWith('.') ? pattern : `.${pattern}`)
  )
})
const activeProxy = proxyUrl && !noProxyHit ? proxyUrl : undefined

const cookieJar = new CookieJar()
const http = got.extend({
  cookieJar, // Remember Cloudflare cookies
  // hpagent 的 CONNECT 隧道按 HTTP/1.1 转发，h2 协商留给直连场景（CI 无代理环境行为不变）
  http2: !activeProxy,
  retry: {
    limit: 10,
    // Retry on 525 (Cloudflare SSL handshake failed) in addition to the default list.
    // Shouldn't happen intermittently, but somehow it did.
    statusCodes: [408, 413, 429, 500, 502, 503, 504, 521, 522, 524, 525],
    backoffLimit: 15_000,
  },
  timeout: { request: 300_000 },
  headers: { 'accept-language': 'en-US,en;q=0.7' },
  ...(activeProxy && { agent: { https: new HttpsProxyAgent({ proxy: activeProxy }) } }),
})
if (activeProxy) {
  console.log('Proxy enabled:', activeProxy)
}

async function getDownloadLink(workUrl: string): Promise<URL> {
  const html = await http.get(workUrl, { headers: { accept: 'text/html' } }).text()
  const document = parseDocument(html, { decodeEntities: false, lowerCaseTags: true })
  const actionsEl = findAll((el) => el.name === 'ul' && /\bactions\b/.test(el.attribs.class ?? ''), document)
  const linkEls = findAll((el) => el.name === 'a' && 'href' in el.attribs, actionsEl)
  for (const linkEl of linkEls) {
    const { href } = linkEl.attribs
    const match = /\/downloads\/\d+\/[^/?#]+?\.html/i.exec(href)
    if (match) {
      return new URL(href, workUrl)
    }
  }
  throw `Download link not found on ${workUrl}`
}

interface ParsedChapter {
  no: number
  title: string
  body: string
}

interface ParsedVolume {
  roman: string
  title: string
  epigraph?: string
  chapters: ParsedChapter[]
}

interface ParsedSource {
  intro: string
  volumes: ParsedVolume[]
}

const CHAPTER_NOTES = /^Chapter (?:End )?Notes$/
const EMPTY_HINT = /^See the end of the chapter(?: for notes)?$/

/** 章内 AO3 UI 残留：'Chapter Notes'/'Chapter End Notes' 保留为 ## 小节（作者注释属原文内容），
 *  但小节内容若仅为 'See the end of the chapter for notes' 提示则整块剔除 */
function cleanChapterBody(body: string): string {
  const lines = body.split('\n')
  const out: string[] = []
  for (let at = 0; at < lines.length; at++) {
    const line = lines[at]
    if (EMPTY_HINT.test(line)) {
      // 孤立提示行直接丢弃
    } else if (CHAPTER_NOTES.test(line)) {
      let hint = at + 1
      while (hint < lines.length && lines[hint].trim() === '') {
        hint++
      }
      if (hint < lines.length && EMPTY_HINT.test(lines[hint])) {
        at = hint // 空提示块（Notes 行 + 空行 + 提示行）整体剔除，外层 at += 1 越过提示行
      } else {
        out.push(`## ${line}`)
      }
    } else {
      out.push(line)
    }
  }
  return out
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\n+|\n+$/g, '')
}

const VOLUME_PAGE_TITLE = /^Volume\s+[IVXLCⅠ-Ⅻ]+:\s+/
// 卷首页块内的可丢弃行：空行、blockquote 空行（'>'）、blockquote 内的分隔线（'> ---'）
const DROP_PAGE_LINE = /^(?:>\s*)?$|^>\s*-{3,}$/

/** AO3 把卷首页（卷标题行 + 卷题词）内嵌在各卷首章正文开头，作者格式不一（卷标题行或在引文块内），
 *  以首个独立 --- 与章正文分隔。返回卷题词与剥离后的章正文；无卷首页时返回 undefined。
 *  卷标题行本身不保留：readme H1 已承载同一标题 */
function takeVolumePage(body: string): { epigraph?: string; chapterBody: string } | undefined {
  const lines = body.split('\n')
  const headAt = lines.findIndex((line) => line.trim() !== '')
  const isVolumeHead = headAt !== -1 && VOLUME_PAGE_TITLE.test(lines[headAt].replace(/^>\s*/, ''))
  const hrAt = isVolumeHead ? lines.indexOf('---', headAt) : -1
  if (hrAt === -1) {
    return undefined
  }
  const block = lines.slice(headAt + 1, hrAt)
  const firstReal = block.findIndex((line) => !DROP_PAGE_LINE.test(line))
  const lastReal = block.findLastIndex((line) => !DROP_PAGE_LINE.test(line))
  return {
    epigraph: firstReal === -1 ? undefined : block.slice(firstReal, lastReal + 1).join('\n'),
    chapterBody: lines
      .slice(hrAt + 1)
      .join('\n')
      .replace(/^\n+|\n+$/g, ''),
  }
}

/** 从卷首章剥离卷首页：题词挂到卷上（供卷 readme 呈现），首章正文从分隔线后开始 */
function splitVolumePage(volume: ParsedVolume): void {
  const [first] = volume.chapters
  if (!first) {
    return
  }
  const page = takeVolumePage(first.body)
  if (!page) {
    return
  }
  first.body = page.chapterBody
  volume.epigraph = page.epigraph
}

/** 按 `## Volume` / `### Chapter` 标记切分全文，第一个卷标记前的内容归 intro（书名/作者/简介） */
function parseChapters(content: string): ParsedSource {
  const intro: string[] = []
  const volumes: ParsedVolume[] = []
  let volume: ParsedVolume | undefined = undefined
  let chapter: ParsedChapter | undefined = undefined
  let body: string[] = []
  const flush = (): void => {
    if (chapter) {
      chapter.body = body.join('\n').replace(/^\n+|\n+$/g, '')
      body = []
    }
  }
  for (const line of content.split('\n')) {
    const vol = /^## Volume (?<roman>[IVXLC]+): (?<title>.+)$/.exec(line)?.groups
    const chap = vol === undefined ? /^### Chapter (?<no>\d+): (?<title>.+)$/.exec(line)?.groups : undefined
    if (vol !== undefined) {
      flush()
      chapter = undefined
      volume = { roman: vol.roman, title: vol.title, chapters: [] }
      volumes.push(volume)
    } else if (chap !== undefined) {
      flush()
      chapter = { no: Number(chap.no), title: chap.title, body: '' }
      volume?.chapters.push(chapter)
    } else if (volume === undefined) {
      intro.push(line)
    } else {
      body.push(line)
    }
  }
  flush()
  for (const vol of volumes) {
    for (const chap of vol.chapters) {
      chap.body = cleanChapterBody(chap.body)
    }
    splitVolumePage(vol)
  }
  return { intro: intro.join('\n').replace(/^\n+|\n+$/g, ''), volumes }
}

function romanToInt(roman: string): number {
  // eslint-disable-next-line eslint/id-length -- 键为罗马数字本身，单字符无法改名
  const values: Record<string, number> = { I: 1, V: 5, X: 10, L: 50, C: 100 }
  let result = 0
  for (let at = 0; at < roman.length; at++) {
    const cur = values[roman[at]] ?? 0
    const next = values[roman[at + 1]] ?? 0
    result += cur < next ? -cur : cur
  }
  return result
}

function slugify(title: string): string {
  return title
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '-')
    .replaceAll(/^-+|-+$/g, '')
}

interface WriteStats {
  created: string[]
  updated: string[]
  removed: string[]
  unchanged: number
}

/** 对比现有 original/ 树做 upsert + 孤儿清理。文件身份 = 全局章编号，
 *  slug 仅在文件首次创建时从当时标题快照，此后标题变化只更新内容（git diff 稳定、URL 不抖动） */
/** git autocrlf 检出的工作树是 CRLF：与产物比对前归一，避免本地运行时全树误报 updated */
function normalizeEol(text: string): string {
  return text.replace(/\r\n/g, '\n')
}

async function writeOriginal(parsed: ParsedSource): Promise<WriteStats> {
  const stats: WriteStats = { created: [], updated: [], removed: [], unchanged: 0 }
  const root = path.resolve(OUTPUT_DIR)
  await mkdir(root, { recursive: true })

  const existing = new Map<string, string>()
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.md')) {
      const file = await readFile(path.join(root, entry.name), 'utf8')
      existing.set(entry.name, normalizeEol(file))
    } else if (entry.isDirectory()) {
      const names = await readdir(path.join(root, entry.name))
      for (const name of names) {
        if (name.endsWith('.md')) {
          const rel = `${entry.name}/${name}`
          const nested = await readFile(path.join(root, rel), 'utf8')
          existing.set(rel, normalizeEol(nested))
        }
      }
    }
  }

  const expected = new Map<string, string>()
  const home = `# To the Stars\n\n${parsed.intro.replace(/^To the Stars\n\n/, '')}\n\n> Autogenerated by scripts/update-source.ts - DO NOT EDIT!\n> Content retrieved from ${WORK_URL}\n> For the Chinese translation, switch the site language.\n`
  expected.set('readme.md', home)
  for (const vol of parsed.volumes) {
    const dir = String(romanToInt(vol.roman)).padStart(2, '0')
    expected.set(
      `${dir}/readme.md`,
      `# Volume ${vol.roman}: ${vol.title}${vol.epigraph ? `\n\n${vol.epigraph}` : ''}\n`,
    )
    for (const chapter of vol.chapters) {
      const prefix = `${String(chapter.no).padStart(3, '0')}-`
      const prev = [...existing.keys()].find((rel) => rel.startsWith(`${dir}/${prefix}`))
      const name = prev ? prev.slice(dir.length + 1) : `${prefix}${slugify(chapter.title)}.md`
      expected.set(`${dir}/${name}`, `# Chapter ${chapter.no}: ${chapter.title}\n\n${chapter.body}\n`)
    }
  }

  for (const [rel, content] of expected) {
    const prev = existing.get(rel)
    if (prev === content) {
      stats.unchanged++
    } else {
      await writeFile(path.join(root, rel), content)
      ;(prev === undefined ? stats.created : stats.updated).push(rel)
    }
  }
  for (const rel of existing.keys()) {
    if (!expected.has(rel)) {
      await rm(path.join(root, rel))
      stats.removed.push(rel)
    }
  }
  return stats
}

// 切分后每文件仅一个 H1，原先为单文件大 markdown 关闭的 MD022/025/026 已恢复默认；
// 剩余关闭项均为转换器产物或作者排版风格
const lintConfig = {
  default: true,
  MD013: false, // 行长：小说正文段落天然长
  MD027: false, // blockquote 续行对齐空格是转换器产物
  MD028: false, // 相邻 blockquote 间的空行是转换器分块产物
  MD034: false, // 作者文本中的裸链接
  MD036: false, // 小说里整段强调（思想/署名）是刻意排版
  MD007: false, // 嵌套列表缩进由转换器决定
  MD045: false, // 图片 alt 取自作者 HTML，作者可能省略（当前 37 张均带图注署名）
}

async function run(content: string): Promise<void> {
  // git autocrlf 检出的存档是 CRLF：JS 正则的 `.` 不匹配 \r，`$` 锚定末尾，行解析会整体失效，先归一为 LF
  const normalized = normalizeEol(content)
  const stats = await writeOriginal(parseChapters(normalized))
  console.log(
    `created ${stats.created.length}, updated ${stats.updated.length}, unchanged ${stats.unchanged}, removed ${stats.removed.length}`,
  )
  for (const rel of [...stats.created, ...stats.updated, ...stats.removed]) {
    console.log(`  ${rel}`)
  }

  const root = path.resolve(OUTPUT_DIR)
  const files: Record<string, string> = {}
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(abs)
      } else if (entry.name.endsWith('.md')) {
        files[path.relative(root, abs).replaceAll('\\', '/')] = await readFile(abs, 'utf8')
      }
    }
  }
  await walk(root)

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

if (fromFile) {
  // 旧存档带 2 行 # 注释头，剥掉后与网络流程产出的 text 对齐；归一必须在剥离之前（CRLF 下 \n 锚点失配）
  const rawFile = await readFile(fromFile, 'utf8')
  const raw = normalizeEol(rawFile)
  await run(
    raw.replace(/^# Autogenerated by scripts\/update-source\.ts - DO NOT EDIT!\n# Content retrieved from .*\n+/, ''),
  )
  process.exit(0)
}

const { stdout } = await execFileAsync('git', ['log', '-1', '--pretty=format:%at', '--', OUTPUT_DIR]).catch(
  () => ({ stdout: '0' }), // original/ 尚未入 git 时（首次运行）视为极旧，必然触发抓取
)
const localLastUpdated = new Date(Number(stdout) * 1000)
console.log('Local version was updated at', localLastUpdated.toISOString())

console.log('Fetching work page for last updated time')
console.time('Fetched')
const downloadLink = await getDownloadLink(WORK_URL)
console.timeEnd('Fetched')

const updatedAtParam = downloadLink.searchParams.get('updated_at')
if (!updatedAtParam?.match(/^\d+$/)) {
  throw `Missing 'updated_at' in download url: ${downloadLink.href}`
}
const remoteLastUpdated = new Date(Number(updatedAtParam) * 1000)
console.log('Remote version was updated at', remoteLastUpdated.toISOString())

if (localLastUpdated >= remoteLastUpdated && !dumpText) {
  console.log('Up to date')
  process.exit(0)
}

console.log('Downloading full HTML from remote')
console.time('Downloaded')
const html = await http.get(downloadLink, { headers: { accept: 'text/html', referer: WORK_URL } }).text()
console.timeEnd('Downloaded')

console.log('Converting HTML to plain text')
// 真实数据实测（docs/update-source-markdown-analysis.md）：作者手写 HTML 常见 <em> 文本 </em> 内边距，
// markdown 强调语法不容忍内侧空格；空 <em></em> 会产出孤立 **。转换前统一清理。
const cleanHtml = html
  .replace(/<(?<tag>em|i|strong|b)>\s+/g, '<$<tag>>')
  .replace(/\s+<\/(?<tag>em|i|strong|b)>/g, '</$<tag>>')
  .replace(/<(?<tag>em|i|strong|b)><\/\k<tag>>/g, '')
const text = convert(cleanHtml, {
  baseElements: { selectors: ['h1', '.byline', '.userstuff'], orderBy: 'occurrence' },
  wordwrap: false,
  formatters: {
    // 作者内嵌的同人图还原为 markdown 外链（src 为绝对地址，alt 带图注与画师署名）；
    // 相对地址按下载页 URL 解析兜底
    imageLink: (elem, walk, builder) => {
      const { src } = elem.attribs
      if (!src) {
        return
      }
      const alt = elem.attribs.alt ?? ''
      builder.addInline(`![${alt}](${new URL(src, downloadLink.href).href})`)
    },
  },
  selectors: [
    { selector: 'a', options: { ignoreHref: true } },
    { selector: 'img', format: 'imageLink' },
    { selector: 'hr', options: { length: 3 } },
    { selector: 'ul', options: { itemPrefix: '- ' } },
    // 行内强调还原为 markdown 语法（方案 A，见 docs/update-source-markdown-analysis.md）
    { selector: 'em', format: 'inlineSurround', options: { prefix: '*', suffix: '*' } },
    { selector: 'i', format: 'inlineSurround', options: { prefix: '*', suffix: '*' } },
    { selector: 'strong', format: 'inlineSurround', options: { prefix: '**', suffix: '**' } },
    { selector: 'b', format: 'inlineSurround', options: { prefix: '**', suffix: '**' } },
    { selector: 'h1', options: { uppercase: false } },
    { selector: 'h2', options: { uppercase: false } },
    { selector: 'h3', options: { uppercase: false } },
    { selector: 'h4', options: { uppercase: false } },
    { selector: 'h5', options: { uppercase: false } },
    { selector: 'h6', options: { uppercase: false } },
  ],
})

// 章节行标题化：卷标注仅出现在各卷首章标题尾部（实测 4 处），剥掉后缀并在该行前插入 ## 卷标题
const content = text
  .replace(/^Chapter \d+: .*$/gm, (line: string) => {
    const mt = /^(?<chap>Chapter \d+: .+?)(?: \(Volume (?<vol>[IVX]+): (?<name>[^)]+)\))?$/.exec(line)
    if (!mt) {
      return line
    }
    const head = mt.groups?.vol ? `## Volume ${mt.groups.vol}: ${mt.groups.name}\n\n` : ''
    return `${head}### ${mt.groups?.chap}`
  })
  // 行尾/整行空白清零（含 U+00A0 等 Unicode 空白，AO3 用 <p>&nbsp;</p> 做章节间隔），收紧连续空行
  .replace(/[^\S\n]+$/gm, '')
  .replace(/\n{3,}/g, '\n\n')

if (dumpText) {
  await mkdir(path.dirname(dumpText), { recursive: true })
  await writeFile(dumpText, content)
  console.log('Saved source text to', dumpText)
  process.exit(0)
}

await run(content)
console.log('Done,', OUTPUT_DIR)
