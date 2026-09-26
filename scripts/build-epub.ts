import { mkdir, writeFile } from 'node:fs/promises'
import { readFileSync, readdirSync } from 'node:fs'
import JSZip from 'jszip'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import remarkBreaks from 'remark-breaks'
import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import remarkRehype from 'remark-rehype'
import { toHtml } from 'hast-util-to-html'
import { unified } from 'unified'

interface BookMeta {
  /** 卷在 books 目录下的目录名 */
  dir: string
  id: string
  title: string
  coverBasename: string
}

interface MdNode {
  type: string
  url?: string
  value?: string
  depth?: number
  children?: MdNode[]
}

interface HastNode {
  type: string
  properties?: Record<string, unknown>
  children?: HastNode[]
}

interface Chapter {
  /** 同时是 Text/<id>.xhtml 文件名与 XML NCName id */
  id: string
  title: string
  html: string
}

interface MediaFile {
  /** Media/<name>，含扩展名 */
  name: string
  buffer: Buffer
}

const creator = 'Hieronym'
const publisher = 'rxliuli'
const language = 'zh-CN'

const books: BookMeta[] = [
  { dir: '01', id: 'tts-01', title: '卷 01 - 量子纠缠', coverBasename: 'cover.png' },
  { dir: '02', id: 'tts-02', title: '卷 02 - 宇宙膨胀', coverBasename: 'cover.png' },
  { dir: '03', id: 'tts-03', title: '卷 03 - 存在悖论', coverBasename: 'cover.png' },
  { dir: '04', id: 'tts-04', title: '卷 04 - 爱因斯坦 - 罗森桥', coverBasename: 'cover.png' },
  { dir: '99', id: 'tts-99', title: '番外', coverBasename: 'cover.png' },
]

const outDir = fileURLToPath(new URL('../dist/epub/', import.meta.url))
const booksRoot = fileURLToPath(new URL('../books/', import.meta.url))

const processor = unified().use(remarkParse).use(remarkGfm).use(remarkBreaks).use(remarkRehype)

const imageMimeTypes: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
}

/** 章节 <dir>/<file> → 章节 id，供卷内互链改写 */
let chaptersByPath = new Map<string, string>()

/** 当前卷的图片收集表：绝对路径 → Media 文件，按首次出现去重排序 */
let mediaByPath = new Map<string, MediaFile>()

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

/** 媒体文件在 manifest 里的 id；EPUB2 的 cover meta 引用的是 id 而非文件名，两处必须一致 */
function mediaId(name: string): string {
  return name.replaceAll('.', '-')
}

function visit(node: MdNode, fn: (node: MdNode) => void): void {
  fn(node)
  for (const child of node.children ?? []) {
    visit(child, fn)
  }
}

function nodeText(node: MdNode): string {
  let text = ''
  visit(node, (it) => {
    if (it.type === 'text') {
      text += it.value ?? ''
    }
  })
  return text
}

/** 章节内全部 image/link 内联节点，线性遍历改写 */
function inlineNodes(mdast: MdNode): MdNode[] {
  const result: MdNode[] = []
  visit(mdast, (it) => {
    if (it.type === 'image' || it.type === 'link') {
      result.push(it)
    }
  })
  return result
}

function compareString(left: string, right: string): number {
  if (left < right) {
    return -1
  }
  if (left > right) {
    return 1
  }
  return 0
}

/** 卷内章节排序：卷首页（readme.md）置顶，其余按文件名（编号前缀）升序 */
function sortChapterFiles(files: string[]): string[] {
  const home = files.find((it) => it.toLowerCase() === 'readme.md')
  const chapters = files
    .filter((it) => it !== home)
    .sort(compareString)
  return home ? [home, ...chapters] : chapters
}

/** 章节 id：readme 卷首页为 chap-000，其余取文件名数字前缀，无前缀回退文件名清洗结果 */
function chapterId(file: string): string {
  if (file.toLowerCase() === 'readme.md') {
    return 'chap-000'
  }
  const num = /^(?<num>\d+)/.exec(file)
  if (num?.groups?.num) {
    return `chap-${num.groups.num}`
  }
  const slug = file.replace(/\.md$/i, '').replaceAll(/[^A-Za-z0-9_-]/g, '-')
  return `chap-${slug}`
}

function findTitle(mdast: MdNode, fallback: string): string {
  const heading = mdast.children?.find((it) => it.type === 'heading' && it.depth === 1)
  return heading ? nodeText(heading).trim() || fallback : fallback
}

function toRelPosix(abs: string): string {
  return path.relative(booksRoot, abs).replaceAll('\\', '/')
}

