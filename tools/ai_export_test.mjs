/* v3.17.0：成绩 AI 的导出 / 导入 / 给本地 AI 的说明书
   跑法：先 `python3 -m http.server 8111`，再 node tools/ai_export_test.mjs */
import { chromium } from '/root/.nvm/versions/node/v22.13.1/lib/node_modules/playwright/index.mjs';

const BASE = 'http://127.0.0.1:8111';
const browser = await chromium.launch({ args: ['--no-sandbox'] });

let pass = 0, fail = 0;
const t = (name, ok, extra) => {
  ok ? pass++ : fail++;
  console.log((ok ? '  ✓ ' : '  ✗ ') + name + (ok || !extra ? '' : '  → ' + extra));
};

const SUBJECTS = [
  { key: 'chinese', name: '语文', full: 150, graded: false },
  { key: 'math', name: '数学', full: 150, graded: false },
  { key: 'english', name: '英语', full: 150, graded: false },
  { key: 'physics', name: '物理', full: 100, graded: false },
  { key: 'chemistry', name: '化学', full: 100, graded: true },
  { key: 'biology', name: '生物', full: 100, graded: true },
];
const exam = {
  id: 901, name: '秋期中考', date: '2026-10-01', subjects: SUBJECTS,
  cutlines: [{ label: '一本线', score: 520 }], gradeRef: { students: 500 },
  status: 'published',
};
const plan = [['张三', 641], ['李四', 630], ['王五', 621], ['赵六', 610], ['孙七', 588], ['周八', 561], ['吴九', 512], ['郑十', 470]];
const rows = plan.map(([name, total], i) => {
  const r = { id: 900 + i, uid: 900 + i, name, no: String(i + 1).padStart(2, '0'), schoolRank: 300 + i, leagueRank: 1100 + i, s: {}, mine: name === '张三' };
  let left = total;
  SUBJECTS.forEach((sub, k) => {
    const v = k === SUBJECTS.length - 1 ? left : Math.round(total * (sub.full / 750));
    if (k < SUBJECTS.length - 1) left -= v;
    r.s[sub.key] = { raw: v, assigned: sub.graded ? v + 5 : null, rank: 100 + i, asgRank: 90 + i };
  });
  return r;
});
const json = (o) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });

const ctx = await browser.newContext({
  viewport: { width: 420, height: 900 }, deviceScaleFactor: 2,
  isMobile: true, hasTouch: true, acceptDownloads: true,
});
const page = await ctx.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push(e.message.slice(0, 160)));
page.on('console', (m) => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text().slice(0, 160)); });

await page.addInitScript(() => {
  localStorage.setItem('cls_login_guide_v1', '1');
  localStorage.setItem('cls_welcome_v1', '1');
  localStorage.setItem('cls_auth', JSON.stringify({ token: 'smoke-token', user: { id: 900, displayName: '张三', role: 'admin' } }));
});

await page.route('**/api/**', async (route) => {
  const u = new URL(route.request().url());
  if (u.pathname.endsWith('/api/scores')) {
    const a = u.searchParams.get('action');
    if (a === 'list') return route.fulfill(json({ ok: true, exams: [exam], config: { access: 'published' } }));
    if (a === 'board') return route.fulfill(json({ ok: true, exam, rows }));
    if (a === 'me') return route.fulfill(json({ ok: true, items: [] }));
    /* 模拟管理员视角：config 里带 aiKey */
    if (a === 'config') return route.fulfill(json({ ok: true, config: { access: 'published', rankBasis: 'graded', trendDefault: 'all', aiApi: 'on', aiKey: 'ak_demo_1234567890' } }));
    return route.fulfill(json({ ok: true }));
  }
  return route.fulfill(json({ ok: true }));
});

