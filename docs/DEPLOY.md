# 发布 / 部署规矩（站主定的，代码里也写了一份）

> 这份文档只为一件事：**别再每次重新摸一遍流程**。
> 门禁 `scripts/predeploy.mjs` 跑完会把同样的内容打一遍。

## 一、推到哪儿

| 项 | 值 |
| --- | --- |
| 唯一远端 | Gitee `zikang0529/class-site` |
| 同步 | Gitee 自动同步到 GitHub，GitHub Pages 出页面 |
| 推送方式 | token（PAT），**不要**去查 GitHub 的提交记录 |
| token 在哪 | 服务站后台「令牌管理」→ `/api/admin?action=secrets` 里的 `GITEE_TOKEN` |

一条命令推完（会自动取 token，用完即弃，不落盘）：

```bash
node scripts/push-gitee.mjs
```

## 二、等多久算生效

| 改了什么 | 最长等待 | 怎么看 |
| --- | --- | --- |
| 只改前端（html/js/css） | **20 秒** | 每 20 秒拉一次 `index.html` 里的版本号 |
| 动了 `api/worker.mjs`（Cloudflare Worker） | **3 分钟** | 每 1 分钟看一次，别 5 秒一刷 |

## 三、怎么验收

用**内置浏览器打开线上地址看真实效果**（截图 + 页内取值），
不要把整页下载下来比哈希 —— 又慢又费 token，还看不出「排版对不对」。

## 四、版本号规矩

- 三段号 `主.小.修`，第一段只有站主发话才动。
- **中版本（第二段）节奏：6 小时**。距上一个中版本首发不到 6 小时，只能升小版本；
  超过 6 小时才可以开新的中版本。（2026-11-09 站主要求从 12 小时改成 6 小时）
- 同一批次共用一条公告：公告标题写 `vX.Y 更新`，后面 `vX.Y.1`、`vX.Y.2` 的内容
  都追加进这一条，不新开。
- 部署前必须：本地 `REL_BUILTIN` 有这一条、云端 `release_notes` 有这一条、
  公告里已追加本次内容、措辞过得了门禁。

## 五、门禁一条龙

```bash
node scripts/build.mjs          # 重打 app.min.js / version.json
node scripts/predeploy.mjs      # 六道闸门 + 备份，过了才准推
node scripts/push-gitee.mjs     # 推 Gitee
```

## 六、新增一个首页板块：五步，一步都不能少（v4.12.0）

站主原话（2026-11-11）：「后续我可能会加一些新内容，新内容也需要同时去适配，
所以这个也要加门禁。」门禁的比对源有四个，都在 `scripts/predeploy.mjs` 的 ③j。

| 步 | 改哪儿 | 具体做什么 |
| --- | --- | --- |
| 1 | `index.html` | 板块 `<section>` 上加 `data-topic="key"`（key 用小写英文，短） |
| 2 | `scripts/tour-map.json` | 在 `scenes.home.steps` 里加这个 key |
| 3 | `tour.js` | `STEPS.home` 里加一步：`{ t:'key', sel:'#元素id', title:'…', text:'…' }` |
| 4 | `guide.html` | 「首页八个区块」里加一条 `<div class="item" data-topic="key">`，写清位置/作用/提示 |
| 5 | 跑门禁 | `node scripts/predeploy.mjs --dry-run`，四者齐了才放行 |

漏了会报成这样，直接点名缺哪个 key：

```
❌ 部署已阻止：首页板块与导览登记不一致：
   · 首页有 data-topic 但登记表没写：album
❌ 部署已阻止：使用教程与登记表不一致：
   · 登记了但 guide.html 没有说明条目：album
```

另外两条固定检查：

- **锚点必须真实存在**：`tour.js` 里 `sel:'#xxx'` 在 `index.html` 找不到就拦，
  否则导览会定位到屏幕左上角（元素被改名后最容易出这个）。
- **新文件必须进两个清单**：`sw.js` 的 `PRECACHE`（断网可用）和
  `.github/workflows/deploy-pages.yml` 的 `SOURCE_FILES`（否则线上 404）。

只加登录弹层里的说明时，只改 `tour.js` 的 `STEPS.login` 与 `tour-map.json` 的
`scenes.login.steps`，首页那四个来源不动。
