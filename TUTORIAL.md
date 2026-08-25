# 25级05班班级服务站 - 使用与维护教程

> 本文件用于在对话卡顿时快速恢复上下文。每次修改流程或要求后，应及时更新本文件和 README.md。

## 0. 模型无关性（最重要）

**本仓库是唯一内容源**。任何 AI（DeepSeek / ChatGPT / Claude / Gemini / 任意模型 / 任意新对话）只要能访问 Gitee 仓库（用 `secrets-hint.txt` 提示的密码解密 `secrets.json.enc` 拿令牌），就能完整接手本项目，**无需依赖任何特定对话的记忆**。

请遵守：
- 所有内容、规则、偏好、决策都应**沉淀到本仓库**（`README.md` / `TUTORIAL.md` / 站内公告 / 源码注释）
- 不要只在对话里口头约定一件事——必须同步写入仓库
- 用户提到新规则时，立即更新 `TUTORIAL.md` 对应章节 + 站内公告 + 必要时同步 `README.md`
- 每次结束前确认本次所有改动已 commit + push 到 Gitee

## 1. 项目目标

为 25级05班 提供一个一站式班级服务网站（静态 PWA），聚合常用链接、公告、倒计时、公众号二维码等内容，可在微信内直接打开并添加到主屏幕。

## 2. 仓库结构

```
.
├── index.html              # 线上站点本体（单文件，直接修改这里）
├── manifest.webmanifest    # PWA 配置
├── sw.js                   # Service Worker（离线兜底 + 更新）
├── favicon.svg             # 站点图标
├── icon-192.png            # PWA 图标
├── icon-512.png
├── qrcode.jpg              # 班级公众号二维码（由维护者提供）
├── backups/                # 每周自动备份的 index.html 快照
├── .github/workflows/      # GitHub Actions 工作流（每周自动备份）
├── source/                 # 早期 React 工程，仅作追溯，不参与线上
├── README.md               # 项目简介与快速入口
└── TUTORIAL.md             # 本文件：完整维护教程
```

**注意**：线上实际只使用根目录的静态文件，`source/` 目录不再构建。

## 3. 工作流（双仓库 + 双平台）

### 3.1 主仓库（Gitee）

- 仓库地址：`https://gitee.com/zikang0529/class-site`
- 用途：主要编辑与版本管理
- 操作：所有内容改动先在本地完成，再推送到 Gitee `master` 分支

### 3.2 GitHub（主链接来源）

- 仓库地址：`https://github.com/yuzikaaang/class-site`（已公开）
- 用途：对外主链接 `https://yuzikaaang.github.io/class-site/` 的来源；Gitee 推送后由镜像自动同步，GitHub Pages 作为全班访问主入口
- 同步方式：通过 Gitee 的「仓库镜像管理」自动同步到 GitHub

#### 配置 Gitee → GitHub 镜像（一次性）

1. 登录 Gitee，进入 `zikang0529/class-site` 仓库
2. 点击「管理」→「仓库镜像管理」→「添加镜像」
3. 镜像方向：Gitee → GitHub
4. 填写 GitHub 仓库地址：`https://github.com/yuzikaaang/class-site`
5. 认证方式：用户名 + Personal Access Token（**GitHub 令牌见仓库内 `secrets.json.enc`，需密码解密**）
6. 开启自动同步（建议每次提交后自动同步）

> 由于 WorkBuddy 沙箱无法直连 GitHub，此镜像必须由用户在 Gitee 网页后台配置。

#### 开启 GitHub Pages（一次性）

1. 登录 GitHub，进入 `yuzikaaang/class-site` 仓库
2. Settings → Pages → Source
3. 选择 `master` 分支，`/(root)` 目录
4. 保存后获得备用链接：`https://yuzikaaang.github.io/class-site/`

> 仓库已设为公开，GitHub Pages 任何人可访问。

## 4. 分享链接

- **主链接（当前）**：`https://yuzikaaang.github.io/class-site/`
  - 由 Gitee→GitHub 镜像自动同步后触发更新；Gitee 与 GitHub 仓库均已公开，便于全班访问与查询
  - 强制刷新缓存：浏览器 `Ctrl/Cmd + F5`
