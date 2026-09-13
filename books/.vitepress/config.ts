import type { Sidebar, SidebarItem, SidebarMulti } from 'vitepress-sidebar/types'
import { defineConfig } from 'vitepress'
import { generateSidebar } from 'vitepress-sidebar'
import { withI18n } from 'vitepress-i18n'

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

const siteConfig = {
  rewrites: {
    'readme.md': 'index.md',
    ':a/readme.md': ':a/index.md',
    ':a/:b/readme.md': ':a/:b/index.md',
    ':a/:b/:c/readme.md': ':a/:b/:c/index.md',
    ':a/:b/:c/:d/readme.md': ':a/:b/:c/:d/index.md',
    ':a/:b/:c/:d/:e/readme.md': ':a/:b/:c/:d/:e/index.md',
    ':a/:b/:c/:d/:e/:f/readme.md': ':a/:b/:c/:d/:e/:f/index.md',
  },
  themeConfig: {
    sidebar: aliasReadmeToIndex(
      generateSidebar({
        documentRootPath: '/books',
        useTitleFromFileHeading: true,
        useTitleFromFrontmatter: true,
        useFolderTitleFromIndexFile: true,
        useFolderLinkFromIndexFile: true,
      }),
    ),
  },
  markdown: {
    breaks: true,
  },
}

export default defineConfig(
  withI18n(siteConfig, {
    // 站点内容为简体中文：设根语言环境为 zhHans，默认主题 UI（上一页/下一页等）随浏览器语言显示为中文
    locales: [{ path: '/', locale: 'zhHans' }],
  }),
)
