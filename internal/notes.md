# 25级05班班级服务站 - 内部维护文档

> **本文件是站主内部维护文档**，用于在对话卡顿时快速恢复上下文。每次修改流程或要求后，应及时更新本文件。
> **对外说明一律写 `README.md`**（只写介绍与用法），**本文件只写维护细节、站规、台账**，两者分工不得混淆（详见下方「铁律 · 文档分工」）。
> **本文件曾命名为 `TUTORIAL.md`**（2026-08-29 移至 `internal/notes.md` 以避人耳目），历史更新记录中出现的「TUTORIAL」旧称均指本文件。

## 0. 模型无关性（最重要）

**本仓库是唯一内容源**。任何 AI（DeepSeek / ChatGPT / Claude / Gemini / 任意模型 / 任意新对话）只要能访问 Gitee 仓库（用站主本地记忆的口令解密 `secrets.json.enc` 拿令牌），就能完整接手本项目，**无需依赖任何特定对话的记忆**。

请遵守：
- 所有内容、规则、偏好、决策都应**沉淀到本仓库**（本文件 `internal/notes.md` / 站内公告 / 源码注释 / `README.md`（对外介绍））
- 不要只在对话里口头约定一件事——必须同步写入仓库
- 用户提到新规则时，立即更新本文件对应章节 + 站内公告 + 必要时同步 `README.md`（**只同步值得对外展示的介绍性内容**）
- 每次结束前确认本次所有改动已 commit + push 到 Gitee
- **铁律 · 文档分工（2026-08-29 立）**：① `README.md` = **对外门面**，读者是普通同学 / 访客，只写「站点是什么、有什么功能、怎么用、在线地址」，**严禁写入**站规、内部实现、令牌/密钥机制、备份与发布口径、防刷逻辑、仓库运维细节；② 本文件 = **内部维护文档**，站规、台账、更新记录、实现细节全部写这里；③ README 中**不得出现**指向本文件的任何链接或路径。
- **铁律 · 内部文档隐藏（2026-08-29 立）**：本文件存放于 `internal/notes.md`（隐蔽路径 + 无辨识度文件名），并要求——① README 不给链接、目录结构里不列出；② **仓库内 `class-site-backup.zip` 必须排除 `internal/`**（否则站主下载备份包即可看到全文）；③ 线上发布包（备用站点 / Pages）一律排除；④ 源码注释中只写「见内部维护文档」，**不得写出文件名或路径**；⑤ 另需理解：仓库本身是公开的，**隐藏入口只是降低被偶然发现的概率，不是安全措施**——真正的敏感信息（令牌、口令）本来就**不入库**（见敏感信息红线）。
- **铁律 · 备用站点实时同步（2026-08-29 立）**：站主已授权——**每次站点内容更新并 push 后，无需再询问，直接重新发布 WorkBuddy 备用链接**，保证备用站与主链内容实时一致。发布口径：净化版（详见第 4 节）。主链 GitHub Pages 由 Gitee 镜像自动同步，本环境无法直连 GitHub。
- **铁律 · 两处同步**：任何内容改动都必须同步更新——① `index.html` 的站内公告（`SITE_DATA.announcements`，新条目放数组末尾、带 `date` 与 `category`）② 本文件「更新记录」表（第 9 节）。`README.md` **仅在有值得对外展示的内容时**才同步（如新增功能、地址变更），仓库/维护类改动**不动 README**。隐藏/彩蛋类不进公告，但仍需记入本文件。详见第 7 节检查清单。
> - **铁律 · 用户要求**：用户提出的**所有要求**必须逐条写入本文件「用户要求台账」（第 10 节）；每次改动前须核对台账、**不得违反或跳过任何已记录的用户要求**；若当前需求与过往要求矛盾，**必须向用户确认并同步更新规则**，不得擅自取舍；用户每次提出要求或需求变更后，**立即 commit + push 到 Gitee**。
> - **铁律 · 通读站规**：每次执行任务前，必须完整阅读**本文件**第 0 节全部铁律 + 第 10 节「用户要求台账」，逐项核对，确保不漏执行任何已记录要求（两处同步 / 隐藏不进公告 / 整站 zip 打包 / 备用站点实时同步等）。`README.md` 已改为对外介绍、**不含站规**，不要再去那里找规则。
> - **铁律 · 整站备份**：每次内容更新后，必须将整个站点（含 `index.html`、`games/`、`manifest.webmanifest`、`sw.js`、`secrets.json.enc` 等，排除 `.git`）重新打包为 `class-site-backup.zip` 并提交推送，确保站主每次下载到的都是最新完整版。**修改前先备份**：每次开始新修改前，先把「修改前」的当前状态打包为 `backup/class-site-backup-before-<时间戳>.zip` 留档（进 git，供回档）。
> - **铁律 · 敏感信息安全（红线）**：① **线上只上传密文**——仓库内**严禁**出现任何明文口令 / 密钥 / API Token / 加密提示；唯一允许提交的是 `secrets.json.enc`（AES-256-CBC + PBKDF2 密文）。② 解密口令**永不入库**：不得写入 `README` / `TUTORIAL` / 任何源码注释 / commit message / hint 文件；口令由维护者**本地记忆**，解密过程**仅在本地**完成。③ 加密脚本与提示文件**不入库**（`secrets-hint.txt`、`scripts/encrypt-secret.sh`、`scripts/decrypt-secret.sh` 等一律 `.gitignore` / 不跟踪）。④ 历史上若发生过口令 / 密钥明文入库事故，必须：a) 立即**轮换被暴露的密钥**（旧密钥视为已泄露）；b) **改写 Git 历史**将明文从所有 commit 中抹除并 force-push；c) 在 TUTORIAL 更新记录中留档事故与处置。⑤ 提交前自检：`git grep` 搜索口令、token、key、hint、password 等关键词必须为空。
> - **铁律 · 公告规范**：站内公告须**简洁、凝练、官方口吻**；除「站主杂谈」与「用户要求」类外不得出现「你 / 我 / 我们」等主观语气词；**只发用户可见的站点功能，仓库 / 维护内容（站规、zip 打包、README / TUTORIAL 更新说明等）一律不进公告**；分点公告每条之间**必须换行**（text 内用 `\n`，CSS `white-space:pre-line` 渲染）。

### 0.1 执行前必读 · 操作清单（化解模型差异）

> 目的：任何 AI 模型（DeepSeek / 轻量模型 / 任意新对话）执行本站任务时，可能因模型能力差异漏步骤（如忘记同步 zip、漏三处同步、该进公告的没进、仓库内容误进公告）。**无论用什么模型，每次执行前必须完整读完本清单并按序执行，不得凭记忆或摘要省略。**

1. **读**：完整阅读**本文件**第 0 节全部铁律 + 第 10 节「用户要求台账」+ 本清单（`README.md` 为对外介绍，不含站规）。
2. **扫**：扫描用户本次消息，找出所有要求 / 印象要求（含「如果 / 以后 / 比如」等词）→ 新要求先记入第 10 节台账。
3. **判**：判断改动性质——用户可见站点功能 → 可发公告（按公告规范）；仓库 / 维护 / 隐藏内容 → **不进公告**，只记本文件；公告分点 → 每条用 `\n` 换行。
4. **改**：完成功能改动；确认 token 不明文、`manifest.webmanifest` / `sw.js` 路径未被误改；`README.md` 是否被误写内部细节。
5. **同步**：① `index.html` 公告（如适用）② 本文件「更新记录」③ `README.md`（**仅限有对外价值的内容，否则不动**）。
6. **打包**：重打包 `class-site-backup.zip`（排除 `.git` / `backup/` / **`internal/`**）。
7. **提交**：`git add` 全部改动文件 → commit → push 到 Gitee。
8. **发布**：push 后**直接重新发布 WorkBuddy 备用链接**（已授权，无需再问），并核对发布包为净化版。
9. **回显**：回复中逐项勾选本清单（读 / 扫 / 判 / 改 / 同步 / 打包 / 提交 / 发布），确保无遗漏。
> - **铁律 · 印象要求识别**：用户对话中出现的**印象要求**（尤其含「如果 / 以后 / 比如」等条件或举例词）一律视为正式要求，即便未明说「记到 Gitee」也必须按「用户要求」铁律写入台账并同步推送；每次回复前先扫描当前消息是否含新要求。
> - **铁律 · 公告分点**：单次更新若含**多条内容**，站内公告须用编号分点（1. 2. 3. …）逐条列出，便于查看；仅单条内容仍用一句话。

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
├── README.md               # 对外介绍（面向访客，不写维护细节）
└── internal/notes.md       # 本文件：内部维护文档（隐蔽存放，不对外链接）
```

**注意**：线上实际只使用根目录的静态文件，`source/` 目录不再构建。
**注意**：`internal/` 目录**不得**进入 `class-site-backup.zip` 与任何线上发布包（避免内部文档被下载）。

## 3. 工作流（双仓库 + 双平台）

### 3.1 主仓库（Gitee）

- 仓库地址：`https://gitee.com/zikang0529/class-site`
- 用途：主要编辑与版本管理
- 操作：所有内容改动先在本地完成，再推送到 Gitee `master` 分支
- **⚠️ 推送凭据用 SSH，禁止把令牌写进 remote URL**（2026-08-29 改）：
  - remote 现为 `git@gitee.com:zikang0529/class-site.git`（原为 `https://zikang0529:<令牌>@gitee.com/...`，`.git/config` 里有明文令牌）
  - 配置：ed25519 密钥 `~/.ssh/id_ed25519_gitee` + `~/.ssh/config`（`Host gitee.com` / `User git` / `IdentityFile` / `IdentitiesOnly yes`）+ `known_hosts` 预置指纹；公钥经 Gitee API 加为账号级公钥（title `class-site-sandbox-20260829`）
  - 换环境时：若没有该私钥，重新生成并添加公钥，或改用 `credential.helper store`；**不要**再把令牌拼进 URL
  - 该 access token 曾以明文出现在 remote URL 中，**建议到 Gitee 设置里轮换一次**

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
- **应急备用链接（WorkBuddy，2026-08-29 重新上线）**：`https://a5048c773a210b3d4-25579.app.workbuddy.link/`
  - 已写入 `SITE_DATA.siteLinks`（label「备用链接」），侧边栏「🔗 复制链接」可复制；**微信内打不开**，需复制到系统浏览器
  - **⚠️ WAF 坑**：该域名前置腾讯云 WAF，**按后缀封禁 `.zip`**（不存在的文件也 403），备份包必须额外提供无扩展名副本 `class-site-backup`，由 `downloadBackup()` 回退获取（详见 4.2）
  - 发布方式：准备发布目录（含 `index.html`/`games/` 等 + 净化版备份包两份），执行 `node /root/.codebuddy/skills/发布为应用/scripts/publish.js --dir <发布目录绝对路径> --language static`
  - 沙箱会话结束后链接可能失效，届时按需重新发布；链接若变化需同步 `SITE_DATA.siteLinks` + 站内公告 + README + 本文件

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
- 生成命令（仓库完整版，铁律）：`zip -rq class-site-backup.zip . -x ".git/*" "backup/*"`
- **下载实现 `downloadBackup()`（2026-08-29 改）**：不再直接 `location.href`，而是 fetch 依次尝试 `./class-site-backup.zip` → `./class-site-backup`（无扩展名副本），命中后用 blob + `a[download]` 保存，文件名统一 `class-site-backup.zip`。
  - **为什么**：WorkBuddy 备用域名前置的腾讯云 WAF **按后缀封禁 `.zip`**（实测 `/nonexistent-xyz.zip` 也 403，与 UA/Referer/HEAD 无关），主链 `github.io` 无此限制。
  - **发布时必须同时放两份**（`.zip` + 无扩展名），否则备用站点下载会失败。
  - 判定失败的条件：`!r.ok`（403/404）或 `content-type` 含 `text/html`（WAF 返回的是 HTML 拦截页）；全部失败且非 `file://` → 提示「备份包下载失败，请稍后重试或联系站主」；`file://` 场景回退直接跳转（fetch 在 file 协议下不可用）。

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

### 5.4 点歌券（贪吃蛇奖励）

**链路**：贪吃蛇吃豆数达到 `REWARD_DOTS`（100）→ `games/snake.html` 前端调用 VoiceHub 开放 API 创建一张券 → 弹窗展示券码 → 同学复制券码去点歌平台点歌时输入 → VoiceHub 原生校验并核销（一张券只能用一次）。

**触发与难度**：
- `REWARD_DOTS = 60`（吃豆数 = 得分 sc，吃到第 60 个豆发券）
- **渐进加速**：`SPEED_BASE=175`ms/步起，每吃 10 个豆提速 10ms（`SPEED_STEP`/`SPEED_STEP_MS`），最快 `SPEED_MIN=80`ms。曲线：0 豆 175 → 50 豆 125 → 60 豆 80。
- 控制：**屏幕虚拟方向键**（`.dpad-btn`，点击/触摸）替代了触摸滑动；键盘方向键仍可用。画布点击用于游戏结束后重开。
- 只改 `games/snake.html` 顶部 `REWARD_DOTS` 及相关速度常量即可调难度。

**其他活动复用点歌券**：后续任何活动（其他小游戏、班级活动等）想发点歌券，走同一套接口即可——前端复制 `games/snake.html` 里的 `claimCoupon()` + `VOICEHUB_COUPON` + `_cpnDec()` 三个部分（注意沿用混淆密文，不要明文放 key），达标时调用 `claimCoupon(score,dur,function(res){ if(res.ok) 展示 res.code })`。

**关键配置（`games/snake.html` 顶部 `VOICEHUB_COUPON`）**：
- `enabled: true`（发券开关）
- `url: https://xsyzc2505.dpdns.org/api/open/card-codes`
- `token: _cpnDec()`——**不明文存储**！完整 key 加密在 `secrets.json.enc` 的 `voicehub.key` 字段（密码见 `secrets-hint.txt`），前端只存混淆密文 `_CPN_ENC`（xor+hex），运行时 `_cpnDec()` 解密。
- 认证请求头 `x-api-key`；创建参数 `{count:1, prefix:'SONG', length:8, note}`，券码取响应 `data.cardCodes[0].code`

**⚠️ 令牌不明文铁律（用户规则，2026-08-26 起生效）**：所有 API Key / 令牌**不得明文进仓库**（Gitee/GitHub 公开）。做法：
1. 明文权威版本只存 `secrets.json.enc`（`./scripts/decrypt-secret.sh <密码>` 查看，`<密码>` 为 6 位数字）
2. 前端必须使用的令牌 → 用 xor+hex 混淆后嵌入（生成方法：`python3` 对 key 逐字符与 `_CPN_MASK` 异或转 hex，替换 `_CPN_ENC`；`_CPN_MASK` 可自行更换）
3. 换 key 步骤：① 更新 `secrets.json` 的 `voicehub.key` 并重新加密 ② 重新生成 `_CPN_ENC` 替换 snake.html ③ 若更换了 `_CPN_MASK` 同步替换
4. 认识局限：纯前端混淆防不了专业逆向（F12 下断点仍可解出），目的是"仓库不明码"，不是密码学防护。涉钱/涉权限高的令牌严禁放前端。

**VoiceHub 侧配套**（必须保持）：
- 仓库 `server/middleware/api-0-open-cors.ts`：开放 `/api/open/*` 跨域（白名单 `https://yuzikaaang.github.io` 等）。**文件名以 `api-0-` 开头**，保证在 `api-auth.ts` 之前执行，否则浏览器预检会被 401 拦截。删除该文件则前端发券失效。
- 上游同步（Sync fork / merge）不受影响：这是纯新增文件，不碰上游任何已有文件。

**手动验证命令**（KEY 从 `secrets.json.enc` 解密获取，勿明文写入命令历史可先用变量）：
```bash
# 创建 1 张测试券
curl -X POST https://xsyzc2505.dpdns.org/api/open/card-codes \
  -H "x-api-key: <KEY>" -H "Content-Type: application/json" \
  -d '{"count":1,"prefix":"TEST","length":8,"note":"测试"}'
# 核销（按 id）
curl -X PATCH https://xsyzc2505.dpdns.org/api/open/card-codes \
  -H "x-api-key: <KEY>" -H "Content-Type: application/json" \
  -d '{"ids":[<ID>],"status":"REDEEMED"}'
```

**防刷现状（务必知情）**：前端仅做「本地每天限领 1 张」（localStorage，清缓存可绕过）。VoiceHub 侧无按人限领，理论上可反复创建券。已通过 VoiceHub 自带的 API 访问日志 + IP 限流机制兜底，但做不到绝对防刷。若后续需要更强限制，可考虑在 VoiceHub 侧加限领逻辑或换中转。

### 5.5 密码错误自锁（全站统一）

**规则（用户定，2026-08-26）**：所有密码/暗号入口连续输错 **超过 3 次锁定 30s**，此后每次再错递增（1 / 2 / 5 / 10 / 30 / 60 分钟封顶），**输对一次清零**。状态存 localStorage，**刷新 / 退出重进依然锁定**。

**实现**：`index.html` 顶部 `LOCK_LEVELS = [0,0,0,0,30,60,120,300,600,1200,3600]`（下标=累计失败次数）。工具函数：`onPassFail(scope)` / `onPassOk(scope)` / `lockRemain(scope)` / `startLockTimer(scope,errEl,inputEl)`（倒计时+禁用输入框，到点自动恢复）。

**接入的入口（scope）**：
| 入口 | scope | 备注 |
|---|---|---|
| 站点入口问答 | `site` | `submitSiteGate()` |
| 资源门禁（课堂笔记等） | `gate_<链接id>` | `checkGate(id)`；锁定期间 render 会禁用输入框 |
| 导出备份 | `export` | `submitExport()` |
| 隐藏娱乐暗号 | `hidden` | `submitHiddenGate()` |

