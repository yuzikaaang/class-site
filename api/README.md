# 用户系统后端部署指南

> 25级05班班级服务站的**登录 + 云同步 + 管理员后台**后端。
> 技术：Vercel Serverless Functions + Neon Postgres，全部在免费额度内。

---

## 一、整体架构

```
┌──────────────────────┐        ┌──────────────────────────┐
│  前端（GitHub Pages）  │        │  后端（Vercel）           │
│  index.html          │ HTTPS  │  /api/auth   登录注册      │
│  · 账号弹窗           │ ─────▶ │  /api/data   个人数据同步  │
│  · 个人中心           │ Bearer │  /api/admin  管理员后台    │
│  · 管理后台           │ token  │         │                 │
└──────────────────────┘        └─────────┼────────────────┘
                                          │ SQL（HTTP 传输）
                                          ▼
                                ┌──────────────────────────┐
                                │  Neon Postgres（免费 0.5GB）│
                                │  users / sessions         │
                                │  user_data / audit_log    │
                                └──────────────────────────┘
```

**前端不动，只加 API**——这是站主选定的方案，所以跨域是必须处理的事。

> 📌 **关于仓库平台**：Vercel **只支持 GitHub / GitLab / Bitbucket** 导入，
> **不支持 Gitee**。本站源码仓库就是 GitHub 上的 `yuzikaaang/class-site`，
> 因此 Vercel 直接连它即可，无需中转。Gitee 上那份是历史镜像，
> 且 Gitee Pages 已于 2024 年永久下线，不再作为部署来源。

---

## 二、部署步骤（约 15 分钟）

### 前置：确认代码在 GitHub 上

Vercel 只能连 **GitHub / GitLab / Bitbucket**（**不支持 Gitee**）。
本站源码仓库在 GitHub：`https://github.com/yuzikaaang/class-site`。

推代码上去（在项目根目录执行，**只需做一次**）：

```bash
git remote add github https://github.com/yuzikaaang/class-site.git
git push -u github master
```

> ⚠️ 若该仓库此前**只放过 GitHub Pages 的产物**（仓库里只有 HTML/静态文件、
> 没有 `api/`、`vercel.json`、`package.json`），直接推会因历史冲突失败。
> 两种处理方式，任选其一：
>
> **A. 仓库还能用 → 强制覆盖**（会丢掉仓库里原有的所有历史，仅当那些内容不重要时用）
> ```bash
> git push -u github master --force
> ```
>
> **B. 更干净 → 在 GitHub 新建一个空仓库**（比如 `class-site-src`），然后
> ```bash
> git remote add github https://github.com/yuzikaaang/class-site-src.git
> git push -u github master
> ```
> 新建仓库**不要勾** "Add a README"，保持全空，否则推的时候还要先拉一次。

> 💡 **GitHub Pages 不受影响**：Pages 是仓库的 Settings → Pages 里单独配的，
> 面向 `gh-pages` 分支或某个目录出页面。往 `master` 推源码**不会**动到它。
> 推完记得去仓库 **Settings → Pages** 确认 Source 仍指向正确的分支。

### 第 1 步：建 Neon 数据库

1. 打开 <https://neon.tech>，用 GitHub 或邮箱注册（免费）
2. 创建项目 → 区域选 **AWS / Singapore**（离国内最近）
3. 进入 **Connection Details**，复制连接串，形如：
   ```
   postgresql://user:pass@ep-xxx-pooler.ap-southeast-1.aws.neon.tech/neondb?sslmode=require
   ```
   > ⚠️ 优先用**带 `-pooler`** 的那个（连接池版）。Serverless 场景下它更稳。

4. 在 Neon 左侧 **SQL Editor** 里，把 `api/schema.sql` 的内容整段粘贴执行，建好 4 张表

### 第 2 步：部署后端到 Vercel

1. 打开 <https://vercel.com>，用 GitHub 登录（授权后 Vercel 才能读你的仓库）
2. **Add New → Project** → 在列表里选 `class-site` 仓库 → Import
   > 如果列表里没有：点 **Adjust GitHub App Permissions** 授予该仓库访问权。
3. 配置（**很重要**）：
   - **Framework Preset**：`Other`
   - **Root Directory**：保持 `./`（仓库根目录）
   - **Build Command**：留空
   - **Output Directory**：留空
