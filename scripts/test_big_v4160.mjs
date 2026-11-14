/* v4.16.0 专项：大屏作业页的更新入口、5 秒自动更新、主题记忆、页眉留白
   站主原话：
     「大屏模式打开之后默认跳到作业看板……发现它不是最新版，要先点返回、到大屏首页
      往下翻、再点最新版，特别麻烦」
     「左下角也有个版本号，点一下可以查询是否为最新版本」
     「更新弹窗跟正常模式一样，由于是大屏模式不可能时刻在线，5 秒之内没有做出反应
      就默认自动更新」
     「作业看板是暗色的，退出之后下次进去又变成亮色」
     「页眉宽度我写了 40px 进去，但那个颜色是灰的，也不知道有没有修改成功」
*/
import { chromium } from 'playwright-core';

const EXE = '/root/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const BASE = process.env.BASE || 'http://127.0.0.1:8899';

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (x === undefined ? '' : ' → ' + JSON.stringify(x))); } };

const browser = await chromium.launch({ executablePath: EXE, args: ['--no-sandbox'] });

async function open(opts = {}) {
  const { onlineVer = '', store = {}, w = 1366, h = 768 } = opts;
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, serviceWorkers: 'block' });
  const p = await ctx.newPage();
  p.on('pageerror', e => console.log('  [pageerror]', e.message));
  await p.route('**/api/**', r => {
    const u = r.request().url();
    const J = o => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
    if (u.includes('/api/exams')) return J({ ok: true, groups: [], pins: { majors: [], days: [], items: [] }, today: '' });
    if (u.includes('/api/content')) return J({ ok: true, items: { holiday_homeworks: [{ id: 'w', title: '本周', start: '2026-11-09', end: '2026-11-15', items: [{ subject: '语文', tasks: [{ text: 'a' }] }] }], announcements: [] } });
    if (u.includes('/auth?action=me')) return J({ ok: true, user: { id: 4, username: 'aibot', displayName: 'AI', role: 'admin' } });
    return J({ ok: true });
  });
  if (onlineVer) {
    await p.route('**/sw.js*', r => r.fulfill({ status: 200, contentType: 'application/javascript', body: "const SITE_VER = '" + onlineVer + "'\n" }));
  }
  await p.addInitScript((st) => {
    try {
      localStorage.setItem('cls_welcome_v1', '1');
      localStorage.setItem('cls_login_guide_v1', '1');
      Object.keys(st || {}).forEach(k => localStorage.setItem(k, st[k]));
    } catch (e) {}
  }, store);
  await p.goto(BASE + '/index.html?big=1&_r=' + Date.now(), { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(2600);
  await p.evaluate(() => {
    window.isAdmin = () => true;
    ['popMask', 'loginGuideMask'].forEach(id => { const e = document.getElementById(id); if (e) e.remove(); });
    BIG.openHw();
  });
  await p.waitForTimeout(1200);
  return { ctx, p };
}

// ① 左下角版本号
console.log('\n① 大屏作业页左下角的版本号');
{
  const { ctx, p } = await open();
  const info = await p.evaluate(() => {
    const el = document.getElementById('bhwVer');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { txt: el.textContent.trim(), x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), vis: getComputedStyle(el).display };
  });
  ok('版本号在页面上', !!info, info);
  const cur = await p.evaluate(() => window.SITE_VERSION);
  ok('文字是当前版本', info && info.txt === 'v' + cur, info && info.txt + ' vs ' + cur);
  ok('位置在左下角', info && info.x < 120 && info.y > 560, info);
  await ctx.close();
}

// ② 点击检查：已是最新
console.log('\n② 点版本号查更新（线上同版本）');
{
  const { ctx, p } = await open({ onlineVer: '4.16.0' });
  await p.evaluate(() => document.getElementById('bhwVer').click());
  await p.waitForTimeout(900);
  const t = await p.evaluate(() => document.getElementById('bhwVer').textContent.trim());
  ok('提示已是最新', /已是最新/.test(t), t);
  ok('没有误弹更新窗', await p.evaluate(() => !document.getElementById('upMask').classList.contains('show')));
  await ctx.close();
}

