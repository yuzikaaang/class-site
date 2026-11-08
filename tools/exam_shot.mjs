/* 考试块与考试看板弹窗的视觉验收：本地起服务 + mock 后端 + 真浏览器截图 */
import { chromium } from '/root/.nvm/versions/node/v22.13.1/lib/node_modules/playwright/index.mjs';

const BASE = 'http://localhost:8112';
const OUT = '/tmp/shots';
const pad = (n) => (n < 10 ? '0' : '') + n;
const dstr = (off) => {
  const d = new Date(Date.now() + off * 86400000);
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
};
const T = dstr(0), Y = dstr(-1), D1 = dstr(1), D2 = dstr(2);
const WD = (s) => {
  const d = new Date(s + 'T00:00:00');
  return '周' + '日一二三四五六'[d.getDay()];
};

/* 段考：今天 + 明天，共 6 科（正好撞上 6 科上限） */
const A = {
  id: 'major_a', name: '2026 高二上第二次段考', temporary: false,
  start: T, end: D1, daysN: 2, count: 6, onCnt: 0, allOn: false, anyOn: false, auto: true,
  days: [
    { date: T, wd: WD(T), onCnt: 0, allOn: false, anyOn: false, items: [
      { id: 'a1', name: '语文', start: '09:00', end: '11:30', pin: false, by: '' },
      { id: 'a2', name: '数学', start: '14:30', end: '16:30', pin: false, by: '' },
    ] },
    { date: D1, wd: WD(D1), onCnt: 0, allOn: false, anyOn: false, items: [
      { id: 'a3', name: '物理', start: '08:30', end: '09:45', pin: false, by: '' },
      { id: 'a4', name: '外语', start: '10:00', end: '12:00', pin: false, by: '' },
      { id: 'a5', name: '化学', start: '14:30', end: '15:45', pin: false, by: '' },
      { id: 'a6', name: '生物', start: '15:50', end: '17:05', pin: false, by: '' },
    ] },
  ],
};

/* 昨天的小测：挑了 2 科，用来验证「压暗」 */
const B = {
  id: 'major_b', name: '数学周测', temporary: false,
  start: Y, end: Y, daysN: 1, count: 2, onCnt: 2, allOn: true, anyOn: true, auto: false,
  days: [
    { date: Y, wd: WD(Y), onCnt: 2, allOn: true, anyOn: true, items: [
      { id: 'b1', name: '数学', start: '19:00', end: '20:00', pin: true, by: 'major' },
      { id: 'b2', name: '物理', start: '20:10', end: '21:10', pin: true, by: 'major' },
    ] },
  ],
};

/* 下个月的月考：没挑，只在弹窗里看得到 */
const C = {
  id: 'major_c', name: '2026 高二上第三次月考', temporary: false,
  start: '2026-12-01', end: '2026-12-02', daysN: 2, count: 6, onCnt: 0, allOn: false, anyOn: false, auto: false,
  days: [
    { date: '2026-12-01', wd: '周二', onCnt: 0, allOn: false, anyOn: false, items: [
      { id: 'c1', name: '语文', start: '09:00', end: '11:30', pin: false, by: '' },
      { id: 'c2', name: '数学', start: '14:30', end: '16:30', pin: false, by: '' },
    ] },
    { date: '2026-12-02', wd: '周三', onCnt: 0, allOn: false, anyOn: false, items: [
      { id: 'c3', name: '物理', start: '08:30', end: '09:45', pin: false, by: '' },
      { id: 'c4', name: '外语', start: '10:00', end: '12:00', pin: false, by: '' },
      { id: 'c5', name: '化学', start: '14:30', end: '15:45', pin: false, by: '' },
      { id: 'c6', name: '生物', start: '15:50', end: '17:05', pin: false, by: '' },
    ] },
  ],
};

const HOMEWORK = {
  id: 'hw1', title: '本周作业',
  items: [
    { subject: '语文', tasks: [{ text: '文言文背诵，抄写第三段并翻译' }] },
    { subject: '数学', tasks: [{ text: '试卷一张（第 12 套），错题整理到本子上' }] },
    { subject: '英语', tasks: [{ text: 'Unit 4 单词默写，听力训练 15 分钟' }] },
    { subject: '物理', tasks: [{ text: '练习册 P45-P47' }] },
  ],
};

function mockApi(page, groups) {
  return page.route('**/api/**', (route) => {
    const u = route.request().url();
    const J = (o) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
    if (u.includes('/api/exams')) {
      if (u.includes('action=pin') || u.includes('action=bulk')) return J({ ok: true, pins: {}, at: Date.now() });
      if (u.includes('action=state')) {
        return J({ ok: true, cfg: { base: 'https://examboard.dpdns.org', classId: '', className: '5班' },
          pins: {}, kv: true, classes: [{ id: 'c5', name: '5班', gradeId: 'g2' }], data: null });
      }
      return J({
        ok: true, at: Date.now(), today: T, title: '2026 高二上第二次段考', cls: '5班',
        base: 'https://examboard.dpdns.org', groups: groups,
        items: [], pins: { majors: ['major_b'], days: [], items: [] },
        pinAt: 0, term: { name: '2026 年秋季 · 高二上', start: '2026-09-01', end: '2027-01-30' },
        cached: false, stale: false,
      });
    }
    if (u.includes('/api/island')) {
      return J({ ok: true, data: { on: true, startDate: '2026-09-01', endDate: '2027-01-30',
        enrollDate: '2025-09-01', term: '2026 年秋季 · 高二上', holidays: [] } });
    }
    if (u.includes('/auth?action=me')) return J({ ok: true, user: { username: 'aibot', role: 'admin' } });
    if (u.includes('/api/content')) {
      return J({ ok: true, items: { holiday_homeworks: { hw1: HOMEWORK }, announcements: [] } });
    }
    return J({ ok: true });
  });
}