4. 展开 **Environment Variables**，添加下面这些（值见 `api/.env.example`）：

   | 变量名 | 说明 | 示例 |
   |---|---|---|
   | `DATABASE_URL` | Neon 连接串 | `postgresql://...neon.tech/neondb?sslmode=require` |
   | `ADMIN_USERS` | 管理员用户名（逗号分隔） | `zikang` |
   | `ALLOW_ORIGINS` | 允许跨域的前端地址 | `https://yuzikaaang.github.io` |
   | `SESSION_DAYS` | 登录保持天数 | `30` |
   | `ALLOW_REGISTER` | 是否开放注册 | `1` |

   > `ALLOW_ORIGINS` **必须填你前端的真实域名**（GitHub Pages 的域名，
   > 形如 `https://yuzikaaang.github.io`），不填浏览器会因跨域拒绝请求。
   > 多个用英文逗号分隔，**结尾不要带斜杠**。
   > 本地调试时可临时填 `*`，上线后改回具体域名。

5. 点 **Deploy**，等 1 分钟左右
6. 部署完拿到地址，形如 `https://class-site-xxxx.vercel.app`

### 第 3 步：把后端地址填进前端

打开 `index.html`，找到这一行（约 4400 行附近）：

```javascript
var API_BASE_DEFAULT = '';
```

改成你的 Vercel 地址：

```javascript
var API_BASE_DEFAULT = 'https://class-site-xxxx.vercel.app';
```

保存 → 推到 GitHub → 同学们强刷页面即可。

### 第 4 步：注册管理员

**第一个注册的账号自动成为管理员**（同时 `ADMIN_USERS` 名单里的用户名注册后也是管理员）。

所以：**你自己第一个去注册**，用户名填 `zikang`，这样你就有管理权限了。

---

## 三、API 一览

所有接口前缀 `/api`，鉴权用 `Authorization: Bearer <token>`。

### 认证 `/api/auth`

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `?action=register` | 注册（body: `username` / `password` / `displayName`） |
| POST | `?action=login` | 登录，返回 `token` |
| POST | `?action=logout` | 登出（销毁当前 token） |
| GET | `?action=me` | 当前用户信息 + 云端已有键列表 |
| POST | `?action=change-password` | 改密码（body: `oldPassword` / `newPassword`） |

### 数据同步 `/api/data`

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/data` | 拉全部云端数据（`items` + 每项 `updatedAt`） |
| GET | `?key=xxx` | 拉某一条 |
| PUT | `/api/data` | 写入（body: `{ items: { k: v } }` 批量，或 `{ key, value }` 单条） |
| DELETE | `?key=xxx` | 删除某一条 |

> ⚠️ 只能同步**白名单内**的键（个人数据），站内容同步不了。
> 白名单在 `api/data.js` 的 `ALLOW_KEYS` 里，新增同步项改那里 + 前端 `CLOUD_KEYS`。

### 管理员 `/api/admin`（需 `role=admin`）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `?action=users` | 用户列表（含每人云端数据条数） |
| GET | `?action=user&id=N` | 用户详情 + 其全部云端数据 + 在线设备 |
| GET | `?action=stats` | 统计（注册数/活跃/占用/最常用键） |
| GET | `?action=audit` | 操作日志 |
| POST | `?action=reset-password` | 重置密码（并踢下线） |
| POST | `?action=set-status` | 启用/禁用 |
| POST | `?action=set-role` | 设为管理员/普通用户 |
| POST | `?action=set-data` | 修改某用户的某条数据 |
| POST | `?action=delete-data` | 删除某用户的某条数据 |
| POST | `?action=delete-user` | 删号（云端数据级联清除） |
| POST | `?action=clear-sessions` | 强制某用户全部设备下线 |

---

## 四、安全设计说明

| 措施 | 说明 |
|---|---|
| **密码哈希** | bcrypt（10 轮），数据库里没有明文密码，站主也看不到 |
| **登录时序攻击防护** | 用户不存在时也走一次 bcrypt 比对，避免通过响应时间探测用户名 |
| **Bearer Token** | 32 字节随机数，存 `sessions` 表；**不用 Cookie**，避开微信对第三方 Cookie 的限制 |
| **数据隔离** | 每个用户的读写都带 `user_id` 条件，跨用户访问在 SQL 层就被挡掉 |
| **键白名单** | 只能同步个人数据键，防止有人往里塞垃圾撑爆库 |
| **体积限制** | 单条 200KB、单用户 2000 条，超了直接拒绝 |
| **自我保护** | 管理员不能禁用/删除/降级自己，避免把管理权限玩没了 |
| **凭据不泄露** | 管理接口只返回 token 前 8 位，完整 token 不出现在响应里 |
| **审计日志** | 所有管理操作记入 `audit_log`，可追溯 |
| **CORS 白名单** | 只放行你配置的前端域名，其他站点调不通 |

> ⚠️ **没做的事**（要清楚）：没有邮箱验证、没有验证码、没有找回密码。
> 忘记密码只能找管理员重置。对班级内部使用够，但如果链接流到班外，
> 建议把 `ALLOW_REGISTER` 设成 `0` 关闭自助注册，改成管理员开号。

---

## 五、本地开发与测试

项目里带了本地测试脚手架（`local_bridge.js` + `testsrv.js`），
让 `api/` 的代码能连本地 Postgres 跑端到端测试——因为
`@neondatabase/serverless` 走 HTTP 协议，连不了本地库。

```bash
# 1. 装依赖
npm install

