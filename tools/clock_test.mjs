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

const V = (sel) => page.evaluate((s) => {
  const el = document.querySelector(s);
  return el ? el.textContent.trim() : null;
}, sel);

/* 1. 五种模式都在 */
const modes = await page.evaluate(() => [...document.querySelectorAll('#modeMenu button')].map((b) => b.textContent.trim()));
t('五种模式齐全', ['数字', '翻页', '秒表', '计时器', '自习'].every((m) => modes.includes(m)), JSON.stringify(modes));

/* 2. 数字时钟：时间格式 + 日期 + 农历 */
await page.evaluate(() => document.querySelector('[data-m="clock"]').click());
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
await page.evaluate(() => document.querySelector('[data-m="flip"]').click());
await page.waitForTimeout(1200);
const flip = await page.evaluate(() => ({
  cards: document.querySelectorAll('#flipView .flip').length,
  vals: [...document.querySelectorAll('#flipView .flip .top .txt')].map((e) => e.textContent),
}));
t('翻页是三张卡片', flip.cards === 3, JSON.stringify(flip));
t('翻页卡片有数字', flip.vals.every((v) => /^\d{2}$/.test(v)), JSON.stringify(flip.vals));

/* 4. 秒表：开始 → 数字在走 → 暂停 → 重置 */
await page.evaluate(() => document.querySelector('[data-m="stop"]').click());
await page.waitForTimeout(300);
await page.evaluate(() => document.getElementById('stopBtn').click());
await page.waitForTimeout(1200);
const sw1 = await V('#stopTime');
await page.evaluate(() => document.getElementById('stopBtn').click());
await page.waitForTimeout(300);
const sw2 = await V('#stopTime');
await page.waitForTimeout(400);
const sw3 = await V('#stopTime');
t('秒表开始后秒数在走', sw1 !== '00:00.00' && /^\d{2}:\d{2}\.\d{2}$/.test((sw1 || '').replace(/\s/g, '')), sw1);
/* 暂停那一刻会比最后一次重绘晚一帧（~10ms），所以比的是「暂停后再读一次是否还在变」 */
t('秒表暂停后数字停住', sw2 === sw3, sw2 + ' / ' + sw3);
await page.evaluate(() => document.getElementById('stopReset').click());
await page.waitForTimeout(200);
t('秒表可以重置', (await V('#stopTime')).indexOf('00:00') === 0, await V('#stopTime'));

/* 5. 计时器：设 2 秒 → 开始 → 归零 */
await page.evaluate(() => document.querySelector('[data-m="timer"]').click());
await page.waitForTimeout(300);
await page.evaluate(() => {
  document.getElementById('th').value = 0;
  document.getElementById('tm').value = 0;
  document.getElementById('ts').value = 2;
  document.getElementById('ts').dispatchEvent(new Event('change', { bubbles: true }));
});
await page.waitForTimeout(200);
t('计时器显示 时:分:秒', (await V('#timerTime')) === '00:00:02', await V('#timerTime'));
await page.evaluate(() => document.getElementById('timerBtn').click());
await page.waitForTimeout(900);
const mid = await V('#timerTime');
await page.waitForTimeout(2200);
const end = await V('#timerTime');
t('计时器在倒数', mid === '00:00:01' || mid === '00:00:02', mid);
t('倒计时到 0 停住', end === '00:00:00', end);

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
await page.evaluate(() => { document.querySelector('[data-m="clock"]').click(); });
await page.waitForTimeout(400);
const sz0 = await page.evaluate(() => ({ cls: document.body.className, fs: getComputedStyle(document.getElementById('bigTime')).fontSize }));
await page.evaluate(() => document.getElementById('sizeBtn').click());
await page.waitForTimeout(300);
const sz1 = await page.evaluate(() => ({ cls: document.body.className, fs: getComputedStyle(document.getElementById('bigTime')).fontSize }));
t('字号可以切档', /sz-\d/.test(sz1.cls) && sz1.fs !== sz0.fs, JSON.stringify([sz0, sz1]));

await page.evaluate(() => { document.querySelector('[data-m="flip"]').click(); });
await page.waitForTimeout(600);
const fp = await page.evaluate(() => {
  const f = document.querySelector('.flip');
  const txt = f.querySelector('.half.top .txt');
  return { w: Math.round(f.getBoundingClientRect().width), tw: Math.round(txt.scrollWidth), font: getComputedStyle(txt).fontSize };
});
t('翻页数字不超出卡片', fp.tw <= fp.w + 1, JSON.stringify(fp));

await page.evaluate(() => { document.querySelector('[data-m="timer"]').click(); });
await page.waitForTimeout(400);
const ts0 = await page.evaluate(() => document.getElementById('timerSet').className);
t('计时器默认只显示数字', ts0.indexOf('hide') >= 0, ts0);
await page.evaluate(() => document.getElementById('timerTime').click());
await page.waitForTimeout(300);
const ts1 = await page.evaluate(() => document.getElementById('timerSet').className);
t('点数字可以调出时长设置', ts1.indexOf('hide') < 0, ts1);

