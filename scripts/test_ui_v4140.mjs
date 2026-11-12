/* v4.14.0 专项：
   ① 「查看画像」由下拉框改为搜索式自动补全，列表按学号排序
   ② 姓名 / 学号都能搜，点选后切人并显示「正在看别人的画像」
   ③ 选中自己会清掉 viewAs，不误挂提示
   ④ 弹层 fixed 挂 body，位置在视口内，Esc 可关
   ⑤ 密码强度条：评分分级 + 四格点亮 + 注册表单已接入
   ⑥ 后台修改密码同样有强度条（独立页面，规则同源） */
import { chromium } from 'playwright-core';
import fs from 'node:fs';

const BASE = (process.env.CLS_SITE || 'http://localhost:8899').replace(/\/$/, '');
const CH = '/root/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const OUT = '/workspace/classsite-v4140/';
fs.mkdirSync(OUT, { recursive: true });

let pass = 0, fail = 0;
const t = (n, ok, x) => {
  if (ok) { pass++; console.log('  ✓ ' + n + (x ? '  [' + x + ']' : '')); }
  else { fail++; console.log('  ✗ ' + n + (x ? '  [' + x + ']' : '')); }
};

const ROWS = [
  { id: 11, name: '陈曦', studentId: '250512' },
  { id: 12, name: '李四', studentId: '250503' },
  { id: 13, name: '张三', studentId: '250501' },
  { id: 14, name: '王五', studentId: '250515' },
  { id: 15, name: '赵六', studentId: '' },
  { id: 16, name: '阿明', studentId: '250508' },
];

const browser = await chromium.launch({ executablePath: CH, args: ['--no-sandbox'] });

async function open(width = 412, height = 900) {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message.slice(0, 120)));
  await page.route('**/api/**', (r) => {
    const u = r.request().url();
    const J = (o) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
    if (u.includes('/api/island')) return J({ ok: true, data: null });
    if (u.includes('/api/content')) return J({ ok: true, items: { announcements: [] } });
    return J({ ok: true });
  });
  await page.addInitScript(() => {
    localStorage.setItem('cls_login_guide_v1', '1');
    localStorage.setItem('cls_theme', 'light');
    localStorage.setItem('cls_theme_auto2', 'off');
    localStorage.setItem('cls_tour_v1', JSON.stringify({ login: { done: 1 }, home: { done: 1 }, services: { done: 1 }, hwpop: { done: 1 }, scores: { done: 1 }, big: { done: 1 }, settings: { done: 1 }, files: { done: 1 } }));
  });
  await page.goto(BASE + '/index.html', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(2400);
  const w = await page.$('.welcome-mask.show button');
  if (w) { try { await w.click({ timeout: 600 }); await page.waitForTimeout(300); } catch (e) {} }
  return { ctx, page, errs };
}

