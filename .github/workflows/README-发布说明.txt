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
  会发布：index.html、admin.html、sw.js、manifest.webmanifest、favicon.svg、
          icon-192.png、icon-512.png、qrcode.jpg、games/、homework/
  不发布：api/、internal/、backup/、source/、*.zip、.github/、
          以及各种配置文件（.gitignore、package.json 等）

【注意】
  · 前端要调后端时，靠 index.html 里的 API_BASE_DEFAULT 指向 Vercel 地址，
    不依赖 api/ 目录，所以排除 api/ 不影响功能。
  · 若以后新增了站点要用的文件（比如新图片文件夹），记得在下面
    SOURCE_FILES 那一行里补上，否则不会被发布。

================================================================
【故障排查】线上显示的是几个月前的旧版页面
================================================================

  症状：改了代码、提交了、Actions 也显示 success，但打开网址看到的
        还是很久以前的存档页。

  排查顺序：

  1. 先看 workflow 最后一步「回查 gh-pages 是否真的更新了」。
     这一步是专门为这个故障加的：
       · 如果它变红，日志会直接告诉你 gh-pages 没更新 → 走第 2 条
       · 如果它变绿，说明推送没问题，问题在 Pages 的构建源 → 走第 3 条

  2. 检查 Actions 的写权限（最常见原因）
     Settings → Actions → General → Workflow permissions
     必须选 "Read and write permissions"，然后 Save。
     如果这里是只读，GITHUB_TOKEN 没有写权限，推送会被静默丢弃，
     但 peaceiris/actions-gh-pages 有可能仍然报告 success。

     改完之后去 Actions 页面点一次 "Run workflow" 手动重跑。

  3. 检查 Pages 的构建源
     Settings → Pages → Build and deployment
       Source 必须是 "Deploy from a branch"
       Branch 必须是 gh-pages + / (root)
     如果不是，Pages 就会一直拿一份旧的静态快照出页面。

  4. 确认 gh-pages 分支的真实状态
     打开仓库的 gh-pages 分支，看它的最后提交时间。
     正常情况下，每次 master 推送后它都会立刻多一次提交，
     提交信息形如「自动发布：<你的提交信息>」。

================================================================
【2026-10-05 二次踩坑全记录】gh-pages 卡死 41 天没更新
================================================================

  【症状】
    gh-pages 的 head 从 2026-08-25 起就再没动过（一直停在 e3bab998），
    但 master 每天都有新提交，Actions 每次都是绿色的 success。

  【根因：上一版回查是「假阳性」】
    上一版回查只做了这一步：
        REMOTE_SIZE=$(git show FETCH_HEAD:index.html | wc -c)
        [ "$REMOTE_SIZE" != "$LOCAL_SIZE" ] && exit 1
    也就是「只比字节数」。

    问题在于：它没比 commit SHA，也没比内容哈希。
    只要远端那份 index.html 的字节数碰巧和本地相等，就会判定通过 ——
    而实际上 gh-pages 根本停在一个完全不同的旧提交上。

    更要命的是 `git fetch --depth=1 origin gh-pages` 把结果写进 FETCH_HEAD，
    在浅克隆 + 已有 FETCH_HEAD 残留的情况下，可能读到的是**上一次**取回的
    对象，于是「拿旧数据去验证旧数据」，必然相等。

  【这一版的修复（deploy-pages.yml 里已实现）】
    1. 推送前先记下 gh-pages 的 head SHA
    2. 推送后再读一次，**指针没变就直接判失败**（识别静默丢弃）
    3. 用 `sha256sum` 逐字节比对 index.html / admin.html（不再比大小）
    4. 校验二：远端必须真的存在这些文件（git cat-file -e）
    5. 回查失败 → 自动触发备用通道：在 _site 里 git init + 强推 gh-pages
    6. 备用通道推完再回查一次

  【实测结果（这次就是靠它救回来的）】
    · 主通道 peaceiris/actions-gh-pages 依然静默失败 → job 变红
    · 但回查**正确地抓到了**（以前会误报成功）
    · 备用通道 git 强推成功，gh-pages 立刻更新到 47e6b295
    · 线上 admin.html 恢复为 170793 字节，内容与本地逐字节一致

  【结论】
    现在这条链路是「自愈」的：peaceiris 就算继续失灵，备用通道也会把
    内容推上去。看到 job 红色不必惊慌，先看最后一步是不是
    「备用通道回查通过」—— 是的话线上就是好的。

  【顺带记录：Gitee → GitHub 镜像有约 2 分钟延迟】
    本次排查时一度误判为「GitHub 落后于 Gitee」，其实是查得太早。
    推完 Gitee 后大约等 2 分钟，GitHub 才会同步到。
    验证方法：对比两边 .github/workflows/deploy-pages.yml 的 size。

================================================================
