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
| 4 | `guide.html` | 「首页」一章里加一条 `<div class="item" data-topic="key">`，写清位置/作用/提示，并配一张截图 |
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

## 六之二、新增一个「板块导览」（v4.13.0）

除首页外，常用服务、作业弹窗、成绩分析、大屏、设置、文件中转站各有独立导览，
场景名见 `tour-map.json`。新增一个板块导览时：

| 步 | 改哪儿 | 具体做什么 |
| --- | --- | --- |
| 1 | `tour.js` | 在 `STEPS` 里加一个场景数组，每步写 `sel` 或 `sels`（多个目标取第一个可见的） |
| 2 | `scripts/tour-map.json` | 加同名场景，列出同样的 key |
| 3 | `app.js` / `big.js` | 在该板块**打开的位置**加一行 `try{ if(window.TOUR) TOUR.maybe('场景名', 900); }catch(e){}` |
| 4 | `guide.html` | 对应章节里加 `data-topic="key"` 条目 |
| 5 | `tour.js` 的 `SCENES` | 把场景名加进数组，设置「帮助」页签才会统计到它 |

`TOUR.maybe()` 内部会判断该场景是否已完成、当前是否有弹窗遮挡，不满足条件就直接返回，
所以可以放心挂在每次打开的地方，不必自己写判断。

## 六之三、教程截图（v4.13.0）

截图放在 `img/guide/`，文件名与章节对应（`home-top / sidebar / services / hwpop / scores /
big-home / big-hw / clock / settings / files / login`）。重新生成：

```bash
node scripts/build.mjs                      # 先保证本地是最新版本号
node /tmp/guide-shots2.mjs                  # 本地 8899 端口起服务后跑，覆盖 img/guide/*.jpg
```

两条固定检查：

- **图片文件必须存在**：`guide.html` 里 `<img src>` 指向的文件缺失就拦。
- **`img` 必须是整目录进发布清单**：写 `img/guide` 会被 `cp -r` 成 `_site/guide/`，
  线上 `/img/guide/*.jpg` 全 404（v4.13.0 踩过）。
