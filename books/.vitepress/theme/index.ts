import { useData, useRoute } from 'vitepress'
import giscusTalk from 'vitepress-plugin-comment-with-giscus'
import theme from 'vitepress/theme'

export default {
  extends: theme,
  setup(): void {
    const { frontmatter } = useData()
    const route = useRoute()

    giscusTalk(
      {
        repo: 'liuli-moe/to-the-stars',
        repoId: 'R_kgDOG4H10w',
        category: 'General',
        categoryId: 'DIC_kwDOG4H1084CQhBn',
        mapping: 'pathname',
        inputPosition: 'bottom',
        lang: 'zh-CN',
      },
      { frontmatter, route },
      true,
    )
  },
}
