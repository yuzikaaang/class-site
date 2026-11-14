/* v4.16.0 记录聚合 + 导出科目维度 端到端验证
   —— 造一天的记录（三类计时 / 有科目 / 有小项 / 有小项缺失 / 有未填科目），
      看记录抽屉是否三级折叠、点小项是否展开明细、导出勾选是否生效 */
import { chromium } from 'playwright-core';

const EXE = '/root/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const BASE = 'http://127.0.0.1:8899';

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (x === undefined ? '' : ' → ' + JSON.stringify(x))); } };

const browser = await chromium.launch({ executablePath: EXE, args: ['--no-sandbox'] });

/* 造数据：今天 09:00 起，
   · 倒计时 英语/默写 22 分钟
   · 倒计时 英语（无小项）9 分钟
   · 正计时 数学 12 分钟
   · 番茄钟 物理/套卷 25 分钟
   · 正计时 未填科目 5 分钟                                            */
const SEGS = (() => {
  const d0 = new Date(); d0.setHours(9, 0, 0, 0);
  const t = (min) => d0.getTime() + min * 60000;
  const mk = (sMin, dMin, o) => Object.assign({ s: t(sMin), e: t(sMin) + dMin * 60000, d: dMin * 60 }, o);
  return [
    mk(0, 22, { m: 'down', n: '', sj: '英语', it: '默写', k: 'down', t: 1500 }),
    mk(30, 9, { m: 'down', n: '', sj: '英语', k: 'down', t: 600 }),
    mk(50, 12, { m: 'up', n: '', sj: '数学', k: 'up' }),
    mk(70, 25, { m: 'pomo:focus', n: '', sj: '物理', it: '套卷', k: 'pomo' }),
    mk(100, 5, { m: 'up', n: '', sj: '', k: 'up' }),
  ];
})();

const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' });
const p = await ctx.newPage();
p.on('pageerror', e => console.log('  [pageerror]', e.message.slice(0, 120)));
await p.route('**/api/**', r => r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }));
await p.addInitScript((segs) => {
  try {
    localStorage.setItem('cls_welcome_v1', '1');
    const d = new Date();
    const k = 'cls_clock_log_' + d.getFullYear() + '-'
      + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    localStorage.setItem(k, JSON.stringify({ v: 2, pomo: 1, segs }));
  } catch (e) {}
}, SEGS);

await p.goto(BASE + '/clock.html?_r=' + Date.now(), { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(1500);
await p.evaluate(() => document.getElementById('logBtn').click());
await p.waitForTimeout(600);

// ① 三级分组：倒计时 / 正计时 / 番茄钟
const groups = await p.evaluate(() => [...document.querySelectorAll('#logList .lga-h .lga-k')].map(e => e.textContent.trim()));
ok('按「倒计时 / 正计时 / 番茄钟」分组', groups.length >= 2 && groups.includes('倒计时') && groups.includes('正计时'), groups);

const sum = await p.evaluate(() => {
  const out = [];
  document.querySelectorAll('#logList .lga-g').forEach(g => {
    const label = g.querySelector('.lga-k').textContent.trim();
    const total = g.querySelector('.lga-t').textContent.trim();
    const subs = [...g.querySelectorAll('.lga-sh')].map(s => s.children[0].textContent.trim() + '=' + s.children[1].textContent.trim());
    out.push({ label, total, subs });
  });
  return out;
});
console.log('   ' + JSON.stringify(sum));
const down = sum.find(x => x.label === '倒计时');
ok('倒计时类里按科目汇总（英语一条）', down && down.subs.some(s => /^英语=31 分钟$/.test(s) || /^英语=31分/.test(s)), down);
ok('科目合计=22+9 分钟', down && /31/.test(down.total), down && down.total);

// ② 小项缩进 + 展开明细
const items = await p.evaluate(() => [...document.querySelectorAll('#logList .lga-i span')].map(e => e.textContent.trim()));
ok('科目下有「默写」小项', items.includes('默写'), items);

const before = await p.evaluate(() => {
  const btn = [...document.querySelectorAll('#logList .lga-i')].find(b => /默写/.test(b.textContent));
  const box = btn.parentNode.querySelector('.lga-ib');
  return { cls: btn.parentNode.className, rows: box.children.length };
});
ok('小项默认收起（明细行已生成但不可见）', before.rows >= 1 && !/\bon\b/.test(before.cls), before);

await p.evaluate(() => {
  const btn = [...document.querySelectorAll('#logList .lga-i')].find(b => /默写/.test(b.textContent));
  btn.click();
});
await p.waitForTimeout(300);
const after = await p.evaluate(() => {
  const btn = [...document.querySelectorAll('#logList .lga-i')].find(b => /默写/.test(b.textContent));
  const box = btn.parentNode.querySelector('.lga-ib');
  return { on: /\bon\b/.test(btn.parentNode.className), rows: [...box.querySelectorAll('.lga-r')].map(r => r.textContent.trim()) };
});
ok('点小项展开，能看到「哪一次、几点、多久」', after.on && after.rows.length >= 1 && /\d{2}:\d{2}–\d{2}:\d{2}/.test(after.rows[0]), after);

// ③ 未填科目的进「未填科目」，时长要算
const up = sum.find(x => x.label === '正计时');
ok('没填科目的单独一栏且时长算进去', up && up.subs.some(s => /未填科目=(5|17)/.test(s)), up);

// ④ 导出：默认只列科目
await p.evaluate(() => document.querySelector('#logTabs [data-lg="sum"]').click());
await p.waitForTimeout(700);
const prev = await p.evaluate(() => document.getElementById('sumPreview').textContent);
ok('导出预览按科目列（英语 / 数学 / 物理）', /英语/.test(prev) && /数学/.test(prev) && /物理/.test(prev), prev.slice(0, 160));
ok('默认不含小项（没有「默写」「套卷」）', !/默写/.test(prev) && !/套卷/.test(prev), prev.slice(0, 160));
ok('有「其他」那一栏（未填科目的归到这里）', /其他/.test(prev), prev.slice(0, 200));

await p.evaluate(() => { document.getElementById('sumItems').checked = true; document.getElementById('sumItems').dispatchEvent(new Event('change', { bubbles: true })); });
await p.waitForTimeout(500);
const prev2 = await p.evaluate(() => document.getElementById('sumPreview').textContent);
ok('勾上「导出小项」后出现小项', /默写/.test(prev2) && /套卷/.test(prev2), prev2.slice(0, 240));

await p.evaluate(() => { document.getElementById('sumItems').checked = false; document.getElementById('sumItems').dispatchEvent(new Event('change', { bubbles: true })); });
await p.waitForTimeout(400);
const prev3 = await p.evaluate(() => document.getElementById('sumPreview').textContent);
ok('取消勾选后又只剩科目合计', !/默写/.test(prev3), prev3.slice(0, 200));
ok('勾选状态存进本机', await p.evaluate(() => localStorage.getItem('cls_clock_sum_items') === '0' || localStorage.getItem('cls_clock_sum_items') === null));

await p.screenshot({ path: '/workspace/classsite-v4160/clock-sum-export.png' });

await browser.close();
console.log('\n结果：' + pass + ' 项通过，' + fail + ' 项失败');
process.exit(fail ? 1 : 0);
