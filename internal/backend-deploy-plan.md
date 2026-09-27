# 后端部署施工图（Vercel + Neon）

> **当前状态：已暂停，等站主有空再继续。**
> 后端代码已全部写完并跑通测试，教程已备好，随时可以接着做。
> 预计剩余工作量：**约 30 分钟**（主要是建仓储 + 填环境变量 + 验证）。

---

## 一、现在是什么情况（一句话）

代码都写好了，本地测试也全通过，**卡在"怎么把代码交给 Vercel"这一步** —— 因为现有 GitHub 仓库里掺了太多无关东西（历史备份、另一个 React 项目），Vercel 认不清哪个才是要部署的。

**解法很明确：新建一个干净的仓库专门放部署文件。**

---

## 二、已完成的部分（不用重做）

| 项目 | 状态 |
|---|---|
| 后端代码（8 个文件） | ✅ 写完，`api/` 目录下 |
| 数据库建表脚本 | ✅ `api/schema.sql`，已在 Neon 跑过 |
| **Neon 数据库** | ✅ **已建好，4 张表已建**（项目 `class-site` / 分支 `production`） |
| 前端账号界面 | ✅ 写完（登录/注册弹窗、个人中心、管理后台） |
| 本地端到端测试 | ✅ 后端 65/65、前端 46/46 通过 |
| Vercel 配置文件 | ✅ 已修正为现行写法 |

**Neon 已建好这点很重要** —— 你之前已经在 Neon 上执行过建表脚本了，那步不用重来。只需要重新拿一次连接串。

---

## 三、剩下的活儿（照着做就行）

### 第 1 步：整理出一份"部署专用"的精简目录

现有仓库 `/workspace/class-site` 里东西太杂。需要挑出**运行必需的**，另存一份。

**必需文件清单：**

```
class-site-deploy/
├── api/                        ← 后端（整个目录，8 个文件）
│   ├── _lib/
│   │   ├── db.js
│   │   └── http.js
│   ├── auth.js
│   ├── data.js
│   ├── admin.js
│   ├── schema.sql
│   └── .env.example
├── index.html                  ← 前端主文件（500KB，全站就这一个）
├── sw.js                       ← Service Worker
├── manifest.webmanifest        ← PWA 配置
├── favicon.svg
├── icon-192.png
├── icon-512.png
├── qrcode.jpg                  ← 公众号二维码
├── games/                      ← 小游戏（index.html 里有 14 处引用）
├── homework/                   ← 作业图片
├── vercel.json                 ← Vercel 配置
├── package.json                ← 后端依赖声明
├── package-lock.json
└── .gitignore
```

**不要放的：**
- ❌ `source/` —— 那个 Vite + React 项目，就是它干扰了 Vercel
- ❌ `backup/` —— 75MB 历史备份
- ❌ `class-site-backup.zip` —— 1.1MB
- ❌ `internal/` —— 内部笔记
- ❌ `node_modules/`
- ❌ `.git/` —— 不要带历史，新建仓库重新开始

> 💡 打包命令（在沙箱里执行）：
> ```bash
> mkdir -p /workspace/class-site-deploy
> cd /workspace/class-site
> cp -r api index.html sw.js manifest.webmanifest favicon.svg \
>       icon-192.png icon-512.png qrcode.jpg games homework \
>       vercel.json package.json package-lock.json .gitignore \
>       /workspace/class-site-deploy/
> cd /workspace/class-site-deploy && rm -rf api/.env api/node_modules
> ```

---

### 第 2 步：GitHub 新建空仓库

1. 打开 https://github.com/new
2. Repository name：**`class-site-deploy`**（或随意，别和现有的重名）
3. **不要勾** "Add a README file"
4. Private / Public 都行（Vercel 支持私有仓库）
5. Create repository

---

### 第 3 步：把精简目录推上去

在 `class-site-deploy` 目录里执行：

```bash
cd class-site-deploy
git init
git branch -M master
git add -A
git commit -m "班级服务站：前端 + 账号后端（部署专用精简仓库）"
git remote add origin https://github.com/yuzikaaang/class-site-deploy.git
git push -u origin master
```

