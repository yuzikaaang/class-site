/* v4.10.13 专项：时钟与计时回到互斥 + 计时页面右上角的小当前时间 */
import { chromium } from 'playwright-core';

const BASE = 'http://localhost:8111';
const CHROME = '/root/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
let pass = 0, fail = 0;
const t = (name, ok, extra) => {
  if (ok) { pass++; console.log('  ✓ ' + name + (extra ? '  [' + extra + ']' : '')); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  [' + extra + ']' : '')); }
};
const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });

const V = (page, sel) => page.evaluate((s) => {
  const el = document.querySelector(s);
  return el ? getComputedStyle(el).display : 'missing';
}, sel);

/* ① 宽屏：点「数字」只亮大时钟，点「正计时」只亮计时器 */
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 820 } });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await page.goto(BASE + '/clock.html', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(900);

  const d0 = { clk: await V(page, '#clockView'), timer: await V(page, '#timerView'), now: await V(page, '#tmNow') };
  t('默认落在数字时钟：只有大时钟，没有计时器，也没有小时间',
    d0.clk === 'block' && d0.timer === 'none' && d0.now === 'none', JSON.stringify(d0));

  const big = await page.evaluate(() => document.getElementById('bigTime').textContent);
  t('大时钟是 时:分:秒', /^\d{2}:\d{2}:\d{2}$/.test(big), big);

  /* 数字模式下的字号应该回到整幅（不再是并排时的 .58） */
  const fs = await page.evaluate(() => {
    const el = document.getElementById('bigTime');
    const cs = getComputedStyle(el);
    return { fs: parseFloat(cs.fontSize), w: Math.round(el.getBoundingClientRect().width), vw: innerWidth };
  });
  t('大时钟按整幅铺开（宽度超过屏宽一半）', fs.w > fs.vw * 0.5, JSON.stringify(fs));

  /* 切到翻页：仍只有时钟，小时间不出现 */
  await page.evaluate(() => document.querySelector('#subTabs button[data-k="flip"]').click());
  await page.waitForTimeout(600);
  const f0 = { clk: await V(page, '#clockView'), flip: await V(page, '#flipView'), timer: await V(page, '#timerView'), now: await V(page, '#tmNow') };
  t('翻页模式只显示翻页时钟，计时器与小时间都不出现',
    f0.clk === 'none' && f0.flip === 'block' && f0.timer === 'none' && f0.now === 'none', JSON.stringify(f0));

  /* 切到计时：只显示计时器 + 右上角小时间 */
  await page.evaluate(() => document.querySelector('#subTabs button[data-k="up"]').click());
  await page.waitForTimeout(600);
  const c0 = { clk: await V(page, '#clockView'), flip: await V(page, '#flipView'), timer: await V(page, '#timerView'), now: await V(page, '#tmNow') };
  t('计时模式只显示计时器，大时钟收起',
    c0.clk === 'none' && c0.flip === 'none' && c0.timer === 'block', JSON.stringify(c0));
  t('计时模式右上角出现小的当前时间', c0.now === 'flex', JSON.stringify(c0));

  const now0 = await page.evaluate(() => document.getElementById('tmNow').textContent);
  t('小时间是 时:分:秒', /^\d{2}:\d{2}:\d{2}$/.test(now0), now0);
  await page.waitForTimeout(1600);
  const now1 = await page.evaluate(() => document.getElementById('tmNow').textContent);
  t('小时间自己会走（不用刷新）', now0 !== now1, now0 + ' → ' + now1);

  /* 尺寸：约等于一个按钮那么长 */
  const geo = await page.evaluate(() => {
    const n = document.getElementById('tmNow').getBoundingClientRect();
    const b = document.querySelector('#bar button').getBoundingClientRect();
    const rec = document.getElementById('logBtn').getBoundingClientRect();
    return {
      nw: Math.round(n.width), nh: Math.round(n.height), bw: Math.round(b.width), bh: Math.round(b.height),
      right: Math.round(innerWidth - n.right), gapRec: Math.round(n.top - rec.bottom),
      overlapsRec: !(n.right <= rec.left || n.left >= rec.right || n.bottom <= rec.top || n.top >= rec.bottom),
    };
  });
  t('小时间宽度与工具栏按钮相近（0.9~1.8 倍）',
    geo.nw >= geo.bw * 0.9 && geo.nw <= geo.bw * 1.8, JSON.stringify(geo));
  t('小时间不压住「记录」按钮', !geo.overlapsRec && geo.gapRec >= 0, JSON.stringify(geo));

  /* 计时器应该居中 */
  const mid = await page.evaluate(() => {
    const r = document.getElementById('timerView').getBoundingClientRect();
    return Math.round(Math.abs((r.left + r.width / 2) - innerWidth / 2));
  });
  t('计时器水平居中（±4px）', mid <= 4, 'off=' + mid);

  t('时钟页无 JS 报错', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* ② 时钟页面按空格：自动切到计时并开始（不会「看不见在跑」） */
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 820 } });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await page.goto(BASE + '/clock.html', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(900);
  await page.keyboard.press(' ');
  await page.waitForTimeout(1600);
  const r = await page.evaluate(() => ({
    timer: getComputedStyle(document.getElementById('timerView')).display,
    on: document.body.className.indexOf('tm-on') >= 0,
    mode: JSON.parse(localStorage.getItem('cls_clock_cfg') || '{}').mode,
    time: document.getElementById('timerTime').textContent,
  }));
  t('时钟页按空格会自动切到计时并开始走',
    r.timer === 'block' && r.on && r.mode === 'timer' && !/^00:00$/.test(r.time), JSON.stringify(r));
  t('空格切模式无 JS 报错', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* ③ 极简模式（开始后只剩数字）：小时间也不显示，数字回到屏幕正中 */
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  await page.addInitScript(() => {
    localStorage.setItem('cls_clock_cfg', JSON.stringify({ mode: 'timer', tk: 'up', bareRun: 1, cfgV: 2 }));
  });
  await page.goto(BASE + '/clock.html?m=timer', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(800);
  await page.evaluate(() => document.getElementById('timerBtn').click());
  await page.waitForTimeout(900);
  const r = await page.evaluate(() => {
    const el = document.getElementById('timerTime');
    const b = el.getBoundingClientRect();
    return {
      bare: document.body.className.indexOf('bare') >= 0,
      now: getComputedStyle(document.getElementById('tmNow')).display,
      gap: Math.round(Math.abs((b.top + b.height / 2) - innerHeight / 2)),
    };
  });
  t('极简模式下小时间收起', r.now === 'none', JSON.stringify(r));
  t('极简模式的数字在屏幕正中（±30px）', r.bare && r.gap <= 30, JSON.stringify(r));
  await ctx.close();
}

/* ④ 手机窄屏：五个子标签完整显示，不压「返回」「记录」，也不横向溢出 */
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await page.goto(BASE + '/clock.html?m=timer', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(900);

  const r = await page.evaluate(() => {
    const tabs = document.getElementById('subTabs').getBoundingClientRect();
    const back = document.getElementById('back').getBoundingClientRect();
    const rec = document.getElementById('logBtn').getBoundingClientRect();
    const now = document.getElementById('tmNow').getBoundingClientRect();
    const items = [...document.querySelectorAll('#subTabs button')];
    const hit = (a, b) => !(a.right <= b.left || a.left >= b.right || a.bottom <= b.top || a.top >= b.bottom);
    return {
      tabs: Math.round(tabs.width), full: items.map((b) => b.textContent).join('/'),
      overflow: document.documentElement.scrollWidth - innerWidth,
      hitBack: hit(tabs, back), hitRec: hit(tabs, rec), hitNow: hit(tabs, now), hitNowRec: hit(now, rec),
      tabRow: Math.round(tabs.top), backRow: Math.round(back.top),
      nowVisible: getComputedStyle(document.getElementById('tmNow')).display,
    };
  });
  t('窄屏五个子标签一个不少', r.full === '数字/翻页/正计时/倒计时/番茄钟', r.full);
  t('窄屏子标签挪到第二行，不压「返回」「记录」',
    r.tabRow > r.backRow + 20 && !r.hitBack && !r.hitRec, JSON.stringify(r));
  t('窄屏小时间在第一行，不压子标签也不压「记录」',
    r.nowVisible === 'flex' && !r.hitNow && !r.hitNowRec, JSON.stringify(r));
  t('窄屏没有横向溢出', r.overflow === 0, 'overflow=' + r.overflow);
  t('窄屏无 JS 报错', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* ⑤ 翻页「关掉秒」之后卡片仍会放大（topRow 的选择器别把 nosec 压住） */
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 820 } });
  const page = await ctx.newPage();
  await page.goto(BASE + '/clock.html', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(700);
  await page.evaluate(() => document.querySelector('#subTabs button[data-k="flip"]').click());
  await page.waitForTimeout(600);
  const w0 = await page.evaluate(() => Math.round(document.querySelector('#flipView .flip').getBoundingClientRect().width));
  await page.evaluate(() => document.getElementById('secBtn').click());
  await page.waitForTimeout(600);
  const w1 = await page.evaluate(() => Math.round(document.querySelector('#flipView .flip').getBoundingClientRect().width));
  t('翻页关掉秒后卡片会放大', w1 > w0, w0 + ' → ' + w1);
  await ctx.close();
}

await browser.close();
console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