/* ---- v3.9.24：翻页可关秒 + 自习（番茄钟） ---- */

/* 9c. 翻页的秒开关 */
await page.evaluate(() => { document.querySelector('[data-m="flip"]').click(); });
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
  document.querySelector('[data-m="clock"]').click();
  return getComputedStyle(document.getElementById('secBtn')).display === 'none';
}));
t('切回翻页仍保持「不要秒」', await page.evaluate(() => {
  document.querySelector('[data-m="flip"]').click();
  return document.getElementById('flipView').className.indexOf('nosec') >= 0;
}));

/* 9d. 自习模式初态 */
await page.evaluate(() => { document.querySelector('[data-m="pomo"]').click(); });
await page.waitForTimeout(400);
const pm0 = await page.evaluate(() => ({
  phase: document.getElementById('pomoPhase').textContent,
  time: document.getElementById('pomoTime').textContent,
  set: document.getElementById('pomoSet').className,
  btn: document.getElementById('pomoBtn').textContent,
  dim: getComputedStyle(document.getElementById('pomoTime')).opacity,
}));
t('自习默认「专注 25:00」且设置收起', pm0.phase === '专注' && pm0.time === '25:00' && pm0.set.indexOf('hide') >= 0, JSON.stringify(pm0));
t('还没开始时数字不灰', Number(pm0.dim) > 0.9, pm0.dim);
await page.evaluate(() => document.getElementById('pomoTime').click());
await page.waitForTimeout(250);
t('点数字能展开时长设置', await page.evaluate(() => document.getElementById('pomoSet').className.indexOf('hide') < 0));

/* 9d-2. 网址参数直达自习（首页「番茄时钟」卡片用的就是它） */
{
  const ctxU = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const pU = await ctxU.newPage();
  await pU.goto(BASE + '/clock.html?m=pomo', { waitUntil: 'domcontentloaded' });
  await pU.waitForTimeout(800);
  const u = await pU.evaluate(() => ({
    mode: document.getElementById('modeBtn').textContent,
    phase: document.getElementById('pomoPhase').textContent,
  }));
  t('clock.html?m=pomo 直接进自习', u.mode === '自习' && u.phase === '专注', JSON.stringify(u));
  await ctxU.close();
}

/* 9d-3. 跳过：跑着就接着跑下一段，没跑就停着等按开始 */
{
  const ctxK = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const pK = await ctxK.newPage();
  await pK.goto(BASE + '/clock.html?m=pomo', { waitUntil: 'domcontentloaded' });
  await pK.waitForTimeout(700);
  await pK.evaluate(() => document.getElementById('pomoSkip').click());
  await pK.waitForTimeout(250);
  const idle = await pK.evaluate(() => ({
    btn: document.getElementById('pomoBtn').textContent,
    phase: document.getElementById('pomoPhase').textContent,
  }));
  t('没开始时跳过：停在休息，等按开始', idle.phase === '休息' && /开始/.test(idle.btn), JSON.stringify(idle));
  await pK.evaluate(() => document.getElementById('pomoBtn').click());
  await pK.waitForTimeout(300);
  await pK.evaluate(() => document.getElementById('pomoSkip').click());
  await pK.waitForTimeout(300);
  const running = await pK.evaluate(() => ({
    btn: document.getElementById('pomoBtn').textContent,
    phase: document.getElementById('pomoPhase').textContent,
  }));
  t('跑着时跳过：接着跑下一段', running.phase === '专注' && /暂停/.test(running.btn), JSON.stringify(running));
  await ctxK.close();
}