**新增入口接入方法**：失败时调 `onPassFail(scope)`（返回 `{count, remain}`），`remain>0` 时调 `startLockTimer(scope, 错误元素, 输入框)`；成功调 `onPassOk(scope)`。
**⚠️ 已知坑**：读取锁定时 `until` 字段**不能用 `|0` 位运算**（毫秒时间戳会溢出成错误值导致锁定失效），已修复为 `typeof d.until==='number'`。

### 5.6 内置小游戏与全站音效

**隐藏娱乐天地**（班徽 5 连击进入，暗号答案 47）现共 **17 个入口**：外链 5 个（云智安/小霸王/2048/4399/7k7k）+ 内置游戏 12 个（`games/`）。内置游戏均单文件、纯 HTML+CSS+JS、深色主题、移动端自适应、含 Web Audio 音效与本地记录（localStorage）：
- `snake.html` 贪吃蛇（吃豆 60 可赢点歌券，见 5.4）
- `tetris.html` 俄罗斯方块 · `whack.html` 打地鼠 · `memory.html` 记忆翻牌
- `bird.html` 像素飞鸟 · `breakout.html` 打砖块 · `match3.html` 消消乐
- `minesweeper.html` 扫雷（**难度可调**：简单 9×9/10、中等 12×12/24、困难 16×16/60、自定义雷数；移动端长按标旗）
- `doodle.html` 涂鸦跳跃（按住屏幕左右半边移动）
- `gomoku.html` 五子棋（**AI 三档**：简单=随机 / 普通=一步贪心 / 困难=negamax 深度2；**可切本地双人**；悔棋；胜负数记录）
- `chess.html` 中国象棋（**完整走法规则**：九宫/蹩马腿/塞象眼/炮隔子/兵过河；**仅本地双人**（已移除 AI）；可悔棋；棋子画在格线交叉点上，含传统炮位/兵位角标装饰）
- `plane.html` 飞机大战（纵版射击，**慢节奏生成**——初始约 1.5s/架，随分数每得 50 分加速一档、最快约 0.6s/架；本地最高分）

> ⚠️ 注意：五子棋/象棋的 AI 评估必须用**正确视角的 negamax**（`evalBoard` 返回白/黑优符号，AI 落子后取 `-negamax(对手)`），否则 AI 会因符号相反而不落子或乱走——曾踩过这个坑（困难档 best 恒为 null）。

**新增小游戏方法**：把新文件放进 `games/`，在 `index.html` 的 `HIDDEN_FUN_LINKS` 数组加一行 `{icon, title, desc, url:'games/xxx.html'}` 即可。

**全站音效**：`index.html` 顶部 `SFX` 对象（Web Audio 合成，无音频文件）。音效集：`click`（全局交互元素自动播放）/ `pop` / `success` / `error` / `fanfare`。全局轻点击音效通过 `document.addEventListener('click', ..., true)` 委托监听（`button/a/.card/.fab/.tab-btn/.daily-btn/.signbar-btn/.side-btn` 等）。特定事件已接入：抽班级签 `success`、彩带彩蛋 `fanfare`、四个密码入口对错 `success/error`。
- 开关：侧边栏「🔔 音效」按钮（`toggleSfx()`），状态存 `localStorage.cls_sfx`（`on`/`off`），默认开。
- 接入新音效：在目标函数里调 `SFX.xxx()`。音量均在 0.02~0.05，注意克制，避免打扰。

## 6. 备份机制

### 6.1 站内手动导出（唯一备份方式）

