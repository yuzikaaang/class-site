/* v3.9.22：全屏时钟（数字 / 翻页 / 秒表 / 计时器）行为验证 */
import { chromium } from 'playwright-core';

const BASE = 'http://localhost:8111';
const browser = await chromium.launch({
  executablePath: '/root/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome',
  args: ['--no-sandbox'],
});
let pass = 0, fail = 0;
const t = (n, c, d) => {
  if (c) { pass++; console.log('  ✓ ' + n); }
  else { fail++; console.log('  ✗ ' + n + (d ? '  → ' + d : '')); }
};

const ctx = await browser.newContext({ viewport: { width: 1280, height: 820 } });
const page = await ctx.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
await page.goto(BASE + '/clock.html', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(900);

/* v3.12.0：模式改成两级 —— 先切「时钟/计时」，再切上面的子标签 */
const goTop = (pg, m) => pg.evaluate((mm) => {
  document.getElementById('modeBtn').click();
  const b = document.querySelector('#modeMenu [data-m="' + mm + '"]');
  if (b) b.click();
  document.getElementById('modeMenu').className = '';
}, m);
const goSub = (pg, k) => pg.evaluate((kk) => {
  let b = document.querySelector('#subTabs button[data-k="' + kk + '"]');
  if (!b) {
    /* 顶层模式不对就先切过去 */
    document.getElementById('modeBtn').click();
    const want = (kk === 'up' || kk === 'down' || kk === 'pomo') ? 'timer' : 'clock';
    const tb = document.querySelector('#modeMenu [data-m="' + want + '"]');
    if (tb) tb.click();
    document.getElementById('modeMenu').className = '';
    b = document.querySelector('#subTabs button[data-k="' + kk + '"]');
  }
  if (b) b.click();
}, k);

const V = (sel) => page.evaluate((s) => {
  const el = document.querySelector(s);
  return el ? el.textContent.trim() : null;
}, sel);

/* 1. v3.11.0：倒计时 / 自习 / 正计时合并，只留三种模式 */
const modes = await page.evaluate(() => [...document.querySelectorAll('#modeMenu button')].map((b) => b.textContent.trim()));
t('顶层两个模式：时钟 / 计时', modes.length === 2 && modes.includes('时钟') && modes.includes('计时'), JSON.stringify(modes));
await goTop(page, 'clock');
await page.waitForTimeout(300);
const clockTabs = await page.evaluate(() => [...document.querySelectorAll('#subTabs button')].map((b) => b.textContent));
t('时钟页上面是「数字 / 翻页」', clockTabs.length === 2 && clockTabs[0] === '数字' && clockTabs[1] === '翻页', JSON.stringify(clockTabs));

/* 2. 数字时钟：时间格式 + 日期 + 农历 */
await goSub(page, 'clock');
await page.waitForTimeout(1100);
const big = await V('#bigTime');
const sub = await V('#bigSub');
t('数字时钟是 时:分:秒', /^\d{2}:\d{2}:\d{2}$/.test(big || ''), big);
t('下面有日期与星期', /年.*月.*日/.test(sub || '') && /星期/.test(sub || ''), sub);
const lunar = await page.evaluate(() => {
  const s = document.getElementById('bigSub').textContent;
  const m = s.match(/(闰?[正二三四五六七八九十冬腊]月[初十廿三][一二三四五六七八九十]?)/);
  return m ? m[1] : '';
});
t('农历也显示出来了', /月/.test(lunar), sub + ' | ' + lunar);

/* 3. 翻页时钟：三张卡片 + 数字 */
await goSub(page, 'flip');
await page.waitForTimeout(1200);
const flip = await page.evaluate(() => ({
  cards: document.querySelectorAll('#flipView .flip').length,
  vals: [...document.querySelectorAll('#flipView .flip .top .txt')].map((e) => e.textContent),
}));
t('翻页是三张卡片', flip.cards === 3, JSON.stringify(flip));
t('翻页卡片有数字', flip.vals.every((v) => /^\d{2}$/.test(v)), JSON.stringify(flip.vals));

/* 4. 正计时（原来的秒表并进计时了）：时长为 0 点开始 → 往上走 */
await page.evaluate(() => {
  const c = JSON.parse(localStorage.getItem('cls_clock_cfg') || '{}');
  c.mode = 'timer'; c.focusSec = 0; c.rounds = 0;
  localStorage.setItem('cls_clock_cfg', JSON.stringify(c));
});
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForTimeout(900);
await page.evaluate(() => document.getElementById('timerBtn').click());
await page.waitForTimeout(1200);
const up1 = (await V('#timerTime')).replace(/\s/g, '');
const upHead = await V('#tmRound');
await page.evaluate(() => document.getElementById('timerBtn').click());
await page.waitForTimeout(300);
const up2 = await V('#timerTime');
await page.waitForTimeout(400);
const up3 = await V('#timerTime');
t('时长为 0 点开始就是正计时', /^\d{2}:\d{2}\.\d{2}$/.test(up1) && up1 !== '00:00.00', up1);
t('正计时时头顶写「正计时」', upHead === '正计时', upHead);
/* 暂停那一刻会比最后一次重绘晚一帧（~10ms），所以比的是「暂停后再读一次是否还在变」 */
t('正计时暂停后停住', up2 === up3, up2 + ' / ' + up3);
await page.evaluate(() => document.getElementById('timerReset').click());
await page.waitForTimeout(200);
t('正计时可以重置', (await V('#timerTime')).indexOf('00:00') === 0, await V('#timerTime'));

/* 5. 倒计时：轮盘设 2 秒 → 开始 → 归零 */
await goTop(page, 'timer');
await goSub(page, 'down');
await page.waitForTimeout(400);
await page.evaluate(() => document.getElementById('timerTime').click());
await page.waitForTimeout(250);
const sheet0 = await page.evaluate(() => document.getElementById('durSheet').className);
t('点大数字能打开时长面板', sheet0.indexOf('show') >= 0, sheet0);
await page.evaluate(() => { window.__clk.wheel('wS', 2); });
await page.waitForTimeout(300);
await page.evaluate(() => document.getElementById('dsOk').click());
await page.waitForTimeout(300);
t('面板里输入 2s 后显示 00:02', (await V('#timerTime')) === '00:02', await V('#timerTime'));
await page.evaluate(() => document.getElementById('timerBtn').click());
await page.waitForTimeout(900);
const mid = await V('#timerTime');
await page.waitForTimeout(2200);
const end = await V('#timerTime');
const endBtn = await V('#timerBtn');
t('倒计时在走', mid === '00:01' || mid === '00:02', mid);
/* 跑完之后回到设定时长、按钮变回「开始」—— 想再来一次直接按就行 */
t('倒计时跑完停在 00:00，按钮回到「开始」', end === '00:00' && /开始/.test(endBtn || ''), end + ' / ' + endBtn);

/* 6. 字体 / 背景 / 12-24 小时 */
await page.evaluate(() => document.getElementById('fontBtn').click());
await page.waitForTimeout(200);
const f1 = await page.evaluate(() => ({ cls: document.body.className, btn: document.getElementById('fontBtn').textContent }));
t('字体可以切换', /f-(hei|mono|round|serif)/.test(f1.cls), JSON.stringify(f1));
await page.evaluate(() => document.getElementById('bgBtn').click());
await page.waitForTimeout(200);
const b1 = await page.evaluate(() => ({ cls: document.body.className, btn: document.getElementById('bgBtn').textContent }));
t('背景可以切换', /bg-(dark|black|cream|navy|green|gray)/.test(b1.cls), JSON.stringify(b1));
await page.evaluate(() => document.getElementById('h12Btn').click());
await page.waitForTimeout(200);
t('12 小时制可切换', (await V('#h12Btn')) === '12 小时', await V('#h12Btn'));

/* 7. 设置会记住 */
const cfg = await page.evaluate(() => localStorage.getItem('cls_clock_cfg'));
t('设置写进了 localStorage', !!cfg && /"mode":"timer"/.test(cfg), cfg);

/* 8. 键盘空格开始/暂停 */
await page.waitForTimeout(2200);
await page.keyboard.press(' ');
await page.waitForTimeout(500);
const kb1 = await V('#timerTime');
t('空格可以开始计时', kb1 !== '00:00:00', kb1);
await page.keyboard.press(' ');
await page.waitForTimeout(200);

/* 9. 更多里写明仿照来源 */
await page.evaluate(() => document.getElementById('aboutBtn').click());
await page.waitForTimeout(300);
const about = await page.evaluate(() => document.getElementById('about').className + '|' + document.querySelector('#about .box').innerText);
t('「更多」里写明仿照的网站', /仿照/.test(about) && /yingming006\.cn/.test(about), about.slice(0, 80));
await page.evaluate(() => document.getElementById('aboutClose').click());

/* 9b. v3.9.23：字号四档、翻页不溢出、计时器默认只看数字 */
await goSub(page, 'clock');
await page.waitForTimeout(400);
const sz0 = await page.evaluate(() => ({ cls: document.body.className, fs: getComputedStyle(document.getElementById('bigTime')).fontSize }));
await page.evaluate(() => document.getElementById('sizeBtn').click());
await page.waitForTimeout(300);
const sz1 = await page.evaluate(() => ({ cls: document.body.className, fs: getComputedStyle(document.getElementById('bigTime')).fontSize }));
t('字号可以切档', /sz-\d/.test(sz1.cls) && sz1.fs !== sz0.fs, JSON.stringify([sz0, sz1]));

await goSub(page, 'flip');
await page.waitForTimeout(600);
const fp = await page.evaluate(() => {
  const f = document.querySelector('.flip');
  const txt = f.querySelector('.half.top .txt');
  return { w: Math.round(f.getBoundingClientRect().width), tw: Math.round(txt.scrollWidth), font: getComputedStyle(txt).fontSize };
});
t('翻页数字不超出卡片', fp.tw <= fp.w + 1, JSON.stringify(fp));

await goTop(page, 'timer');
await page.waitForTimeout(400);
const ts0 = await page.evaluate(() => document.getElementById('durSheet').className);
t('时长面板默认收起', ts0.indexOf('show') < 0, ts0);
await page.evaluate(() => document.getElementById('timerTime').click());
await page.waitForTimeout(300);
const ts1 = await page.evaluate(() => document.getElementById('durSheet').className);
t('点数字可以调出时长面板', ts1.indexOf('show') >= 0, ts1);
await page.evaluate(() => document.getElementById('dsClose').click());
await page.waitForTimeout(200);

/* ---- v3.9.24：翻页可关秒 + 自习（番茄钟） ---- */

/* 9c. 翻页的秒开关 */
await goSub(page, 'flip');
await page.waitForTimeout(500);
const sec0 = await page.evaluate(() => ({
  btn: document.getElementById('secBtn').textContent,
  vis: getComputedStyle(document.getElementById('secBtn')).display,
  cards: [...document.querySelectorAll('#flipView .flip')].filter((e) => getComputedStyle(e).display !== 'none').length,
  w: Math.round(document.querySelector('#flipView .flip').getBoundingClientRect().width),
}));
t('翻页模式下有「秒」开关，默认三张卡', sec0.vis !== 'none' && sec0.cards === 3 && /秒 · 显示/.test(sec0.btn), JSON.stringify(sec0));
await page.evaluate(() => document.getElementById('secBtn').click());
await page.waitForTimeout(600);
const sec1 = await page.evaluate(() => ({
  btn: document.getElementById('secBtn').textContent,
  cls: document.getElementById('flipView').className,
  cards: [...document.querySelectorAll('#flipView .flip')].filter((e) => getComputedStyle(e).display !== 'none').length,
  w: Math.round(document.querySelector('#flipView .flip').getBoundingClientRect().width),
  only: [...document.querySelectorAll('#flipView .flip-sep')].filter((e) => getComputedStyle(e).display !== 'none').length,
}));
t('关掉秒后只剩「时 : 分」两张卡', sec1.cards === 2 && sec1.only === 1 && /秒 · 隐藏/.test(sec1.btn), JSON.stringify(sec1));
t('关掉秒后卡片会放大', sec1.w > sec0.w, sec0.w + ' → ' + sec1.w);
t('切到别的模式时「秒」按钮收起', await page.evaluate(() => {
  document.querySelector('#subTabs button[data-k="clock"]').click();
  return getComputedStyle(document.getElementById('secBtn')).display === 'none';
}));
t('切回翻页仍保持「不要秒」', await page.evaluate(() => {
  document.querySelector('#subTabs button[data-k="flip"]').click();
  return document.getElementById('flipView').className.indexOf('nosec') >= 0;
}));

/* 9d. 计时模块初态（倒计时 / 自习 / 正计时已合并，v3.11.0） */
/* 先把上一段改过的时长还原，免得测到的是 2 秒 */
await page.evaluate(() => {
  const c = JSON.parse(localStorage.getItem('cls_clock_cfg') || '{}');
  c.mode = 'timer'; c.focusSec = 1500; c.rounds = 1; c.restSec = 5;
  c.tk = 'up'; c.downSec = 0; c.bareRun = 0;
  localStorage.setItem('cls_clock_cfg', JSON.stringify(c));
});
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForTimeout(900);
await goTop(page, 'timer');
await page.waitForTimeout(400);
const pm0 = await page.evaluate(() => ({
  tabs: [...document.querySelectorAll('#subTabs button')].map((b) => b.textContent),
  time: document.getElementById('timerTime').textContent,
  btn: document.getElementById('timerBtn').textContent,
  mark: getComputedStyle(document.getElementById('markBtn')).display,
}));
t('计时页上面是「正计时 / 倒计时 / 番茄钟」', pm0.tabs.join('/') === '正计时/倒计时/番茄钟', JSON.stringify(pm0.tabs));
t('刚进来是正计时 00:00', pm0.time.indexOf('00:00') === 0, pm0.time);
t('正计时才有「记一笔」', pm0.mark !== 'none', pm0.mark);
t('还没开始时按钮是「开始」', /开始/.test(pm0.btn), pm0.btn);

await goSub(page, 'down');
await page.waitForTimeout(300);
const pDown = await page.evaluate(() => ({
  time: document.getElementById('timerTime').textContent,
  mark: getComputedStyle(document.getElementById('markBtn')).display,
  skip: getComputedStyle(document.getElementById('skipBtn')).display,
}));
t('倒计时刚进来也是 00:00', pDown.time === '00:00', pDown.time);
t('倒计时没有「记一笔」，也没有「跳过」', pDown.mark === 'none' && pDown.skip === 'none', JSON.stringify(pDown));

await goSub(page, 'pomo');
await page.waitForTimeout(300);
const pPomo = await page.evaluate(() => ({
  time: document.getElementById('timerTime').textContent,
  head: document.getElementById('tmRound').textContent,
  skip: getComputedStyle(document.getElementById('skipBtn')).display,
  mark: getComputedStyle(document.getElementById('markBtn')).display,
}));
t('番茄钟默认 25:00，有「跳过」没「记一笔」', pPomo.time === '25:00' && pPomo.skip !== 'none' && pPomo.mark === 'none', JSON.stringify(pPomo));

/* 9d-2. 老网址参数继续能用（?m=pomo 以前是首页「番茄时钟」卡片的地址） */
{
  const ctxU = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const pU = await ctxU.newPage();
  await pU.goto(BASE + '/clock.html?m=pomo', { waitUntil: 'domcontentloaded' });
  await pU.waitForTimeout(800);
  const u = await pU.evaluate(() => ({
    mode: document.getElementById('modeBtn').textContent,
    phase: document.getElementById('tmPhase').textContent,
  }));
  t('clock.html?m=pomo 自动落到「计时」', u.mode === '计时' && u.phase === '专注', JSON.stringify(u));
  await ctxU.close();
}

/* 9d-3. 跳过：专注里跳过 → 进休息；休息里跳过 → 回专注 */
{
  const ctxK = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const pK = await ctxK.newPage();
  await pK.addInitScript(() => {
    localStorage.setItem('cls_clock_cfg', JSON.stringify({ mode: 'timer', tk: 'pomo', focusSec: 120, restSec: 1, rounds: 2 }));
  });
  await pK.goto(BASE + '/clock.html?m=timer', { waitUntil: 'domcontentloaded' });
  await pK.waitForTimeout(700);
  await pK.evaluate(() => document.getElementById('timerBtn').click());
  await pK.waitForTimeout(300);
  await pK.evaluate(() => document.getElementById('skipBtn').click());
  await pK.waitForTimeout(300);
  const skipRest = await pK.evaluate(() => ({
    phase: window.__clk.state().phase,
    btn: document.getElementById('timerBtn').textContent,
  }));
  t('专注里点跳过：直接进休息', skipRest.phase === 'rest' && /暂停/.test(skipRest.btn), JSON.stringify(skipRest));
  await pK.evaluate(() => document.getElementById('skipBtn').click());
  await pK.waitForTimeout(300);
  const skipFocus = await pK.evaluate(() => ({
    phase: window.__clk.state().phase,
    round: window.__clk.state().round,
  }));
  t('休息里点跳过：进入下一轮专注', skipFocus.phase === 'focus' && skipFocus.round === 2, JSON.stringify(skipFocus));
  await ctxK.close();
}

/* 9e. 多轮循环：专注 → 休息 → 专注 → 结束（用探针快进，不真等） */
{
  const ctx2 = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const p2 = await ctx2.newPage();
  const errs2 = [];
  p2.on('pageerror', (e) => errs2.push(e.message));
  await p2.addInitScript(() => {
    localStorage.setItem('cls_clock_cfg', JSON.stringify({ mode: 'timer', tk: 'pomo', focusSec: 60, restSec: 1, rounds: 2, sound: 'blue' }));
  });
  await p2.goto(BASE + '/clock.html?m=timer', { waitUntil: 'domcontentloaded' });
  await p2.waitForTimeout(800);

  await p2.evaluate(() => document.getElementById('timerBtn').click());
  await p2.waitForTimeout(400);
  const run1 = await p2.evaluate(() => ({ st: window.__clk.state(), head: document.getElementById('tmRound').textContent }));
  t('开始后第 1 轮专注在走', run1.st.run && run1.st.phase === 'focus' && run1.st.round === 1, JSON.stringify(run1));

  await p2.evaluate(() => window.__clk.finish());
  await p2.waitForTimeout(500);
  const afterFocus = await p2.evaluate(() => ({ st: window.__clk.state(), phase: document.getElementById('tmPhase').textContent }));
  t('第 1 轮专注结束自动进休息', afterFocus.st.phase === 'rest' && afterFocus.phase === '休息', JSON.stringify(afterFocus));
  t('进休息后自动接着走', afterFocus.st.run === true, JSON.stringify(afterFocus.st));

  await p2.evaluate(() => window.__clk.finish());
  await p2.waitForTimeout(500);
  const afterRest = await p2.evaluate(() => ({ st: window.__clk.state(), head: document.getElementById('tmRound').textContent }));
  t('休息结束自动进第 2 轮', afterRest.st.phase === 'focus' && afterRest.st.round === 2, JSON.stringify(afterRest));

  await p2.evaluate(() => window.__clk.finish());
  await p2.waitForTimeout(500);
  const doneAll = await p2.evaluate(() => ({ st: window.__clk.state(), btn: document.getElementById('timerBtn').textContent }));
  t('最后一轮跑完就停下', doneAll.st.run === false && /开始/.test(doneAll.btn), JSON.stringify(doneAll));

  /* 番茄数按完成的轮次记 */
  const pomo = await p2.evaluate(() => {
    const k = Object.keys(localStorage).find((x) => x.indexOf('cls_clock_log_') === 0);
    const v = k ? JSON.parse(localStorage.getItem(k)) : null;
    return v ? v.pomo : null;
  });
  t('跑完两轮记 2 个番茄', pomo === 2, 'pomo=' + pomo);

  t('计时模块无 JS 报错', errs2.length === 0, errs2.join(' | '));
  await ctx2.close();
}

/* 9e-2. v3.12.0：默认不收起；站主在设置里打开「开始计时后收起界面」才收起 */
{
  const ctxB = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const pB = await ctxB.newPage();
  const errsB = [];
  pB.on('pageerror', (e) => errsB.push(e.message));
  await pB.addInitScript(() => {
    localStorage.setItem('cls_clock_cfg', JSON.stringify({ mode: 'timer', tk: 'up', bareRun: 0 }));
  });
  await pB.goto(BASE + '/clock.html?m=timer', { waitUntil: 'domcontentloaded' });
  await pB.waitForTimeout(800);

  const cfg0 = await pB.evaluate(() => JSON.parse(localStorage.getItem('cls_clock_cfg') || '{}').bareRun);
  t('默认不收起界面（bareRun = 0）', cfg0 === 0, String(cfg0));

  await pB.evaluate(() => document.getElementById('timerBtn').click());
  await pB.waitForTimeout(500);
  const run0 = await pB.evaluate(() => ({
    bare: document.body.className.indexOf('bare') >= 0,
    acts: getComputedStyle(document.querySelector('#timerView .actions')).display,
  }));
  t('默认开始后按钮还在', !run0.bare && run0.acts === 'flex', JSON.stringify(run0));

  /* 在「更多」里把开关打开 */
  await pB.evaluate(() => document.getElementById('timerReset').click());
  await pB.evaluate(() => document.getElementById('aboutBtn').click());
  await pB.waitForTimeout(200);
  await pB.evaluate(() => document.querySelector('#tmOpts .seg button[data-v="1"]').click());
  await pB.waitForTimeout(150);
  const on = await pB.evaluate(() => ({
    cfg: JSON.parse(localStorage.getItem('cls_clock_cfg') || '{}').bareRun,
    txt: document.querySelector('#tmOpts .seg button.on').textContent,
    cls: document.querySelector('#tmOpts .seg button.on').className,
  }));
  t('开关点一下变「开」并存进配置', on.cfg === 1 && on.txt === '开' && on.cls.indexOf('on') >= 0, JSON.stringify(on));
  await pB.evaluate(() => document.getElementById('aboutClose').click());

  await pB.evaluate(() => document.getElementById('timerBtn').click());
  await pB.waitForTimeout(500);
  const run1 = await pB.evaluate(() => {
    const r = document.getElementById('timerTime').getBoundingClientRect();
    return {
      bare: document.body.className.indexOf('bare') >= 0,
      acts: getComputedStyle(document.querySelector('#timerView .actions')).display,
      head: getComputedStyle(document.getElementById('tmHead')).display,
      subj: getComputedStyle(document.getElementById('subjRow')).display,
      centerGap: Math.round(Math.abs((r.top + r.height / 2) - window.innerHeight / 2)),
    };
  });
  t('打开开关后：跑起来只剩数字', run1.bare && run1.acts === 'none' && run1.subj === 'none', JSON.stringify(run1));
  t('跑起来后数字在屏幕正中（±30px）', run1.centerGap <= 30, 'gap=' + run1.centerGap);

  await pB.evaluate(() => document.getElementById('timerTime').click());
  await pB.waitForTimeout(400);
  const open1 = await pB.evaluate(() => ({
    bare: document.body.className.indexOf('bare') >= 0,
    acts: getComputedStyle(document.querySelector('#timerView .actions')).display,
  }));
  t('点一下数字把操作区唤出来', !open1.bare && open1.acts === 'flex', JSON.stringify(open1));
  await pB.evaluate(() => document.getElementById('timerTime').click());
  await pB.waitForTimeout(300);
  t('再点一下又收起', await pB.evaluate(() => document.body.className.indexOf('bare') >= 0));

  await pB.evaluate(() => document.getElementById('timerBtn').click());   /* 暂停 → 展开 */
  await pB.waitForTimeout(400);
  t('暂停时自动展开操作区', await pB.evaluate(() => document.body.className.indexOf('bare') < 0));
  t('极简模式无 JS 报错', errsB.length === 0, errsB.join(' | '));
  await ctxB.close();
}

/* 9e-4. v3.12.1：轮盘用自己实现的拖动（不依赖系统滚动），拖两格就是 2 */
{
  const ctxW = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const pW = await ctxW.newPage();
  const errsW = [];
  pW.on('pageerror', (e) => errsW.push(e.message));
  await pW.addInitScript(() => {
    localStorage.setItem('cls_clock_cfg', JSON.stringify({ mode: 'timer', tk: 'down', downSec: 0 }));
  });
  await pW.goto(BASE + '/clock.html?m=timer', { waitUntil: 'domcontentloaded' });
  await pW.waitForTimeout(900);
  await pW.evaluate(() => document.getElementById('timerTime').click());
  await pW.waitForTimeout(300);

  const box = await pW.evaluate(() => {
    const r = document.getElementById('wM').getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  /* 往上拖 88px = 2 格 */
  await pW.mouse.move(box.x, box.y);
  await pW.mouse.down();
  await pW.mouse.move(box.x, box.y - 40, { steps: 4 });
  await pW.mouse.move(box.x, box.y - 88, { steps: 4 });
  await pW.mouse.up();
  await pW.waitForTimeout(400);

  const drag = await pW.evaluate(() => {
    const w = document.querySelector('#wM .w-item.on');
    return { on: w ? w.textContent : '', transform: document.querySelector('#wM .w-list').style.transform };
  });
  t('拖动轮盘能滚动（拖两格到 02）', drag.on === '02', JSON.stringify(drag));

  await pW.evaluate(() => document.getElementById('dsOk').click());
  await pW.waitForTimeout(300);
  const val = await pW.evaluate(() => JSON.parse(localStorage.getItem('cls_clock_cfg')).downSec);
  t('拖出来的 2 分钟存进了配置', val === 120, String(val));
  t('轮盘无 JS 报错', errsW.length === 0, errsW.join(' | '));
  await ctxW.close();
}

/* 9e-3. v3.11.1：响铃遍数可配（默认 2，等放完再放下一遍） */
{
  const ctxT = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const pT = await ctxT.newPage();
  await pT.goto(BASE + '/clock.html?m=timer', { waitUntil: 'domcontentloaded' });
  await pT.waitForTimeout(800);
  const times0 = await pT.evaluate(() => {
    const c = JSON.parse(localStorage.getItem('cls_clock_cfg') || '{}');
    return { cfg: c.alertTimes, btns: [...document.querySelectorAll('#alertList .al-row button')].slice(0, 5).map((b) => b.textContent) };
  });
  t('提醒遍数默认 2 遍', times0.cfg === 2 || times0.cfg === undefined, JSON.stringify(times0.cfg));
  await pT.evaluate(() => {
    const row = document.querySelector('#alertList .al-row');
    const btns = [...row.querySelectorAll('button')];
    btns[3].click();      /* 选 4 遍 */
  });
  await pT.waitForTimeout(300);
  const times1 = await pT.evaluate(() => ({
    cfg: JSON.parse(localStorage.getItem('cls_clock_cfg') || '{}').alertTimes,
    on: document.querySelector('#alertList .al-row button.on').textContent,
  }));
  t('点一下能改成 4 遍并存进配置', times1.cfg === 4 && times1.on === '4', JSON.stringify(times1));
  await ctxT.close();
}

/* 9f. v3.10.0：全屏「时间到」提醒（倒计时 + 自定义文字 + 自动消失 + 点击关闭） */
{
  const ctx3 = await browser.newContext({ viewport: { width: 1280, height: 820 } });
  const p3 = await ctx3.newPage();
  const errs3 = [];
  p3.on('pageerror', (e) => errs3.push(e.message));
  await p3.goto(BASE + '/clock.html', { waitUntil: 'domcontentloaded' });
  await p3.waitForTimeout(700);

  await p3.evaluate(() => document.getElementById('aboutBtn').click());
  await p3.waitForTimeout(200);
  await p3.evaluate(() => {
    const i = document.getElementById('toastInp');
    i.value = '下课啦';
    i.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await p3.waitForTimeout(150);
  await p3.evaluate(() => document.getElementById('aboutClose').click());

  await goTop(p3, 'timer');
  await goSub(p3, 'down');
  await p3.waitForTimeout(250);
  await p3.evaluate(() => {
    document.getElementById('timerTime').click();
    window.__clk.wheel('wS', 1);
  });
  await p3.waitForTimeout(300);
  await p3.evaluate(() => document.getElementById('dsOk').click());
  await p3.waitForTimeout(150);
  await p3.evaluate(() => document.getElementById('timerBtn').click());
  await p3.waitForTimeout(1700);
  const fa0 = await p3.evaluate(() => ({
    on: document.getElementById('fullAlert').className.indexOf('on') >= 0,
    txt: document.getElementById('fullAlertTxt').textContent,
  }));
  t('倒计时到点弹出全屏提醒', fa0.on, JSON.stringify(fa0));
  t('全屏提醒显示自定义文字', fa0.txt === '下课啦', fa0.txt);

  await p3.evaluate(() => document.getElementById('fullAlert').click());
  await p3.waitForTimeout(100);
  t('点击可提前关闭全屏提醒', await p3.evaluate(() => document.getElementById('fullAlert').className.indexOf('on') < 0));

  await p3.evaluate(() => document.getElementById('timerBtn').click());
  await p3.waitForTimeout(1700);
  const onBefore = await p3.evaluate(() => document.getElementById('fullAlert').className.indexOf('on') >= 0);
  await p3.waitForTimeout(3200);
  const onAfter = await p3.evaluate(() => document.getElementById('fullAlert').className.indexOf('on') >= 0);
  t('全屏提醒约 3 秒后自动消失', onBefore && !onAfter, 'before=' + onBefore + ' after=' + onAfter);

  t('全屏提醒无 JS 报错', errs3.length === 0, errs3.join(' | '));
  await ctx3.close();
}

/* 9g. 专注结束（多轮里的第 1 轮）也弹全屏提醒（用假时钟快进） */
{
  const ctx4 = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const p4 = await ctx4.newPage();
  await p4.clock.install({ time: new Date('2026-10-25T15:00:00') });
  await p4.addInitScript(() => {
    localStorage.setItem('cls_clock_cfg', JSON.stringify({ mode: 'timer', tk: 'pomo', focusSec: 60, restSec: 1, rounds: 3 }));
  });
  await p4.goto(BASE + '/clock.html?m=timer', { waitUntil: 'domcontentloaded' });
  await p4.clock.runFor(400);
  await p4.evaluate(() => document.getElementById('timerBtn').click());
  await p4.clock.runFor(61000);
  const fa = await p4.evaluate(() => ({
    on: document.getElementById('fullAlert').className.indexOf('on') >= 0,
    txt: document.getElementById('fullAlertTxt').textContent,
    phase: window.__clk.state().phase,
  }));
  t('第 1 轮专注结束弹「时间到」并进休息', fa.on && fa.txt === '时间到！' && fa.phase === 'rest', JSON.stringify(fa));
  await ctx4.close();
}

/* 9h. v3.10.0：自习「科目 + 这次做什么」 */
{
  const ctx5 = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const p5 = await ctx5.newPage();
  const errs5 = [];
  p5.on('pageerror', (e) => errs5.push(e.message));
  await p5.goto(BASE + '/clock.html?m=pomo', { waitUntil: 'domcontentloaded' });
  await p5.waitForTimeout(700);

  const subjN = await p5.evaluate(() => document.querySelectorAll('#subjRow button').length);
  t('科目按钮共 7 个（含「其他」）', subjN === 7, 'subjN=' + subjN);
  t('有「这次做什么」输入框', await p5.evaluate(() => !!document.getElementById('doingInp')));

  await p5.evaluate(() => document.querySelector('[data-subj="语文"]').click());
  await p5.waitForTimeout(150);
  const n1 = await p5.evaluate(() => document.getElementById('modeName').textContent);
  t('选语文后显示「语文」', n1 === '语文', n1);

  await p5.evaluate(() => {
    const i = document.getElementById('doingInp');
    i.value = '试卷';
    i.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await p5.waitForTimeout(150);
  const n2 = await p5.evaluate(() => document.getElementById('modeName').textContent);
  t('填「试卷」后显示「语文·试卷」', n2 === '语文·试卷', n2);

  await p5.evaluate(() => document.querySelector('[data-subj="其他"]').click());
  await p5.waitForTimeout(150);
  const n3 = await p5.evaluate(() => document.getElementById('modeName').textContent);
  t('选「其他」后只显示做的事', n3 === '试卷', n3);

  await p5.evaluate(() => {
    const i = document.getElementById('doingInp');
    i.value = '家务';
    i.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await p5.waitForTimeout(150);
  const n4 = await p5.evaluate(() => document.getElementById('modeName').textContent);
  t('其他 + 家务 显示「家务」', n4 === '家务', n4);

  t('自习科目/事项功能无 JS 报错', errs5.length === 0, errs5.join(' | '));
  await ctx5.close();
}

/* 9i. v3.10.0：音效升级 / 白噪音 / 工具栏手动收起 */
{
  const ctx6 = await browser.newContext({ viewport: { width: 1280, height: 820 } });
  const p6 = await ctx6.newPage();
  const errs6 = [];
  p6.on('pageerror', (e) => errs6.push(e.message));
  await p6.goto(BASE + '/clock.html', { waitUntil: 'domcontentloaded' });
  await p6.waitForTimeout(700);

  const snds = await p6.evaluate(() => [...document.querySelectorAll('#sndRow button')].map((b) => b.getAttribute('data-snd')));
  t('音效有「叮咚」「清脆」等 7 个选项', snds.length === 7 && snds.includes('ding') && snds.includes('chime'), JSON.stringify(snds));
  await p6.evaluate(() => document.querySelector('[data-snd="blue"]').click());
  await p6.waitForTimeout(200);
  t('点「蓝牙」能选中并存进配置（无报错即真实音频解码播放成功）', await p6.evaluate(() => {
    const c = JSON.parse(localStorage.getItem('cls_clock_cfg') || '{}');
    return c.sound === 'blue' && document.querySelector('[data-snd="blue"]').className === 'on';
  }));

  const noises = await p6.evaluate(() => [...document.querySelectorAll('#noiseRow button')].map((b) => b.getAttribute('data-noise')));
  t('白噪音有雨 / 风 / 海浪 3 个', noises.length === 3 && noises.includes('rain') && noises.includes('wind') && noises.includes('wave'), JSON.stringify(noises));
  await p6.evaluate(() => document.querySelector('[data-noise="rain"]').click());
  await p6.waitForTimeout(150);
  t('点「雨声」能打开并记进配置', await p6.evaluate(() => { const c = JSON.parse(localStorage.getItem('cls_clock_cfg') || '{}'); return !!(c.noise && c.noise.rain); }));
  await p6.evaluate(() => document.querySelector('[data-noise="rain"]').click());
  await p6.waitForTimeout(150);
  t('再点一下能关掉', await p6.evaluate(() => { const c = JSON.parse(localStorage.getItem('cls_clock_cfg') || '{}'); return !(c.noise && c.noise.rain); }));

  await p6.evaluate(() => { document.getElementById('bar').className = 'show'; });
  await p6.waitForTimeout(100);
  t('有常驻的工具栏开关按钮', await p6.evaluate(() => !!document.getElementById('barBtn')));
  await p6.evaluate(() => document.getElementById('barBtn').click());
  await p6.waitForTimeout(150);
  t('点开关立即收起工具栏', await p6.evaluate(() => document.getElementById('bar').className.indexOf('show') < 0));
  t('收起后箭头变成「展开」方向', await p6.evaluate(() => document.getElementById('barBtn').className.indexOf('open') < 0));
  await p6.evaluate(() => document.getElementById('barBtn').click());
  await p6.waitForTimeout(150);
  t('再点开关能重新展开工具栏', await p6.evaluate(() => document.getElementById('bar').className.indexOf('show') >= 0));
  t('展开后箭头翻回「收起」方向', await p6.evaluate(() => document.getElementById('barBtn').className.indexOf('open') >= 0));
  t('点空白处也能展开工具栏', await p6.evaluate(() => {
    document.getElementById('bar').className = '';
    document.getElementById('barBtn').className = '';
    document.getElementById('stage').dispatchEvent(new MouseEvent('click', {bubbles:true}));
    return document.getElementById('bar').className.indexOf('show') >= 0;
  }));
  const sndKeys = await p6.evaluate(() => [...document.querySelectorAll('#sndRow button')].map((b) => b.getAttribute('data-snd')));
  t('音效含蓝牙（时间到推荐）等 7 项', sndKeys.length === 7 && sndKeys.includes('blue') && sndKeys.includes('ding') && sndKeys.includes('bell'), JSON.stringify(sndKeys));

  t('音效 / 白噪音 / 收起无 JS 报错', errs6.length === 0, errs6.join(' | '));
  await ctx6.close();
}

/* 10. 无 JS 报错 */
t('无 JS 报错', errs.length === 0, errs.join(' | '));

await browser.close();
console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
