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

function readVolumeTitle(root: string, dir: string): string | undefined {
  const file = fileURLToPath(new URL(`../${root}/${dir}/readme.md`, import.meta.url))
  const line = readFileSync(file, 'utf8')
    .split('\n')
    .find((it) => it.startsWith('# '))
  return line?.slice(2).trim()
}

function restoreSidebarItems(items: SidebarItem[], root: string): SidebarItem[] {
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
    return [{ ...it, text: readVolumeTitle(root, dir) ?? dir }]
  })
}

/** 卷索引方面 vitepress-sidebar 只认 index.md，readme.md 卷首页会让分组标题回退成文件夹名；
 *  从卷首页一级标题恢复标题，并移除站点首页（readme.md）在侧边栏中的多余条目 */
function restoreVolumeTitles(sidebar: Sidebar, root: string): Sidebar {
  if (Array.isArray(sidebar)) {
    return restoreSidebarItems(sidebar, root)
  }
  const result: SidebarMulti = {}
  for (const [base, item] of Object.entries(sidebar)) {
    result[base] = { ...item, items: restoreSidebarItems(item.items, root) }
  }
  return result
}

/** documentRootPath 为仓库根时 vitepress-sidebar 会把 scanStartPath 段从链接中剥掉；
 *  locale 页面 URL 需要该段作为前缀，对侧边栏的分组键与各级链接统一补回 */
function prefixSidebarLinks(items: SidebarItem[], prefix: string): SidebarItem[] {
  return items.map((it) => ({
    ...it,
    ...(it.link && { link: `${prefix}${it.link}` }),
    ...(it.items && { items: prefixSidebarLinks(it.items, prefix) }),
  }))
}

function prefixSidebar(sidebar: Sidebar, prefix: string): Sidebar {
  if (Array.isArray(sidebar)) {
    return prefixSidebarLinks(sidebar, prefix)
  }
  const result: SidebarMulti = {}
  for (const [base, item] of Object.entries(sidebar)) {
    // 分组键即 URL 前缀（SidebarMultiItem 无 link 属性），补前缀后整体浅拷贝
    result[`${prefix}${base}`] = { ...item, items: prefixSidebarLinks(item.items, prefix) }
  }
  return result
}

/** 生成某一侧的侧边栏。中文文档根为 books/（vitepress-sidebar 生成的链接相对文档根，
 *  恰与 rewrites 剥离 books/ 前缀后的站点 URL 匹配）；英文文档根为仓库根限定扫描 original/，
 *  链接保留 /original/ 前缀，与 locale 路径一致 */
function buildSidebar(root: 'books' | 'original'): Sidebar {
  return restoreVolumeTitles(
    aliasReadmeToIndex(
      generateSidebar({
        documentRootPath: root === 'books' ? '/books' : '/',
        ...(root === 'original' && { scanStartPath: root }),
        useTitleFromFileHeading: true,
        useTitleFromFrontmatter: true,
        useFolderTitleFromIndexFile: true,
        useFolderLinkFromIndexFile: true,
      }),
    ),
    root,
  )
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

// 英文侧边栏独立生成：scanStartPath 限扫 original/，其链接是相对路径（无前导斜杠），
// 补 /original/ 前缀后与 locale 页面 URL 匹配
const enSidebar = prefixSidebar(buildSidebar('original'), '/original/')

const config: UserConfig = {
  title: '魔法少女小圆 - 飞向星空',
  description:
    '在经历了几个世纪的动荡之后，一个乌托邦式的 AI— 人类政府治理着地球，预示着后稀缺社会的来临和太空殖民的新时代。一次意外的接触却让科技更先进的敌对外星种族打破了和平，这迫使魔法少女们走出幕后，拯救人类文明。在这一切之中，志筑良子，一个普通的女孩，仰望着星空，好奇着她在宇宙中的归所。',
  sitemap: { hostname },
  ignoreDeadLinks: true,
  // srcDir 上移到仓库根后，排除仓库根下的非站点 md（根 README、分析文档、参考克隆）
  srcExclude: ['**/draft-*.md', 'readme.md', 'docs/**', 'mark-magic/**'],
  rewrites: {
    // 中文内容物理位于 books/ 下：剥掉 books/ 前缀使站点 URL 与现网一致（外链/RSS/评论不破坏）；
    // readme 规则必须在通配 .md 规则之前命中
    'books/readme.md': 'index.md',
    'books/:a/readme.md': ':a/index.md',
    'books/:a/:b/readme.md': ':a/:b/index.md',
    'books/:a/:b.md': ':a/:b.md',
    // original/（英文 locale 目录）的 readme 由以下通配规则重写
    ':a/readme.md': ':a/index.md',
    ':a/:b/readme.md': ':a/:b/index.md',
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
    sidebar: buildSidebar('books'),
  },
  // 多 locale 时 vitepress 自动渲染语言切换器；locale 级配置深度叠加在根配置之上，
  // nav/logo/中文侧边栏自动继承。root = 中文译文（books/），/original/ = 英文原文；
  // 英文侧 UI 文案即默认主题的英文默认值，只需替换侧边栏；
  // 中文侧 UI 文案与 vitepress 官方 zh 文档的翻译一致
  locales: {
    root: {
      label: '简体中文',
      lang: 'zh-CN',
      themeConfig: {
        docFooter: { prev: '上一页', next: '下一页' },
        outline: { label: '页面导航' },
        lastUpdated: { text: '最后更新于' },
        langMenuLabel: '多语言',
        returnToTopLabel: '回到顶部',
        sidebarMenuLabel: '菜单',
        darkModeSwitchLabel: '主题',
        lightModeSwitchTitle: '切换到浅色模式',
        darkModeSwitchTitle: '切换到深色模式',
        skipToContentLabel: '跳转到内容',
        notFound: {
          title: '页面未找到',
          quote: '但如果你不改变方向，并且继续寻找，你可能最终会到达你所前往的地方。',
          linkLabel: '前往首页',
          linkText: '带我回首页',
        },
      },
    },
    original: {
      label: 'English',
      lang: 'en-US',
      themeConfig: { sidebar: enSidebar },
    },
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
    publicDir: './static',
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
  outDir: './dist/docs',
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
    // RSS 仅收录中文译文（books/），英文原文 original/ 天然不在 glob 范围内
    const posts = await createContentLoader('books/**/*.md', {
      excerpt: true,
      render: true,
      globOptions: {
        ignore: ['**/99/**'],
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

export default defineConfig(config)
