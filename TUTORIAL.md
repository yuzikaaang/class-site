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
| 2026-08-26 | ① 贪吃蛇门槛定为**吃 60 个豆**（`REWARD_DOTS=60`），新增**屏幕虚拟方向键**（替代触摸滑动，键盘保留）；② **全站密码自锁**：站点门禁/资源门禁/导出备份/隐藏暗号统一接入 `LOCK_LEVELS` 机制——连续输错超 3 次锁 30s，再错递增 1/2/5/10/30/60 分钟，状态持久化（刷新无效），输对清零。修复一个坑：`until` 字段曾用 `|0` 位运算导致毫秒时间戳溢出、锁定失效。详见 5.5。 |
| 2026-08-26 | 贪吃蛇正式规则（测试通过）：发券门槛定为 **吃 100 个豆**（`REWARD_DOTS`）；**渐进加速**——每吃 10 个豆提速 10ms（175→下限 80ms）；控制为方向键/滑动。站内公告已从旧「30 分」更新为新规则。另记录：后续其他活动可通过同一 VoiceHub API 发券（复用 `claimCoupon()` 三件套，见 5.4）。 |
| 2026-08-26 | 点歌券触发条件由「得分」改为「蛇身长度」：`REWARD_LENGTH`（当前**临时为 5** 供测试，正式建议 32，调回时同步更新站内公告）。**令牌不明文铁律**：VoiceHub key 移入 `secrets.json.enc`（新增 `voicehub` 字段，密码 本地口令 解密），前端改为 xor+hex 混淆密文 `_CPN_ENC` + `_cpnDec()` 运行时解密；以后所有 API/令牌一律不明文进仓库。详见第 5.4 节。 |
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

