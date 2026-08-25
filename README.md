# 25级05班班级服务站（静态站点）

25级05班 一站式班级服务网站，聚合常用链接、公告、倒计时、公众号二维码等，可在微信内直接打开并添加到主屏幕。

## 在线地址

| 平台 | 链接 | 说明 |
|------|------|------|
| **GitHub Pages（主链接）** | `https://yuzikaaang.github.io/class-site/` | 当前主链接；Gitee→GitHub 镜像自动同步，内容随仓库实时更新。Gitee 与 GitHub 仓库均已公开 |
| WorkBuddy（应急备用，已取消常驻） | 由维护者按需临时重新发布 | 主链接打不开时，临时向 AI 申请重新发布获取新链接；常规不再作为分发入口 |

## 目录结构

```
.
├── index.html              # 网站本体（单文件，直接编辑这里）
├── manifest.webmanifest    # PWA 配置
├── sw.js                   # Service Worker（离线兜底 + 实时更新）
├── favicon.svg             # 站点图标
├── icon-192.png            # PWA 图标
├── icon-512.png
├── qrcode.jpg              # 班级公众号二维码
├── class-site-backup.zip   # 完整版备份包（站内密码验证后下载，每次更新后重新生成）
├── secrets.json.enc        # 令牌加密文件（密码提示见 secrets-hint.txt）
├── secrets-hint.txt        # 密码提示（不含真实密码）
├── scripts/                # 令牌加密/解密脚本
├── source/                 # 早期 React 工程，仅作追溯，不参与线上
├── README.md               # 本文件
└── TUTORIAL.md             # 完整维护教程（供新对话快速恢复上下文）
```

## 使用方式

- **查看/编辑内容**：直接编辑根目录 `index.html`（网站本身就是这一个文件）。
- **资源规范**：
  - 图标类：使用图床直链。
  - 二维码类：直接放入仓库根目录（避免图床审核不过）。
- **路径规范**：所有本地资源统一使用相对路径（`./xxx`），以同时兼容 WorkBuddy 根路径部署和 GitHub Pages 子路径部署。
- **主链接更新**：修改 `index.html` 后推送到 Gitee，Gitee→GitHub 镜像自动同步，GitHub Pages 通常几分钟内刷新（强制刷新用 `Ctrl/Cmd + F5`）。
- **安装到手机**：用手机浏览器打开链接 → 菜单「添加到主屏幕」，即可像 APP 一样使用，内容随网站实时更新。

## 双仓库同步

- **Gitee 主仓库（已公开）**：`https://gitee.com/zikang0529/class-site`
- **GitHub 主链接仓库（已公开）**：`https://github.com/yuzikaaang/class-site`

由于 WorkBuddy 沙箱无法直连 GitHub，GitHub 同步通过 **Gitee 仓库镜像管理** 完成：

1. Gitee 仓库 → 管理 → 仓库镜像管理 → 添加镜像
2. 方向：Gitee → GitHub，地址：`https://github.com/yuzikaaang/class-site`
3. 使用 GitHub Token 认证，开启自动同步

GitHub Pages 在 GitHub 仓库 Settings → Pages 中开启（选择 `master` 分支 `/(root)`）。

## 备份与导出

- 网站内置「导出备份」功能（侧边栏底部按钮）：输入备份密码后下载完整版 `class-site-backup.zip`（含全部网站内容）。
- 备份密码在站内以 SHA-256 哈希存储，不在源码中出现明文。
- 导出 zip 由维护者每次内容更新后同步更新。

## 令牌管理

- 令牌已加密存储在 `secrets.json.enc`（AES-256-CBC + PBKDF2 迭代 20 万次），**密码由维护者保管**。
- **密码提示：6 位数字**（详见 `secrets-hint.txt`，不包含真实密码）。
- 新对话需要编辑仓库时，向 AI 提供密码即可解密获取账号与令牌。
- 解密：`./scripts/decrypt-secret.sh <密码>`；加密：`./scripts/encrypt-secret.sh <密码>`。
- 不要在文档或对话中明文暴露令牌。

## 说明

- 线上链接仅做「静态文件 → 网页链接」的转换，不在本仓库构建。
- `source/` 为早期 React 工程，仅供追溯，不参与线上服务。
- 详细维护教程请查看 [TUTORIAL.md](./TUTORIAL.md)。

## 最近更新

- 2026-08-25：修复站内所有密码输入失效（哈希校验函数 `sha256Hex` 被重复定义覆盖，统一为同步版）；作业查看卡片 Classworks 说明更正（校园网限制导致班级电脑端连不上服务器、无法同步云端），「前往 Classworks」入口排到第一位。
- 2026-08-25：主链接切换为 GitHub Pages（`https://yuzikaaang.github.io/class-site/`），原 WorkBuddy 分享链接取消常驻、改为应急备用；Gitee 与 GitHub 仓库均已公开。
- 2026-08-25：公告系统重构（按网站内部/班级事务/班级活动/站主杂谈四类分组 + 置顶 Classworks 通知）；学习资料新增网络限制提示弹窗；作业查看卡片新增「当前作业/历史日历」按钮；PWA 主图标升级为 512；公告时间改回精确到分。
- 2026-08-25：修复每日日报卡片空白问题；班级公告时间精确到秒；导出密码错误提示增强。
- 2026-08-25：修复日报卡片排版（被压缩成一团）；修复首次输入正确密码仍报错的 bug（异步哈希未 await）；密码显示切换按钮换为更精致的 SVG 图标。
