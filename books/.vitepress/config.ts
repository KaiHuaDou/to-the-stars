import {
  type ContentData,
  type PageData,
  type SiteConfig,
  type TransformPageContext,
  type UserConfig,
  createContentLoader,
  defineConfig,
} from 'vitepress'
import type { Sidebar, SidebarItem, SidebarMulti } from 'vitepress-sidebar/types'
import { readFile, writeFile } from 'node:fs/promises'
import { Feed } from 'feed'
import { fileURLToPath } from 'node:url'
import { generateSidebar } from 'vitepress-sidebar'
import { pagefindPlugin } from 'vitepress-plugin-pagefind'
import { parse } from 'node-html-parser'
import path from 'node:path'
import { readFileSync } from 'node:fs'
import { withI18n } from 'vitepress-i18n'

const hostname = 'https://tts.liuli.moe'
const gtagId = 'G-F20H7RT1RM'

/** 将侧边栏中的 readme 链接改写为 index，并移除被替换掉的 readme 条目 */
function aliasSidebarItems(items: SidebarItem[]): SidebarItem[] {
  return items.map((item) => {
    if (!item.items) {
      return item
    }
    const readmeIndex = item.items.findIndex((child) => child.link?.endsWith('/readme'))
    if (readmeIndex === -1) {
      return item
    }
    const readme = item.items[readmeIndex]
    return {
      ...item,
      link: readme.link?.replace('readme', 'index'),
      items: item.items.filter((child) => child !== readme),
    }
  })
}

function aliasReadmeToIndex(sidebar: Sidebar): Sidebar {
  if (Array.isArray(sidebar)) {
    return aliasSidebarItems(sidebar)
  }
  const result: SidebarMulti = {}
  for (const [base, item] of Object.entries(sidebar)) {
    const items = aliasSidebarItems(item.items)
    result[base] = { ...item, items }
  }
  return result
}

function readVolumeTitle(dir: string): string | undefined {
  const file = fileURLToPath(new URL(`../${dir}/readme.md`, import.meta.url))
  const line = readFileSync(file, 'utf8')
    .split('\n')
    .find((it) => it.startsWith('# '))
  return line?.slice(2).trim()
}

function restoreSidebarItems(items: SidebarItem[]): SidebarItem[] {
  return items.flatMap((it) => {
    if (!it.items) {
      if (it.link?.endsWith('/readme')) {
        return []
      }
      return [it]
    }
    const dir = it.text ?? ''
    if (!/^\d+$/.test(dir)) {
      return [it]
    }
    return [{ ...it, text: readVolumeTitle(dir) ?? dir }]
  })
}

/** 卷索引方面 vitepress-sidebar 只认 index.md，readme.md 卷首页会让分组标题回退成文件夹名；
 *  从卷首页一级标题恢复标题，并移除站点首页（readme.md）在侧边栏中的多余条目 */
function restoreVolumeTitles(sidebar: Sidebar): Sidebar {
  if (Array.isArray(sidebar)) {
    return restoreSidebarItems(sidebar)
  }
  const result: SidebarMulti = {}
  for (const [base, item] of Object.entries(sidebar)) {
    result[base] = { ...item, items: restoreSidebarItems(item.items) }
  }
  return result
}

/** 无 frontmatter description 的页面从正文提取，行为与 vitepress-plugin-twitter-card 一致 */
function extractDescription(content: string, maxLength: number): string {
  const lines = content.split('\n')
  let start = lines.findIndex((it) => it.startsWith('# '))
  if (start === -1) {
    start = lines.findIndex((it) => it.startsWith('---'))
  }
  const text = lines
    .slice(start + 1)
    .filter((it) => !it.startsWith('#') && !it.startsWith('---') && !it.startsWith('![') && !it.startsWith('['))
    .join(' ')
    .trim()
  if (text.length <= maxLength) {
    return text
  }
  return `${text.slice(0, maxLength).trim()}...`
}

