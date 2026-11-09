#!/usr/bin/env node
/* ============================================================================
 * push-gitee.mjs —— 一键推送到 Gitee（站主指定路线）
 * ----------------------------------------------------------------------------
 * 站主原话（2026-11-09）：
 *   「我们推送是推送到 Gitee 上的，你去找 GitHub 是没有用的；Gitee 会自动同步
 *     源码到 GitHub。推送用 token 的方式，token 在服务站后台的令牌管理里面。」
 *
 * 所以这里把那条流程固化成一条命令：
 *   ① 用维护账号登录取 token（口令不写进仓库：环境变量或 ~/.cls_ai_pass）
 *   ② 读 /api/admin?action=secrets 里的 GITEE_TOKEN（后台「令牌管理」那一页）
 *   ③ git push 到 Gitee（令牌只在命令行参数里出现一次，不写文件、不进 remote）
 *
 * 用法：
 *   node scripts/push-gitee.mjs              # 推当前分支到 master
 *   node scripts/push-gitee.mjs master       # 指定远端分支
 * ========================================================================= */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const API = process.env.CLS_API || 'https://api.classsite.dpdns.org';
const USER = process.env.CLS_AI_USER || 'aibot';
const PASS = process.env.CLS_AI_PASS
  || (() => { try { return fs.readFileSync(path.join(os.homedir(), '.cls_ai_pass'), 'utf8').trim(); } catch (e) { return ''; } })();
const BRANCH = process.argv[2] || 'master';
const OWNER = 'zikang0529';
const REPO = 'class-site';

if (!PASS) {
  console.error('❌ 没有维护账号口令：设置 CLS_AI_PASS，或写入 ~/.cls_ai_pass');
  process.exit(1);
}

async function json(url, opt) {
  const r = await fetch(url, opt);
  const t = await r.text();
  try { return JSON.parse(t); } catch (e) { throw new Error(url + ' 返回的不是 JSON：' + t.slice(0, 120)); }
}

const login = await json(API + '/api/auth?action=login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: USER, password: PASS }),
});
if (!login.token) {
  console.error('❌ 登录失败：' + (login.message || '没有拿到 token'));
  process.exit(1);
}

const sec = await json(API + '/api/admin?action=secrets', {
  headers: { Authorization: 'Bearer ' + login.token },
});
const list = Array.isArray(sec.secrets) ? sec.secrets : [];
const row = list.find((x) => x && (x.name === 'GITEE_TOKEN' || x.name === 'gitee'));
if (!row || !row.value) {
  console.error('❌ 后台令牌管理里没有 GITEE_TOKEN（/api/admin?action=secrets）');
  process.exit(1);
}

const url = 'https://' + OWNER + ':' + row.value + '@gitee.com/' + OWNER + '/' + REPO + '.git';
try {
  execFileSync('git', ['push', url, 'HEAD:' + BRANCH], {
    cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname), '..'),
    stdio: ['ignore', 'inherit', 'inherit'],
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  console.log('\n✅ 已推送到 Gitee（' + OWNER + '/' + REPO + ' ' + BRANCH + '）');
  console.log('   Gitee 会自动同步到 GitHub，前端一般 20 秒内生效；');
  console.log('   动了 api/worker.mjs 时 Cloudflare 最多 3 分钟，每 1 分钟看一次就行。');
} catch (e) {
  console.error('❌ 推送失败：' + (e.message || e));
  process.exit(1);
}
