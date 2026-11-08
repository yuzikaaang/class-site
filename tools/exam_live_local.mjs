/* 用线上真实考试数据在本地渲染，验收最终排版（资源本地加载，数据来自 /api/exams） */
import { chromium } from '/root/.nvm/versions/node/v22.13.1/lib/node_modules/playwright/index.mjs';
import fs from 'node:fs';

const OUT = '/workspace/exam-preview';
const live = await (await fetch('https://api.classsite.dpdns.org/api/exams?action=list&fresh=1')).json();
const groups = live.groups || [];
console.log('线上考试：', groups.map((g) => g.name + ' ' + g.start + '~' + g.end + ' ' + g.count + '科').join(' | '));
console.log('默认应停档位对应的日期：', live.today);

const HOMEWORK = { id: 'hw1', title: '本周作业', items: [
  { subject: '语文', tasks: [{ text: '文言文背诵，抄写第三段并翻译' }] },
  { subject: '数学', tasks: [{ text: '试卷一张（第 12 套），错题整理' }] },
  { subject: '英语', tasks: [{ text: 'Unit 4 单词默写' }] },
] };

function mock(page, pins) {
  return page.route('**/api/**', (route) => {
    const u = route.request().url();
    const J = (o) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
    if (u.includes('/api/exams')) {
      if (u.includes('action=pin') || u.includes('action=bulk')) return J({ ok: true, pins: {}, at: Date.now() });
      if (u.includes('action=state')) return J({ ok: true, cfg: { base: live.base, classId: '', className: live.cls }, pins: {}, kv: true, classes: [], data: null });
      /* 把「已挑」状态套上去，模拟站主挑了整场之后的样子 */
      const gs = JSON.parse(JSON.stringify(groups)).map((g) => {
        if (!pins.majors.includes(g.id)) return g;
        let on = 0;
        g.days.forEach((d) => d.items.forEach((i) => { i.pin = true; i.by = 'major'; on++; }));
        g.onCnt = on; g.allOn = true; g.anyOn = true;
        g.days.forEach((d) => { d.onCnt = d.items.length; d.allOn = true; d.anyOn = true; });
        return g;
      });
      return J(Object.assign({}, live, { groups: gs, pins: pins }));
    }
    if (u.includes('/api/island')) {
      return J({ ok: true, data: { on: true, startDate: '2026-09-01', endDate: '', enrollDate: '2025-09-01', term: '2026 年秋季 · 高二上', holidays: [] } });
    }
    if (u.includes('/auth?action=me')) return J({ ok: true, user: { username: 'aibot', role: 'admin' } });
    if (u.includes('/api/content')) return J({ ok: true, items: { holiday_homeworks: { hw1: HOMEWORK }, announcements: [] } });
    return J({ ok: true });
  });
}

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1680, height: 960 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();

const pins = { majors: groups.map((g) => g.id), days: [], items: [] };
await page.addInitScript(() => {
  localStorage.setItem('cls_bigscreen', '1');
  localStorage.setItem('cls_welcome_v1', '1');
  localStorage.setItem('cls_login_guide_v1', '1');
  localStorage.setItem('cls_auth', JSON.stringify({ token: 'T', user: { username: 'aibot', role: 'admin' } }));
});
await mock(page, pins);
await page.goto('http://localhost:8112/index.html?_r=' + Date.now() + '#/hw', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(3400);

const s1 = await page.evaluate(() => {
  const b = document.getElementById('bhwExam');
  if (!b) return { missing: true };
  return {
    head: (b.querySelector('.bhex-h') || {}).textContent,
    dates: [...b.querySelectorAll('.bhex-date')].map((x) => x.textContent.trim()),
    rows: [...b.querySelectorAll('.bhex-row')].map((x) => ({
      s: (x.querySelector('.bhex-sub') || {}).textContent,
      t: (x.querySelector('.bhex-time') || {}).textContent,
    })),
    more: (b.querySelector('.bhex-more') || {}).textContent || '',
  };
});
console.log('作业看板（真实数据 + 已挑整场）：', JSON.stringify(s1, null, 1));
await page.screenshot({ path: OUT + '/0-线上真实数据.png' });

await page.evaluate(() => { const b = document.getElementById('bhwExamAdd'); if (b) b.click(); });
await page.waitForTimeout(1400);
const s2 = await page.evaluate(() => ({
  tabs: [...document.querySelectorAll('#bexTabs .bex-tab')].map((b) => b.textContent + (b.className.includes('on') ? '*' : '')),
  tip: (document.getElementById('bexTip') || {}).textContent,
  groups: [...document.querySelectorAll('.bex-grp')].map((x) => x.textContent.replace(/\s+/g, ' ').trim()),
}));
console.log('弹窗（默认档位）：', JSON.stringify(s2, null, 1));
await page.screenshot({ path: OUT + '/0-线上弹窗.png' });

const c = await page.$('.bex-caret');
if (c) {
  await c.click();
  await page.waitForTimeout(500);
  const s3 = await page.evaluate(() => ({
    days: [...document.querySelectorAll('.bex-day')].map((x) => x.textContent.replace(/\s+/g, ' ').trim()),
    items: [...document.querySelectorAll('.bex-it')].map((x) => x.textContent.replace(/\s+/g, ' ').trim()),
    dots: [...document.querySelectorAll('.bex-dot')].map((x) => x.textContent),
    auto: [...document.querySelectorAll('.bex-auto')].map((x) => x.textContent),
  }));
  console.log('展开：', JSON.stringify(s3, null, 1));
  await page.screenshot({ path: OUT + '/0-线上弹窗-展开.png' });
}

await browser.close();
console.log('done');