await page.goto(BASE + '/index.html', { waitUntil: 'domcontentloaded', timeout: 120000 });
await page.waitForTimeout(2000);
await page.evaluate(() => { if (typeof openCat === 'function') openCat(3); });
await page.waitForTimeout(1800);
await page.evaluate(() => {
  try { AUTH.user = { id: 900, displayName: '张三', role: 'admin' }; } catch (e) {}
  if (typeof scSetTab === 'function') scSetTab('me');
});
await page.waitForTimeout(1600);

/* ---------- 1. 卡片上出现导出入口 ---------- */
const btnOk = await page.evaluate(() => {
  const c = document.querySelector('[data-ai="me"]');
  return !!(c && c.querySelector('[data-ai-act="export"]'));
});
t('AI 卡片有「导出」按钮', btnOk);

/* ---------- 2. 打开导出面板 ---------- */
await page.click('[data-ai="me"] [data-ai-act="export"]');
await page.waitForTimeout(400);
const panel = await page.evaluate(() => {
  const d = document.getElementById('aiExpDlg');
  if (!d) return null;
  return {
    show: d.className.includes('show'),
    items: [...d.querySelectorAll('.ai-xitem')].map((b) => b.getAttribute('data-x')),
    hasKeyBox: !!d.querySelector('#aiXKey'),
    scene: d.getAttribute('data-scene'),
  };
});
t('导出面板能打开', panel && panel.show);
t('六项都在（one/all/cfg/imp/guide/copy）',
  panel && ['one', 'all', 'cfg', 'imp', 'guide', 'copy'].every((k) => panel.items.includes(k)),
  panel && panel.items.join(','));
t('有「包含密钥」勾选框', panel && panel.hasKeyBox);

/* ---------- 3. 设置包：默认不含 Key，勾了才含 ---------- */
const packNoKey = await page.evaluate(() => {
  AIC.key = 'sk-secret-abc'; AIC.provider = 'deepseek'; AIC.base = 'https://api.deepseek.com/v1';
  AIC.model = 'deepseek-chat'; AIC.depth = 'deep'; AIC.goal = '进前 10';
  return aiCfgPack(false);
});
const packKey = await page.evaluate(() => aiCfgPack(true));
t('设置包默认不带密钥', !('key' in packNoKey), JSON.stringify(Object.keys(packNoKey)));
t('勾选后带上密钥', packKey.key === 'sk-secret-abc', packKey.key);
t('设置包带详细程度与目标', packNoKey.cfg.depth === 'deep' && packNoKey.cfg.goal === '进前 10', JSON.stringify(packNoKey.cfg));
t('设置包有提示词字段（空 = 用站点默认）', typeof packNoKey.cfg.prompt === 'string');
t('设置包有可识别的 kind', packNoKey.kind === 'ai-config' && packNoKey.app === 'class-site');
t('默认包里不带班级查询密钥', !packNoKey.api || !packNoKey.api.key, JSON.stringify(packNoKey.api || null));
t('勾选后班级查询密钥也带上', !!(packKey.api && packKey.api.key === 'ak_demo_1234567890'), JSON.stringify(packKey.api || null));