> ⚠️ 如果 GitHub 要求登录：用 **Personal Access Token** 代替密码
> （GitHub → Settings → Developer settings → Personal access tokens → 生成，勾 `repo` 权限）

推完检查：GitHub 仓库里应该能看到 `api/`、`index.html`、`vercel.json` 等，**没有** `source/`、`backup/`。

---

### 第 4 步：拿 Neon 连接串

1. 打开 https://neon.tech → 进 `class-site` 项目
2. 左侧点 **Connect**（或 **Postgres database**）
3. 复制连接串，**必须带 `-pooler`**：
   ```
   postgresql://neondb_owner:xxxxx@ep-xxx-pooler.c-2.ap-southeast-1.aws.neon.tech/neondb?sslmode=require
   ```
4. **表已经建好了，不用再跑 SQL**（你之前跑过了）

---

### 第 5 步：Vercel 导入

1. https://vercel.com → 用 GitHub 登录
2. **Add New → Project** → 选 **`class-site-deploy`**（新仓库！）
3. 配置：
   - **Framework Preset**：`Other`
   - **Root Directory**：`./`（留默认）
   - **Build Command**：**留空**
   - **Output Directory**：**留空**
4. 展开 **Environment Variables**，填这 5 个：

   | Name | Value |
   |---|---|
   | `DATABASE_URL` | Neon 连接串（整条粘全，含 `?sslmode=require`） |
   | `ADMIN_USERS` | `zikang` |
   | `ALLOW_ORIGINS` | `https://yuzikaaang.github.io` |
   | `SESSION_DAYS` | `30` |
   | `ALLOW_REGISTER` | `1` |

   > ⚠️ `ALLOW_ORIGINS` **结尾千万别带 `/`**

5. 点 **Deploy**，等 1 分钟

---

### 第 6 步：验证后端活了

拿到地址（形如 `https://class-site-deploy-xxx.vercel.app`）后，浏览器直接打开：

```
https://你的地址.vercel.app/api/auth?action=me
```

**期望看到**：一串 JSON，类似
```json
{"ok":false,"error":"未登录"}
```

- ✅ 看到 JSON → **后端成功**
- ❌ 404 或 HTML 页面 → 函数没被识别，检查 `api/` 目录是否推上去了
- ❌ 500 → 看 Vercel 的 Functions 日志

---

### 第 7 步：把地址填进前端

打开 `index.html`（**注意：原来的主仓库那份**），找到约 4390 行：

```javascript
var API_BASE_DEFAULT = '';
```

改成（**注意结尾不带斜杠**）：

```javascript
var API_BASE_DEFAULT = 'https://class-site-deploy-xxx.vercel.app';
```

- 这份 `index.html` **推回主仓库**（`git push` 到 Gitee，镜像自动同步 GitHub）
- ⚠️ 如果第 3 步是从精简仓库出的页面，那这里也要同步改精简仓库那份

> 🤔 **这里有个待决定的事**：以后 `index.html` 到底以哪个仓库为准？
> 三种选择见下方「五、后续要做的决定」。

---

### 第 8 步：注册管理员

1. 打开网站 → 点侧边栏 **👤 登录 / 注册**
2. **你自己第一个注册**，用户名填 `zikang`
3. **第一个注册的账号自动成为管理员**

> ⚠️ **必须你先注册**。被同学抢先的话，你得找那个同学开权限。

---

## 四、以后怎么用（日常维护）

| 场景 | 操作 |
|---|---|
| 改前端（`index.html`） | 改主仓库 → 推 Gitee → 镜像同步 GitHub |
| 改后端（`api/*.js`） | 改精简仓库 → 推 GitHub → Vercel **自动重新部署** |
| 看后端日志 | Vercel → 项目 → Logs |
| 改环境变量 | Vercel → Settings → Environment Variables → **改完必须 Redeploy 才生效** |
| 关掉自助注册 | 环境变量 `ALLOW_REGISTER` 改 `0` → Redeploy |
| 忘记管理员密码 | 找另一个管理员重置，或直接在 Neon 里改 |

---

## 五、后续要做的决定（等你回来想清楚）

### ① `index.html` 以哪个仓库为准？