- **应急备用链接（WorkBuddy，按需重新发布）**：主链接 `github.io` 国内偶尔不可达时，临时向 AI 申请重新发布获取新链接
  - 原常驻链接 `https://a5048c773a210b3d4-25579.app.workbuddy.link/`（及更早的 `a5048c773a210b3d4.app.workbuddy.link`）已于 2026-08-25 取消发布，已失效
  - 重新发布会在新沙箱会话生成新链接，不保证与历史链接一致

## 4.1 令牌管理（重要）

- 所有令牌（Gitee 账号/令牌、GitHub 账号/令牌）已加密存储在仓库根目录 `secrets.json.enc`
- 加密算法：AES-256-CBC + PBKDF2（迭代 200000），**密码由仓库维护者保管**
- **密码提示：6 位数字**（具体密码见 `secrets-hint.txt` 旁注，仅维护者知晓）
- **需要令牌时**：向 AI 提供密码，AI 执行 `./scripts/decrypt-secret.sh <密码>` 解密获取，不在对话中明文展示
- 更新令牌时：把明文写入 `secrets.json`，执行 `./scripts/encrypt-secret.sh <密码>` 生成新密文并自动删除明文
- 不要在 README、TUTORIAL、对话中明文暴露令牌

## 4.2 备份与导出（站内手动导出）

- 网站侧边栏底部内置「📦 导出备份」按钮：输入备份密码后下载完整版 `class-site-backup.zip`（含全部网站内容，用于本地留存 / 还原）。
- 备份密码仅以 SHA-256 哈希存储在 `index.html` 前端逻辑中，源码中无明文；**输入错误时页面会提示「站主高中绝对不会忘记的数字」**。
- **每次内容更新后**：维护者需重新生成 `class-site-backup.zip` 并随改动一起提交，保证导出文件与线上一致。
- 生成命令：`zip -r class-site-backup.zip . -x ".git/*" "backups/*" ".github/*" "*.log" "source/node_modules/*"`

## 5. 修改规范

### 5.1 改什么

- 只改根目录 `index.html` 的页面内容（增 / 删 / 改）
- 不动 `source/` 目录
- 需要新功能或大改时，先评估是否能在单文件 `index.html` 内完成

### 5.2 资源处理

- **图标类**：使用图床直链（由维护者上传到图床后提供）
  - 例如：`https://s41.ax1x.com/2026/08/25/pnpe3ff.png`
- **二维码类**：直接放到仓库根目录（图床审核可能不过）
  - 文件名：`qrcode.jpg`
  - 引用方式：`qrUrl: "qrcode.jpg"`（相对路径）

### 5.3 路径规范

为了同时兼容 WorkBuddy（根路径）和 GitHub Pages（`/class-site/` 子路径），所有本地资源统一使用**相对路径**：

```html
<link rel="manifest" href="./manifest.webmanifest">
<link rel="apple-touch-icon" href="./icon-192.png">
```

`manifest.webmanifest` 和 `sw.js` 内的路径也已统一改为相对路径，不要随意改回绝对路径。

## 6. 备份机制

### 6.1 站内手动导出（唯一备份方式）

- 网站侧边栏底部「📦 导出备份」按钮 → 输入备份密码 → 下载 `class-site-backup.zip`。
- 备份密码 备份口令 仅以 SHA-256 哈希存在前端，源码无明文（见 `EXPORT_PASS_HASH`）。
- **每次内容更新后必须重新生成 zip 并提交**（保证导出文件与线上一致）：
  ```bash
  zip -r class-site-backup.zip . -x ".git/*" "backups/*" ".github/*" "*.log" "source/node_modules/*"
  ```

### 6.2 版本还原

- 还原入口：仓库 git 历史（每次提交都有完整快照）+ `class-site-backup.zip`。
- 需要还原时，从 git 历史或 zip 恢复根目录文件即可。

## 7. 更新检查清单

每次修改后，确保：

- [ ] `index.html` 已按需求修改
- [ ] **站内班级公告已同步新增/修改一条**（`SITE_DATA.announcements`，新的放最上面）
- [ ] 图标链接有效（可打开）
- [ ] 二维码图片已放入仓库根目录（如需要）
- [ ] `manifest.webmanifest`、`sw.js` 路径未被误改
- [ ] `class-site-backup.zip` 已重新生成
- [ ] `README.md` 和 `TUTORIAL.md` 已同步更新
- [ ] 已提交并推送到 Gitee `master`
- [ ] Gitee → GitHub 镜像已同步（GitHub Pages 主链接已刷新）
- [ ] 主链接 GitHub Pages 在国内可访问（如已开启）

