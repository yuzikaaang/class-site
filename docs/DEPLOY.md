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