- 网站侧边栏底部「📦 导出备份」按钮 → 输入备份密码 → 下载 `class-site-backup.zip`。
- 备份密码仅以 SHA-256 哈希存在前端（见 `EXPORT_PASS_HASH`），明文口令不入库。
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
- [ ] `class-site-backup.zip` 已重新生成（**已排除 `internal/`**）
- [ ] 本文件（`internal/notes.md`）「更新记录」已同步
- [ ] `README.md` 仅当有对外价值的内容时才同步，且**未写入内部细节、未链接本文件**
- [ ] 已提交并推送到 Gitee `master`
- [ ] **WorkBuddy 备用链接已重新发布**（实时同步，无需询问）
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
| 2026-08-30 | 🎲 **歌单管理「已播放 / 已排期」默认排除 + 公示备注可自定义（用户可见，已发公告）**：① **需求 1（用户原话「在歌单管理列表已播放和已排期的默认排除不要我点」）**——此前「排除已播放 / 排除已排期」只作用于**抽签那一刻的过滤**，歌单管理列表里这些歌仍显示为正常可勾选状态，用户得一首首手动点。**现改为列表里也自动排除**：新增 `djAutoExclude()` / `djAutoExReason(s,info)`（放在 `djSaveRounds` 之后），**每次实时从本地排期历史算出，不写进 localStorage**——与手动排除（`cls_dj_excluded` / `cls_dj_excluded_req`）的区别是：排期清空或标记取消后这首歌**自动恢复可抽**，点「清空排除」也**不会误伤**它。被自动排除的行：标题划线 + 行尾标 **`🚫 已播放` / `🚫 已排期`**（不给勾选框，带 title 说明如何恢复），**判定顺序：已播放优先于已排期**（同首歌两个条件都满足时显示「已播放」）。按点歌人视图同步显示「· 自动排除 N」；状态栏改为「共 X 首 · 手动排除 A 首 / B 人 · 已播放或已排期 C 首（默认排除，不用手动点）」。**是否生效仍受面板两个开关控制**（默认都开），开关加了 `onchange="renderDjSongs(_djSongsCache)"`，改开关列表实时变。**顺手重构**：`djRun()` 里原来那段 `rounds` 遍历删掉，改调 `djAutoExclude()`，抽签与列表共用同一套判定，避免两处逻辑漂移。**⚠️ 踩坑（差点漏）**：删了 `var rounds = djLoadRounds()...` 后，djRun 末尾保存批次处的 `rounds.push(...)` 变成未定义变量，抽签直接报 `拉取失败：rounds is not defined`（**测试里靠打印抽签结果文本才发现**——只断言「不含被排除的歌」会**假阳性通过**，因为压根没抽成）。已在保存处补 `var rounds = djLoadRounds();`。**教训：删变量声明前先 grep 该变量在函数内的所有引用。**② **需求 2（用户原话「公示时间不要展示了，最后加上备注……也可以让我手动再加备注」）**——`djCopy()` 去掉 `公示时间：` 行（`抽取时间` 保留），备注统一挪到最后；新增「公示备注」输入框 `#djCopyNote`（textarea，placeholder「例如：本次点歌不随机抽人，是对段考前十的奖励」），默认由 `djDefaultNote()` **按当前开关自动生成**：`规则：每人限一首；已播放的不再抽；已排期的不重复上。`（关掉哪个开关就不显示哪条，全关则为空；开了「高赞必选 N」会追加「点赞最高的 N 首必选」）。用户改过就存 `cls_dj_copy_note` 下次沿用，旁边「↺ 默认」按钮（`djResetCopyNote()`）清记忆并恢复规则文案。**备注合并规则**：批次备注（历史记录里填的 `last.note`）与公示备注**合并成一行**放最后：`备注：<批次备注> <公示备注>`。③ **顺带修一个漏网的按钮**：把「抽歌面板 / 歌单管理」加进全站对比度扫描视图后（采样 507 → **591**），扫出 `.btn-green`（**微信绿 `#07c160`**）白字仅 **2.38:1**——用于「📋 一键复制公示」「查看公众号」「仅这次切换」。改为 **`#0a7d42`（5.22:1）**，hover `#06ad56`→**`#09703c`（6.18:1）**。**注**：`#07c160` 在别处是**文字色**（倒计时天数、qr-head 标题）和**渐变背景**（allhol-head），那些不受影响，只改了 `.btn-green` 这个白字按钮底。改完全站 **591 个文字元素、亮暗双模式 0 项不达标** ✅。④ **另补一条暗色兜底 CSS**：`.dark .dj-ex-tag{color:#ffb08a!important}`——原有规则只写了 `.dark #djSongsMask .dj-ex-tag`，覆盖不到新增的抽歌面板「↺ 默认」按钮；歌单管理说明里的强调文字也从写死 `#c2410c`（暗色 3.02:1）改为 `.dj-ex-tag`。⑤ **测试**：新增 `test_dj_auto_exclude_and_note.py` **38 项全过**（列表自动排除标签 / 不给勾选框 / 不写进 localStorage / 关开关后恢复 / 按人视图计数 / 状态栏文案 / 抽签侧排除回归 / 公示无「公示时间」/ 备注在最后 / 默认文案 / 手动覆盖 / 持久化 / ↺ 默认 / 批次备注合并）；回归 `test_dj_filter.py` 32 项、`test_dj_offline_tip.py` 20 项、全站扫描 591 元素均通过。**旧测试同步**：`test_dj_filter.py` 里状态栏断言由「1 位点歌人」改为「/ 1 人」+「不用手动点」（措辞更新）。已做修改前备份 `backup/class-site-backup-before-20260830-1839.zip`；已重打包 `class-site-backup.zip`；已重新发布备用链接。 |
| 2026-08-30 | 🎨 **按钮配色全站达标 + 抽歌面板 CORS 降级提示（用户可见）**：① **按钮配色（用户拍板「按钮那个可以改」）**——上一轮扫描剩的 9 类不达标全是「品牌色底 + 白字」，本轮全部调到 AA：主品牌蓝 `#4a6cf7` → **`#3f5fe6`**（白字 **4.39 → 5.26:1**，加深 3 个色阶，视觉几乎无差），**29 处全改**（`.btn` / `.side-btn.active` / `.tab-btn.active` / `.filter-btn.active` / header 与卡片渐变起点 / 页头 / 日历高亮 / spinner / 焦点边框等），**保持全站色调一致**；绿色按钮 `#059669` → **`#047857`**（白字 3.77 → **5.48:1**；倒计时数字落 `#f8fafc` 3.60 → **5.24:1**）；暗色绿按钮 `#10b981` → `#047857`（2.54 → **5.48:1**）；签到条与紫按钮 `#7c83ff` → **`#574fd6`**（白字 3.21 → **6.01:1**），**彩带 `CONFETTI_COLORS` 里的 `#7c83ff` 保留不动**（那是图形不是文字，WCAG 不适用）；禁用态 `.btn-disabled`（「敬请期待」）——亮色白字 1.57:1 → 改 **`#475569` 深蓝灰字（4.84:1）**，**暗色下原本 `background:#475569` + 白字本就 7.58:1 达标**，若照搬亮色的深字会变成「深字落深底 1.00:1」撞色，故 `.dark .btn-disabled` 显式补 `color:#fff`。**改完全站扫描 507 个文字元素、亮暗双模式 0 项不达标** ✅。② **抽歌面板 CORS 降级提示（用户要求「CORS 先不改，先在这个页面显示让他去主链接抽」）**——备用域名未进点歌平台白名单时，备用站上抽签 / 歌单管理 / 点歌券全部 `Failed to fetch`，此前**用户只看到一句看不懂的报错**。现于抽歌面板顶部加 `#djOfflineTip`（默认 `display:none`，`.dj-offline-tip` 类控制）：**⚠️ 当前站点连不上点歌平台** + 说明「本站是备用链接，点歌平台还没给它开放跨域权限……请到主链接操作，数据同一份」+ **「🔗 前往主链接抽歌」按钮**。**实现要点（重要）**：**不判断当前域名，只认「请求失败」这个事实**——在 `djFetchSongs()` 的 promise 链尾统一挂 `.then(djMarkApiUp)` / `.catch(djMarkApiDown)`，因此**所有调用点（抽签 `djRun` / 歌单管理 `djOpenSongs` / 券管理）自动生效**；`openDjPanel()` 里加 `djProbeApi()` **打开面板即静默探测一次**，用户不用点了「开始抽签」才看到失败。**等你把备用域名加进白名单后，提示会自动消失，不用回来改代码**；反过来主链若哪天 API 挂了也会同样提示。按钮走 `djGoMain()`：从 `SITE_DATA.siteLinks` 取第一条（不硬编码），**同 host 走 `location.href` 同标签跳、不同 host 走 `window.open` 新标签**。③ **测试**：新增 `test_dj_offline_tip.py` **20 项全过**——API 不可达时提示自动显示 / 文案正确 / 抽签与歌单管理失败后提示仍在 / 点按钮取到主链接 URL / 非同源判定走新标签；API 正常时提示不显示且抽签正常出结果；提示条亮暗双模式对比度全达标（亮 4.82 / 5.01 / 5.26，暗 9.05 / 6.57 / 5.26）。回归 `test_dj_filter.py` 31 项、`test_contrast_dual.py` 26 项、全站扫描 507 元素均通过，无 JS 异常。④ **回档点说明**：本轮未单独打「修改前」包——**改动前状态即 `backup/class-site-backup-before-20260830-175414.zip`**（该包打包后我才动手改按钮色与降级提示），git 上前一版为 `ae551a1`，两者均可回档。已重打包 `class-site-backup.zip` 并重新发布备用链接。 |
| 2026-08-30 | 🎨 **全站亮色低对比度清理 + 全站对比度自动扫描器（仓库/样式，不进公告）**：① **起因**——上一条里修完歌单管理后台后自查发现，本次新加的「每人限一首」说明文字用的是 `#9aa7b8`（亮色落白底 **2.44:1**），自己就违反了当天刚立的新站规。② **顺手全站排雷**——`grep -c "#9aa7b8"` 共 **20+ 处**（首页卡片副标题、作业日历空态、日历星期表头、「敬请期待」占位、公告搜索空态、点歌券备注/空态、密码框眼睛图标等），**亮色下全部只有 2.44:1**。根因：该色值原本是**为暗色底设计的**，`.dark [style*="color:#9aa7b8"]` 只在暗色下把它翻成 `--fg-3`，亮色下没有任何兜底，于是写死的地方在白天模式全部发灰看不清。③ **修法**——**一条全局 CSS 兜底**替代逐处修改：`[style*="color:#9aa7b8"],[style*="color: #9aa7b8"]{color:var(--fg-3)}`（`#7a869a` 同），放在暗色区块**之前**、不带 `!important`，因此暗色下仍由既有的 `.dark` 规则接管，两模式互为对称。另修 3 处类选择器：`.card-sub`（首页卡片副标题）→ `var(--fg-3)`；`.dark .card-sub` 原 `#64748b` 落 `#1b2432` 仅 **3.28:1** → `var(--fg-3)`；`.eye-btn`（密码框眼睛图标）→ `var(--fg-3)`。以及 `.pwd-ime-tip`（输入法提示）亮色 `#9db1ff` **2.07:1** → `#3b5bfd`（**5.12:1**），并**去掉 `opacity:.9`**（半透明会把实际对比度从 5.12 拉低到 4.33，卡在门槛下）。④ **新增全站自动扫描器 `scan_contrast_all.py`**（脚本在会话沙箱 `/root/.codebuddy/artifact/`，不入库）：亮/暗 2 模式 × 首页 + 7 个分类 + 复制链接/数据管理/导出备份 = **22 个视图**，遍历**所有可见文字叶子元素**，取 `getComputedStyle().color` + **逐级合成半透明背景**得到有效背景，按 WCAG AA 判定并去重输出。**踩坑**：若祖先链上出现 **CSS 渐变**（`background-image` 含 `gradient`），`backgroundColor` 是 transparent、会被误判成白底，产生大量假阳性（页头白字、`.cd-viewall`、`.board-count` 等都中招）——**遇到渐变即跳过该元素**，扫描器才可信。⑤ **结果**——累计采样 **507 个文字元素**，**正文 / 次要信息类 0 项不达标** ✅；剩余 **9 类不达标全部是「按钮配色」**（品牌色底 + 白字），属设计选择，已列给用户定夺：主按钮 `#4a6cf7` 白字 **4.39:1**（差 0.11，加深到 `#3f5fe6` 即 5.26:1）、绿色按钮 `#10b981` 白字 **2.54~3.77:1**、签到条 `#7c83ff` 白字 **3.21:1**、禁用态 `.btn-disabled` `#c3d0df` 白字 **1.57:1**（禁用控件 WCAG 本就豁免）。⑥ **回归**——`test_contrast_dual.py` 26 项定点采样全过（暗色最低 5.12、亮色最紧「清空排除」4.60）；`test_dj_filter.py` 31 项功能断言全过、无 JS 报错。⑦ 已做修改前备份 `backup/class-site-backup-before-20260830-175414.zip`；已重打包 `class-site-backup.zip`；已重新发布备用链接。 |
| 2026-08-30 | 🔧 **抽歌「排除已排期」真修复 + 双模式对比度达标 + 两条新站规（用户可见，已发公告）**：① **「排除已排期」形同虚设（用户反馈「按钮是对的但是后台没有修改」）**——根因：`djRun()` 里 `if(r.addedToPlatform) schedIds[s.id]=1;`，**只有被手动勾选「已排期（已加到平台）」的批次才计入**，而新抽签生成的记录默认 `addedToPlatform:false`（历史记录弹窗里那个勾选框是另一个语义：是否已推送到点歌平台），导致该开关勾选后**刚抽中过的歌照样会被再抽到**。修复：去掉条件改为 `schedIds[s.id]=1;`——**只要抽中过就进了本地排期，即算已排期**。② **三个开关默认全开**——按用户要求「已排期或已播放的默认排除」：`#djExcludePlayed`（原本已 checked）+ `#djExcludeSched`（**本次改为 checked**）+ `#djOnePer`（上一轮已 checked）；`#djExcludeSched` 补 `title="本地排期列表里已有的歌不再重复抽中"`。③ **双模式对比度修复（用户反馈「备注下方的字在日常模式下看不清」）**——实测：亮色元信息行 `#9aa7b8` 落白底 **2.44:1** ❌、暗色排除标记 `#c2410c` 落 `#1b2432` **3.02:1** ❌。修法：新增 `.dj-song-meta{color:var(--fg-3)}`（亮 `#5f6b80` / 暗 `#9aa7b8` 自动适配，不再写死）与 `.dj-ex-tag`（亮 `#c2410c` / `.dark` 下 `#ffb08a`），替换 7 处 inline 色值（歌曲序号 / 标题排除态 / 元信息行 / 「👤 已排除」标记 / 分组人名 / 分组歌曲数 / 「清空排除」按钮）；暗色规则放在第 510 行 `.dark .dj-song-title` 之后，并写成 `.dark #djSongsMask .dj-song-title.dj-ex-tag` 提高特异性以压过既有 `!important`。**新增自动化自检**（`test_contrast_dual.py`）：亮/暗两模式 × 按歌曲/按点歌人两视图，共 **24 项采样全部达 AA**（亮色最紧两项：「清空排除」按钮 4.60、Tab 未激活 4.55；暗色最低 5.12）。④ **两条新站规入台账**——【主链 + 备用链接实时同步】（升级原「备用站点实时同步」，并写明**主链 GitHub 本环境未登录、无法自动推送，必须每次提醒用户手动同步**，除非用户提供 PAT/ssh）；【亮色 / 暗色双模式可读性】（AA 门槛 + 色值约定 + `var(--fg-3)` 与 `.dj-ex-tag` 的正确用法 + 既有 `.dark [style*=]` 覆盖机制的局限 + 自动化验证方法）。⑤ **回归**：`test_dj_filter.py` 扩到 **31 项全过**（因「排除已排期」改默认开启，原用例连抽会互相干扰，已给抽签辅助函数加 `keep` 参数区分「独立抽签」与「连续抽签」），新增 T11 三开关默认态 / T12 连抽两次零重复（核心修复）/ T13 关掉开关后允许重复抽到。无 JS 报错。未另发公告（沿用当日 16:05 那条规则升级公告，本次为其修复补充）。⑥ **【重要运维发现】点歌平台 API 的 CORS 白名单是硬编码的（不在环境变量里）**——备用链接上抽歌/券管理全部 `Failed to fetch` (`Access to fetch ... has been blocked by CORS policy: Response to preflight`)。排查结论：线上跑的是**用户自己的 fork 仓库 `yuzikaaang/VoiceHub`**（**不是**上游 `laoshuikaixue/VoiceHub`、**也不是** `hzhbrother/VoiceHub1`，后两者 main 分支都没有 `/api/open` 的 CORS 逻辑），文件 `server/middleware/api-0-open-cors.ts`（commit `2ac7ef8`「Add CORS middleware for open API endpoints」，2026-08-25 新增，仅此一个提交），白名单是源码里**硬编码的 `ALLOWED_ORIGINS` Set**：`https://yuzikaaang.github.io`（主链）、`https://zikang0529.gitee.io`（Gitee Pages）、`http://localhost:8899`、`http://127.0.0.1:8899`（本地测试）。**没有环境变量可配**，也不是 h3 `handleCORS`、不是 `routeRules.cors`。**匹配规则（实测确认）**：精确字符串匹配，**区分协议 + 主机 + 端口，末尾不能带斜杠**——`http://localhost:3000` 被拒（只有 8899 在名单）、`https://random-xyz.github.io` 被拒（非通配）、`https://yuzikaaang.github.io/`（带尾斜杠）也被拒。**加新域名的方法**：改 `server/middleware/api-0-open-cors.ts` 的 Set，新增一行（如 `'https://a5048c773a210b3d4-25579.app.workbuddy.link'`）→ 提交到 main → Vercel 自动重新部署；Vercel 面板**不需要**配任何环境变量。**注**：中间件对 OPTIONS 无条件返回 204，所以不在白名单时表现为「204 但无 CORS 头」，浏览器侧看到的是 preflight 失败。备用链未加入白名前，其上所有调 API 的功能（抽歌 / 歌单管理 / 点歌券管理 / 4 个游戏发券）均不可用——**主链不受影响**。已做修改前备份 `backup/class-site-backup-before-20260830-153450.zip`；已重打包 `class-site-backup.zip`。 |
| 2026-08-30 | 🎲 **点歌抽签：按点歌人排除 + 每人限一首 + 歌单管理双视图（用户可见，已发公告）**：① **需求**——用户原话「点歌随机歌单能不能筛选不抽取一首歌或者说不抽取哪一个人点的歌？还有就是每次抽取时每个人的歌只能上一次，不可能一个人点的歌同时上到了这个歌单」。其中「排除某一首歌」此前已实现（`cls_dj_excluded`），本次补齐另外两项并顺手把歌单管理做成可用形态。② **新增 `djReqName(s)`**——统一取点歌人（`requester` 可能是 string 也可能是 `{name}`），`trim()` 后返回，空串代表「未填写点歌人」；全站原本多处重复的 `typeof s.requester==='string'?...:...` 三元统一收敛到该函数。③ **按点歌人排除**——新增 `cls_dj_excluded_req`（姓名数组）+ `djGetExcludedReq()` / `djSetExcludedReq()`；`djRun()` 过滤池时 `if(rq && exReq[rq]) return false;`。④ **每人限一首（核心）**——面板新增 `#djOnePer`（**默认勾选**）；`djRun()` 改为 `usedId` + `usedReq` 双占用表，`take(s)` 同时校验；高赞必选阶段按点赞降序遍历，撞车即顺延并累计 `deferred` 计数用于提示；随机阶段 `bag` 先剔除已占用点歌人的全部歌，每中一首再反向清理 `bag` 里同一人的其它歌。**容量诊断**：`cap = personCnt + anonCnt`（不同点歌人数 + 无点歌人信息的歌数），抽取数超过 `cap` 时自动收敛并说明「受『每人限一首』限制：本次池中 X 位点歌人 + Y 首无点歌人信息，最多只能抽 Z 首」。顺延提示改为按 `deferred` 计数（此前只在数量不足时提示，实际补足了名额却不提示，用户看不到「为什么这首高赞没上」）。⑤ **歌单管理弹窗重构**——新增「🎵 按歌曲 / 👤 按点歌人」双 Tab（`_djSongsView` + `djSongsTab()` + `djSyncSongsTab()` 高亮）、搜索框 `#djSongSearch`（`djSongsFilter()` 匹配 歌名/歌手/点歌人）、「清空排除」按钮（`djClearExcluded()`，confirm 保护）；按点歌人视图按歌曲数降序分组、点名字展开其歌、可整人排除。**实现要点**：所有回调一律走**索引**（`djToggleReqIdx(i)` / `djSetExcludedReqIdx(i)`）+ 全局数组 `_djReqGroups`，单曲用 `djSetExcludedById(id)`（纯数字），**避免把姓名拼进内联 JS 字符串导致引号/转义炸掉**；某人的歌若被整人排除，行尾显示「👤 已排除」（带 title 说明去哪里解除）且不给可点 checkbox，避免「排除了这个人又单独勾回来」的语义冲突。⑥ **实测**（Playwright，mock 平台 API）：26 项功能断言全过——默认抽签同一人不重复、超容量收敛到 6 首并提示、关掉开关可抽满全池 11 首、整人排除后该人 0 首、单曲排除生效、高赞必选撞车顺延且提示 2 首、搜索命中点歌人/歌手、按点歌人分组 5 组（4 人 + 未填写）、展开/勾选/localStorage 落库/状态栏计数、清空排除、无 JS 报错。另有 **60 次随机压力测试零违例**（抽 6 首 ×20 / 抽满上限 ×20 / 高赞必选 5 首 ×10 / 排除 2 人 ×5 / 关闭开关 ×5），真实 API 回归同样通过（实抽 5 位不同同学）。**踩坑**：Playwright 的 `page.route` **拦不到 Service Worker 发起的 fetch**，必须用 `browser.new_context(service_workers='block')` 禁用 SW，否则拿到的是线上真实歌单（37 首），测试断言会全部假阳性通过（第一版就栽在这）。⑦ 已发站内公告（category `site`，2026-08-30 16:05）；`sw.js` 缓存版本 v5 → **v6**。已做修改前备份 `backup/class-site-backup-before-20260830-153450.zip`；已重打包 `class-site-backup.zip`。 |
| 2026-08-29 | 🔤 **密码框禁用输入法导致中文答案打不出来 → 全局修复 + 答案多形态兼容（用户可见，已发公告）**：① **根因**：`type="password"` 的输入框，浏览器（Chromium / Safari / 微信内置）会**强制禁用 IME 中文输入法**（安全策略，防密码被输入法记录），同学切不出中文、只能输英文——用户实测「眼睛闭着（密文态）时无法用系统本地输入法，只能把眼睛打开」。此前唯一变通是点眼睛切成明文再输入，体验很差。② **修复**：全部密码框由 `type="password"` 改为 **`type="text"` + `class="pwd-mask"`，靠 CSS `-webkit-text-security:disc` 遮蔽**（视觉仍是圆点，但 IME 完全可用）；新增 CSS `input.pwd-mask` / `input.pwd-mask.pwd-plain` / `.pwd-ime-tip`。涉及 8 处（含 1 处 JS 动态生成）：`siteGateInput`、`hiddenGateInput`、`dataEncPass`、`dataEncPass2`、`exportPassInput`、`djIdInput`、`djVillageInput`、`gate-input-<id>`；另有 1 处 CSS 选择器 `input[type="password"]` 同步改为 `input.pwd-mask`。③ **`togglePwd()` 重写**：不再切 `type`（切回 password 会重新禁 IME），改为 `classList.toggle('pwd-plain')`，并同步 `aria-label`。④ **降级兜底**：`initPwdMaskFallback()` 用 `CSS.supports('-webkit-text-security','disc')` 检测，不支持的浏览器（Firefox）自动回退 `type=password` 保证遮蔽，并在输入框父节点追加 `.pwd-ime-tip` 提示「点眼睛显示后即可输入中文」。⑤ **答案多形态兼容**：新增 `normAnswer()`（全角→半角 / 去所有空白 / 去常见中英文标点 / 转小写），门禁（`submitSiteGate`）、各链接门禁（`checkGate`）、隐藏暗号（`submitHiddenGate`）均改用它——**哈希算法本身未变**，既有答案哈希不受影响，不含空格的输入结果完全一致。`SITE_GATE.answers` 由 1 个扩到 **11 个哈希**：标准答案、简称、别名 ×2、农历叫法、常见错字、全拼、全拼+jie、拼音首字母、英文、英文全称——**全部只存哈希，答案明文一律不入库**（含本文件也不得记录明文，用 `hashSecret(明文, GATE_SALT)` 在本地生成哈希后填入）。`hint` 改为「三个字；输入法打不出中文时，可直接输拼音或英文」。⑥ **安全斟酌**：门禁弹窗提示行与站内公告**均不写答案示例**（曾写拼音示例，等于把答案直接给外人，已删除），对外只说「可输入该节日的拼音或英文」；**本文件同样不得记录答案明文或拼音**（仓库公开，写了等于门禁失效），如需新增答案请本地算哈希后只填哈希值。⑦ 实测（Playwright）：17 种写法全部通过（中文标准答案 / 简称 / 别名 / 农历叫法 / 常见错字 / 全拼 / 全拼+jie / 全拼带连字符 / 全拼带空格 / 首尾空格 / 全角大写 / 拼音首字母 / 英文 / 英文全称 / 中文中间带空格等），5 个错误答案（其它节日名 / 随机英文 / 随机数字 / 错别字）全部拒绝；**测试用例的明文答案只在对话与本地测试中，未写入仓库**；眼睛切换 `disc→none→disc` 且 `type` 始终为 `text`；模拟键盘输入中文取值正常；模拟不支持 `text-security` 的浏览器时正确回退 `password` + 提示，拼音答案仍能通过；7 个密码框（含动态生成的 `gate-input-6/7`）全部确认为 `text+pwd-mask+disc`；无 JS 报错。已发站内公告（category `site`，2026-08-29 18:10）。已做修改前备份；已重打包 `class-site-backup.zip`。 |
| 2026-08-29 | 🎮 **消消乐全新动画系统（游戏内容，按站规不进公告）**：① 新增 **requestAnimationFrame 主循环 + 统一 Tween 系统**（支持 `easeOutCubic` / `easeOutBack` / `easeInBack` / `easeOutElastic`），实现交换、消除、下落、入场、重排的全流程动画。② **交换动画**：相邻两个格子平滑互换；无效交换则交换过去再弹回原位（bad 音效）。③ **消除动画**：被消除格子先轻微放大再缩小 + 旋转淡出，并伴随 **粒子碎裂**（11 个碎片带重力）、**冲击波圆环**、**+分数飘字**（金橙色带黑边，字号随连击变大）、**屏幕震动**（4 连及以上触发）、**全屏闪光**（连击 ≥2 时）。④ **下落动画**：上方格子按重力感下落（时长按距离，带 `easeOutBack` 轻微回弹），新生成块从棋盘顶部外滑入。⑤ **连锁消除**：每次下落后自动检测并继续消除，连击计数显示在 HUD（粉色 `连击 ×N`），Combo ≥2 时在棋盘上方弹出 `COMBO ×N` 大字。⑥ **入场动画**：开局所有块从上往下依次掉落。⑦ **拖拽交换**：补齐此前缺失的拖拽交互（tip 原本写「拖拽或点击交换」但代码未实现），现在支持**按下并滑动**触发交换，与「点击两次交换」并存。⑧ **选中高亮**：选中格子带金色呼吸描边和脉冲缩放。⑨ **无解自动重排**：每轮连锁结束若无解，自动洗牌并以「无解 · 自动重排」提示，带缩放退场 + 弹入动画。⑩ **高清渲染**：按设备 `devicePixelRatio` 缩放 canvas，真机可达 DPR 2~3。实测 Playwright：连续 12 轮有效交换无空洞、busy 不卡死；无效交换正确回弹；拖拽与点击两次均触发消除；重排后恢复有解；帧率稳定（空闲 / 动画密集 maxGap 均 ≤16.8ms，60fps 无掉帧）；切后台/恢复无异常。已做修改前备份；已重打包 `class-site-backup.zip`。 |
| 2026-08-29 | 📚 **文档体系重构 · 对外 / 内部分离 + 内部文档隐藏 + 备用站点实时同步授权（仓库运维，不进公告）**：① **README 改版为对外门面**——原 README 含「维护须知（站规）」「令牌管理」「备份与导出」「双仓库同步」「最近更新（大量技术细节）」等内部内容，现全部移除/迁入本文件；新 README 只保留：站点简介、**在线地址**（主链 GitHub Pages + 备用 WorkBuddy 链接，含「微信内打不开」提示）、**功能一览**（常用服务 / 班级应用 / 学习资料 / 成绩查询 / 班级事务 / 其他工具 / 安装为应用 / 隐藏娱乐天地）、**使用方式**（手机/电脑添加到桌面、复制链接、微信内跳转提示、数据管理与导入导出）、**常见问题**（作业不同步、点歌券规则、数据丢失、链接失效）、**技术说明**（纯静态 PWA、单文件 `index.html`、离线可用）、**开源与版权**。同步**删除**已失效的过时引用（`secrets-hint.txt`、`scripts/` 已于历史脱敏时删除，README 中仍在写）。② **本文件迁移 + 隐藏**——`TUTORIAL.md` → **`internal/notes.md`**（隐蔽目录 + 无辨识度文件名）；README 中「详细维护教程请查看 [TUTORIAL.md]」链接与目录结构条目一并删除；顶层铁律新增「文档分工」「内部文档隐藏」「备用站点实时同步」三条站规，并把「三处同步」修订为「两处同步（站内公告 + 本文件），README 仅在外向内容时同步」；第 7 节检查清单同步（含「zip 已排除 `internal/`」「备用链接已重新发布」）。③ **备份包排除内部文档**——`class-site-backup.zip` 打包命令增加 `-x "internal/*"`，避免站主/访客下载备份包即可读到内部维护全文；线上发布包本就排除。④ **源码注释脱敏**——`games/snake.html` 顶部注释「重新加密方法见 TUTORIAL 5.4」改为「见内部维护文档」，不写文件名（该文件线上可访问）。⑤ **备用站点实时同步授权**——用户明确「备用链接你也需要实时同步更新」，此后每次改动 push 后直接发布，不再逐次询问。⑥ **已向用户明示**：仓库为公开仓库，隐藏入口只降低被偶然发现的概率，不是安全措施；真正的敏感信息（API Key、解密口令）本就**不入库**（密文 `secrets.json.enc` + 本地记忆口令 + 前端混淆密文运行时解密），因此无新增风险。未发站内公告（仓库/维护内容按站规不进公告）。已做修改前备份；已重打包 `class-site-backup.zip`。 |
| 2026-08-29 | 🗂️ **历史公告迁入「🔔 重要更新」（站内归类整理，未新增公告）**：把 5 条对同学影响较大的历史公告从原 `site`/`class` 调整到 `activity`（分类键名未变，显示名已改为「🔔 重要更新」）：`2026-08-29 15:20 备用链接上线`（原 `site`，置顶至 18:00）、`2026-08-25 16:46 Classworks 断连通知`（原 `class`，important）、`2026-08-26 00:45 密码防爆破`（原 `site`）、`2026-08-25 22:58 今日班级签上线`（原 `site`）、`2026-08-25 19:11 侧边栏安装教程`（原 `site`）。调整后 `activity` 共 5 条，`site` 降为 46 条，`class` 剩余 1 条；`ANN_CATS`/`CATS`/`#allSearchCat` 顺序保持不变（site/activity/class/misc）。实测：首页点「🔔 重要更新」筛选显示 5 条，两条置顶在前；全部公告弹窗分组 `🔔 重要更新（5）▾` 正确；下拉排序 `全部/site/重要更新/class/站主杂谈` 正确。已做修改前备份；已同步 README 最近更新 + 重打包 `class-site-backup.zip`。 |
| 2026-08-29 | 📌 **公告分类改名 + 班级活动通知系统 + 个人数据加密导出（用户可见，已发公告）**：① **分类改名 + 前移**——首页筛选栏 `CATS` 顺序由 `site/class/activity/misc/all` 改为 `site/**activity**/class/misc/all`，`activity` 显示名由「🎉 班级活动」改为「🔔 重要更新」；`ANN_CATS`（全部公告弹窗板块折叠）与 `#allSearchCat` 下拉同步改名并把顺序统一为 `site/activity/class/misc`，键名 `activity` 不变，原有公告自动归入新板块。② **备用链接公告改限时置顶**——`importantUntil` 由 `2026-08-30T15:20:00` 改为 **`2026-08-29T18:00:00`**；`isImportant()` 原有逻辑 `if(a.importantUntil && new Date(a.importantUntil).getTime() <= Date.now()) return false;` 已支持到期自动取消置顶，无需改代码。实测：当前 `true`、模拟 18:00:30 后 `false`。③ **新增班级活动通知系统**——配置 `SITE_DATA.activity`：`enabled`（总开关）/`id`（换活动改 id，让已关过弹窗的同学重新收到）/`title`/`body`（`\n` 换行）/`startAt`（可选，未到点不触发）/`endAt`（**活动结束时间，到点后弹窗与悬浮球全部消失**）/`linkText`+`linkUrl`（可选按钮）。核心函数：`actActive()`（按 startAt/endAt 判定）、`actAutoPopped()`（localStorage `cls_act_pop_<id>_<toDateString>`，同一天只自动弹一次）、`actAutoPop()`（轮询等待其它 `.allboard-mask.show`/`.gate.show` 关闭后再弹，最多等 12 秒，避免与欢迎语/门禁叠加）、`actBubbleShow()`（悬浮球显隐 + 每 60 秒 `setInterval` 复查，`endAt` 一到立即撤球）、`actSyncBubble()`（活动球可见时把学习资料球 `bottom` 从 16px 顶到 74px 避让；`studyBubbleShow()` 末尾也调用它）。DOM 新增 `#actMask`（弹窗）与 `#actBubble`（右下角橙色 🎉 球 + 红点，仿学习资料悬浮球）。初始化：文件末尾 `actInit()`。实测 4 场景——进行中（自动弹→点关闭→球 flex→点球重开→同日再进站不自动弹但球仍在）/ 已过 endAt（不弹无球）/ enabled=false（不弹无球）/ 未到 startAt（不弹无球），无报错。④ **个人数据加密导出**——**背景**：原 `exportData()`/`copyDataText()` 直接 `JSON.stringify(collectAllData())` 导出明文，姓名（`cls_coupon_name`、`cls_class_list` 全班 61 人）、班级签（`cls_sign_*` 含签文）、点歌台账 `cls_coupon_ledger` 全部裸奔。**实现**：新增 `_b64enc/_b64dec`、`cryptoOK()`、`_deriveKey()`（PBKDF2-SHA256，iterations=**150000**，派生 AES-GCM 256）、`encPayload()`（随机 16 字节 salt + 12 字节 iv，输出 `{v:2,alg:'PBKDF2-SHA256/AES-GCM',iter,salt,iv,ct}`）、`decPayload()`；新增口令弹窗 `#dataEncMask` + `askDataEnc(mode,cb)`（导出=密码+确认密码，导入=仅密码）、`submitDataEnc()`（≥4 位、两次一致校验）。`exportData/copyDataText` 改为先 `askDataEnc('export')` 再加密；`doImport` 按 `obj.v===2 && obj.alg.indexOf('AES-GCM')>=0` 分流到 `askDataEnc('import')` + `decPayload`，失败提示「密码错误或数据已损坏」，**旧版明文数据仍走 `applyImport()`（向下兼容）**。`cryptoOK()` 为假时 `_plainWarn()` 弹确认框说明风险后才允许明文导出。数据管理弹窗说明文案与两个按钮（「📤 导出数据（加密 .json）」「📋 复制加密数据文本」）同步更新。实测：导出文件顶层仅 `alg/ct/iter/iv/salt/v`，明文「余子康」「状态很在线」零命中；跨设备（老设备导出→全新 context 导入）7 项数据 / 61 人名单 / 班级签全部还原；错密码正确报错；旧版明文导入 999/77 生效；密码不一致、过短校验均正确。已做修改前备份 `backup/class-site-backup-before-20260829-161001.zip`；已同步 README 最近更新 + 重打包 `class-site-backup.zip`。 |
| 2026-08-29 | 🔍 **核销状态确认 + git remote 去明文令牌 + 券管理备注展示修复（站主功能 / 仓库运维，不进公告）**：① **老遗留消除——券核销后 status 实测为 `REDEEMED`**：此前判定「平台 API 返回 403 无法实测」是误判，**实际只需带 `x-api-key` 请求头即可**（CORS 回显任意 Origin，本地也能直连）。实测已核销券 `SONGPKV8PQC8`：`{"id":20,"code":"SONGPKV8PQC8","status":"REDEEMED","redeemedBy":79,"redeemedAt":"2026-08-29T07:45:03.938Z","note":"余子康 · 2026-08-29 08:20 · 贪吃蛇吃豆50奖励"}`。现有逻辑（去掉 status 过滤 + 非 AVAILABLE 即已用）**确实能拦住它**：本地实跑 `platformFind('余子康')` → `{found:true, code:"SONGPKV8PQC8", status:"REDEEMED"}`，`platformFind('张三丰')` → `{found:false}`。据此把 4 游戏文案从「非 AVAILABLE 一律『已使用』」细化为 `statusTxt()`：`REDEEMED`→**已核销**／其他非 AVAILABLE（如 `LOCKED`）→**已使用**／`AVAILABLE`→**仍可用**；并加注释记录平台实际字段值。② **git remote 去明文令牌**：原 `https://zikang0529:<令牌>@gitee.com/...` 改为 `git@gitee.com:zikang0529/class-site.git`。做法——`ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519_gitee`，公钥经 `POST https://gitee.com/api/v5/user/keys`（带 `access_token`）加为账号级公钥（title `class-site-sandbox-20260829`，id 6018691）；`~/.ssh/config` 配 `Host gitee.com` + `IdentityFile` + `IdentitiesOnly yes`；`ssh-keyscan` 预置 `known_hosts` 避免首次交互确认。验证：`ssh -T git@gitee.com` → `Hi 余子康(@zikang0529)!`；`git ls-remote` 免密成功；`.git/config` grep 令牌**无残留**。**仍建议到 Gitee 轮换该 access token**（它曾明文出现在 remote URL 与对话中）。③ **券管理备注展示不完整（真机 400px 宽实测）**：根因 `.cp-note` 用 `white-space:nowrap` + `text-overflow:ellipsis`，显示宽仅 154px 而内容宽 272~295px，**被截掉近一半且移动端无法 hover 看 title**。修复——去掉 nowrap/ellipsis 改 `word-break:break-all` 自动换行；新增 `cpNoteHtml()` 把「名字 · 时间 · 游戏奖励」按 `·` 拆三段分色（名字加粗深蓝 / 时间次要灰 / 游戏奖励蓝色），新增对应 `.cp-nm/.cp-tm/.cp-gm/.cp-dot` 类与 `.dark` 变体；新增 `cpFmt()` 按浏览器本地时区格式化时间——**原实现直接切片 UTC，显示「创建 2026-08-29 00:20」而备注写「08:20」，两者对不上**，现已一致；`cpTimeHtml()` 对已核销券补一行「已核销 时间」。对比度实测：亮色 备注 5.67／名字 14.26／游戏 5.12／时间行 2.44→**5.38**（原 `#9aa7b8` 落白底不达标，改 `#5f6b80`）；暗色 9.24／14.75／8.01／5.87。全过 AA，无报错。已做修改前备份 `backup/class-site-backup-before-20260829-155146.zip`；已同步 README 最近更新 + 重打包 `class-site-backup.zip`。 |
| 2026-08-29 | 🔗 **备用链接上线 + 备份包可下载 + 全站隐私扫描（用户可见，已发公告）**：① **备用链接**——`SITE_DATA.siteLinks` 新增 `{label:"备用链接", url:"https://a5048c773a210b3d4-25579.app.workbuddy.link/", note:"⚠️ 微信内打不开！…"}`，`openCopyLink()` 渲染结构由「单层 div + span + 按钮」改为「外层 div + 内层 flex 行 + `.link-note` 提示行」，支持 `l.note`；新增 `.link-note` CSS（亮色 `#c2410c` / `.dark #ffb08a`，避免暗色下橙字落深底对比度不足）；弹窗顶部 `<p>` 文案改为「平时用主链接；主链接打不开时再用备用链接，备用链接在微信内无法打开」。② **备份包可下载**——**关键坑**：WorkBuddy 域名前置腾讯云 WAF，**按后缀封禁 `.zip`**（不存在的 `/nonexistent-xyz.zip` 同样 403，实测与 UA/Referer/HEAD 无关），原 `window.location.href='./class-site-backup.zip'` 在备用站点必然失败。新增 `downloadBackup()`：fetch 依次尝试 `./class-site-backup.zip` → `./class-site-backup`（无扩展名副本），`!r.ok` 或 `content-type` 含 `text/html` 即判失败试下一个，命中后 `URL.createObjectURL(blob)` + `a.download='class-site-backup.zip'` 保存（用户拿到的始终是 zip 名）；全部失败时 `file://` 回退跳转、否则显示「备份包下载失败」。③ **发布口径**——发布目录 `/workspace/.publish-class-site`：含 `index.html`/`games/`(13)/`manifest.webmanifest`/`sw.js`/`favicon.svg`/`icon-*.png`/`qrcode.jpg` + **两份备份包**（`class-site-backup.zip` 与无扩展名 `class-site-backup`）。备份包为**净化版**（排除 `backup/`、`source/`、`secrets.json.enc`、`README.md`、`TUTORIAL.md`、`cloudbaserc.json`、`.gitignore`），仓库内 `class-site-backup.zip` 仍是完整版。实测线上 `/class-site-backup`→200(226822B，`application/octet-stream`)、`/class-site-backup.zip`→403(WAF)、`/backup/`·`/README.md`·`/secrets.json.enc`·`/source/package.json`→404；Playwright 线上端到端：弹窗两条链接 + 微信提示正常，下载得 226822B 有效 zip（21 条目），无控制台错误。本地模拟「删掉 .zip」回退测试同样通过。④ **隐私扫描（4 类，结论：无明文泄露）**——模式扫描（`sk-`/`sk-ant-`/`ghp_`/`gho_`/`github_pat_`/`AKIA`/`xoxb-`/`AIza`/`Bearer `/`secretId`/`SecretKey`/`access_token`/`private_key` 等）**0 命中**；`token\|password\|secret\|apikey\|accessKey` 变量赋值 **0 命中**；≥24 位十六进制命中 4 个游戏的 `_CPN_ENC`（发券凭证 XOR 密文，掩码 `vgate25coupon0801`，非明文）与 `index.html` contacts 的 SHA-256 姓名哈希（设计如此）；手机/QQ/身份证/邮箱命中 `index.html` 中一个 11 位数字串（`177****9631`），实为某条 64 位 SHA-256 哈希（`25b1be539510316be9396879a1…` 形式）的内部子串，**误报、非手机号**；`secrets.json.enc` 为 OpenSSL `Salted__` 二进制密文，`cloudbaserc.json` 的 `envId` 为占位符。⑤ 站内公告新增置顶条目（2026-08-29 15:20，category `site`，`importantUntil: "2026-08-30T15:20:00"`）。已做修改前备份 `backup/class-site-backup-before-20260829-151636.zip`；已同步 README 最近更新 + 重打包 `class-site-backup.zip`。 |
| 2026-08-29 | 🎟️ **点歌券「每周一张」改严格判定（券核销后不再重复发；属发券机制，不进公告）**：① **根因**——`platformFind` 里 `if(!c\|\|c.status!=="AVAILABLE") continue;`，券被核销（USED 等）后从查重结果里消失，同学用掉券再达标就能**再领一张**，“每周一张”形同虚设。② **改动 A（核心）**——去掉 status 过滤，本周内「note 首段名字 + 含游戏备注」命中即 `resolve({found:true, code, status})`（status 回传供文案区分）。③ **改动 B（不一致兜底）**——`doClaim` 原为 `ledgerHas→showClaimedName` / `alreadyClaimed→showClaimedDevice` 直接拒绝；改为本地命中时先 `platformFind(name)` 核实：`f.found` → `showClaimedName(name,f.code,f.status)` 拦截并展示原券码；`f.err`（网络失败）→ 保守拦截（不放行，防止断网就能刷券）；确认无券 → `ledgerDel(name)` + `clearClaimed()` 清本地记录后走正常生成。新增 `ledgerDel`/`clearClaimed`（snake 用 `GAME_ID` 与 `song_coupon_w_snake`，其余用 `REWARD.game`）。④ **改动 C（文案）**——`showClaimedName(name,code,status)` 增参数，命中时补一行「你的券码：XXX（已使用/仍可用）」；`showReward` 命中非 AVAILABLE 时 tag 显示「本周这张券你已领过（已使用），下周一 0 点刷新」。⑤ 实测（Playwright mock 平台 API，4 游戏 × 7 场景 = 28 项）：后台无券→生成(POST=1)；有可用券→展示原码(POST=0)；**券已使用→拦截并标注已使用(POST=0)**；本地有记录+后台已使用→拦截展示原码；本地有记录+后台无券→清记录后生成；本地有记录+网络失败→保守拦截(POST=0)；只有上周的券→正常生成。全部符合预期、无报错。已做修改前备份 `backup/class-site-backup-before-20260829-140800.zip`；已同步 README 最近更新 + 重打包 `class-site-backup.zip`。**待确认**：平台核销后 `status` 是否确实不为 `AVAILABLE`（本环境访问平台 API 返回 403，无法实测；若核销后仍返回 AVAILABLE，需按实际字段名调整判定）。 |
| 2026-08-29 | 🐍🦘 **两处小修（游戏内容，不进公告）**：① **贪吃蛇豆子不再生成在蛇身内部**——原 `place()` 为 `food={x:rand*N,y:rand*N}` 纯随机，蛇身越长命中概率越高（豆子刷在身体里表现为“豆子消失了/和蛇重叠”）。改为：先用 `occ[x+","+y]` 标记蛇身占格，再遍历全盘收集空格 `free[]`，从 `free[]` 随机取一个；`free` 为空（蛇填满棋盘）时回退原随机避免死循环。实测：随机 4000 局（蛇长 3~342，棋盘 400 格）落在蛇身 **0 次**；极端仅剩 1 个空格时正确取到该格；连续 200 次吃豆后放豆仍 0 次；无页面报错。② **涂鸦跳跃达标限时 2:30 → 2:00**——`REWARD.timeLimit` 150→120，开始遮罩 `<p>` 与底部 `.tip` 文案同步改为「限时 2:00」；`fmtTime()` 由 `Math.floor` 改为 `Math.ceil(s)`，开局显示满值 `2:00`（原实现在 119.98s 时会显示 `1:59`）。实测 1:00/1:58 达标正常弹窗发券，2:01 达标静默不发券；开局显示 2:00、2.5 秒后 1:57、剩 0.6 秒显示 0:01。已做修改前备份 `backup/class-site-backup-before-20260829-084422.zip`；已同步 README 最近更新 + 重打包 `class-site-backup.zip`（未进公告，符合站规）。 |
| 2026-08-29 | 🐍 **贪吃蛇：达标弹窗暂停 + 继续游戏 2 秒无敌（游戏内容，不进公告）**：① **暂停**——`showNameAsk()` 末尾加 `clearTimeout(timer); paused=true`（此前弹窗弹出后蛇继续跑，选名字期间会撞死）；`showReward()` 开头同样加 `if(!over){clearTimeout(timer);paused=true}`；`loop()` 末尾由无条件 `timer=setTimeout(...)` 改为 `if(!paused) timer=setTimeout(loop,curSpeed(sc))`，否则暂停当步仍会排下一次 timer。② **2 秒无敌**——新增 `let invince=0` + `INVINCE_MS=2000` + `isInv()` + `resumeGame()`（`invince=Date.now()+INVINCE_MS; paused=false; loop()`）；`loop()` 碰撞分支：无敌期内撞自己不判死、撞墙把蛇头夹紧到界内继续走；`draw()` 中无敌时蛇身变金色 `#ffcf7a` 且右上角画「🛡 无敌 Xs」倒计时。三个恢复入口 `closeName()`（取消领券）/ `closeReward()`（继续游戏）/ `claimContinue()`（已领过→继续游戏）统一调 `resumeGame()`；`reset()` 清零无敌。③ **避免“恢复一帧又被暂停”**——`doClaim()` 中原 `closeName()` 改为 `hideNameMask()`（只隐藏不恢复），因为其后可能接着弹「已领过」或券码弹窗。④ 两处弹窗加提示行「点『继续游戏』后有 2 秒无敌（撞墙、撞到自己都不会死）」。Playwright 实测：达标即暂停且蛇头 1.2s 不动；取消/已领过/券码三种关闭路径均 `paused=false` 且无敌≈2000ms；无敌撞墙 `over=false` 且蛇头夹紧在 0；无敌结束后撞墙正常死亡；端到端领券备注「余子康 · 2026-08-29 08:37 · 贪吃蛇吃豆50奖励」正常。已做修改前备份 `backup/class-site-backup-before-20260829-083032.zip`；已同步 README 最近更新 + 重打包 `class-site-backup.zip`（未进公告，符合站规）。 |
| 2026-08-29 | 🦘 **涂鸦跳跃移动端适配 + 限时领券（游戏内容，不进公告）**：① **HUD 改画 canvas + 锁定视口**：移动端原 DOM HUD（高度/最高/目标）字数过多且每帧改写数字 → 重排 + 数字宽度变化 + 整页高度超出视口 → 触摸时被拖动/抖动“鬼畜”。修复：HUD 全部画进 canvas（`drawHUD`），用等宽字体数字、`m:ss` 倒计时；DOM 顶部只剩一行静态 topbar（返回/标题/目标徽章）；body 加 `overflow:hidden/overscroll-behavior:none/100dvh`，JS `fit()` 按可用空间动态计算画布尺寸（适配 360×640~414×896），测试 5 种视口均不溢出。② **限时 2:30 发券**：`REWARD.timeLimit`（150，2026-08-29 调整为 120 = 2:00，见下条），`reset()` 初始化 `playMs/lastAt/overtime/leftSec`；`tick()` 内累加真实游戏时长（掉落/已领券弹窗时 `playing=false` 自动冻结）；`sc>=10000` 且未超时才 `showNameAsk()`，超时后达标不弹窗、不发券，但可继续玩，canvas 内显示粉色文字提示“本局已超时，达标不再发券 · 重开一局可再挑战”。开始遮罩与底部 tip 同步说明限时规则。Playwright 验证：限时内达标弹窗；超时后达标静默。已做修改前备份 `backup/class-site-backup-before-20260829-081423.zip`；已同步 README 最近更新 + 重打包 `class-site-backup.zip`（未进公告，符合站规）。 |
| 2026-08-29 | 🎯 **两款游戏发券门槛调整（游戏内容，不进公告）**：俄罗斯方块 `REWARD.threshold` 120→**200**（HUD 目标/弹窗标题「得到 200 分！」/`nmTask`/`note`「俄罗斯方块200分奖励」/补发下拉（200 分）同步）；像素飞鸟 30→**20 管**（HUD/标题「跨过 20 个水管！」/`nmTask`/`note`「像素飞鸟过20管奖励」/补发下拉（过 20 管）同步）。**防重兼容**：两游戏 `platformFind` 匹配改为 `noteHit(note)`，新增 `REWARD.noteAlias`（bird `['像素飞鸟过30管奖励','像素飞鸟过40管奖励']`、tetris `['俄罗斯方块120分奖励']`），本周已按旧门槛发出的券仍能被识别并展示原券码，避免改门槛导致同一人重复领。主站 `_RI_NOTE` 同步为新文案。已做修改前备份 `backup/class-site-backup-before-20260829-003438.zip`；已同步 README 最近更新 + 重打包 `class-site-backup.zip`（未进公告，符合站规）。 |
| 2026-08-28 | 🦘 **涂鸦跳跃发券门槛调整（游戏内容，不进公告）**：`REWARD.threshold` 3000→5000，同步 `REWARD.title`（跳到 5000 高度！）、`note`（涂鸦跳跃5000高奖励）、HUD 目标（5000 高得点歌券）、`nmTask` 默认文案、主站补发系统 `riGame` 下拉选项（涂鸦跳跃（5000 高））。已做修改前备份 `backup/class-site-backup-before-20260828-2231.zip`；Artifact 备用链接发布再次尝试仍 403 不可用（台账待办未变）。已同步 README 最近更新 + 重打包 `class-site-backup.zip`（未进公告，符合站规）。 |
| 2026-08-28 | 📦 **修改前备份机制 + 站主杂谈入口公告 + 公告规则更新（站规级）**：① **修改前备份**——新增 `backup/` 目录，每次开始新修改前先把「修改前」的当前状态打包为 `backup/class-site-backup-before-<YYYYMMDD-HHmm>.zip`（排除 `.git`/`backup/`/`class-site-backup.zip`），进 git 可追溯；回档时据此包恢复。已更新铁律「整站备份」+ README 维护须知。② **站主杂谈公告告知隐藏空间入口**——公告 `SITE_DATA.announcements` 新增 category `misc` 条目（2026-08-28 22:30）：直接写明「首页连点班徽 5 次唤出「隐藏区域」门禁，输入暗号进入」，暗号不透露（仍自行探索）。**本次为用户点名要求的例外**。③ **新站规「游戏/隐藏空间不进公告（除非用户要求）」**——更新台账站规「隐藏/彩蛋不进公告」：默认游戏内容与隐藏空间只同步 README/TUTORIAL 不进公告，除非站主明确要求；已同步台账历史表 + README 维护须知 + 站内公告。④ **备用链接代码接入（待发布）**——`SITE_DATA.siteLinks` 备用项结构保留；`openCopyLink` 占位逻辑改为「有备用项则不显示『敬请期待』」；⚠️ 本轮尝试发布 WorkBuddy 分享链接（Artifact 上传 index.html）连续返回 403「path not allowed」（/workspace/class-site/、/workspace/、/root/uploads/ 三路径均失败），判定为发布服务侧不可用，备用链接 URL 待服务恢复后发布填入。已同步 README 最近更新 + 站内公告 + 重打包 `class-site-backup.zip`。 |
| 2026-08-28 | 🎮 **游戏点歌券规则升级 + 涂鸦难度曲线 + 排行榜隐藏（用户可见，已发公告；补发系统属站主功能未进公告）**：① **发券后台核对**——新增 `CLASS_LIST`（全班 61 人名单，写入 `cls_class_list` 供小游戏读取，games 内置副本兜底）与领券台账 `cls_coupon_ledger`（`{周key:{游戏:{名字:时间·来源}}}`，`ledgerGet/ledgerAdd/ledgerHas`）；4 个发券游戏（bird/snake/doodle/tetris）领券改为：达标→弹名字选择器（输入即过滤 `nmFilter`/`nmPick`）→必须从名单选（`doClaim` 校验 `classList().indexOf(name)>=0`）→①台账按名字已领则拒绝并提示（`showClaimedName`，显示领券时间）②本设备已标记（旧数据）提示截图联系管理员（`showClaimedDevice`）→调 API；**成功才** `ledgerAdd`+`markClaimed`（原实现先标记后发券、失败也吞次数，已改为成功才记账）；失败提示「截图通关画面发管理员，核对后手动补发」。② **门槛调整**——bird `REWARD.threshold` 40→30（HUD/标题/备注同步）、snake `REWARD_DOTS` 60→50（HUD/描述同步）；doodle 3000、tetris 120 不变。③ **涂鸦难度曲线**——新增 `diffLvl()=floor(sc/500)` 及 `gravity()`(0.42+0.015/档,封顶0.18)、`platGapY()`(60+2/档,封顶24)、`springChance()`(0.14−0.008/档,下限0.06)、`platGapX()`(60+6/档+rand100)，tick/reset/生成函数全部接入。④ **排行榜隐藏**——id:15 卡片加 `active:false`（渲染过滤 `l.active!==false`，数据保留可恢复）。⑤ **补发系统**——点歌券管理弹窗新增「游戏点歌券补发」区：`riGame`(4游戏下拉)+`riNameInput/riNameList`(名单搜索选择)+`riTime`(datetime-local 默认当前)+`riSubmit`(写入台账 `· 补发` 锁定本周)+`riRender`(本周补发记录列表)；`openCouponAdmin` 时 `riInit()`。⑥ 实测（Playwright override claimCoupon）：成功写台账+设备标记、同名重复领拦截含名字+时间、失败不写台账+提示截图、非名单名字拒绝；snake/tetris 流程同验；doodle 难度各档数值正确。已同步 README 最近更新 + 站内公告 + 重打包 `class-site-backup.zip`。 |
| 2026-08-28 | 🎨 **隐藏彩蛋弹窗文字对比度修复（隐藏功能，不进公告）**：① 门禁/娱乐天地弹窗内联浅灰 `#4a5568`/`#9aa7b8` 改为双模式类 `.pop-sub`(`#5f6b80`/`.dark #aab4c8`)、`.pop-hint`(`#64748b`/`.dark #b9c2d4`)；娱乐天地条目描述 `.hidden-fun-desc` 补 `.dark #b4bdd0`；班级签 `.sign-text` 强制浅字 `#eef2fb`、`.sign-sub` 提亮至 `#b3bbdd`；彩带 `#confettiText` 继承 `.confetti-box{color:#e6edf7}` 浅字。② 根因——这些弹窗在暗色/恒深底上用了浅色或继承亮色深字，班级签与彩带在亮色模式下深蓝字落深底几乎不可见。③ 实测强制亮/暗两模式：门禁/娱乐/班级签/彩带关键文字 ratio 亮色 5.9~16.5、暗色 5.1~16.1，全部过 AA。仅同步 README + TUTORIAL，未进站内公告（属隐藏功能）。已重打包 `class-site-backup.zip`。 |
| 2026-08-28 | 🎨 **倒计时面板时间文字对比度补修（用户可见，已发公告）**：① 根因——「查看全部」弹窗里具体时间字用了内联浅灰 `#9aa7b8`（亮色落白底仅 2.4）与蓝 `#3b5bfd`（暗色落深底仅 2.6），节假日弹窗名字用 `#2c3e50`（暗色落深底几乎不可见）；首页倒计时面板内的时间文字 `.imp-full` 落在 `rgba(255,255,255,.18)` 浅蓝药丸上、白字仅约 3.0。② 修复——新增双模式类 `.imp-date`(`#5f6b80`/`.dark #aab4c8`)、`.imp-remain`(`#3b5bfd`/`.dark #9db1ff`)、`.imp-name`(`#1f2a44`/`.dark #e6edf7`)、`.imp-past`(`#64748b`/`.dark #aab4c8`)；把弹窗 JS 内 4 处内联色改为这些类；面板药丸底色 `rgba(255,255,255,.18)`→`rgba(0,0,0,.18)`，白字 `.imp-full` 提至 6+；「已过」徽章底色 `#9aa7b8`→`#64748b`。③ 实测（强制暗色类后）弹窗时间字 ratio 均 ≥10，亮色落白底 ≥4.5。已同步 README 最近更新 + 站内公告 + 重打包 `class-site-backup.zip`。 |
| 2026-08-28 | 🎨 **全站文字对比度优化（用户可见，已发公告）**：① 根因——`.dark body` 此前只设背景未切换 `color`，暗色模式下正文继承亮色 `body{color:#2c3e50}` 落在暗背景上几乎不可见；另大量内联 `style="color:#2c3e50/#4a5568/#9aa7b8/..."` 在暗色弹窗/面板中同样不可见。② 修复——新增 `--fg/--fg-2/--fg-3/--fg-muted` CSS 变量及 `.dark` 对应浅色变量，`body{color:var(--fg)}` 与 `.dark body{color:var(--fg)}`；新增一组 `.dark [style*="color:#xxx"]{color:...!important}` 内联翻转规则覆盖弹窗/面板内联深色文本；`.signbar-sub`/`.cd-sub`/`.cd-days`/`.board-empty`/`.placeholder`/footer 文字亮暗两模式分别加深/提亮；倒计时 `.cd-sem .cd-name/.cd-sub` 强制白字（解决蓝/绿渐变面板上暗字不可见）；`.btn-qr` 暗色提亮；footer 去内联改 class。③ 小游戏——消消乐 `.ov button`、扫雷 `.diff-row button` 第 2/3 个（白字落浅橙/浅粉渐变，对比 <2.5）改深棕 `#3a1206` 文字（ratio>6）；飞机/打砖块/涂鸦 深字落青绿渐变本就高对比未动；像素飞鸟白字落蓝渐变 3.76 可接受未动。已同步 README 最近更新 + 站内公告 + 重打包 `class-site-backup.zip`。 |
| 2026-08-27 | 🎟️ **点歌人显示 + 券管理移动端适配**：① **点歌人显示**——经探测确认 VoiceHub `songs.requester`（姓名字符串）与 `schedules.requester`（含姓名/年级/班级对象）均返回点歌人完整信息（API 早就有，前端一直没渲染）。已补齐：歌单管理每行加「点歌：XXX」、抽签结果每首标「（点歌：XXX · 点赞 N）」、抽签历史与一键复制公示均显示点歌人、批次存储保存 `requester` 字段（兼容字符串与对象）。② **券管理移动端适配**——添加行拆为两行（数量+按钮一行、备注独立行）；列表行改为三段式（券码+状态 / 备注 ellipsis / 时间）+按钮**纵向竖排**避免挤压；长备注显示省略号（`title` 悬停看全文）。③ 排查时发现 VoiceHub 平台 `card-codes` 数据当前为空（`total:0`）——与代码无关，可能后台清理或自动清理；前端代码正确，真实数据恢复后即正常显示。均属隐藏/站主功能，不进公告。 |
| 2026-08-27 | 🎟️ **点歌券删除真实化 + 券管理并入抽歌 + 领券填名字**：① **真实删除**——站主在 VoiceHub 后台开放删除权限，探测到正确端点为 `DELETE /card-codes?id=XX`（查询参数形式，实测创建→删除→列表复查通过，id=15 测试券已清理）；券管理「🗑 删除」按钮改为真实删除（`cpDelete` + confirm，删后平台与本站同步生效），原「本地隐藏」逻辑移除。② **并入抽歌**——券管理入口从隐藏空间移至抽歌面板（「🎼 歌单管理」旁并排按钮），受抽歌身份验证（身份证+村名）保护，隐藏空间卡片移除。③ **领券填写名字**——四款游戏每周首次达标领券前弹「填写领券人」（`showNameAsk/doClaim`），名字必填+记忆（`cls_coupon_name`），发券备注自动为「名字 · 时间 · 任务」（如「张三 · 2026-08-27 13:51 · 贪吃蛇吃豆60奖励」）；用户提供的 60 人名单下拉方案暂作废，采用自行输入。④ 修复贪吃蛇 `showReward` 引用未定义 `score`（应为 `sc`）的潜伏 bug——此前达标领券会 ReferenceError 卡在「正在生成券码」。均属隐藏/站主功能，不进公告。 |
| 2026-08-27 | 🎤 **抽歌排期二期（历史/备注/标记/导出导入/排除已排期）**：① 本地排期改为批次记录（`djLoadRounds/djSaveRounds`，每批含 `at` 时间、`note` 备注、`addedToPlatform` 已排期、`played` 已播放、`songs[]`；旧扁平数据自动迁移为一批）；② 新增历史弹窗 `#djHistoryMask`（改备注 `djSetRoundNote` / 勾选标记 `djToggleRoundFlag` / 删除本批 `djDeleteRound` / 导出 `djExportRounds` / 导入 `djImportRounds` / 清空 `djClear`）；③ 新增「排除已排期」`djExcludeSched`（排除本地已标记 addedToPlatform 的歌曲），「排除已播放」合并 API `played` 与本地标记；④ 移除「高赞优先」开关（保留「高赞必选 N 首」+ 其余纯随机）；⑤ 面板顶部描述/提示文字由浅灰 `#9aa7b8` 加深为 `#5b6781`（亮色可读），历史弹窗暗色适配。 |
| 2026-08-27 | 🐛 **抽歌抽签数量 bug 修复 + 池反馈**：`djRun` 抽签循环条件原为 `k < n-picked.length`（picked 每轮增长导致剩余数实时变小），实际只抽 ceil(池/2) 首——真实池（近7天=4首）下表现为"输入几首都只抽 2 首"。修复：循环前先算 `need = n - picked.length`；结果新增"池中 X 首"与"池中仅 X 首，已全部抽取"提示（默认近7天池较小，需更多请勾选「不限时间」）。「排除已播放」开关经真实 API 复测有效（不限时间下池 34 vs 20），"无效"系近7天池内无已播放歌曲的错觉。 |
| 2026-08-27 | 🎤 **抽歌排期五项升级**：① 身份验证接入全站自锁（`onPassFail('dj')`，连错 4 次锁 30s、按 `LOCK_LEVELS` 递增，锁定时禁用输入+倒计时）；② 验证输入改 `type=password` + 小眼睛显隐（`togglePwd`）；③ 新增「不限时间范围」开关（`djNoLimitChange`，勾选忽略时间过滤并禁用时间输入）；④ 新增「高赞必选 N 首」——点赞最高前 N 必定中选（结果 🔥 标记），其余按高赞加权或纯随机（`djRun` 重构：guarantee + restPool）；⑤ 抽歌/复制链接/主题询问弹窗暗色文字适配（`dj-label`/`dj-desc` 类 + 暗色 CSS，含结果底色与输入框暗色样式）。 |
| 2026-08-27 | 🎤 **抽歌排期（隐藏管理功能，不进公告）**：点歌平台卡片图标连点 5 次 → 本地身份验证（身份证后四位 + 户籍村名，xor 混淆答案、不上传）→ 抽歌面板（投稿时间范围 / 抽取数量 / 高赞优先 / 排除已播放）。`djFetchSongs()` 用新只读 key（xor 混淆密文）分页拉 `/api/open/songs`，本地按 `createdAt` 过滤、随机或按 voteCount 加权抽签，结果存本地 `cls_dj_schedule`，一键复制公示。因开放 API 无排期写接口，采用本地排期（用户选定）。VoiceHub 双 key 权限：旧 key=仅发券（POST card-codes），新 key=只读歌单/排期（GET songs/schedules）。 |
| 2026-08-27 | 🔐 **口令轮换完成 + 悬浮球板块限定**：① `secrets.json.enc` 已用新口令重新加密（AES-256-CBC + PBKDF2 200000 轮，往返验证通过；**口令值不入库**）；② 补发现 TUTORIAL 6.1 节曾明文写出导出备份口令，已脱敏为「明文口令不入库」，并随历史改写一并抹除；③ 学习资料访问提示悬浮球 `studyBubbleShow()` 增加 `__activeCat!==5` 判定——仅在学习资料板块（id=5）内显示，`goHomeView()` 与其他分类打开时隐藏。 |
| 2026-08-27 | 🔐 **【事故+修复】敏感信息泄露**：此前 `TUTORIAL.md` 两处明文出现 `secrets.json.enc` 解密口令 + tracked 的 `secrets-hint.txt`（"6位数字"提示将口令暴力破解复杂度降到极低）+ `scripts/encrypt-secret.sh` & `scripts/decrypt-secret.sh` 入仓。处置：① 工作树脱敏——TUTORIAL 两处"密码 本地口令"替换为"本地口令（口令不入库）"；`git rm secrets-hint.txt scripts/encrypt-secret.sh scripts/decrypt-secret.sh`；保留 `secrets.json.enc` 密文。② 新站规"敏感信息安全（红线）"——线上只传密文、口令永不入库、脚本与提示不入库、提交前 `git grep` 自检。③ **改写 Git 历史** 抹除所有 commit 中的明文与 hint/脚本文件并 force-push。④ **必须轮换已被暴露的密钥**（旧密钥视为已泄露），重新加密 `secrets.json.enc`。已记台账。 |
| 2026-08-27 | 📌 **复制链接弹窗 + 自动暗色三选 + 全站液态玻璃动画**：① 「复制链接」改弹窗：`SITE_DATA.siteLinks` 列表渲染（主链接 + 备用链接占位「敬请期待」），复制主链接；② 夜间自动暗色询问改三选弹窗 `#themeAutoAskMask`（仅这次切换 / 关闭自动切换 / 保持暗色）；③ 全站视觉升级：背景光斑漂移（`blobA/blobB`）、表面玻璃化（`--glass-bg`+`backdrop-filter`）、卡片流光（`sheen`）与入场（`riseIn`）、弹窗弹出（`popIn`）、按钮按压/旋转/FAB 脉冲等动画。已发分点公告。 |
| 2026-08-27 | 📌 **夜间自动暗色 + 复制链接**：① 自动暗色模式：`isNightTime()`（分钟制 >=1110 或 <450，即 18:30~次日 7:30）判断夜间；`applyAutoTheme()` 在 `initTheme` 加载时应用并按需写入 `cls_theme`，另设 30s 定时器仅在 `isNightTime()!==_lastAutoNight` 边界翻转时应用（白天手动切深色不被覆盖）；夜间自动暗色下手动切回亮色 → `toggleTheme` 内 `confirm` 询问是否关闭自动切换，确认后写 `cls_theme_auto='off'` 永不再自动切换。② 侧边栏底部新增「🔗 复制链接」`copySiteLink()`（clipboard API + `fallbackCopyLink` execCommand 兜底，按钮短暂显示「✅ 链接已复制」）。已发分点公告。 |
| 2026-08-27 | 📌 **学习资料悬浮球 + 公告时间筛选升级**：① 学习资料「访问提示」弹窗关闭后（未勾选不再显示）右下角出现带红点消息悬浮球 `#studyBubble`（`closeStudyNotice`/`dismissStudyNotice` 内调 `studyBubbleShow`），点击重新打开；勾选「不再显示」则无悬浮球。② 全部公告日期筛选重做：快捷范围 近 3 天 / 7 天 / 15 天 / 30 天 / 近半年 + 自定义起止日期（`#allDateRange` 在选 custom 时显示）；`annDateOk(a,time,from,to)` 支持 3/7/15/30/180 天与 custom 区间。③ 全部公告按时间隐藏更早公告、公告条数随筛选实时更新（标题「全部公告（N 条）」/搜索「范围内 N 条」）；筛选设置持久化 `cls_ann_filter`（`showAllBoard` 打开时恢复）。已发分点公告（含 `\n` 换行）。 |
| 2026-08-26 | 📌 **公告体系升级 + 化解模型差异**：① 新站规**「仓库内容不进公告」**——删除 23:18（备份包 / 通读站规）与 23:38（站规更新）两条仓库内容公告，公告只发用户可见功能；② 新站规**「公告分点换行」**——分点公告每条用 `\n` 换行，`.board-text` 加 `white-space:pre-line`；③ 「全部公告」弹窗大改：按板块折叠、仅该页显示搜索框、模糊搜索（相近词词典 `ANN_SYN`，彩蛋↔隐藏↔暗号）、范围筛选（板块 / 时间：近 7 天 / 近 30 天 / 2026）、命中 `<mark>` 高亮（`renderAllBoard` / `annMatch` / `annHighlight`）；④ **化解模型差异**——新增「0.1 执行前必读 · 操作清单」（读 / 扫 / 判 / 改 / 同步 / 打包 / 提交 八步），任何模型执行前必读并按序勾选；⑤ 新站规**「对话总结凝练 + 歧义询问 + 省 token」**。已同步 README 维护须知 + 站内公告（仅用户可见功能公告）。 |
| 2026-08-26 | 🧹 **数据管理新增「全部清理」 + 立站规·公告规范**：① 侧边栏「💾 数据管理」新增 **「全部清理」** 按钮，新函数 `wipeAllData()` 选择性清空后刷新——清除游戏记录、主题/音效、密码与暗号通关及锁状态等，**保留设备标识 `cls_device_id`、班级签 `cls_sign_*`、点歌券记录 `song_coupon_*`（防借初始化刷签/刷券）**；原 `resetData()`（仅清游戏 key）保留。② 新站规**「公告规范」**：站内公告须简洁凝练官方口吻，除「站主杂谈」与「用户要求」类外禁用「你/我/我们」主观语气词。已记入 TUTORIAL 铁律 + 用户要求台账（站规表）+ README 维护须知 + 站内公告 + 重打包 `class-site-backup.zip`。 |
| 2026-08-26 | 📌 **站规补充 + 全部清理修正**：① 新站规**「印象要求识别」**——对话中含「如果/以后/比如」等条件或举例词的要求，即便未明说也视为正式要求，记入台账并同步推送；② 新站规**「公告分点」**——单次更新含多条内容时，站内公告用编号分点（1. 2. 3. …）列出；③ 修正「全部清理」：不再清空设备标识 / 班级签 / 点歌券记录（见上条）。已同步 TUTORIAL 铁律 + 用户要求台账 + README 维护须知 + 站内公告（分点写法）+ 重打包 `class-site-backup.zip`。 |
| 2026-08-26 | 📦 **整站自动备份 zip + 通读站规**（新增站规）：① **通读站规**——每次执行任务前完整阅读 README 与 TUTORIAL「用户要求」，逐项核对，确保不漏执行（三处同步 / 隐藏不进公告 / 整站 zip 打包）；② **整站备份**——每次内容更新后把整个站点（含 `index.html`/`games/`/`manifest.webmanifest`/`sw.js`/`secrets.json.enc`，排除 `.git`）重新打包为 `class-site-backup.zip` 并提交推送。现 `class-site-backup.zip` 已随本次更新重打包为最新版。已同步 README 维护须知 + 站内公告。 |
| 2026-08-26 | 🍬 **消消乐图标重绘**：6 种图案由「同形状纯色圆 + 中心白点」改为**不同形状 + 强对比色**（圆 / 方块 / 三角 / 星星 / 菱形 / 六边形，各带深色描边与左上高光），`KIND=6` + `_rr`/`_star` 辅助绘制，辨识度更高、色弱也能区分；仍走离屏 Canvas 缓存 `glyphCache`，不回退逐格 emoji。属隐藏娱乐天地内容，按铁律不入公告，仅记此处与 README。 |
| 2026-08-26 | 🛠 隐藏娱乐天地三处体验修复：① **消消乐**修「消除一次后卡死无法再点」——`matchAt()` 在匹配贴左/上边缘时 `i` 循环停在 -1，会把 `行/列=-1` 当作可消除格 push 进结果，导致 `doMatch` 里 `grid[-1][c]=null` 抛错、且抛错发生在 `busy` 复位与 `setTimeout` 连锁之前，于是 `busy` 卡在 `true` 永久冻结。修复：两个 push 循环起点改为 `Math.max(0,i)`；并让 `_matchChain` 在每次连锁结束时归零（原为全局累加，可能误触 12 层上限提前截断连锁）。② **涂鸦跳跃**移动端由「按住屏幕左右半边滑动」改为屏幕下方 **◀ 左 / 右 ▶ 虚拟按键**（`hold()` 绑定 pointerdown/up/leave/cancel，按住设 `dirL/dirR`、松开清零，键盘 ← → 仍可用）。③ **扫雷**修「踩雷后『再来一局』无反应」——`reset()` 未隐藏结算遮罩 `overOv`，导致重开后遮罩仍盖在棋盘上、点击像没反应；现 `reset()` 内 `overOv.classList.add('hidden')`。手机端标旗改为「轻点翻开 / 长按约 450ms 标旗」：统一用 pointer 事件，`pointerType==='mouse'` 时左键翻开/右键标旗，`pointerType==='touch'` 时用计时器区分轻点与长按（长按触发 `flag` 并置 `longFired`，松手时不再 `open`）。 |
| 2026-08-26 | ① **数据管理**：侧边栏新增「💾 数据管理」→ 弹窗含导出（下载 JSON）/复制/导入（文件+粘贴）/重置。`collectAllData()` 导出全部 localStorage；`doImport()` 逐 key 恢复；`resetData()` 只清游戏 key（`GAME_KEYS` + `song_coupon_*`/`cls_sign_*`/`cls_device_id`），保留门禁/主题/音效。② 消消乐**性能优化**：emoji `fillText` 改为离屏 canvas 预渲染 `glyphCache` + `drawImage`（移动端卡顿主因），连锁上限 12 层。③ 打砖块**关卡系统**：`buildLevel(lv)` 5 种布局循环（网格/交错/金字塔/V形/随机）、`lv>=3` 起每关升级一排双血砖、球速随关卡 +0.35、`breakout_lv` 记最高关。已发公告（数据管理）。 |
| 2026-08-26 | 联系人「余子康」（contacts 哈希 `592a6bc0…`）新增 `qq` 字段（XOR 加密，`xorEncrypt('3271065361')`）；`findContactDo` 渲染新增 QQ 复制按钮（`copy-btn`，与微信/电话一致）。象棋兵位已修复（5 兵/5 卒隔格），若线上仍显示一排 9 个兵需强刷缓存。 |
| 2026-08-26 | ① 象棋修正摆位：兵/卒改为传统摆法（各 5 个，`x=0,2,4,6,8` 隔格放置，原误写成一排 9 个类国际象棋）；② **返回记忆**：`openLink()` 跳转前调 `rememberView()` 记录当前视图到 `sessionStorage.cls_return_view`（`home`/`cat_<id>`/`hidden`），页面加载时（**必须在底部 `goHomeView()` 之后**）恢复并清除——否则会被其覆盖回首页（曾踩坑）。已发公告。 |
| 2026-08-26 | ⚠️ 未公开项（不进站内公告）：隐藏娱乐天地新增 **中国象棋**（完整规则+AI三档+双人）与 **飞机大战**，五子棋升级 **AI 三档+双人模式**，扫雷支持**自定义雷数**；隐藏入口现 17 个（详见 5.6）。公开项：公告新增**彩蛋提示**（仅模糊提示站内藏有彩蛋与隐藏空间，**不透露入口、触发方法与暗号**）。踩坑记录：AI 搜索必须用正确视角 negamax，否则评估符号相反导致不落子（见 5.6 注意事项）。 |
| 2026-08-26 | ⚠️ 未公开项（不进站内公告）：隐藏娱乐天地新增 6 个内置小游戏（像素飞鸟/打砖块/消消乐/扫雷/涂鸦跳跃/五子棋 AI），`games/` 现有 10 个内置游戏，隐藏入口共 15 个（详见 5.6）。公开项：**全站音效系统**上线（`SFX` 对象 + 侧边栏开关，详见 5.6），已发公告。 |
| 2026-08-26 | ① 贪吃蛇门槛定为**吃 60 个豆**（`REWARD_DOTS=60`），新增**屏幕虚拟方向键**（替代触摸滑动，键盘保留）；② **全站密码自锁**：站点门禁/资源门禁/导出备份/隐藏暗号统一接入 `LOCK_LEVELS` 机制——连续输错超 3 次锁 30s，再错递增 1/2/5/10/30/60 分钟，状态持久化（刷新无效），输对清零。修复一个坑：`until` 字段曾用 `|0` 位运算导致毫秒时间戳溢出、锁定失效。详见 5.5。 |
| 2026-08-26 | 贪吃蛇正式规则（测试通过）：发券门槛定为 **吃 100 个豆**（`REWARD_DOTS`）；**渐进加速**——每吃 10 个豆提速 10ms（175→下限 80ms）；控制为方向键/滑动。站内公告已从旧「30 分」更新为新规则。另记录：后续其他活动可通过同一 VoiceHub API 发券（复用 `claimCoupon()` 三件套，见 5.4）。 |
| 2026-08-26 | 点歌券触发条件由「得分」改为「蛇身长度」：`REWARD_LENGTH`（当前**临时为 5** 供测试，正式建议 32，调回时同步更新站内公告）。**令牌不明文铁律**：VoiceHub key 移入 `secrets.json.enc`（新增 `voicehub` 字段，由本地口令解密（口令不入库），前端改为 xor+hex 混淆密文 `_CPN_ENC` + `_cpnDec()` 运行时解密；以后所有 API/令牌一律不明文进仓库。详见第 5.4 节。 |
| 2026-08-26 | 🐍 贪吃蛇达标发点歌券：吃到 30 分 → 前端调 VoiceHub 开放 API 创建一张券（`POST https://xsyzc2505.dpdns.org/api/open/card-codes`，请求头 `x-api-key`，body `{count:1,prefix:'SONG',length:8,note}`），弹窗展示券码；同学复制券码去点歌平台点歌时输入，由 VoiceHub 原生核销（一张券只能用一次）。**VoiceHub 侧配套部署**了 `server/middleware/api-0-open-cors.ts`（开放 `/api/open/*` 跨域，白名单 github.io 等）；前端配置在 `games/snake.html` 顶部 `VOICEHUB_COUPON`。维护要点与换 key 方法见「第 5.4 节点歌券」。 |
| 2026-08-25 | 班级签位置由公告栏「仓库」按钮旁改为「每日日报」上方独立窄卡片（桌面约 380px，明显窄于日报；移动端满宽）；图标与弹窗标题改用文字「签」，避免部分设备 emoji 显示异常；公告栏现仅留「公众号」「仓库」两按钮；新增「三处同步」铁律（每次改动必须同步 ①站内公告 ②README ③TUTORIAL，见第 0/7 节）；SW 缓存升至 v4。 |
| 2026-08-25 | 修复站内所有密码输入失效（`sha256Hex` 被重复定义覆盖 + 链接数据全部补全 id + `render()` 现在会保留当前分类视图，修复课堂笔记 / 教学课件 / 私人云盘 / 联系方式查询的门禁点击无反应和验证后整页空白问题）；作业查看卡片 Classworks 说明更正（校园网限制导致班级电脑端连不上服务器、无法同步云端），「前往 Classworks」入口排到第一位；点歌平台下方新增「服务器配置有限，没有立即跳转请耐心等待几秒」提示；SW 缓存升至 v3。 |
| 2026-08-25 | 公告栏「公众号」旁新增「仓库」按钮（跳转 Gitee）；8.25-8.27「2026 暑假作业」标注为示例测试数据（`isDemo: true`，弹窗与日历详情均显示「⚠️ 示例测试数据，并非真实作业」）。 |
| 2026-08-25 | 「班级事务」中「建言献策」「情况反映」两个 `comingSoon` 卡片合并为「意见反馈」卡片（id 17，问卷星匿名问卷 `https://www.wjx.top/vm/tFMclw4.aspx#`）。 |
| 2026-08-25 | ⚠️ 未公开项（不进站内公告）：① 私人云盘已隐藏（`active: false`，数据保留，后续可恢复）；② 新增隐藏娱乐天地彩蛋：点击班徽 5 次（3 秒内）弹出暗号框，暗号为「同学群目前人数」，答案 47（`HIDDEN_SALT='cls2505-hide-salt'`，哈希存储），正确后进入 `hiddenViewMask`，内含 `HIDDEN_FUN_LINKS` 娱乐链接（修改该数组即可增删内容）。 |
| 2026-08-25 | ⚠️ 未公开项：隐藏娱乐天地新增「云智安（网页应用集合站）」`https://yqzan.cn/`（登录账号 `xsyzclass5` / 密码 `xsyz985211`），卡片支持 `login:{user,pass}` 字段自动展示账号密码并提供复制按钮。 |
| 2026-08-25 | 主链接切换为 GitHub Pages（`https://yuzikaaang.github.io/class-site/`）；WorkBuddy 常驻分享链接取消发布，改为应急备用（主链接不可达时临时重新发布）；Gitee 与 GitHub 仓库均已公开。 |
| 2026-08-25 | 每日日报入口改为 `https://newsnow.czl.net/c/china`（不再自部署），简介同步更新；修复「全部重要日期」弹窗倒计时不走秒的问题（弹窗打开后每秒刷新）。 |
| 2026-08-25 | 令牌加密存储上线：`secrets.json.enc` + `scripts/encrypt-secret.sh` / `scripts/decrypt-secret.sh`，文档中不再出现明文令牌；本地工作副本清理。 |
| 2026-08-25 | 取消自动备份与每周打包（Gitee 个人版不支持定时任务），改为站内「📦 导出备份」：密码验证（SHA-256 哈希）后下载完整版 `class-site-backup.zip`；约定每次内容更新同步一条站内公告并更新 README。 |
| 2026-08-25 | 导出备份密码输入错误时提示「站主高中绝对不会忘记的数字」；新增 `secrets-hint.txt` 密码提示文件（令牌密码提示：6 位数字）；主链接决策待定：若 github.io 国内访问稳定则作为主链接并停用 WorkBuddy。 |
| 2026-08-25 | 修复每日日报卡片空白（链接条目缺失 `id:4` 导致首页日报区找不到数据）；公告时间统一精确到秒（`YYYY-MM-DD HH:MM:SS`）。 |
| 2026-08-25 | 修复日报卡片排版（`.daily-card` 设为 flex 横排占满）；修复首次输入正确密码仍报错的 bug（`submitSiteGate`/`findContact` 改 await 异步哈希，之前同步拿 Promise 导致永远比对失败）；密码显示切换按钮由 emoji 改为 SVG 图标。 |
| 2026-08-25 | **模型无关性**：TUTORIAL 顶部加「0. 模型无关性」声明，强调本仓库是唯一内容源、所有规则沉淀到仓库。公告改名为「公告」并按 `site/class/activity/misc` 四类分组（弹窗内分小节展示），置顶 `important:true` 始终置顶（新增 Classworks 网络限制置顶）。PWA `apple-touch-icon` 与 manifest 主图标升为 512。**学习资料板块新增「网络限制提示」弹窗**（进入分类时弹出，含「不再显示」复选框，localStorage 记忆 `cls_study_notice_dismissed`）。**作业查看卡片改造**（因 Classworks 校园网打不开）：去掉原 mainUrl，新增 `customActions`：`查看当前作业`（自动匹配今日所属作业段）+ `历史作业（日期）`（日历视图，含月份切换/日期点击/详情），`SITE_DATA.holidayHomeworks` 数据模型由维护者后续手动同步，平常小作业不收录。公告时间统一为「精确到分」。 |