## 8. 常见问题

**Q：为什么 GitHub 同步不通过 WorkBuddy 直接做？**
A：WorkBuddy 沙箱无法直连 GitHub（TLS 被重置），因此使用 Gitee 官方镜像功能作为中转。

**Q：WorkBuddy 分享链接还能用吗？**
A：常驻的 WorkBuddy 链接已于 2026-08-25 取消发布。主链接改为 GitHub Pages（`https://yuzikaaang.github.io/class-site/`）。仅当主链接国内不可达时，才临时向维护者（AI）申请重新发布 WorkBuddy 链接作为应急入口。

**Q：source/ 目录还能用吗？**
A：不参与线上，仅作历史追溯。线上所有功能都在根目录 `index.html` 中实现。

## 9. 更新记录

| 日期 | 内容 |
|------|------|
| 2026-08-25 | 修复站内所有密码输入失效（`sha256Hex` 被重复定义覆盖 + 链接数据全部补全 id + `render()` 现在会保留当前分类视图，修复课堂笔记 / 教学课件 / 私人云盘 / 联系方式查询的门禁点击无反应和验证后整页空白问题）；作业查看卡片 Classworks 说明更正（校园网限制导致班级电脑端连不上服务器、无法同步云端），「前往 Classworks」入口排到第一位；点歌平台下方新增「服务器配置有限，没有立即跳转请耐心等待几秒」提示；SW 缓存升至 v3。 |
| 2026-08-25 | 主链接切换为 GitHub Pages（`https://yuzikaaang.github.io/class-site/`）；WorkBuddy 常驻分享链接取消发布，改为应急备用（主链接不可达时临时重新发布）；Gitee 与 GitHub 仓库均已公开。 |
| 2026-08-25 | 每日日报入口改为 `https://newsnow.czl.net/c/china`（不再自部署），简介同步更新；修复「全部重要日期」弹窗倒计时不走秒的问题（弹窗打开后每秒刷新）。 |
| 2026-08-25 | 令牌加密存储上线：`secrets.json.enc` + `scripts/encrypt-secret.sh` / `scripts/decrypt-secret.sh`，文档中不再出现明文令牌；本地工作副本清理。 |
| 2026-08-25 | 取消自动备份与每周打包（Gitee 个人版不支持定时任务），改为站内「📦 导出备份」：密码验证（SHA-256 哈希）后下载完整版 `class-site-backup.zip`；约定每次内容更新同步一条站内公告并更新 README。 |
| 2026-08-25 | 导出备份密码输入错误时提示「站主高中绝对不会忘记的数字」；新增 `secrets-hint.txt` 密码提示文件（令牌密码提示：6 位数字）；主链接决策待定：若 github.io 国内访问稳定则作为主链接并停用 WorkBuddy。 |
| 2026-08-25 | 修复每日日报卡片空白（链接条目缺失 `id:4` 导致首页日报区找不到数据）；公告时间统一精确到秒（`YYYY-MM-DD HH:MM:SS`）。 |
| 2026-08-25 | 修复日报卡片排版（`.daily-card` 设为 flex 横排占满）；修复首次输入正确密码仍报错的 bug（`submitSiteGate`/`findContact` 改 await 异步哈希，之前同步拿 Promise 导致永远比对失败）；密码显示切换按钮由 emoji 改为 SVG 图标。 |
| 2026-08-25 | **模型无关性**：TUTORIAL 顶部加「0. 模型无关性」声明，强调本仓库是唯一内容源、所有规则沉淀到仓库。公告改名为「公告」并按 `site/class/activity/misc` 四类分组（弹窗内分小节展示），置顶 `important:true` 始终置顶（新增 Classworks 网络限制置顶）。PWA `apple-touch-icon` 与 manifest 主图标升为 512。**学习资料板块新增「网络限制提示」弹窗**（进入分类时弹出，含「不再显示」复选框，localStorage 记忆 `cls_study_notice_dismissed`）。**作业查看卡片改造**（因 Classworks 校园网打不开）：去掉原 mainUrl，新增 `customActions`：`查看当前作业`（自动匹配今日所属作业段）+ `历史作业（日期）`（日历视图，含月份切换/日期点击/详情），`SITE_DATA.holidayHomeworks` 数据模型由维护者后续手动同步，平常小作业不收录。公告时间统一为「精确到分」。 |