function rewriteImage(node: MdNode, abs: string): void {
  let media = mediaByPath.get(abs)
  if (!media) {
    const name = `img-${String(mediaByPath.size + 1).padStart(3, '0')}${path.extname(abs).toLowerCase()}`
    media = { name, buffer: readFileSync(abs) }
    mediaByPath.set(abs, media)
  }
  node.url = `../Media/${media.name}`
}

function rewriteContentLink(node: MdNode, abs: string): void {
  if (!node.url?.toLowerCase().endsWith('.md')) {
    return
  }
  const target = chaptersByPath.get(toRelPosix(abs))
  if (target) {
    node.url = `./${target}.xhtml`
  }
}

/** 收集图片为 Media/img-NNN（按首次出现去重排序）并改写引用；章节互链改写为 ./chap-NNN.xhtml */
function rewriteLinks(mdast: MdNode, absFile: string): void {
  for (const node of inlineNodes(mdast)) {
    const url = node.url ?? ''
    if (/^[./]/.test(url)) {
      const abs = path.resolve(path.dirname(absFile), url)
      if (node.type === 'image') {
        rewriteImage(node, abs)
      } else {
        rewriteContentLink(node, abs)
      }
    }
  }
}

/** 序列化时把 hast 布尔属性从 true 改为空串，结果才是 attr="" 的合法 XHTML */
function fixBooleanAttributes(node: HastNode): void {
  const props = node.properties
  if (props) {
    for (const key of Object.keys(props)) {
      if (props[key] === true) {
        props[key] = ''
      }
    }
  }
  for (const child of node.children ?? []) {
    fixBooleanAttributes(child)
  }
}

function renderChapter(file: string, absFile: string, id: string): Chapter {
  const mdast = processor.parse(readFileSync(absFile, 'utf8'))
  const fallback = path.basename(file, path.extname(file))
  const title = findTitle(mdast, fallback)
  rewriteLinks(mdast, absFile)
  const hast = processor.runSync(mdast)
  fixBooleanAttributes(hast)
  const html = toHtml(hast, { closeSelfClosing: true })
  return { id, title, html }
}

function chapterXhtml(chapter: Chapter): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${language}" lang="${language}">
  <head>
    <title>${escapeXml(chapter.title)}</title>
  </head>
  <body>
    <main>
${chapter.html}
    </main>
  </body>
</html>
`
}

function coverXhtml(): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="${language}" lang="${language}">
  <head>
    <title>cover</title>
  </head>
  <body>
    <main>
      <svg xmlns="http://www.w3.org/2000/svg" height="100%" preserveAspectRatio="xMidYMid meet" version="1.1" viewBox="0 0 1352 2000" width="100%" xmlns:xlink="http://www.w3.org/1999/xlink">
        <image width="1352" height="2000" xlink:href="../Media/cover.png" />
      </svg>
    </main>
  </body>
</html>
`
}

function navXhtml(meta: BookMeta, chapters: Chapter[]): string {
  const items = chapters
    .map((it) => `        <li><a href="./${escapeXml(it.id)}.xhtml">${escapeXml(it.title)}</a></li>`)
    .join('\n')
  // 正文起点取第二个章节（第一个是卷首页），卷内无章节时不写 bodymatter（当前各卷都有章节，此处只作防御）
  const beginning = chapters[1]?.id ?? chapters[0]?.id
  const landmarks = [
    '        <li><a epub:type="cover" href="./cover.xhtml">cover</a></li>',
    ...(beginning
      ? [`        <li><a epub:type="bodymatter" href="./${escapeXml(beginning)}.xhtml">beginning</a></li>`]
      : []),
  ].join('\n')
  return `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${language}" lang="${language}">
  <head>
    <title>Navigation</title>
  </head>
  <body>
    <nav epub:type="toc" id="toc">
      <h1>${escapeXml(meta.title)}</h1>
      <ol>
${items}
      </ol>
    </nav>
    <nav epub:type="landmarks" hidden="">
      <ol>
${landmarks}
      </ol>
    </nav>
  </body>
</html>
`
}