## 10. 用户要求台账

> 铁律要求：用户提出的**所有要求**逐条记录于此；每次改动前不得违反任何已记录要求；若新需求与旧要求冲突，先向用户确认并更新本表，再动手。
> 说明：下表「持续生效」为站规级要求；其余为历史提出的功能要求（均已上线/已处理）。日期取对应需求提出或落地时段。

### 站规（持续生效）

- **仓库唯一源 + 两处同步（2026-08-29 由「三处同步」改）**：Gitee 为唯一内容源；任何改动同步 ① 站内公告（`index.html` 的 `SITE_DATA.announcements`）② 本文件「更新记录」。`README.md` **不再作为必同步项**——仅在有对外价值（新功能、地址变更等）时才更新，且只写介绍性内容。
- **【站规】文档分工（2026-08-29 立）**：`README.md` = 对外门面（面向访客，只写站点介绍 / 功能 / 用法 / 地址），**禁止**写入站规、内部实现、令牌机制、备份与发布口径、防刷逻辑等；本文件 = 内部维护文档，站规 / 台账 / 更新记录 / 实现细节全部在此。
- **【站规】内部文档隐藏（2026-08-29 立）**：本文件存于 `internal/notes.md`；README **不得**给出链接或路径、目录结构不得列出；`class-site-backup.zip` 与所有线上发布包**必须排除 `internal/`**；源码注释只写「见内部维护文档」，不写文件名。**注**：仓库是公开的，隐藏入口只降低被偶然发现的概率，不构成安全保护——真正的敏感信息本来就**不入库**。
- **【站规】主链 + 备用链接实时同步（2026-08-30 由「备用站点实时同步」升级）**：每次站点内容更新后，按序执行 ① 同步站内公告与本文件 ② `commit + push` 到 Gitee（唯一内容源）③ **重新发布 WorkBuddy 备用链接**（`publish.js --dir /workspace/.publish-class-site`，链接固定 `https://a5048c773a210b3d4-25579.app.workbuddy.link`）——**无需再询问，直接发布**。④ **主链 GitHub Pages 同步**：本环境**未登录 GitHub**（`gh auth status` 为未登录，仓库只有 `gitee.com` 一个 remote），**无法自动推送**，必须**每次主动提醒用户手动同步**，或等用户在本地/网页端完成 Gitee→GitHub 同步后再告知。**若用户提供 GitHub 访问方式（PAT / ssh key），则写入本文件并改为自动推送。**
- **【运维备忘】点歌平台 API 的 CORS 白名单（2026-08-30 记）**：线上平台是**用户自己的 fork 仓库 `yuzikaaang/VoiceHub`**，白名单硬编码在 `server/middleware/api-0-open-cors.ts` 的 `ALLOWED_ORIGINS` Set，**无环境变量可配**；当前含 4 项：`https://yuzikaaang.github.io`、`https://zikang0529.gitee.io`、`http://localhost:8899`、`http://127.0.0.1:8899`。精确匹配（协议 + 主机 + 端口，末尾无斜杠）。**新增允许来源 = 改源码 → push main → Vercel 自动部署**。备用链接 `https://a5048c773a210b3d4-25579.app.workbuddy.link` **尚未加入**，故备用站上抽歌 / 券管理等一切调 API 的功能均不可用（主链正常）。**已加前端降级提示（2026-08-30）**：抽歌面板顶部 `#djOfflineTip`，**请求失败即显示**（不判断域名），引导用户去主链接；白名单补上后提示自动消失，无需改代码。用户已知晓并计划回家后自行去 fork 仓库加白名单。
- **【站规】亮色 / 暗色双模式可读性（2026-08-30 立）**：新增或修改**任何** UI 文字，必须保证**日常模式（亮色）与暗色模式两种模式下都看得清**——正文对比度 ≥ **4.5:1**，大字号（≥18.66px，或 ≥14px 且粗体）≥ **3:1**（WCAG AA）。**色值约定（禁止写死）**：① 次要信息（计数 / 时间 / 说明）一律用 `var(--fg-3)`（亮 `#5f6b80` 5.38:1 / 暗 `#9aa7b8` 6.39:1），**禁止直接写 `#9aa7b8`**（亮色落白底仅 **2.44:1**，看不清）。② 警示/排除态文字用 `.dj-ex-tag`（亮 `#c2410c` 5.18:1 / 暗 `#ffb08a` 8.79:1），**暗色下禁止用 `#c2410c`**（落 `#1b2432` 仅 **3.02:1**）。③ 正文用 `var(--fg)` / 次要用 `var(--fg-2)`。**既有的 `.dark [style*="color:#xxx"]` 全局覆盖机制**（第 153 行起）只对已登记色值生效，新色值必须显式补 `.dark` 规则，别指望它兜底。**验证方法**（改完必跑）：Playwright 取 `getComputedStyle(el).color` + 向上遍历 `backgroundColor` 得到有效背景，算对比度后逐项打印；两种模式 × 各视图全部采样，`applyLightTheme()` 切亮色、`document.documentElement.classList.add('dark')` 切暗色。
   **历史存量已清理（2026-08-30）**：全站 20+ 处写死 `#9aa7b8` 已由**亮色全局兜底规则**统一映射到 `var(--fg-3)`——`[style*="color:#9aa7b8"]{color:var(--fg-3)}`（放在暗色区块之前、不带 `!important`，暗色仍由 `.dark` 规则接管）。**新代码直接用 `var(--fg-3)`，不要再写死任何 hex。**
   **全站扫描器**（改完建议跑）：遍历所有可见文字叶子元素，逐级合成半透明背景后算对比度，亮/暗 × 首页 + 各分类 + 各弹窗全部采样。**注意**：祖先链含 CSS 渐变时背景不可判定，必须跳过，否则把渐变当白底会刷出一片假阳性。
   **遗留已清零（2026-08-30，用户拍板后）**：全站按钮配色全部调到 AA——主蓝 `#4a6cf7`→**`#3f5fe6`**（29 处）、绿 `#059669`/`#10b981`→**`#047857`**、紫 `#7c83ff`→**`#574fd6`**（彩带色不动）、禁用态亮色改 **`#475569` 深字**。**全站扫描 507 个文字元素、亮暗双模式 0 项不达标。** **踩坑**：改色前先 grep 该色值的**全部**出现位置——`.dark .btn-disabled{background:#475569}` 是既有的，若把亮色的文字也改成 `#475569` 就会「深字落深底 1.00:1」撞色，必须给 `.dark` 显式补 `color:#fff`。**新代码直接用这批色值**：按钮底 `#3f5fe6` / `#047857` / `#574fd6`，次要信息 `var(--fg-3)`，警示态 `.dj-ex-tag`。