async function open(page, groups) {
  await page.addInitScript(() => {
    localStorage.setItem('cls_bigscreen', '1');
    localStorage.setItem('cls_welcome_v1', '1');
    localStorage.setItem('cls_login_guide_v1', '1');
    localStorage.setItem('cls_auth', JSON.stringify({ token: 'TESTTOKEN', user: { username: 'aibot', role: 'admin' } }));
  });
  await mockApi(page, groups);
  await page.goto(BASE + '/index.html?_r=' + Date.now() + '#/hw', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(3200);
}

const browser = await chromium.launch({ args: ['--no-sandbox'] });

/* ① 作业看板：只有段考（6 科整） */
{
  const ctx = await browser.newContext({ viewport: { width: 1680, height: 960 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  await open(page, [A]);
  await page.screenshot({ path: OUT + '/big-hw-1.png' });
  const info = await page.evaluate(() => {
    const b = document.getElementById('bhwExam');
    if (!b) return { missing: true };
    const cs = (s) => { const e = b.querySelector(s); return e ? getComputedStyle(e) : null; };
    return {
      head: (b.querySelector('.bhex-h') || {}).textContent,
      dates: [...b.querySelectorAll('.bhex-date')].map((x) => x.textContent.trim()),
      rows: [...b.querySelectorAll('.bhex-row')].map((x) => x.textContent.trim()),
      more: (b.querySelector('.bhex-more') || {}).textContent || '',
      fs: cs('.bhex-sub') ? cs('.bhex-sub').fontSize : '',
      color: cs('.bhex-sub') ? cs('.bhex-sub').color : '',
      timeColor: cs('.bhex-time') ? cs('.bhex-time').color : '',
    };
  });
  console.log('【作业看板 · 单场】', JSON.stringify(info, null, 1));
  await page.evaluate(() => document.documentElement.classList.add('dark'));
  await page.waitForTimeout(400);
  await page.screenshot({ path: OUT + '/big-hw-1-dark.png' });
  await ctx.close();
}

/* ② 作业看板：段考 + 昨天的小测（验证合并与压暗） */
{
  const ctx = await browser.newContext({ viewport: { width: 1680, height: 960 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  await open(page, [B, A]);
  await page.screenshot({ path: OUT + '/big-hw-2.png' });
  const info = await page.evaluate(() => {
    const b = document.getElementById('bhwExam');
    return {
      head: (b.querySelector('.bhex-h') || {}).textContent,
      past: [...b.querySelectorAll('.bhex-past')].map((x) => x.textContent.trim()),
      pastRows: document.querySelectorAll('.bhex-row.bhex-off').length,
      rowOp: [...b.querySelectorAll('.bhex-row')].map((x) => x.textContent.trim().slice(0, 4) + '=' + getComputedStyle(x).opacity),
      more: (b.querySelector('.bhex-more') || {}).textContent || '',
      mnames: [...b.querySelectorAll('.bhex-mname')].map((x) => x.textContent.trim()),
    };
  });
  console.log('【作业看板 · 多场】', JSON.stringify(info, null, 1));
  await ctx.close();
}

/* ③ 弹窗：收起 / 展开 */
{
  const ctx = await browser.newContext({ viewport: { width: 1680, height: 960 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  await open(page, [B, A, C]);
  await page.click('#bhwExamAdd');
  await page.waitForTimeout(700);
  await page.screenshot({ path: OUT + '/panel-1.png' });
  const collapsed = await page.evaluate(() => ({
    tabs: [...document.querySelectorAll('#bexTabs .bex-tab')].map((b) => b.textContent + (b.className.includes('on') ? '*' : '')),
    bulk: (document.getElementById('bexBulk') || {}).textContent,
    tip: (document.getElementById('bexTip') || {}).textContent,
    groups: [...document.querySelectorAll('.bex-grp')].map((x) => x.textContent.replace(/\s+/g, ' ').trim()),
  }));
  console.log('【弹窗 · 收起】', JSON.stringify(collapsed, null, 1));

  /* 展开第三场（12 月那次），并切到「全部」 */
  await page.click('#bexTabs [data-scope="all"]');
  await page.waitForTimeout(250);
  const carets = await page.$$('.bex-caret');
  if (carets.length) await carets[carets.length - 1].click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: OUT + '/panel-2.png' });
  const expanded = await page.evaluate(() => ({
    days: [...document.querySelectorAll('.bex-day')].map((x) => x.textContent.replace(/\s+/g, ' ').trim()),
    items: [...document.querySelectorAll('.bex-it')].map((x) => x.textContent.replace(/\s+/g, ' ').trim()),
    dots: document.querySelectorAll('.bex-dot').length,
  }));
  console.log('【弹窗 · 展开】', JSON.stringify(expanded, null, 1));

  /* 深色 */
  await page.evaluate(() => document.documentElement.classList.add('dark'));
  await page.waitForTimeout(300);
  await page.screenshot({ path: OUT + '/panel-3-dark.png' });
  await ctx.close();
}

await browser.close();
console.log('截图已输出到', OUT);