function tocNcx(meta: BookMeta, spine: Chapter[]): string {
  const points = spine
    .map(
      (it, index) => `    <navPoint id="np-${index + 1}" playOrder="${index + 1}">
      <navLabel><text>${escapeXml(it.title)}</text></navLabel>
      <content src="Text/${escapeXml(it.id)}.xhtml"/>
    </navPoint>`,
    )
    .join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head>
    <meta name="dtb:uid" content="${escapeXml(meta.id)}"/>
    <meta name="dtb:depth" content="1"/>
    <meta name="dtb:totalPageCount" content="0"/>
    <meta name="dtb:maxPageNumber" content="0"/>
  </head>
  <docTitle><text>${escapeXml(meta.title)}</text></docTitle>
  <navMap>
${points}
  </navMap>
</ncx>
`
}

function contentOpf(meta: BookMeta, spine: Chapter[], media: MediaFile[]): string {
  const modified = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  const manifest = spine
    .map(
      (it) =>
        `    <item id="${escapeXml(it.id)}" href="Text/${escapeXml(it.id)}.xhtml" media-type="application/xhtml+xml"/>`,
    )
    .join('\n')
  const mediaManifest = media
    .map((it) => {
      const id = mediaId(it.name)
      const mime = imageMimeTypes[path.extname(it.name).toLowerCase()] ?? 'application/octet-stream'
      const cover = it.name === 'cover.png' ? ' properties="cover-image"' : ''
      return `    <item id="${escapeXml(id)}" href="Media/${escapeXml(it.name)}" media-type="${mime}"${cover}/>`
    })
    .join('\n')
  const spineItems = spine.map((it) => `    <itemref idref="${escapeXml(it.id)}"/>`).join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="book-id" version="3.0" xml:lang="${language}">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="book-id">${escapeXml(meta.id)}</dc:identifier>
    <dc:title>${escapeXml(meta.title)}</dc:title>
    <dc:creator>${escapeXml(creator)}</dc:creator>
    <dc:publisher>${escapeXml(publisher)}</dc:publisher>
    <dc:language>${escapeXml(language)}</dc:language>
    <meta property="dcterms:modified">${modified}</meta>
    <meta name="cover" content="${escapeXml(mediaId('cover.png'))}"/>
  </metadata>
  <manifest>
    <item id="nav" href="Text/nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
${manifest}
${mediaManifest}
  </manifest>
  <spine toc="ncx">
${spineItems}
  </spine>
</package>
`
}

interface RenderedBook {
  spine: Chapter[]
  chapters: Chapter[]
  media: MediaFile[]
}

function renderBookChapters(meta: BookMeta): RenderedBook {
  const bookDir = path.join(booksRoot, meta.dir)
  const files = sortChapterFiles(readdirSync(bookDir).filter((it) => it.toLowerCase().endsWith('.md')))
  const ids = files.map((file) => chapterId(file))
  chaptersByPath = new Map(files.map((file, index) => [`${meta.dir}/${file}`, ids[index]]))
  mediaByPath = new Map()

  const chapters = files.map((file, index) => renderChapter(file, path.join(bookDir, file), ids[index]))
  const coverSource = path.join(bookDir, 'assets', meta.coverBasename)
  const media: MediaFile[] = [{ name: 'cover.png', buffer: readFileSync(coverSource) }, ...mediaByPath.values()]
  const spine: Chapter[] = [{ id: 'cover', title: 'cover', html: '' }, ...chapters]
  return { spine, chapters, media }
}

function zipXmlFiles(zip: JSZip, meta: BookMeta, book: RenderedBook): void {
  zip.file('content.opf', contentOpf(meta, book.spine, book.media))
  zip.file('Text/nav.xhtml', navXhtml(meta, book.chapters))
  zip.file('toc.ncx', tocNcx(meta, book.spine))
  zip.file('Text/cover.xhtml', coverXhtml())
  for (const chapter of book.chapters) {
    zip.file(`Text/${chapter.id}.xhtml`, chapterXhtml(chapter))
  }
}

function zipMediaFiles(zip: JSZip, media: MediaFile[]): void {
  for (const item of media) {
    zip.file(`Media/${item.name}`, item.buffer)
  }
}

function buildZip(meta: BookMeta, book: RenderedBook): JSZip {
  const zip = new JSZip()
  // 按 EPUB 规范，mimetype 条目必须是 ZIP 首条目且不压缩
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' })
  zip.file(
    'META-INF/container.xml',
    `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>
`,
  )
  zipXmlFiles(zip, meta, book)
  zipMediaFiles(zip, book.media)
  return zip
}

async function buildBook(meta: BookMeta): Promise<void> {
  const book = renderBookChapters(meta)
  const zip = buildZip(meta, book)
  const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
  await writeFile(path.join(outDir, `${meta.title}.epub`), buffer)
  console.log(`Built ${meta.title}.epub (${book.chapters.length} chapters, ${book.media.length} media)`)
}

async function main(): Promise<void> {
  await mkdir(outDir, { recursive: true })
  for (const meta of books) {
    await buildBook(meta)
  }
}

await main()
