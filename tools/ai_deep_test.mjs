/* v3.16.3 验证：单科视角 / 追问 / 详细程度 / 目标 / 全班诊断 / 时钟毫秒+白噪音音量 */
/* v3.16.3：AI 的单科 / 追问 / 详细程度 / 目标 / 班级诊断 + 时钟毫秒与白噪音音量
   跑法：先 `python3 -m http.server 8111`，再 node tools/ai_deep_test.mjs */
import { chromium } from 'playwright-core';

const BASE = 'http://127.0.0.1:8111';
const browser = await chromium.launch({
  executablePath: '/root/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome',
  args: ['--no-sandbox'],
});
let pass = 0, fail = 0;
const t = (n, ok, x) => { ok ? pass++ : fail++; console.log((ok ? '  ✓ ' : '  ✗ ') + n + (ok || !x ? '' : '  → ' + x)); };

const SUBJECTS = [
  { key: 'chinese', name: '语文', full: 150, graded: false },
  { key: 'math', name: '数学', full: 150, graded: false },
  { key: 'english', name: '英语', full: 150, graded: false },
  { key: 'physics', name: '物理', full: 100, graded: false },
  { key: 'chemistry', name: '化学', full: 100, graded: true },
  { key: 'biology', name: '生物', full: 100, graded: true },
];
const exam = { id: 901, name: '冒烟测试月考', date: '2026-10-01', subjects: SUBJECTS, cutlines: [{ label: '一本线', score: 520 }], gradeRef: { students: 500 } };
const plan = [['张三', 641], ['李四', 630], ['王五', 621], ['赵六', 610], ['孙七', 588], ['周八', 561], ['吴九', 512], ['郑十', 470]];
const rows = plan.map(([name, total], i) => {
  const r = { id: 900 + i, uid: 900 + i, name, schoolRank: 300 + i, leagueRank: 1100 + i, s: {} };
  let left = total;
  SUBJECTS.forEach((sub, k) => {
    const v = k === SUBJECTS.length - 1 ? left : Math.round(total * (sub.full / 750));
    if (k < SUBJECTS.length - 1) left -= v;
    r.s[sub.key] = { raw: v, assigned: sub.graded ? v + 5 : null, rank: 100 + i, asgRank: 90 + i };
  });
  return r;
});
const json = (o) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });

