# 25级05班班级服务站 - 使用与维护教程

> 本文件用于在对话卡顿时快速恢复上下文。每次修改流程或要求后，应及时更新本文件和 README.md。

## 0. 模型无关性（最重要）

**本仓库是唯一内容源**。任何 AI（DeepSeek / ChatGPT / Claude / Gemini / 任意模型 / 任意新对话）只要能访问 Gitee 仓库（用 `secrets-hint.txt` 提示的密码解密 `secrets.json.enc` 拿令牌），就能完整接手本项目，**无需依赖任何特定对话的记忆**。

请遵守：
- 所有内容、规则、偏好、决策都应**沉淀到本仓库**（`README.md` / `TUTORIAL.md` / 站内公告 / 源码注释）
- 不要只在对话里口头约定一件事——必须同步写入仓库
- 用户提到新规则时，立即更新 `TUTORIAL.md` 对应章节 + 站内公告 + 必要时同步 `README.md`
- 每次结束前确认本次所有改动已 commit + push 到 Gitee
- **铁律 · 三处同步**：任何内容改动（新增/调整/修复功能）都必须同步更新三处、缺一不可——① `index.html` 的站内公告（`SITE_DATA.announcements`，新条目放数组末尾、带 `date` 与 `category`）② `README.md` 的「最近更新」③ `TUTORIAL.md` 的「更新记录」表。隐藏/彩蛋类不进公告，但仍需记在 TUTORIAL。详见第 7 节检查清单。
> - **铁律 · 用户要求**：用户提出的**所有要求**必须逐条写入本文件「用户要求台账」（第 10 节）；每次改动前须核对台账、**不得违反或跳过任何已记录的用户要求**；若当前需求与过往要求矛盾，**必须向用户确认并同步更新规则**，不得擅自取舍；用户每次提出要求或需求变更后，**立即 commit + push 到 Gitee**。README 顶部「维护须知」同步提示此规。
> - **铁律 · 通读站规**：每次执行任务前，必须完整阅读 `README.md` 与 `TUTORIAL.md` 的「用户要求」章节（第 10 节台账 + 顶部铁律），逐项核对，确保不漏执行任何已记录要求（三处同步 / 隐藏不进公告 / 整站 zip 打包等）。
> - **铁律 · 整站备份**：每次内容更新后，必须将整个站点（含 `index.html`、`games/`、`manifest.webmanifest`、`sw.js`、`secrets.json.enc` 等，排除 `.git`）重新打包为 `class-site-backup.zip` 并提交推送，确保站主每次下载到的都是最新完整版。
> - **铁律 · 敏感信息安全（红线）**：① **线上只上传密文**——仓库内**严禁**出现任何明文口令 / 密钥 / API Token / 加密提示；唯一允许提交的是 `secrets.json.enc`（AES-256-CBC + PBKDF2 密文）。② 解密口令**永不入库**：不得写入 `README` / `TUTORIAL` / 任何源码注释 / commit message / hint 文件；口令由维护者**本地记忆**，解密过程**仅在本地**完成。③ 加密脚本与提示文件**不入库**（`secrets-hint.txt`、`scripts/encrypt-secret.sh`、`scripts/decrypt-secret.sh` 等一律 `.gitignore` / 不跟踪）。④ 历史上若发生过口令 / 密钥明文入库事故，必须：a) 立即**轮换被暴露的密钥**（旧密钥视为已泄露）；b) **改写 Git 历史**将明文从所有 commit 中抹除并 force-push；c) 在 TUTORIAL 更新记录中留档事故与处置。⑤ 提交前自检：`git grep` 搜索口令、token、key、hint、password 等关键词必须为空。
> - **铁律 · 公告规范**：站内公告须**简洁、凝练、官方口吻**；除「站主杂谈」与「用户要求」类外不得出现「你 / 我 / 我们」等主观语气词；**只发用户可见的站点功能，仓库 / 维护内容（站规、zip 打包、README / TUTORIAL 更新说明等）一律不进公告**；分点公告每条之间**必须换行**（text 内用 `\n`，CSS `white-space:pre-line` 渲染）。

### 0.1 执行前必读 · 操作清单（化解模型差异）

> 目的：任何 AI 模型（DeepSeek / 轻量模型 / 任意新对话）执行本站任务时，可能因模型能力差异漏步骤（如忘记同步 zip、漏三处同步、该进公告的没进、仓库内容误进公告）。**无论用什么模型，每次执行前必须完整读完本清单并按序执行，不得凭记忆或摘要省略。**

