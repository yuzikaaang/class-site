================================================================
GitHub Pages 自动发布配置说明（给站主看的备忘）
================================================================

【做什么】
  每次 master 分支有新提交，这个 workflow 会自动把「上线需要的文件」
  复制到 gh-pages 分支，GitHub Pages 从 gh-pages 出页面。

  master（源仓库，全量） → 自动清洗 → gh-pages（线上，只放该公开的）

【为什么要这样】
  之前 Pages 直接从 master 根目录出页面，导致仓库里所有文件都会被托管 ——
  包括 internal/（内部维护文档）、backup/（77 个历史版本 HTML）、api/（后端源码）。
  加了这一步之后，master 里照样什么都有，但线上只剩该公开的那几个文件。

【和你原定铁律的关系】
  internal/notes.md 里写的「铁律 · 内部文档隐藏」要求「线上发布包一律排除 internal/」。
  本 workflow 就是把这条铁律真正实现出来。

【站主需要做什么（只需一次）】
  1. 让 GitHub 上出现 gh-pages 分支（workflow 第一次跑完就有了）
  2. 去仓库 Settings → Pages，把 Source 从
       "Deploy from a branch: master / (root)"
     改成
       "Deploy from a branch: gh-pages / (root)"
  3. 之后就不用管了，全自动

【发布内容】
  会发布：index.html、sw.js、manifest.webmanifest、favicon.svg、
          icon-192.png、icon-512.png、qrcode.jpg、games/、homework/
  不发布：api/、internal/、backup/、source/、*.zip、.github/、
          以及各种配置文件（.gitignore、package.json 等）

【注意】
  · 前端要调后端时，靠 index.html 里的 API_BASE_DEFAULT 指向 Vercel 地址，
    不依赖 api/ 目录，所以排除 api/ 不影响功能。
  · 若以后新增了站点要用的文件（比如新图片文件夹），记得在下面
    SOURCE_FILES 那一行里补上，否则不会被发布。
================================================================