const ctx = await browser.newContext({ viewport: { width: 420, height: 900 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const page = await ctx.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push(e.message.slice(0, 160)));
page.on('console', (m) => { if (m.type() === 'error') { const l = m.location(); errs.push('CONSOLE ' + m.text().slice(0, 120) + ' @' + (l && l.url)); } });

let captured = [];
await page.addInitScript(() => {
  localStorage.setItem('cls_login_guide_v1', '1');
  localStorage.setItem('cls_welcome_v1', '1');
  localStorage.setItem('cls_auth', JSON.stringify({ token: 'smoke-token', user: { id: 900, displayName: '张三', role: 'user' } }));
});
await page.route('**/chat/completions', async (route) => {
  captured.push(route.request().postData());
  const sse = ['## 结论\n', '这次总分 641，班排第 **1**。\n\n', '## 下一步\n1. 先补物理\n']
    .map((c) => 'data: ' + JSON.stringify({ choices: [{ delta: { content: c } }] }) + '\n\n').join('') + 'data: [DONE]\n\n';
  await route.fulfill({ status: 200, contentType: 'text/event-stream', body: sse });
});
await page.route('**/api/**', async (route) => {
  const u = new URL(route.request().url());
  if (u.pathname.endsWith('/api/scores')) {
    const a = u.searchParams.get('action');
    if (a === 'list') return route.fulfill(json({ ok: true, exams: [exam], config: { access: 'on' } }));
    if (a === 'board') return route.fulfill(json({ ok: true, exam, rows }));
    if (a === 'me') return route.fulfill(json({ ok: true, items: [] }));
    if (a === 'config') return route.fulfill(json({ ok: true, config: { access: 'on' } }));
    return route.fulfill(json({ ok: true }));
  }
  return route.fulfill(json({ ok: true }));
});

await page.goto(BASE + '/index.html', { waitUntil: 'domcontentloaded', timeout: 120000 });
await page.waitForTimeout(2200);
await page.evaluate(() => { try { AUTH.user = { id: 900, displayName: '张三', role: 'user' }; } catch (e) {} });
await page.evaluate(() => { if (typeof openCat === 'function') openCat(3); });
await page.waitForTimeout(1500);
await page.evaluate(() => { if (typeof scSetTab === 'function') scSetTab('me'); });
await page.waitForTimeout(1500);

/* ---------- 1. 视角切换 ---------- */
const tabs = await page.evaluate(() => [...document.querySelectorAll('[data-ai="me"] .ai-tab')].map((b) => b.textContent));
t('卡里出现「总览 / 单科」两个视角', tabs.length === 2 && tabs.join(',') === '总览,单科', tabs.join(','));
await page.click('[data-ai="me"] .ai-tab[data-tab="subj"]');
await page.waitForTimeout(500);
const chips = await page.evaluate(() => [...document.querySelectorAll('[data-ai="me"] .ai-chip')].map((b) => b.textContent));
t('单科视角列出六科', chips.length === 6 && chips.includes('数学'), chips.join(','));
await page.click('[data-ai="me"] .ai-chip[data-subj="math"]');
await page.waitForTimeout(500);
const subjBody = await page.evaluate(() => {
  const c = document.querySelector('[data-ai="me"]');
  return { concl: (c.querySelector('.sc-ai-concl') || {}).textContent || '', badge: (c.querySelector('[data-ai-badge]') || {}).textContent || '' };
});
t('单科本地版换成了数学', /数学/.test(subjBody.concl), subjBody.concl.slice(0, 50));
t('单科视角角标回到「本地规则」', /本地规则/.test(subjBody.badge), subjBody.badge);

/* ---------- 2. 详细程度 + 目标 ---------- */
await page.evaluate(() => {
  localStorage.setItem('cls_ai_cfg_v1', JSON.stringify({ provider: 'deepseek', base: 'https://api.deepseek.com/v1', model: 'deepseek-chat', temp: 0.6, depth: 'deep', goal: '下次月考进班级前 10' }));
});
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2200);
await page.evaluate(() => { try { AUTH.user = { id: 900, displayName: '张三', role: 'user' }; } catch (e) {} });
await page.evaluate(() => { if (typeof openCat === 'function') openCat(3); });
await page.waitForTimeout(1200);
await page.evaluate(() => { if (typeof scSetTab === 'function') scSetTab('me'); });
await page.waitForTimeout(1500);
/* 重新填一次 Key（上面 reload 前 Key 是空的，这里直接写混淆值太麻烦，改用 UI 保存） */
await page.click('[data-ai-act="cfg"]');
await page.waitForTimeout(400);
const dlg2 = await page.evaluate(() => {
  const d = document.getElementById('aiDlg');
  return { depth: d.querySelector('#aiDepthSel').value, goal: d.querySelector('#aiGoalInp').value, tip: (d.querySelector('#aiDepthTip') || {}).textContent };
});
t('弹窗回显「详细」和目标', dlg2.depth === 'deep' && /前 10/.test(dlg2.goal), JSON.stringify(dlg2));
await page.fill('#aiKeyInp', 'sk-fake-for-test');
await page.click('#aiSave');
await page.waitForTimeout(700);

const goalChip = await page.evaluate(() => (document.querySelector('[data-ai="me"] .ai-goal') || {}).textContent || '');
t('卡片上显示目标 chip', /前 10/.test(goalChip), goalChip);

/* ---------- 3. 单科 AI 请求 ---------- */
captured = [];
await page.click('[data-ai="me"] .ai-tab[data-tab="subj"]');
await page.waitForTimeout(400);
await page.click('[data-ai="me"] .ai-chip[data-subj="physics"]');
await page.waitForTimeout(400);
await page.click('[data-ai="me"] [data-ai-act="run"]');
await page.waitForTimeout(1800);
const req1 = captured[0] ? JSON.parse(captured[0]) : null;
const u1 = req1 ? req1.messages[1].content : '';
t('单科分析发起了请求', captured.length === 1, 'captured=' + captured.length);
t('单科 payload 只说这一科', /【这一科】/.test(u1) && /物理/.test(u1), u1.slice(0, 80));
t('单科 payload 不含其他科的名字', !/【各科】/.test(u1));
t('详细档写进了系统提示词', !!(req1 && /「详细」档/.test(req1.messages[0].content)));
t('详细档 max_tokens 放开了', !!(req1 && req1.max_tokens >= 2000), req1 && String(req1.max_tokens));
t('目标写进了用户消息', /【我的目标】/.test(u1) && /前 10/.test(u1), u1.slice(-160));

/* ---------- 4. 追问 ---------- */
captured = [];
await page.fill('[data-ai="me"] [data-ai-chatin]', '物理这科到底该从哪补？');
await page.click('[data-ai="me"] [data-ai-act="chat"]');
await page.waitForTimeout(1800);
const req2 = captured[0] ? JSON.parse(captured[0]) : null;
const roles = req2 ? req2.messages.map((m) => m.role) : [];
t('追问带上了历史（system/user/user）', roles.length >= 3 && roles[1] === 'user' && roles[2] === 'user', roles.join(','));
t('最后一条就是我的问题', !!(req2 && /该从哪补/.test(req2.messages[req2.messages.length - 1].content)));
const bubbles = await page.evaluate(() => ({
  u: [...document.querySelectorAll('[data-ai="me"] .ai-bub.u')].map((e) => e.textContent),
  a: [...document.querySelectorAll('[data-ai="me"] .ai-bub.a')].map((e) => e.textContent.trim().slice(0, 20)),
}));
t('对话气泡渲染（我问 + 它答）', bubbles.u.length === 1 && bubbles.a.length === 1, JSON.stringify(bubbles));

/* ---------- 5. 全班成绩单的班级诊断 ---------- */
await page.evaluate(() => { if (typeof scSetTab === 'function') scSetTab('board'); });
await page.waitForTimeout(1500);
const board = await page.evaluate(() => {
  const c = document.querySelector('[data-ai="board"]');
  if (!c) return null;
  return {
    concl: (c.querySelector('.sc-ai-concl') || {}).textContent || '',
    ks: [...c.querySelectorAll('.sc-ai-k')].map((e) => e.textContent),
    todo: (c.querySelector('.sc-ai-todo') || {}).textContent || '',
    hasBtn: !!c.querySelector('[data-ai-act="run"]'),
  };
});
t('成绩单下面出现班级诊断卡', !!board, JSON.stringify(board && board.ks));
t('本地版有学科 / 上线 / 需关注', board && board.ks.includes('学科') && board.ks.includes('上线') && board.ks.includes('需关注'), board && board.ks.join(','));
t('本地版给了「最值得做的三件事」', board && /最值得做的三件事/.test(board.todo), board && board.todo.slice(0, 40));

captured = [];
await page.click('[data-ai="board"] [data-ai-act="run"]');
await page.waitForTimeout(1800);
const req3 = captured[0] ? JSON.parse(captured[0]) : null;
const u3 = req3 ? req3.messages[1].content : '';
t('班级诊断走班主任视角', /班主任/.test(u3), u3.slice(0, 60));
t('班级 payload 带需关注名单', /需要关注的学生/.test(u3), u3.slice(0, 60));
t('班级 payload 里没有人名泄漏', !/张三|李四|王五|赵六/.test(captured.join('')));

/* ---------- 6. 时钟：毫秒开关 + 白噪音音量 ---------- */
await page.goto(BASE + '/clock.html', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1000);
await page.evaluate(() => {
  document.getElementById('modeBtn').click();
  const b = document.querySelector('#modeMenu [data-m="timer"]');
  if (b) b.click();
  document.getElementById('modeMenu').className = '';
});
await page.waitForTimeout(500);
const t0 = await page.evaluate(() => window.__clk.text(65 * 1000, true));
t('正计时默认只到秒（01:05）', t0 === '01:05', t0);

await page.evaluate(() => {
  document.getElementById('aboutBtn').click();
});
await page.waitForTimeout(400);
const optTxt = await page.evaluate(() => (document.getElementById('tmOpts') || {}).textContent || '');
t('设置在「计时」里给了百分秒开关', /百分秒/.test(optTxt), optTxt);
const noiseUi = await page.evaluate(() => {
  const inp = document.getElementById('noiseVolInp');
  return { has: !!inp, val: inp ? inp.value : null, label: (document.getElementById('noiseVolVal') || {}).textContent };
});
t('白噪音有音量滑杆', noiseUi.has && noiseUi.val === '70', JSON.stringify(noiseUi));
await page.evaluate(() => {
  const inp = document.getElementById('noiseVolInp');
  inp.value = '30';
  inp.dispatchEvent(new Event('input', { bubbles: true }));
});
await page.waitForTimeout(300);
const volAfter = await page.evaluate(() => {
  const c = JSON.parse(localStorage.getItem('cls_clock_cfg') || '{}');
  return { cfg: c.noiseVol, val: (document.getElementById('noiseVolVal') || {}).textContent };
});
t('拖滑杆会改配置并回显', Number(volAfter.cfg) === 0.3 && volAfter.val === '30%', JSON.stringify(volAfter));

await page.evaluate(() => {
  const segs = document.querySelectorAll('#tmOpts .seg');
  segs[segs.length - 1].querySelectorAll('button')[0].click();   // 第二行 = 百分秒开关，点「开」
});
await page.waitForTimeout(300);
const t1 = await page.evaluate(() => window.__clk.text(65 * 1000, true));
t('打开后出现百分秒', /class="ms"/.test(t1), t1);
const t2 = await page.evaluate(() => window.__clk.text(3725 * 1000, true));
t('超过一小时补出小时位', t2.replace(/<[^>]+>/g, '').indexOf('1:02:05') === 0, t2);

t('无 JS 报错', errs.length === 0, errs.slice(0, 3).join(' | '));
console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
await browser.close();
process.exit(fail ? 1 : 0);