- **隐藏/彩蛋/游戏内容不进公告（除非用户明确要求）**：小游戏、隐藏空间类改动只同步 README / TUTORIAL，默认不写站内公告；仅保留一条模糊彩蛋提示（只说「藏着彩蛋和隐藏空间、自己去探索」，不透露触发方法/密码）。**例外**：2026-08-28 用户明确要求以「站主杂谈」公告告知隐藏空间进入方式（连点班徽 5 次唤出门禁，暗号仍需自行探索），该次为特例已执行；后续除非用户点名要求，游戏/隐藏空间内容一律不进公告。
- **令牌不明文**：所有 API / 令牌一律不明文进仓库（VoiceHub Key 存 `secrets.json.enc`，由本地口令解密，**口令一律不入库**；前端用混淆密文运行时解密）。
- **用户要求全量留档与遵守**：所有要求写入本台账；改动前不违反已记录要求；冲突先问用户并更新规则；提要求后立即 `commit + push`。
- **通读站规**：每次执行任务前，完整阅读**本文件**第 0 节铁律 + 第 10 节台账（README 不含站规），逐项核对，确保不漏执行任何已记录要求（两处同步 / 隐藏不进公告 / 整站 zip 打包 / 备用站点实时同步等）。
- **整站备份（zip）**：每次内容更新后，将整个站点（含 `index.html`、`games/`、`manifest.webmanifest`、`sw.js`、`secrets.json.enc` 等，排除 `.git`）重新打包为 `class-site-backup.zip` 并提交推送，确保每次下载都是最新完整版。**另：每次开始新修改前，先把「修改前」的当前状态打包为 `backup/class-site-backup-before-<YYYYMMDD-HHmm>.zip`（排除 `.git`、`backup/`、`class-site-backup.zip`）留档，用户要回档时据此压缩包恢复；`backup/` 目录进 git 可追溯。**
- **敏感信息安全（红线）**：① 线上只上传密文——严禁明文口令/密钥/Token/加密提示入仓；仅 `secrets.json.enc` 可提交。② 解密口令永不入库（不入 README/TUTORIAL/注释/commit/hint），由维护者本地记忆，解密仅在本地完成。③ 加密脚本与提示文件不入库（`secrets-hint.txt`、`scripts/*.sh` 一律不跟踪）。④ 历史口令/密钥明文入库事故处置：立即轮换暴露密钥 + 改写 Git 历史抹除明文并强推 + 更新记录留档。⑤ 提交前 `git grep` 自检口令/token/key/hint/password 必须为空。
- **公告规范**：站内公告须简洁、凝练、官方口吻；除「站主杂谈」与「用户要求」类外禁用「你/我/我们」等主观语气词；**只发用户可见的站点功能，仓库/维护内容（站规、zip 打包、README/TUTORIAL 更新说明等）不进公告**；分点公告每条换行（`\n`）。
- **印象要求识别**：对话中含「如果/以后/比如」等条件或举例词的要求，即便未明说也视为正式要求，记入台账并推送。
- **公告分点**：单次更新含多条内容时，站内公告用编号分点（1. 2. 3. …）列出，每条换行。
- **对话总结凝练**：每次用户对话后先凝练总结要求；有歧义主动询问；回复精炼省 token。