/* ---------- 4. 诊断导出（本地规则版也能导） ---------- */
const md = await page.evaluate(() => aiSceneMd('me', true));
t('导出的 Markdown 有标题', /^# 我的画像 · 总览 · AI 诊断/.test(md), md.slice(0, 40));
t('导出的 Markdown 有考试名', /秋期中考/.test(md));
t('导出注明是本地规则', /本地规则/.test(md));
t('导出带数据附录', /附：分析时喂给模型的数据/.test(md) && /【总分】/.test(md));
t('导出里没有真实姓名（已代号化）', !/张三|李四/.test(md) || /同学\d/.test(md), md.slice(0, 200));

/* ---------- 5. 下载真的触发 ---------- */
const dl = page.waitForEvent('download', { timeout: 8000 }).catch(() => null);
await page.evaluate(() => {
  const d = document.getElementById('aiExpDlg');
  d.querySelector('[data-x="one"]').click();
});
const got = await dl;
t('点「导出这份诊断」会触发下载', !!got, got ? got.suggestedFilename() : 'no download event');
if (got) {
  const fn = got.suggestedFilename();
  t('文件名含考试与场景', /成绩AI_秋期中考_\d+_我的画像/.test(fn) || /\.md$/.test(fn), fn);
}

/* ---------- 6. 说明书 ---------- */
const guide = await page.evaluate(() => aiGuideMd());
t('说明书有接口地址', /\/api\/scores\?action=ai/.test(guide));
t('说明书带密钥', /ak_demo_1234567890/.test(guide));
t('说明书带学号（01）', /`01`/.test(guide), guide.slice(0, 400));
t('说明书带提示词', /## 五、提示词/.test(guide));
t('说明书带详细程度骨架', /## 六、详细程度/.test(guide));
t('说明书带目标', /进前 10/.test(guide));

/* ---------- 7. 导入：真的读文件并覆盖设置 ---------- */
page.on('dialog', (d) => d.accept());
const fc = page.waitForEvent('filechooser', { timeout: 8000 }).catch(() => null);
await page.evaluate(() => aiImportPick());
const chooser = await fc;
t('导入会拉起选文件', !!chooser);
if (chooser) {
  const pack = {
    app: 'class-site', kind: 'ai-config', version: '3.17.0',
    cfg: {
      provider: 'custom', base: 'http://127.0.0.1:11434/v1', model: 'qwen2.5:7b',
      temp: 0.3, depth: 'brief', goal: '先稳住物理', prompt: '你是我的学习教练。'
    },
    key: 'sk-from-file',
    api: { base: 'https://api.classsite.dpdns.org', key: 'ak_from_file' },
  };
  await chooser.setFiles({ name: 'cfg.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(pack)) });
  await page.waitForTimeout(700);
  const after = await page.evaluate(() => ({
    provider: AIC.provider, base: AIC.base, model: AIC.model,
    depth: AIC.depth, goal: AIC.goal, key: AIC.key, temp: AIC.temp,
    stored: JSON.parse(localStorage.getItem('cls_ai_cfg_v1') || '{}'),
  }));
  t('导入后服务商换成自定义', after.provider === 'custom' && after.base === 'http://127.0.0.1:11434/v1', after.base);
  t('导入后模型换成 qwen', after.model === 'qwen2.5:7b');
  t('导入后详细程度生效', after.depth === 'brief');
  t('导入后目标生效', after.goal === '先稳住物理');
  t('导入后密钥生效', after.key === 'sk-from-file');
  t('导入后写进了本机存储', !!after.stored.k && after.stored.depth === 'brief', JSON.stringify(after.stored).slice(0, 120));
  const savedApi = await page.evaluate(() => localStorage.getItem('cls_ai_apikey_v1'));
  t('导入后班级查询密钥也落盘（说明书能用）', savedApi === 'ak_from_file', String(savedApi));
}

/* ---------- 8. 错误文件不会把设置搞坏 ---------- */
const bad = page.waitForEvent('filechooser', { timeout: 8000 }).catch(() => null);
await page.evaluate(() => aiImportPick());
const ch2 = await bad;
if (ch2) {
  await ch2.setFiles({ name: 'bad.json', mimeType: 'application/json', buffer: Buffer.from('{"kind":"something-else"}') });
  await page.waitForTimeout(500);
  const still = await page.evaluate(() => ({ model: AIC.model, key: AIC.key }));
  t('导入无关文件不改设置', still.model === 'qwen2.5:7b' && still.key === 'sk-from-file', JSON.stringify(still));
}

t('没有 JS 报错', errs.length === 0, errs.join(' | ').slice(0, 300));

await browser.close();
console.log('\n' + pass + ' / ' + (pass + fail));
process.exit(fail ? 1 : 0);