| 方案 | 说明 | 优劣 |
|---|---|---|
| **A. 主仓库为准** | 精简仓库只放 `api/` + 一个"占位" `index.html` | ✅ 简单，前端只改一处<br>❌ Vercel 上也有一份没用的前端 |
| **B. 精简仓库为准** | 前端后端都放精简仓库，主仓库只留历史 | ✅ Vercel 上前后端同域，**不用配 CORS**<br>❌ 要改发布流程，两处同步 |
| **C. 干脆前端也搬 Vercel** | 站点直接部署在 Vercel，废弃 Pages | ✅ 最简单，同域没跨域问题<br>❌ 链接要换，同学们得重新收藏 |

> 💡 **我的建议是 C**。你现在的痛点是"前端在 Pages、后端在 Vercel"这种分离架构带来的跨域、CORS、两处同步问题。如果**前后端都放 Vercel**，这些全没了 —— 而且 Vercel 免费额度也够。缺点是链接会从 `yuzikaaang.github.io/class-site/` 变成 `xxx.vercel.app`，需要重新通知同学（或者绑个自定义域名解决）。

### ② GitHub 那个空的 `main` 分支

现在 GitHub 仓库有 `main`（空壳）+ `master`（真内容）。**删不删都行**，Vercel 导入时手动选 `master` 即可。想删的话：

```bash
# 先改默认分支为 master：Settings → General → Default branch → 切到 master
# 然后删除
git push https://github.com/yuzikaaang/class-site.git --delete main
```

### ③ Gitee 镜像同步

现在是 **Gitee → GitHub 单向、定时同步**（不是实时）。

⚠️ **重要**：**别在 GitHub 上手动改代码** —— 下次镜像同步会覆盖掉。

---

## 六、本次已排掉的坑（供参考）

部署失败的原因，已定位两个：

| 坑 | 现象 | 状态 |
|---|---|---|
| `vercel.json` 里写了废弃的 `"runtime": "nodejs20.x"` | 报 `Serverless Function contains invalid runtime` | ✅ 已修 |
| `source/` 是个完整 React 项目，干扰框架识别 | Vercel 误当主项目构建 → 失败 | ✅ 精简仓库方案可绕过 |
| 仓库太重（141 提交 / .git 222MB / backup 75MB） | 克隆慢、易超时 | ✅ 精简仓库方案可绕过 |

---

## 七、出问题了怎么办

| 现象 | 排查 |
|---|---|
| 部署失败，报 runtime 相关 | 检查 `vercel.json` 里**没有** `runtime` 字段 |
| 部署失败，报构建相关 | 检查仓库里**没有** `source/` 目录 |
| `/api/*` 全部 404 | 检查 `api/` 目录推上去了没；Vercel 项目设置的 Root Directory 是不是 `./` |
| 前端登录报 CORS 错 | 检查 `ALLOW_ORIGINS` 是否完全等于前端域名（含 `https://`、不带结尾 `/`）；改完要 Redeploy |
| 登录后过一会掉线 | 正常，token 默认 30 天过期 |
| 数据库连不上 | 检查 `DATABASE_URL` 是否带 `-pooler`、是否含 `?sslmode=require` |
| 改了环境变量没生效 | **Vercel 改环境变量不会自动重部署**，要手动 Redeploy |

---

## 八、关键文件索引

| 文件 | 作用 |
|---|---|
| `api/README.md` | 后端完整部署文档（架构、API 一览、安全设计、FAQ） |
| `api/schema.sql` | 建表脚本（已在 Neon 跑过） |
| `api/.env.example` | 环境变量模板 |
| `api/auth.js` | 登录/注册/改密码 |
| `api/data.js` | 云同步（读/写/删） |
| `api/admin.js` | 管理员后台接口 |
| `api/_lib/db.js` | 数据库连接（Neon 无服务器版） |
| `api/_lib/http.js` | CORS、响应封装、鉴权 |

---

## 九、安全提醒

- **`.env` 绝不入库**（`.gitignore` 已配好）
- **管理员令牌只返回前 8 位**
- **密码用 bcrypt 哈希**，数据库里没明文
- ⚠️ **去 Gitee 吊销旧令牌**：之前推代码用的那个令牌，现在主力转 GitHub 了，建议到 Gitee → 设置 → 私人令牌里**直接吊销**