1. **读**：完整阅读 `README.md`「维护须知」+ 本文件第 0 节全部铁律 + 第 10 节「用户要求台账」+ 本清单。
2. **扫**：扫描用户本次消息，找出所有要求 / 印象要求（含「如果 / 以后 / 比如」等词）→ 新要求先记入第 10 节台账。
3. **判**：判断改动性质——用户可见站点功能 → 可发公告（按公告规范）；仓库 / 维护 / 隐藏内容 → **不进公告**，只记 README + TUTORIAL；公告分点 → 每条用 `\n` 换行。
4. **改**：完成功能改动；确认 token 不明文、`manifest.webmanifest` / `sw.js` 路径未被误改。
5. **同步**：① `index.html` 公告（如适用）② `README.md`「最近更新」③ `TUTORIAL.md`「更新记录」。
6. **打包**：重打包 `class-site-backup.zip`（排除 `.git`）。
7. **提交**：`git add` 全部改动文件 → commit → push 到 Gitee。
8. **回显**：回复中逐项勾选本清单（读 / 扫 / 判 / 改 / 同步 / 打包 / 提交），确保无遗漏。
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

- **仓库唯一源 + 三处同步**：Gitee 为唯一内容源；任何改动同步 ① 站内公告（`index.html` 的 `SITE_DATA.announcements`）② `README.md`「最近更新」③ `TUTORIAL.md`「更新记录」。
- **隐藏/彩蛋不进公告**：小游戏、隐藏空间类改动只同步 README / TUTORIAL，不写站内公告；仅保留一条模糊彩蛋提示（只说「藏着彩蛋和隐藏空间、自己去探索」，不透露触发方法/密码）。
- **令牌不明文**：所有 API / 令牌一律不明文进仓库（VoiceHub Key 存 `secrets.json.enc`，由本地口令解密，**口令一律不入库**；前端用混淆密文运行时解密）。
- **用户要求全量留档与遵守**：所有要求写入本台账；改动前不违反已记录要求；冲突先问用户并更新规则；提要求后立即 `commit + push`。
- **通读站规**：每次执行任务前，完整阅读 README 与 TUTORIAL 的「用户要求」章节，逐项核对，确保不漏执行任何已记录要求（三处同步 / 隐藏不进公告 / 整站 zip 打包等）。
- **整站备份（zip）**：每次内容更新后，将整个站点（含 `index.html`、`games/`、`manifest.webmanifest`、`sw.js`、`secrets.json.enc` 等，排除 `.git`）重新打包为 `class-site-backup.zip` 并提交推送，确保每次下载都是最新完整版。
- **敏感信息安全（红线）**：① 线上只上传密文——严禁明文口令/密钥/Token/加密提示入仓；仅 `secrets.json.enc` 可提交。② 解密口令永不入库（不入 README/TUTORIAL/注释/commit/hint），由维护者本地记忆，解密仅在本地完成。③ 加密脚本与提示文件不入库（`secrets-hint.txt`、`scripts/*.sh` 一律不跟踪）。④ 历史口令/密钥明文入库事故处置：立即轮换暴露密钥 + 改写 Git 历史抹除明文并强推 + 更新记录留档。⑤ 提交前 `git grep` 自检口令/token/key/hint/password 必须为空。
- **公告规范**：站内公告须简洁、凝练、官方口吻；除「站主杂谈」与「用户要求」类外禁用「你/我/我们」等主观语气词；**只发用户可见的站点功能，仓库/维护内容（站规、zip 打包、README/TUTORIAL 更新说明等）不进公告**；分点公告每条换行（`\n`）。
- **印象要求识别**：对话中含「如果/以后/比如」等条件或举例词的要求，即便未明说也视为正式要求，记入台账并推送。
- **公告分点**：单次更新含多条内容时，站内公告用编号分点（1. 2. 3. …）列出，每条换行。
- **对话总结凝练**：每次用户对话后先凝练总结要求；有歧义主动询问；回复精炼省 token。

### 历史功能要求

| 日期 | 用户要求 | 状态 |
|------|----------|------|
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
| 2026-08-27 | **【事故+修复】敏感信息安全**：此前 `TUTORIAL.md` 两处明文出现 `secrets.json.enc` 解密口令 + tracked 的 `secrets-hint.txt`（6位数字提示，降低暴力破解难度）+ `scripts/encrypt-secret.sh` & `scripts/decrypt-secret.sh` 入仓。处置：① 工作树：TUTORIAL 脱敏（口令替换为"本地口令（口令不入库）"）、`git rm secrets-hint.txt scripts/*.sh`（保留 `secrets.json.enc` 密文）；② 立新铁律"敏感信息安全（红线）"——线上只传密文、口令永不入库、脚本与提示不入库、提交前 `git grep` 自检；③ **改写 Git 历史**抹除所有 commit 中的明文与 hint 文件并 `force-push`；④ **必须轮换已暴露的密钥**（旧密钥视为已泄露）。 | 处置中 |
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