/* 9e. 用假时钟跑完整番茄循环（1 分钟专注 / 1 分钟休息） */
{
  const ctx2 = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const p2 = await ctx2.newPage();
  const errs2 = [];
  p2.on('pageerror', (e) => errs2.push(e.message));
  await p2.clock.install({ time: new Date('2026-10-25T15:00:00') });
  await p2.goto(BASE + '/clock.html', { waitUntil: 'domcontentloaded' });
  await p2.clock.runFor(400);
  await p2.evaluate(() => { document.querySelector('[data-m="pomo"]').click(); });
  await p2.clock.runFor(200);
  await p2.evaluate(() => {
    const pf = document.getElementById('pf'), pb = document.getElementById('pb');
    pf.value = 1; pf.dispatchEvent(new Event('change', { bubbles: true }));
    pb.value = 1; pb.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await p2.clock.runFor(200);
  const before = await p2.evaluate(() => document.getElementById('pomoTime').textContent);
  await p2.evaluate(() => document.getElementById('pomoBtn').click());
  await p2.clock.runFor(3000);
  const running = await p2.evaluate(() => ({
    t: document.getElementById('pomoTime').textContent,
    btn: document.getElementById('pomoBtn').textContent,
  }));
  t('自习开始后倒计时在走', running.t !== before && /01:00|00:5\d/.test(running.t) && /暂停/.test(running.btn), JSON.stringify([before, running]));

  await p2.clock.runFor(61000);
  const afterFocus = await p2.evaluate(() => ({
    phase: document.getElementById('pomoPhase').textContent,
    cnt: document.getElementById('pomoCount').textContent,
    cls: document.getElementById('pomoPhase').className,
  }));
  t('专注结束自动进休息并记一个番茄', afterFocus.phase === '休息' && afterFocus.cnt === '1' && afterFocus.cls === 'rest', JSON.stringify(afterFocus));
  t('进休息后自动继续走', await p2.evaluate(() => document.getElementById('pomoBtn').textContent.indexOf('暂停') >= 0));

  await p2.clock.runFor(61000);
  t('休息结束自动回到专注', await p2.evaluate(() => document.getElementById('pomoPhase').textContent) === '专注');

  /* 跳到第 4 个番茄，看长休息 */
  for (let i = 0; i < 3; i++) {
    await p2.clock.runFor(61000);   // 专注
    await p2.clock.runFor(61000);   // 休息
  }
  const longRest = await p2.evaluate(() => ({
    phase: document.getElementById('pomoPhase').textContent,
    cnt: document.getElementById('pomoCount').textContent,
    t: document.getElementById('pomoTime').textContent,
  }));
  t('每 4 个番茄给一次长休息', longRest.phase === '长休息' && longRest.cnt === '4', JSON.stringify(longRest));

  /* 隔天打开：今天的计数要归零 */
  await p2.clock.setSystemTime(new Date('2026-10-26T09:00:00'));
  await p2.reload({ waitUntil: 'domcontentloaded' });
  await p2.clock.runFor(400);
  await p2.evaluate(() => { document.querySelector('[data-m="pomo"]').click(); });
  await p2.clock.runFor(300);
  const nextDay = await p2.evaluate(() => document.getElementById('pomoCount').textContent);
  t('换一天番茄计数自动归零', nextDay === '0', nextDay);
  t('自习模式无 JS 报错', errs2.length === 0, errs2.join(' | '));
  await ctx2.close();
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

  await p3.evaluate(() => { document.querySelector('[data-m="timer"]').click(); });
  await p3.waitForTimeout(200);
  await p3.evaluate(() => {
    document.getElementById('th').value = 0;
    document.getElementById('tm').value = 0;
    document.getElementById('ts').value = 1;
    document.getElementById('ts').dispatchEvent(new Event('change', { bubbles: true }));
  });
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

  await p3.evaluate(() => {
    document.getElementById('ts').value = 1;
    document.getElementById('ts').dispatchEvent(new Event('change', { bubbles: true }));
    document.getElementById('timerBtn').click();
  });
  await p3.waitForTimeout(1700);
  const onBefore = await p3.evaluate(() => document.getElementById('fullAlert').className.indexOf('on') >= 0);
  await p3.waitForTimeout(3200);
  const onAfter = await p3.evaluate(() => document.getElementById('fullAlert').className.indexOf('on') >= 0);
  t('全屏提醒约 3 秒后自动消失', onBefore && !onAfter, 'before=' + onBefore + ' after=' + onAfter);

  t('全屏提醒无 JS 报错', errs3.length === 0, errs3.join(' | '));
  await ctx3.close();
}

/* 9g. 自习阶段切换也弹全屏提醒（用假时钟快进） */
{
  const ctx4 = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const p4 = await ctx4.newPage();
  await p4.clock.install({ time: new Date('2026-10-25T15:00:00') });
  await p4.goto(BASE + '/clock.html', { waitUntil: 'domcontentloaded' });
  await p4.clock.runFor(400);
  await p4.evaluate(() => { document.querySelector('[data-m="pomo"]').click(); });
  await p4.clock.runFor(200);
  await p4.evaluate(() => {
    const pf = document.getElementById('pf'), pb = document.getElementById('pb');
    pf.value = 1; pf.dispatchEvent(new Event('change', { bubbles: true }));
    pb.value = 1; pb.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await p4.clock.runFor(200);
  await p4.evaluate(() => document.getElementById('pomoBtn').click());
  await p4.clock.runFor(61000);
  const fa = await p4.evaluate(() => ({
    on: document.getElementById('fullAlert').className.indexOf('on') >= 0,
    txt: document.getElementById('fullAlertTxt').textContent,
    phase: document.getElementById('pomoPhase').textContent,
  }));
  t('自习专注结束也弹全屏提醒', fa.on && fa.txt === '时间到！', JSON.stringify(fa));
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