console.log('\nA. 查看画像');
{
  const { ctx, page, errs } = await open();
  /* 首页的异步渲染会把板块容器整块重建，等它彻底停下来再注入测试状态 */
  await page.waitForTimeout(2600);
  await page.evaluate((rows) => {
    window.AUTH.user = { id: 0, role: 'admin', name: '班级电脑' };
    SC.rows = rows; SC.viewAs = null; SC.tab = 'me'; SC.exam = { subjects: [], cutlines: [] };
    SC.loaded = true; openCat(3); scLoad = function(){}; scEnsureMounted = function(){};
  }, ROWS);
  await page.waitForTimeout(700);
  await page.evaluate(() => {
    document.getElementById('scPaneBox').innerHTML = scViewBar();
    SC._vpList = null;
  });
  await page.waitForTimeout(200);

  t('A1 不再是 <select>', await page.evaluate(() => !document.querySelector('.sc-viewbar-sel')));
  t('A2 按钮显示当前同学（姓名 + 学号）', /陈曦（250512）/.test(await page.textContent('#scVPickCur')));

  await page.click('#scVPickBtn');
  await page.waitForTimeout(350);
  const order = await page.evaluate(() => [...document.querySelectorAll('#scVPickList .sc-vpick-item')].map((b) => b.querySelector('.sc-vpick-sid').textContent));
  t('A3 列表按学号升序，无学号排最后', JSON.stringify(order) === JSON.stringify(['250501', '250503', '250508', '250512', '250515', '无学号']), order.join(','));

  await page.fill('#scVPickInp', '张');
  await page.waitForTimeout(250);
  t('A4 按姓名筛出 1 人', (await page.$$('#scVPickList .sc-vpick-item')).length === 1, '');
  t('A5 命中的字有高亮', await page.evaluate(() => !!document.querySelector('#scVPickList mark')));

  await page.fill('#scVPickInp', '2505');
  await page.waitForTimeout(250);
  t('A6 按学号前缀筛出 5 人', (await page.$$('#scVPickList .sc-vpick-item')).length === 5);

  await page.fill('#scVPickInp', '李四');
  await page.waitForTimeout(200);
  await page.click('#scVPickList .sc-vpick-item');
  await page.waitForTimeout(500);
  const picked = await page.evaluate(() => ({
    viewAs: SC.viewAs,
    tab: SC.tab,
    pane: document.getElementById('scPaneBox').innerHTML.slice(0, 140),
    label: document.getElementById('scVPickCur') ? document.getElementById('scVPickCur').textContent : '(none)',
    tip: document.querySelector('.sc-viewbar-tip') ? document.querySelector('.sc-viewbar-tip').textContent : '',
    pop: document.querySelectorAll('body > .sc-vpick-pop').length,
  }));
  t('A7 点选后切到李四', picked.viewAs === '12' && /李四（250503）/.test(picked.label), JSON.stringify(picked));
  t('A8 顶部出现「正在看别人的画像」', /正在看别人/.test(picked.tip));
  t('A9 弹层选完即从 body 摘掉', picked.pop === 0, String(picked.pop));

  /* 选中自己 → viewAs 归零 */
  if (!(await page.$('#scVPickBtn'))) {
    await page.evaluate(() => { document.getElementById('scPaneBox').innerHTML = scViewBar(); });
  }
  /* 让这个管理员同时是学生「陈曦」，才能验证「选自己 = 看本人」 */
  await page.evaluate(() => { AUTH.user.name = '陈曦'; });
  await page.click('#scVPickBtn');
  await page.waitForTimeout(300);
  await page.fill('#scVPickInp', '陈曦');
  await page.waitForTimeout(200);
  await page.click('#scVPickList .sc-vpick-item');
  await page.waitForTimeout(500);
  t('A10 选中自己清空 viewAs', await page.evaluate(() => SC.viewAs === null));

  /* 弹层位置 + Esc */
  await page.click('#scVPickBtn');
  await page.waitForTimeout(350);
  const box = await page.evaluate(() => {
    const p = document.getElementById('scVPickPop').getBoundingClientRect();
    return { x: p.x, y: p.y, w: p.width, h: p.height, vw: innerWidth, vh: innerHeight, pos: getComputedStyle(document.getElementById('scVPickPop')).position };
  });
  t('A11 弹层 fixed 且在视口内', box.pos === 'fixed' && box.x >= 0 && box.x + box.w <= box.vw + 1 && box.y + box.h <= box.vh + 1, JSON.stringify(box));
  await page.keyboard.press('Escape');
  await page.waitForTimeout(250);
  t('A12 Esc 收起', await page.evaluate(() => document.getElementById('scVPickPop').hidden === true));
  t('A13 无脚本报错', errs.length === 0, errs.slice(0, 2).join(' | '));
  await ctx.close();
}

console.log('\nB. 密码强度');
{
  const { ctx, page, errs } = await open();
  const sc = await page.evaluate(() => ['123456', '20100710', 'abc123', 'abc12345', 'Abc12345', 'Abc123!@#xyz', 'aaaaaaaa'].map((v) => [v, pwdScore(v)]));
  t('B1 六位纯数字 = 1（弱）', sc[0][1] === 1, JSON.stringify(sc[0]));
  t('B2 生日 8 位纯数字 = 2（一般）', sc[1][1] === 2, JSON.stringify(sc[1]));
  t('B3 八位字母数字 = 2', sc[3][1] === 2, JSON.stringify(sc[3]));
  t('B4 大小写 + 数字 = 3', sc[4][1] === 3, JSON.stringify(sc[4]));
  t('B5 四类字符 + 长度 = 4（强）', sc[5][1] === 4, JSON.stringify(sc[5]));
  t('B6 全同字符直接判弱', sc[6][1] === 1, JSON.stringify(sc[6]));

  /* 注册表单接入 */
  await page.evaluate(() => {
    document.getElementById('acctBody').innerHTML = '<div class="acct-field"><label>密码</label><input id="acctP" type="password" data-pwm="1">' + pwmHtml() + '</div>';
    const i = document.getElementById('acctP');
    i.value = 'Abc12345';
    i.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForTimeout(350);
  const m = await page.evaluate(() => {
    const x = document.querySelector('#acctBody .pwm');
    return { lv: x.getAttribute('data-lv'), txt: x.querySelector('.pwm-txt').textContent, lit: [...x.querySelectorAll('i')].filter((i) => getComputedStyle(i).backgroundColor !== 'rgb(238, 228, 218)').length };
  });
  t('B7 注册框有强度条并点亮 3 格', m.lv === '3' && m.lit === 3 && m.txt === '较强', JSON.stringify(m));
  t('B8 无脚本报错', errs.length === 0, errs.slice(0, 2).join(' | '));
  await ctx.close();
}

console.log('\nC. 后台改密');
{
  const ctx = await browser.newContext({ viewport: { width: 900, height: 700 } });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message.slice(0, 120)));
  await page.goto(BASE + '/admin.html', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1000);
  const has = await page.evaluate(() => ({
    fn: typeof pwmInput === 'function',
    css: !!document.querySelector('style') && /\.pwm\[data-lv="4"\]/.test(document.documentElement.innerHTML),
  }));
  t('C1 后台有 pwmInput 函数', has.fn);
  t('C2 后台样式含四档强度', has.css);
  t('C3 无脚本报错', errs.length === 0, errs.slice(0, 2).join(' | '));
  await ctx.close();
}

await browser.close();
console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
