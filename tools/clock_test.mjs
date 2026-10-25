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

/* 1. 四种模式都在 */
const modes = await page.evaluate(() => [...document.querySelectorAll('#modeMenu button')].map((b) => b.textContent.trim()));
t('四种模式齐全', ['数字', '翻页', '秒表', '计时器'].every((m) => modes.includes(m)), JSON.stringify(modes));

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

/* 10. 无 JS 报错 */
t('无 JS 报错', errs.length === 0, errs.join(' | '));

await browser.close();
console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
