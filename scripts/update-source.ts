#!/usr/bin/env node
import { stat, writeFile } from 'node:fs/promises'
import { CookieJar } from 'tough-cookie'
import { HttpsProxyAgent } from 'hpagent'
// @ts-expect-error - html-to-text v10 未自带类型声明
import { convert } from 'html-to-text'
import { execFile } from 'node:child_process'
import { findAll } from 'domutils'
import got from 'got'
import { lint } from 'markdownlint/promise'
import { parseDocument } from 'htmlparser2'
import { promisify } from 'node:util'

const WORK_URL = 'https://archiveofourown.org/works/777002'
const LOCAL_FILE = 'scripts/source.md'

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

const { stdout } = await execFileAsync('git', ['log', '-1', '--pretty=format:%at', '--', LOCAL_FILE])
const localLastUpdated = new Date(Number(stdout) * 1000)
console.log('Local version was updated at', localLastUpdated.toISOString())

console.log('Fetching work page for last updated time')
console.time('Fetched')
const downloadLink = await getDownloadLink(WORK_URL)
console.timeEnd('Fetched')

const updatedAtParam = downloadLink.searchParams.get('updated_at')
if (!updatedAtParam?.match(/^\d+$/)) {
  throw `Missing 'updated_at' in download url: ${downloadLink}`
}
const remoteLastUpdated = new Date(Number(updatedAtParam) * 1000)
console.log('Remote version was updated at', remoteLastUpdated.toISOString())

if (localLastUpdated >= remoteLastUpdated) {
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
  selectors: [
    { selector: 'a', options: { ignoreHref: true } },
    { selector: 'img', format: 'skip' },
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

// 生成文件的 markdownlint 配置：关闭与小说正文/文件头冲突的规则；
// MD037（强调标记内侧空格）保持开启，作为强调清理逻辑的回归门禁
const lintConfig = {
  default: true,
  MD013: false, // 行长：小说正文段落天然长
  MD022: false, // 文件头两行 # 注释
  MD025: false, // 同上（多个一级标题）
  MD026: false, // 同上（注释行尾 !）
  MD027: false, // blockquote 续行对齐空格是转换器产物
  MD028: false, // 相邻 blockquote 间的空行是转换器分块产物
  MD034: false, // 作者文本中的裸链接
  MD036: false, // 小说里整段强调（思想/署名）是刻意排版
  MD007: false, // 嵌套列表缩进由转换器决定
}

const content = `# Autogenerated by scripts/update-source.ts - DO NOT EDIT!
# Content retrieved from ${WORK_URL}

${text}
`
  // 章节行标题化：卷标注仅出现在各卷首章标题尾部（实测 4 处），剥掉后缀并在该行前插入 ## 卷标题
  .replace(/^Chapter \d+: .*$/gm, (line) => {
    const mt = /^(?<chap>Chapter \d+: .+?)(?: \(Volume (?<vol>[IVX]+): (?<name>[^)]+)\))?$/.exec(line)
    if (!mt) {
      return line
    }
    const head = mt.groups.vol ? `## Volume ${mt.groups.vol}: ${mt.groups.name}\n\n` : ''
    return `${head}### ${mt.groups.chap}`
  })
  // 行尾/整行空白清零（含 U+00A0 等 Unicode 空白，AO3 用 <p>&nbsp;</p> 做章节间隔），收紧连续空行
  .replace(/[^\S\n]+$/gm, '')
  .replace(/\n{3,}/g, '\n\n')
await writeFile(LOCAL_FILE, content)

const results = await lint({ strings: { [LOCAL_FILE]: content }, config: lintConfig })
const errors = results[LOCAL_FILE]
if (errors.length > 0) {
  console.error(`markdownlint failed with ${errors.length} problem(s), first 20:`)
  for (const problem of errors.slice(0, 20)) {
    const detail = problem.errorDetail ? ` [${problem.errorDetail}]` : ''
    console.error(`  line ${problem.lineNumber}: ${problem.ruleNames.join('/')} ${problem.ruleDescription}${detail}`)
  }
  process.exit(1)
}
console.log('markdownlint passed')

const { size } = await stat(LOCAL_FILE)
console.log('Done,', (size / 1024 / 1204).toFixed(2), 'MB saved to', LOCAL_FILE)