function getAbsPath(outDir: string, rel: string): string {
  if (rel.endsWith('.html')) {
    return path.join(outDir, rel)
  }
  if (rel.endsWith('/')) {
    return path.join(outDir, rel, 'index.html')
  }
  return rel
}

async function cleanHtml(html: string, baseUrl: string): Promise<string | undefined> {
  const dom = parse(html).querySelector('main > .vp-doc > div')
  for (const img of dom?.querySelectorAll('img') ?? []) {
    const src = img.getAttribute('src')
    if (src) {
      img.setAttribute('src', new URL(src, baseUrl).toString())
    }
  }
  return dom?.innerHTML
}

/** 章节 md 无 frontmatter.title，与 mark-magic 一致地从第一个 h1 提取标题 */
function findTitle(html: string): string | undefined {
  const h1 = parse(html).querySelector('h1')
  return h1?.textContent.replace(/\u200b/g, '').trim()
}

function compareUrl(left: ContentData, right: ContentData): number {
  if (left.url < right.url) {
    return -1
  }
  if (left.url > right.url) {
    return 1
  }
  return 0
}

/** 复刻 vitepress-plugin-twitter-card：首页使用站点信息，其余页面从正文提取描述 */
async function twitterMeta(
  pageData: PageData,
  ctx: TransformPageContext,
): Promise<{ title?: string; description?: string }> {
  if (pageData.frontmatter.layout === 'home') {
    return { title: ctx.siteConfig.site.title, description: ctx.siteConfig.site.description }
  }
  let description: string | undefined = pageData.frontmatter.description
  if (!description && pageData.filePath) {
    const content = await readFile(path.resolve(ctx.siteConfig.root, pageData.filePath), 'utf8')
    description = extractDescription(content, 160)
  }
  return { title: pageData.title, description }
}

// 在 transformHtml 中收集构建产物 html，供 buildEnd 生成 RSS 时把正文图片重写为绝对地址
const htmlMap: Record<string, string> = {}

/** 单条 RSS 内容：正文去掉零宽字符，图片重写为绝对地址 */
async function rssItemHtml(siteConfig: SiteConfig, it: ContentData): Promise<string | undefined> {
  let html = it.html?.replaceAll('&ZeroWidthSpace;', '')
  if (it.html?.includes('<img')) {
    const raw = htmlMap[getAbsPath(siteConfig.outDir, it.url)]
    if (raw) {
      html = await cleanHtml(raw, path.posix.join(hostname, siteConfig.site.base))
      it.html = html
    }
  }
  return html
}