### 历史功能要求

| 日期 | 用户要求 | 状态 |
|------|----------|------|
| 2026-08-30 | **歌单管理「已播放 / 已排期」默认排除 + 公示备注可自定义（用户明确要求）**：① 原话「在歌单管理列表已播放和已排期的默认排除不要我点」——列表里这些歌自动排除（实时算、不入库，行尾标 🚫 已播放 / 🚫 已排期，不给勾选框，判定顺序「已播放」优先），原来只有抽签时过滤、列表里还得手动点；② 原话「公示时间不要展示了，可以在最后加上备注……也可以让我手动再加备注」——`djCopy()` 去掉公示时间行，备注挪到最后，新增可编辑的 `#djCopyNote`（默认按当前开关自动生成「规则：每人限一首；已播放的不再抽；已排期的不重复上。」，可自己写如「本次不随机抽人，是对段考前十的奖励」），改过记住、有「↺ 默认」可恢复，批次备注与公示备注合并一行。 | 已上线 |
| 2026-08-30 | **点歌抽签过滤与去重（用户明确要求）**：① 可筛选不抽取某一首歌；② 可筛选不抽取某一个人点的歌；③ **每次抽签同一位同学的歌最多上一首**（原话「不可能一个人点的歌同时上到了这个歌单」）。落地：`cls_dj_excluded`（单曲）+ `cls_dj_excluded_req`（整人）两级排除；`#djOnePer` **默认开启**的抽签去重（含容量收敛与原因提示）；歌单管理改为「按歌曲 / 按点歌人」双视图 + 搜索 + 清空排除。 | 已上线 |
| 2026-08-28 | **【站规】修改前备份（回档）**：每次开始新修改前，先把「修改前」的当前状态打包为 `backup/class-site-backup-before-<YYYYMMDD-HHmm>.zip`（排除 `.git`/`backup/`/`class-site-backup.zip`）并进 git；用户要回档时据此包恢复。 | 生效 |
| 2026-08-28 | **【站规】游戏/隐藏空间默认不进公告**：游戏内容、隐藏空间不入站内公告，除非用户明确要求；2026-08-28 用户点名要求以「站主杂谈」公告告知隐藏空间入口（连点班徽 5 次），为特例已执行。 | 生效 |
| 2026-08-28 | **WorkBuddy 备用分享链接**：创建 workbuddy 分享链接作为站点备用入口，并同步进侧边栏「复制链接」弹窗（`SITE_DATA.siteLinks` 备用项）。⚠️ 当前 Artifact 发布服务返回 403 不可用，待服务恢复后发布填入；弹窗占位逻辑已改（有备用项则不显示「敬请期待」）。 | 处理中 |
| 2026-08-28 | **站主杂谈公告告知隐藏空间入口**：公告（category `misc` 站主杂谈）直接写明「首页连点班徽 5 次唤出门禁」，暗号不透露。 | 已上线 |
| 2026-08-28 | **电脑端标签页堆积修复**：`openLink()` 电脑端分支由 `window.open(...,'_blank')` 改为对站内相对路径（`games/xxx.html` 等非 http(s)）走 `window.location.href` 同标签打开；外部 http(s) 链接仍新标签打开。已真机验证站内游戏 0 新标签、外部 1 新标签；同步站内公告 + README。 | 已上线 |
| 2026-08-29 | **Gitee Pages 备用方案作废 → 清除死链**：Gitee Pages 已于 2024 年官方永久下线、无恢复计划，原备用 `https://zikang0529.gitee.io/class-site/` 为死链已清除，`SITE_DATA.siteLinks` 恢复为仅主链接（备用行"敬请期待"），站内公告同步说明。已备案、微信可开的备用链接将改用其他方案（待定，候选：腾讯云 CloudBase 静态托管），部署后回填并同步公告。 | 已失效（Gitee Pages 下线） |
| 2026-08-29 | **CloudBase 接入（工具链就绪）**：沙箱安装 `@cloudbase/cli`（tcb 3.8.1），新增 `cloudbaserc.json`（静态托管根目录声明 `./`，忽略 `.git`/`backup`/`class-site-backup.zip`/`source`）。因本环境无 CloudBase MCP/IDE 插件加载机制，按官方 skill §2 走 CLI 兜底。登录/创建环境/部署需站主腾讯云或微信实名账号（`tcb login` 的 OAuth 授权无法由 AI 代点）；envId 落地后回填 `SITE_DATA.siteLinks` 备用项并同步公告。 | 工具链就绪·待站主实名建环境 |
| 2026-08-28 | **涂鸦跳跃领券门槛 5000 → 10000**：`REWARD.threshold` 及 HUD/标题/备注/补发下拉同步改为 10000。物理曲线此前已确保高分段可跳上台阶，无需重调重力。游戏内容，按站规不进公告，仅同步 README/TUTORIAL。 | 已上线 |
| 持续生效 | **【站规】用户要求全量留档与遵守**：① 所有要求写入本台账；② README 顶部加「维护须知」提示；③ 改动前不得违反/跳过已记录要求；④ 冲突先问用户并更新规则；⑤ 提要求后立即 commit+push。 | 生效 |
| 持续生效 | **【站规】通读站规**：每次执行任务前，完整阅读 README 与 TUTORIAL 的「用户要求」章节（第 10 节台账 + 顶部铁律），逐项核对，确保不漏执行任何已记录要求（三处同步 / 隐藏不进公告 / 整站 zip 打包等）。 | 生效 |
| 持续生效 | **【站规】整站备份（zip）**：每次内容更新后，将整个站点（含 `index.html`、`games/`、`manifest.webmanifest`、`sw.js`、`secrets.json.enc` 等，排除 `.git`）重新打包为 `class-site-backup.zip` 并提交推送，确保每次下载都是最新完整版。 | 生效 |
| 持续生效 | **【站规】公告规范**：站内公告文案须简洁、凝练、官方口吻；除「站主杂谈」板块与「用户要求」类公告外，禁用「你 / 我 / 我们」等主观语气词，表达短而完整。 | 生效 |
| 持续生效 | **【站规】印象要求识别**：对话中出现的印象要求（含「如果 / 以后 / 比如」等条件或举例词）一律视为正式要求，即便未明说「记到 Gitee」也须写入台账并同步推送；每次回复前先扫描当前消息是否含新要求。 | 生效 |
| 持续生效 | **【站规】公告分点**：单次更新含多条内容时，站内公告用编号分点（1. 2. 3. …）逐条列出，便于查看；单条内容仍用一句话。 | 生效 |
| 持续生效 | **【站规】仓库内容不进公告**：仓库 / 维护相关内容（站规、zip 打包、README / TUTORIAL 更新说明等）一律不进站内公告；公告只发用户可见的站点功能。已删除此前两条仓库内容公告（23:18 备份包 / 通读站规、23:38 站规更新）。 | 生效 |
| 持续生效 | **【站规】公告分点换行**：分点公告每条之间必须换行（text 内用 `\n`，CSS `white-space:pre-line` 渲染）。 | 生效 |
| 2026-08-26 | **公告查看页增强**：「全部公告」弹窗支持 ① 按板块折叠（点击分类标题 `toggleAnnCat`）② 仅该页显示搜索框 ③ 模糊搜索（相近词词典 `ANN_SYN`，如彩蛋 ↔ 隐藏 ↔ 暗号，猜测意图）④ 范围筛选（板块 `allSearchCat` / 时间 `allSearchTime`：近 7 天 / 近 30 天 / 2026）⑤ 命中 `<mark>` 高亮（`renderAllBoard` / `annMatch` / `annHighlight`）。 | 已上线 |
| 持续生效 | **化解模型差异**：`TUTORIAL.md` 新增「0.1 执行前必读 · 操作清单」，任何模型执行前必须先看操作要求并逐项勾选（读 / 扫 / 判 / 改 / 同步 / 打包 / 提交），防轻量模型漏同步 zip、漏三处同步等。 | 生效 |
| 持续生效 | **对话总结凝练 + 歧义询问 + 省 token**：每次用户对话后先凝练总结要求；有歧义主动询问；回复精炼省 token。 | 生效 |
| 2026-08-27 | **学习资料提示悬浮球**：访问提示弹窗关闭后（未勾选「不再显示」）在右下角显示带红点消息悬浮球（`#studyBubble`），点击重新打开；勾选「不再显示」则不出现悬浮球。 | 已上线 |
| 2026-08-27 | **公告日期筛选升级**：快捷范围改为 近 3 天 / 7 天 / 15 天 / 30 天 / 近半年，并支持自定义起止日期（`#allDateFrom` / `#allDateTo`）。 | 已上线 |
| 2026-08-27 | **公告按时间隐藏**：全部公告可按时间隐藏更早公告（范围同日期筛选，`annDateOk` 支持 3/7/15/30/180 天与 custom 区间），公告条数随之更新；筛选设置持久化（`cls_ann_filter`）。 | 已上线 |
| 2026-08-27 | **夜间自动暗色模式**：18:30~次日 7:30 自动暗色、其余亮色（`isNightTime` 分钟制：>=1110 或 <450）；加载时 `applyAutoTheme` 应用 + 每 30s 检查边界（`_lastAutoNight`）；夜间自动暗色时手动切回亮色 → `confirm` 询问是否关闭自动切换（`cls_theme_auto='off'` 后永不再自动切换）。 | 已上线 |
| 2026-08-27 | **复制链接按钮**：侧边栏底部新增「🔗 复制链接」（`copySiteLink` + `fallbackCopyLink`），一键复制当前网页地址到剪贴板（clipboard API + execCommand 兜底）。 | 已上线 |
| 2026-08-27 | **复制链接弹窗（主+备用结构）**：侧边栏「🔗 复制链接」改为弹窗（`openCopyLink` / `copyOneLink` / `closeCopyLink`），按 `SITE_DATA.siteLinks` 列表渲染（当前仅主链接，备用链接未上线留占位行「敬请期待」）；复制即站点主链接（不再复制当前 location）。 | 已上线 |
| 2026-08-27 | **夜间自动暗色三选弹窗**：夜间手动切亮色改为 `#themeAutoAskMask` 三选——仅这次切换（`themeAskOnce`，切亮并保持自动开启）/ 关闭自动切换（`themeAskOff` 写 `cls_theme_auto='off'`）/ 保持暗色（`closeThemeAutoAsk`）；替代原 confirm 双选。 | 已上线 |
| 2026-08-27 | **全站液态玻璃与动画**：背景光斑漂移动画（`blobA` / `blobB`）、主要表面玻璃化（`--glass-bg` 变量 + `backdrop-filter` 毛玻璃：sidebar / card / allboard-box / install-sec）、卡片流光扫过（`sheen`）、卡片入场（`riseIn` 交错延迟）、弹窗弹出（`popIn`）、按钮按压反馈、主题按钮旋转、FAB 脉冲、页头轻浮动；尊重 `prefers-reduced-motion`。 | 已上线 |
| 2026-08-27 | **四款游戏·已领过再达标处理（印象要求）**：若本周已达过领券目标（本周已领），**暂停游戏**并弹窗提示「本周已领过」，用户可选择 **继续游戏 / 退出游戏**（snake `paused` + `claimContinue/claimExit`；bird/tetris/doodle `pauseForClaimed` + 同理）；原「已领过就静默继续」不再适用。另：**像素飞鸟开局 2 秒无敌**（`invince=Date.now()+2000`，无敌期不判水管/上下边界碰撞、鸟半透明闪烁、边界夹紧不飞出）。 | 已上线 |
| 2026-08-27 | **抽歌前先列全部歌单 + 手动排除**：抽歌面板新增「🎼 歌单管理」——先调 API 列出全部歌曲（标题/歌手/点赞/投稿时间/是否播放），用户可勾选「排除」标记不参与抽签（存 `cls_dj_excluded`，`djGetExcluded/djSetExcluded`），`djRun` 抽签时自动跳过被排除歌曲；排除列表持久化、可随时取消。 | 已上线 |
| 2026-08-27 | **小游戏领券备注来源（确认）**：经 VoiceHub `GET /card-codes` 实测，发券接口 `note` 字段已生效——四款游戏备注分别为「贪吃蛇吃豆60奖励 / 像素飞鸟过40管奖励 / 俄罗斯方块120分奖励 / 涂鸦跳跃3000高奖励」，后台可按备注区分来源；无需改动。 | 已确认 |
| 2026-08-27 | **点歌券管理（站主，并入抽歌面板）**：`openCouponAdmin` 入口从隐藏空间**移入抽歌面板**（与「🎼 歌单管理」并排，受抽歌身份验证保护）：① **添加**——数量+备注，真实调 POST `/card-codes` 生成（旧发券 key xor 混淆密文 `CP_ADMIN_KEY_ENC`）；② **列表**——GET `/card-codes` 展示券码/状态/备注/时间；③ **禁用**——本地标记 `cls_coupon_disabled`（划线+「已禁用」，可恢复）；④ **删除**——**真实删除**：站主在 VoiceHub 后台开放了权限，实测 `DELETE /card-codes?id=XX`（查询参数形式）返回 success，删除后平台与列表同步生效（`cpDelete` 带 confirm 确认）；原「本地隐藏」方案作废。 | 已上线 |
| 2026-08-27 | **小游戏领券需填写名字（备注留痕）**：四款游戏（贪吃蛇/像素飞鸟/俄罗斯方块/涂鸦跳跃）每周**第一次达标领券前**弹「填写领券人」弹窗（`showNameAsk`/`doClaim`/`closeName`），名字必填（空则红框提示）、记忆上次输入（`cls_coupon_name`）；发券备注自动写成「**名字 · 时间（YYYY-MM-DD HH:mm）· 任务**」，如「张三 · 2026-08-27 13:51 · 贪吃蛇吃豆60奖励」。**采用自行输入名字方式**（用户 2026-08-27 提供的 60 人名单下拉方案作废，后续如需名单选择再接入）。另修复贪吃蛇 `showReward` 内 `claimCoupon(score,...)` 引用未定义变量 `score`（应为 `sc`）的潜伏 bug——此前达标领券会抛 ReferenceError 导致券码卡在「正在生成…」。 | 已上线 |
| 2026-08-27 | **点歌人信息显示（确认）**：经探测 VoiceHub `songs.requester`（姓名字符串）与 `schedules.requester`（含姓名/年级/班级对象）均返回点歌人完整信息，**前端一直未渲染——已全部补齐**：① 歌单管理（`renderDjSongs`）每行加「点歌：XXX」；② 抽签结果（`djRun`）每首标「（点歌：XXX · 点赞 N）」；③ 抽签历史（`djRenderHistory`）与一键复制公示（`djCopy`）均显示点歌人；④ 批次存储（`rounds[].songs[].requester`）保存点歌人字段（历史/公示可复用）。`songs.requester` 兼容字符串或对象，统一通过 `typeof==='string'` 取姓名。 | 已上线 |
| 2026-08-29 | **游戏点歌券跨设备防重复（换浏览器不再重复出券）**：根因=`cls_coupon_ledger` 台账在各设备 localStorage 独立，换浏览器即"未领"可重复领（曾实测 3 个浏览器同名字同游戏出 3 张券）。修复=发券前先查点歌平台后台（`GET /api/open/card-codes?page=1&limit=100`，复用发券 key，实测 HTTP 200 有读权限且 CORS 放行 GitHub Pages）：本周内「note 首段名字 + 含 `REWARD.note` 游戏备注 + status=AVAILABLE」命中 → 直接展示该券码（`platformFind`，不再生成），未命中才调生成；按 `createdAt`（浏览器本地时区）与 `weekStartMs()`（本周一 0 点）比较，仅认本周可用券。4 游戏（bird/snake/tetris/doodle）`showReward` 前插 `platformFind`（snake 用 `REWARD_DOTS` 拼 note）；站主补发 `riSubmit` 自动在平台生成统一格式券（`_RI_NOTE` 与游戏端 note 一致），补发同学换设备再领同样被平台查重拦回并找回券码。真机 mock 验证：平台无记录→生成新券（POST=1）；平台有记录（清缓存新浏览器）→展示原券且 POST=0。站内公告已同步。 | 已上线 |
| 2026-08-29 | **井字棋新增 + 五子棋简单档 AI 改进**：① 新增 `games/tictactoe.html`——9 格棋盘，本地双人 + 人机三档（简单=随机空位 / 普通=能赢先赢、能堵先堵、否则中心→角→边 / 困难=minimax，穷举验证后手 O 必不败、玩家最优对局为平局），深色主题、移动端自适应、音效、胜负平记录（`ttt_w`/`ttt_l`/`ttt_d`），已加 `HIDDEN_FUN_LINKS` 卡片（五子棋后）；② 五子棋「简单」档由纯随机改为「抓自己必胜 → 堵对手必胜 → 局势加权随机」（按 `lineScore` 攻+防分做权重抽样），保留随机性但不再乱下，难度梯度 简单<普通<困难 更清晰。游戏内容，按站规不进公告。 | 已上线 |
| 2026-08-29 | **【站规】备用链接实时同步**：用户原话「那个备用链接你也需要实时同步更新的，我这边更新之后呢，您要随时把费用那边更新好」（「费用」= 备用/备用站点，即 WorkBuddy 链接）。要求：**每次站点内容更新后，AI 主动重新发布备用链接，不必再逐次询问授权**；发布口径沿用净化版（排除 `backup/`、`source/`、`secrets.json.enc`、`README.md`、`internal/`、`cloudbaserc.json`、`.gitignore`，备份包需 `.zip` 与无扩展名副本各一份）。已写入第 0 节铁律与本节站规。 | 站规·已生效 |
| 2026-08-29 | **【站规】README 改为对外展示文档**：用户原话「read me 的话，我想要就是类似展示给其他人看的，所以可以不用把一些详细的东西写进去，你可以更多是写一些介绍」。要求：`README.md` 定位为**对外门面**（站点介绍 / 功能一览 / 使用方式 / 在线地址 / 常见问题），**删除**其中的「维护须知（站规）」「令牌管理」「备份与导出」「双仓库同步」「最近更新（技术细节）」等内部内容，全部迁入本文件。已重写 README 并立「文档分工」站规。 | 站规·已生效 |
| 2026-08-29 | **【站规】内部维护文档入口隐藏**：用户原话「那个入口可以隐藏得深一点点，就是尽量不被其他人发现」。要求：本文件由根目录 `TUTORIAL.md` 移至 **`internal/notes.md`**（隐蔽目录 + 无辨识度文件名）；README 不给出任何链接 / 不列入目录结构；仓库内 `class-site-backup.zip` 与线上发布包**排除 `internal/`**；源码注释（`games/snake.html`）去掉文件名，只写「见内部维护文档」。**已向用户说明**：仓库是公开的，隐藏入口只降低被偶然发现的概率，不构成安全保护，真正的敏感信息（令牌 / 口令）本就不入库。 | 站规·已生效 |
| 2026-08-27 | **点歌券管理移动端适配**：用户反馈移动端备注显示不佳。修复：① **添加行**——数量输入与「➕ 添加」按钮同一行（按钮 `margin-left:auto` 靠右），备注 input 单独占下一行（`width:100%`），不再因窄屏挤压；② **列表行**——信息区改为三段式：①券码+状态（`flex-wrap` 自动换行） ②备注独立一行（`overflow:hidden;text-overflow:ellipsis;white-space:nowrap`，长备注显示省略号 + `title` 悬停看全文） ③时间独立一行（灰色小字）；按钮区改为**纵向竖排**（`flex-direction:column`，不挤占信息区空间），`flex-shrink:0` 不会被压扁。实测窄屏（390px）：3 行渲染、长备注省略号截断、按钮竖排两个（禁用/删除），无报错。 | 已上线 |
| 2026-08-27 | **抽歌排期二期（历史/备注/标记/导出导入/排除已排期）**：本地排期改为**批次记录**（每批含 抽取时间 `at` / 备注 `note` / 已排期 `addedToPlatform` / 已播放 `played` 标记，可改备注、勾选标记、删除本批、导出 JSON、导入 JSON、清空全部；旧扁平数据自动迁移为一批）；新增「排除已排期」开关（排除本地历史中已标记 addedToPlatform 的歌曲，「排除已播放」同时考虑 API `played` 与本地标记）；移除「高赞优先」开关（保留「高赞必选 N 首」+ 其余纯随机）；面板顶部描述文字加深（亮色可读），历史弹窗暗色适配。 | 已上线 |
| 2026-08-27 | **四款游戏周常点歌券**：贪吃蛇吃满 60 豆 / 像素飞鸟跨过 40 管 / 俄罗斯方块 120 分 / 涂鸦跳跃 3000 高，各得一张点歌券（VoiceHub card-codes 发券），**每款游戏每周一张、每周一刷新**（`weekKey()` 周一为一周起点，localStorage `song_coupon_w_<game>`）；贪吃蛇文案由 100 改为 60。涂鸦跳跃平台修复：新平台 x 限制在上一平台左右 60~160px（`djNextPlatX`，跳远极限约 200px，避免左右极端跳不过去）。 | 已上线 |
| 2026-08-27 | **【事故+修复】敏感信息安全**：此前 `TUTORIAL.md` 两处明文出现 `secrets.json.enc` 解密口令 + tracked 的 `secrets-hint.txt`（6位数字提示，降低暴力破解难度）+ `scripts/encrypt-secret.sh` & `scripts/decrypt-secret.sh` 入仓。处置：① 工作树：TUTORIAL 脱敏（口令替换为"本地口令（口令不入库）"）、`git rm secrets-hint.txt scripts/*.sh`（保留 `secrets.json.enc` 密文）；② 立新铁律"敏感信息安全（红线）"——线上只传密文、口令永不入库、脚本与提示不入库、提交前 `git grep` 自检；③ **改写 Git 历史**抹除所有 commit 中的明文与 hint 文件并 `force-push`；④ **必须轮换已暴露的密钥**（旧密钥视为已泄露）。⑤ 后续：解密口令已轮换、`secrets.json.enc` 已用新口令重新加密（同 encrypt-secret.sh 方案，往返验证通过，口令值不入库）；另补发现 TUTORIAL 6.1 节曾明文写出导出备份口令，已脱敏并随历史改写一并抹除；学习资料悬浮球改为仅板块内显示。 | 已完成 |
| 2026-08-22~26 | **班级签**：首页「每日日报」上方窄卡片，每天限抽一次，次日 0 点刷新。 | 已上线 |
| 2026-08-22~26 | **彩带彩蛋**：连续切换白天/黑夜主题 3 次触发彩带。 | 已上线 |
| 2026-08-22~26 | **隐藏娱乐天地（小游戏集合）**：陆续新增 贪吃蛇/俄罗斯方块/打地鼠/记忆翻牌/像素飞鸟/打砖块/消消乐/扫雷/涂鸦跳跃/五子棋/象棋/飞机大战，均单文件、深色主题、移动端自适应、含音效与本地最高分；入口在隐藏空间（班徽点 5 次 → 暗号 → 进入）。 | 已上线 |
| 2026-08-26 | **贪吃蛇**：放慢速度；吃满 60 豆发点歌券（VoiceHub 开放 API 创建，每人每天限领一张、每张仅核销一次）；每 10 豆提速；屏幕虚拟方向键（键盘仍可用）；API 令牌加密不明文进仓库。 | 已上线 |
| 2026-08-26 | **全站密码自锁**：站点门禁/资源门禁/导出备份/隐藏暗号统一接入，连续错 3 次锁 30s、再错递增 1/2/5 分钟…，输对清零。 | 已上线 |
| 2026-08-26 | **全站音效**：按钮/卡片点击、抽班级签、彩带彩蛋、密码验证均有音效；侧边栏「音效」开关可关（localStorage 记忆）。 | 已上线 |
| 2026-08-26 | **五子棋**：人机三档（随机/贪心/负极大搜索 depth2）+ 本地双人。 | 已上线 |
| 2026-08-26 | **象棋**：中国象棋传统规则（兵/卒各 5 个隔格摆、含炮位角标），棋子画在格线交叉点，本地双人（无 AI）。 | 已上线 |
| 2026-08-26 | **飞机大战**：放慢敌机节奏（初始约 1.5s/架，每得 50 分加速一档，最快 0.6s/架）。 | 已上线 |
| 2026-08-26 | **扫雷**：雷数自定；移动端「轻点翻开 / 长按约 450ms 标旗」；踩雷后「再来一局」正常重开。 | 已上线 |
| 2026-08-26 | **消消乐**：修复「靠边连消后卡死无法再点」；图标由同形状纯色圆改为 6 种异形强色（圆/方块/三角/星星/菱形/六边形，强对比 + 描边 + 高光）。 | 已上线 |
| 2026-08-26 | **涂鸦跳跃**：移动端由「按住屏幕半边滑动」改为屏幕下方 ◀ 左 / 右 ▶ 虚拟按键。 | 已上线 |
| 2026-08-26 | **打砖块**：关卡系统（5 种布局循环 + 双血砖 + 过关提速 + 最高关卡记录）。 | 已上线 |
| 2026-08-26 | **返回记忆**：从网站跳外链/小游戏返回，自动恢复到跳转前视图（首页/分类/隐藏空间）。 | 已上线 |
| 2026-08-26 | **数据管理**：侧边栏新增导出/复制/导入/重置本地数据（游戏最高分、记录、班级签等）。 | 已上线 |
| 2026-08-26 | **联系人余子康**：新增 QQ 号 3271065361（加密存储，可查看/复制）。 | 已上线 |
| 2026-08-26 | **公告彩蛋提示**：站内公告保留一条模糊提示，只说「藏着彩蛋和隐藏空间、自己去探索」，不透露触发方法/密码。 | 已上线 |
| 2026-08-22 | **回声洞（LeanCloud 后端）**：用户经评估后放弃，未实施。 | 已放弃 |