// ③ 有新版 → 弹窗 + 5 秒倒计时
console.log('\n③ 线上有新版 → 大屏也弹更新窗');
{
  const { ctx, p } = await open({ onlineVer: '4.99.0' });
  await p.evaluate(() => document.getElementById('bhwVer').click());
  await p.waitForTimeout(1500);
  const s = await p.evaluate(() => {
    const m = document.getElementById('upMask');
    const a = document.getElementById('upAuto');
    return { show: m && m.classList.contains('show'), txt: a ? a.textContent : '(没有倒计时)', ver: (document.getElementById('upVer') || {}).textContent };
  });
  ok('更新弹窗弹出来了', s.show, s);
  ok('弹窗上写了版本 4.99.0', /4\.99\.0/.test(s.ver || ''), s.ver);
  ok('有 5 秒自动更新的倒数提示', /秒后自动更新/.test(s.txt || ''), s.txt);
  ok('倒数在走（不是停在 5）', !/^5 秒/.test((await p.evaluate(() => (document.getElementById('upAuto') || {}).textContent || '')).trim()), 'still 5');

  console.log('\n④ 点「稍后」能取消自动更新');
  await p.evaluate(() => document.getElementById('upLater').click());
  await p.waitForTimeout(400);
  const after = await p.evaluate(() => ({
    show: document.getElementById('upMask').classList.contains('show'),
    tip: !!document.getElementById('upAuto')
  }));
  ok('弹窗关掉了', !after.show, after);
  ok('倒计时也停了（提示块已移除）', !after.tip, after);
  /* selfHeal 会在启动 4 秒后偷偷查 sw.js，查到新版就带 ?_r= 整页强刷 ——
     这条必须让路，否则「稍后」形同虚设 */
  await p.waitForTimeout(2600);
  const stay = await p.evaluate(() => ({ url: location.href, alive: typeof BIG !== 'undefined' }));
  ok('点了「稍后」不会被后台静默强刷掉', /\?big=1(#|$)/.test(stay.url) && stay.alive, stay);
  await ctx.close();
}

// ⑦ 5 秒没人点 → 自动更新（整页重载，带 _r 绕过缓存）
console.log('\n⑦ 5 秒无人响应 → 自动更新');
{
  const { ctx, p } = await open({ onlineVer: '4.99.0' });
  const navs = [];
  p.on('request', r => { if (r.isNavigationRequest() && /_r=/.test(r.url())) navs.push(r.url()); });
  await p.evaluate(() => document.getElementById('bhwVer').click());
  await p.waitForTimeout(1300);
  const before = await p.evaluate(() => (document.getElementById('upAuto') || {}).textContent || '');
  ok('倒数从 5 往下走', /^[34] 秒后自动更新/.test(before.trim()), before);
  await p.waitForTimeout(9000);
  ok('倒数结束后自己走更新流程（发生整页重载）', navs.length > 0, navs);
  ok('重载地址保留了 ?big=1', navs.length > 0 && /big=1/.test(navs[0]), navs[0]);
  await ctx.close();
}

// ⑤ 大屏主题记忆
console.log('\n⑤ 大屏里选的暗色，退出再进还在');
{
  const { ctx, p } = await open({ store: { cls_bhw_theme: 'dark' } });
  const dark1 = await p.evaluate(() => document.documentElement.classList.contains('dark'));
  ok('打开大屏就是暗色', dark1, dark1);
  await p.evaluate(() => BIG.themeToggle());
  await p.waitForTimeout(900);
  const dark2 = await p.evaluate(() => document.documentElement.classList.contains('dark'));
  const memo = await p.evaluate(() => localStorage.getItem('cls_bhw_theme'));
  ok('切成明亮后大屏自己记住了', dark2 === false && memo === 'light', { dark2, memo });
  await ctx.close();
}
{
  const { ctx, p } = await open({ store: { cls_bhw_theme: 'light', cls_theme: 'dark' } });
  const dark = await p.evaluate(() => document.documentElement.classList.contains('dark'));
  ok('大屏记忆优先于全站主题（记忆是亮色就是亮色）', dark === false, dark);
  await ctx.close();
}

// ⑥ 页眉右侧留白：边输边生效
console.log('\n⑥ 顶栏右侧留白：输入就生效');
{
  const { ctx, p } = await open();
  const before = await p.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--bhw-top-pad').trim());
  await p.evaluate(() => {
    /* 模拟在设置里敲数字：只触发 input，不失焦、不回车 */
    const el = document.createElement('input');
    el.id = 'uiTopPadOk';
    document.body.appendChild(el);
    bigSetPref('topPad', '40', el);
  });
  await p.waitForTimeout(300);
  const v = await p.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--bhw-top-pad').trim());
  const pad = await p.evaluate(() => getComputedStyle(document.querySelector('.bhw-top')).paddingRight);
  const stored = await p.evaluate(() => JSON.parse(localStorage.getItem('cls_bhw_prefs') || '{}').topPad);
  ok('输入 40 后变量立刻变成 40px（原来 ' + (before || '0px') + '）', v === '40px', v);
  ok('顶栏右内边距真的变大了', parseFloat(pad) >= 40, pad);
  ok('配置也存进本机了', stored === 40, stored);
  await ctx.close();
}

await browser.close();
console.log('\n结果：' + pass + ' 项通过，' + fail + ' 项失败');
process.exit(fail ? 1 : 0);