# 2. 起本地 Postgres（或用 Docker）
sudo service postgresql start
sudo -u postgres psql -c "create user clstest with password 'clstest123' superuser;"
sudo -u postgres createdb -O clstest classsite

# 3. 建表
PGPASSWORD=clstest123 psql -h 127.0.0.1 -U clstest -d classsite -f api/schema.sql

# 4. 起测试服务器
DATABASE_URL="postgresql://clstest:clstest123@127.0.0.1:5432/classsite" \
ADMIN_USERS="zikang" ALLOW_ORIGINS="*" PORT=8912 node testsrv.js

# 5. 前端连本地后端：在 index.html 里设
#    var API_BASE_DEFAULT = 'http://localhost:8912';
```

> `testsrv.js` 和 `local_bridge.js` 只是本地测试用，**部署到 Vercel 时不会被调用**
> （Vercel 只按 `api/` 目录下的文件生成函数）。可以保留，也可以删掉。

---

## 六、免费额度够用吗

| 项目 | 免费额度 | 你们班的量级 |
|---|---|---|
| Neon 存储 | 0.5 GB | 60 人 × 每人几十条 JSON ≈ **几 MB**，绰绰有余 |
| Neon 计算 | 191.9 小时/月 | 流量小的话基本用不完；怕超就把 Neon 设成「空闲自动挂起」 |
| Vercel 函数调用 | 100 GB·小时/月 | 班级日活几十人，远用不到 |
| 冷启动 | Neon 有约 1s 冷启动 | 同学感知不太明显，可接受 |

> 结论：**完全够用，不会产生费用**。真要超了，Neon 会在控制台提醒你。

---

## 七、常见问题

**Q：Vercel 能导入 Gitee 仓库吗？**
A：**不能**。Vercel 官方只支持 GitHub / GitLab / Bitbucket 三家。
本站源码本来就在 GitHub（`yuzikaaang/class-site`），直接连它即可。
如果以后想继续用 Gitee 做镜像，两者可以并存——GitHub 推 Vercel 部署，
Gitee 只是备份，互不干扰（但记得两边都推，否则代码会不同步）。

**Q：`ALLOW_ORIGINS` 填错了会怎样？**
A：浏览器控制台报 CORS 错误，登录/同步全部失败。检查三点：
① 域名拼写是否完全一致（含 `https://`）；② 结尾是否多带了 `/`；
③ 修改环境变量后是否**重新部署**（Vercel 改环境变量不会自动生效，要 Redeploy）。

**Q：同学打开页面卡在「加载中」？**
A：检查 `ALLOW_ORIGINS` 是否填对了前端域名（结尾不要带 `/`）。

**Q：登录后数据没同步？**
A：云同步是**登录后手动点「立即同步」**触发的，不会自动上传全部数据。
页面关闭时会补推一次（用 `sendBeacon`）。

**Q：换了手机怎么恢复？**
A：新设备打开站点 → 登录同一账号 → 点「从云端恢复」。

**Q：想关闭自助注册？**
A：Vercel 环境变量把 `ALLOW_REGISTER` 改成 `0`，重新部署。

**Q：怎么让同学也能当管理员？**
A：管理后台用户列表里点「设为管理员」。

**Q：数据库连接数被打爆？**
A：不会。用的是 `@neondatabase/serverless`（HTTP 传输，不走长连接池），
这正是为了避开 Serverless 的连接数陷阱。