const config: UserConfig = {
  title: '魔法少女小圆 - 飞向星空',
  description:
    '在经历了几个世纪的动荡之后，一个乌托邦式的 AI— 人类政府治理着地球，预示着后稀缺社会的来临和太空殖民的新时代。一次意外的接触却让科技更先进的敌对外星种族打破了和平，这迫使魔法少女们走出幕后，拯救人类文明。在这一切之中，志筑良子，一个普通的女孩，仰望着星空，好奇着她在宇宙中的归所。',
  sitemap: { hostname },
  ignoreDeadLinks: true,
  srcExclude: ['**/draft-*.md'],
  rewrites: {
    'readme.md': 'index.md',
    ':a/readme.md': ':a/index.md',
    ':a/:b/readme.md': ':a/:b/index.md',
    ':a/:b/:c/readme.md': ':a/:b/:c/index.md',
    ':a/:b/:c/:d/readme.md': ':a/:b/:c/:d/index.md',
    ':a/:b/:c/:d/:e/readme.md': ':a/:b/:c/:d/:e/index.md',
    ':a/:b/:c/:d/:e/:f/readme.md': ':a/:b/:c/:d/:e/:f/index.md',
  },
  markdown: {
    breaks: true,
    attrs: false,
  },
  themeConfig: {
    nav: [
      { text: 'GitHub', link: 'https://github.com/liuli-moe/to-the-stars' },
      {
        text: '社区',
        items: [
          { text: '原作官网', link: 'https://tts.determinismsucks.net' },
          { text: 'epub 电子书', link: 'https://github.com/liuli-moe/to-the-stars/releases/latest' },
          { text: '同人画', link: 'https://ttshieronym.tumblr.com/tagged/fanart' },
        ],
      },
    ],
    logo: { light: '/logo.png', dark: '/logoDark.png' },
    sidebar: restoreVolumeTitles(
      aliasReadmeToIndex(
        generateSidebar({
          documentRootPath: '/books',
          useTitleFromFileHeading: true,
          useTitleFromFrontmatter: true,
          useFolderTitleFromIndexFile: true,
          useFolderLinkFromIndexFile: true,
        }),
      ),
    ),
  },
  head: [
    ['script', { async: '', src: `https://www.googletagmanager.com/gtag/js?id=${gtagId}` }],
    [
      'script',
      {},
      `window.dataLayer = window.dataLayer || [];
        function gtag(){dataLayer.push(arguments);}
        gtag('js', new Date());
        gtag('config', '${gtagId}');`,
    ],
    ['link', { rel: 'icon', href: '/logo.png' }],
  ],
  vite: {
    publicDir: '../static',
    plugins: [
      pagefindPlugin({
        customSearchQuery: (input: string) => {
          const segmenter = new Intl.Segmenter('zh-CN', { granularity: 'word' })
          const result: string[] = []
          for (const it of segmenter.segment(input)) {
            if (it.isWordLike) {
              result.push(it.segment)
            }
          }
          return result.join(' ')
        },
        btnPlaceholder: '搜索',
        placeholder: '搜索文档',
        emptyText: '空空如也',
        heading: '共：{{searchResult}} 条结果',
      }),
    ],
  },
  outDir: '../dist/docs',
  async transformPageData(pageData, ctx): Promise<void> {
    pageData.frontmatter.head ??= []
    const { head } = pageData.frontmatter
    if (head.some((it: [string, Record<string, string>]) => it[1]?.name === 'twitter:card')) {
      return
    }
    const meta = await twitterMeta(pageData, ctx)
    head.push(
      ['meta', { name: 'twitter:card', content: 'summary' }],
      ['meta', { name: 'twitter:title', content: meta.title }],
      ['meta', { name: 'twitter:description', content: meta.description }],
      ['meta', { name: 'twitter:image', content: `${hostname}/cover.png` }],
      ['meta', { name: 'twitter:site', content: '@rxliuli' }],
    )
  },
  transformHtml(code, id): void {
    if (!/[\\/]404\.html$/.test(id)) {
      htmlMap[id] = code
    }
  },
  async buildEnd(siteConfig): Promise<void> {
    const feed = new Feed({
      id: hostname,
      title: siteConfig.site.title,
      description: siteConfig.site.description ?? '',
      copyright: 'Copyright © 2023 Hieronym, Inc. Built with feed.',
      link: hostname,
    })
    const posts = await createContentLoader('**/*.md', {
      excerpt: true,
      render: true,
      globOptions: {
        ignore: ['dist', '**/99/**'],
      },
    }).load()
    for (const it of posts.toSorted(compareUrl).slice(posts.length - 10)) {
      // eslint-disable-next-line no-await-in-loop -- 条目最多 10 个，串行生成足够且更直观
      const html = await rssItemHtml(siteConfig, it)
      feed.addItem({
        title: it.frontmatter.title ?? findTitle(it.html ?? ''),
        id: `${hostname}${it.url}`,
        link: `${hostname}${it.url}`,
        content: html,
        date: it.frontmatter.date,
      })
    }
    await writeFile(path.join(siteConfig.outDir, 'rss.xml'), feed.rss2())
  },
}

export default defineConfig(
  withI18n(config, {
    // 站点内容为简体中文：设根语言环境为 zhHans，默认主题 UI（上一页/下一页等）随浏览器语言显示为中文
    locales: [{ path: '/', locale: 'zhHans' }],
  }),
)
