/* v4.16.3 专项：作业跨设备合并上传、左下角同步状态、大屏分贝仪
   站主原话：
     「班级电脑上的作业编辑经过 5 分钟后仍然没有上传云端，手机打开未能看到语文作业，
       而且在手机端添加化学作业后，班级电脑等待更新后出现化学作业而语文作业被覆盖消失」
     「作业同步需要有小弹窗提示，在同步后左下角显示同步状态，已同步（绿色），同步失败（红色）」
     「底部功能栏最右侧新增分贝仪……不同颜色代表不同分贝区间，分为安静（绿色）、
       一般（黄色）、嘈杂（橙色）、吵闹（红色），点击数字可以进入设置界面」
*/
import { chromium } from 'playwright-core';
import { mergeHwById } from '../api/content.js';

const EXE = '/root/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const BASE = process.env.BASE || 'http://127.0.0.1:8899';
/* v4.16.5：期次日期改成「今天」。
   以前写死 2026-11-09~11-15，过了那天 currentHw() 就落到「本周自动期次」，
   hwTask 改的根本不是这份数据，上传断言全部扑空 —— 看着像产品没上传，
   其实是测试数据过期。 */
const DAY = (() => { const d = new Date(); const z = n => ('0' + n).slice(-2); return d.getFullYear() + '-' + z(d.getMonth() + 1) + '-' + z(d.getDate()); })();

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (x === undefined ? '' : ' → ' + JSON.stringify(x))); } };

/* ===================== ① 合并算法（纯函数） ===================== */
console.log('\n① 按 id 合并：两台设备的改动不互相覆盖');
{
  const hw = (id, txt) => ({ id, title: id, start: DAY, end: DAY, items: [{ subject: '语文', tasks: [{ text: txt }] }] });

  const a = mergeHwById([hw('w1', '云端语文')], [hw('w2', '手机化学')], []);
  ok('云端语文 + 提交化学 → 两期都在', a.length === 2 && a[0].id === 'w1' && a[1].id === 'w2', a.map(x => x.id));

  const b = mergeHwById([hw('w1', '旧')], [hw('w1', '新')], []);
  ok('同 id 覆盖内容', b.length === 1 && b[0].items[0].tasks[0].text === '新', b);

  const c = mergeHwById([hw('w1', 'a'), hw('w2', 'b')], [hw('w1', 'a2')], []);
  ok('改第一期不影响第二期，顺序保持不变', c.map(x => x.id).join(',') === 'w1,w2' && c[0].items[0].tasks[0].text === 'a2', c.map(x => x.id));

  const d = mergeHwById([hw('w1', 'a')], [hw('w1', 'a2')], ['w1']);
  ok('dels 指定的期次被删掉', d.length === 0, d);

  const e = mergeHwById(null, [hw('w1', 'a')], null);
  ok('云端为空 / 异常输入也能正常工作', e.length === 1, e);

  const f = mergeHwById([hw('w1', 'a')], [{ title: '无 id' }, null, 'x'], []);
  ok('没有 id 的脏数据被跳过，不污染云端', f.length === 1, f);
}

/* ===================== 浏览器部分 ===================== */
const browser = await chromium.launch({
  executablePath: EXE,
  args: ['--no-sandbox', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
});

async function open(opts = {}) {
  const { store = {}, w = 1366, h = 768, failPut = false, extraList = [] } = opts;
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, serviceWorkers: 'block' });
  const p = await ctx.newPage();
  p.on('pageerror', e => console.log('  [pageerror]', e.message));
  const seen = { posts: [] };
  /* 云端状态的活副本：POST 之后 GET 必须能读到刚写进去的东西，
     否则轮询会把页面又拉回旧数据，测出来的就是 mock 的问题而不是产品的。 */
  let cloud = [
    { id: 'w', title: '本周', start: DAY, end: DAY, items: [{ subject: '语文', tasks: [{ text: 'a' }] }] },
    ...extraList
  ];

  await p.route('**/api/**', async r => {
    const u = r.request().url();
    const J = (o, st = 200) => r.fulfill({ status: st, contentType: 'application/json', body: JSON.stringify(o) });
    if (u.includes('/api/exams')) return J({ ok: true, groups: [], pins: { majors: [], days: [], items: [] }, today: '' });
    if (u.includes('/api/content')) {
      if (r.request().method() === 'POST') {
        if (failPut) return J({ ok: false, error: '数据库暂时不可用' }, 500);
        let body = {};
        try { body = JSON.parse(r.request().postData() || '{}'); } catch (e) {}
        seen.posts.push(body);
        cloud = mergeHwById(cloud, body.list || [], body.dels || []);
        return J({ ok: true, list: cloud, count: cloud.length, serverTime: Date.now() });
      }
      return J({ ok: true, items: { holiday_homeworks: cloud, announcements: [] } });
    }
    if (u.includes('/auth?action=me')) return J({ ok: true, user: { id: 4, username: 'aibot', displayName: 'AI', role: 'admin' } });
    return J({ ok: true });
  });

  await p.addInitScript((st) => {
    try {
      localStorage.setItem('cls_welcome_v1', '1');
      localStorage.setItem('cls_login_guide_v1', '1');
      localStorage.setItem('cls_hw_edit', '1');
      Object.keys(st || {}).forEach(k => localStorage.setItem(k, st[k]));
    } catch (e) {}
  }, store);

  await p.goto(BASE + '/index.html?big=1&_r=' + Date.now(), { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(2500);
  await p.evaluate(() => {
    window.isAdmin = () => true;
    ['popMask', 'loginGuideMask'].forEach(id => { const e = document.getElementById(id); if (e) e.remove(); });
    BIG.openHw();
  });
  await p.waitForTimeout(1200);
  return { ctx, p, seen };
}

/* ===================== ② 未登录也能上传 ===================== */
console.log('\n② 班级电脑（未登录）改完作业也会上传');
{
  const { ctx, p, seen } = await open();
  /* 清掉登录态：模拟班级电脑常态 */
  await p.evaluate(() => { try { localStorage.removeItem('cls_auth'); localStorage.removeItem('cls_token'); } catch (e) {} });
  await p.evaluate(() => { BIG.hwTask(0, 0, '语文作业A'); });
  await p.waitForTimeout(3000);
  const got = seen.posts.length > 0 ? seen.posts[seen.posts.length - 1] : null;
  ok('确实发出了上传请求', !!got, seen.posts.length);
  ok('请求体里带着刚改的语文', !!got && JSON.stringify(got.list).includes('语文作业A'), got && JSON.stringify(got.list).slice(0, 160));
  await ctx.close();
}

/* ===================== ③ 左下角同步状态 ===================== */
console.log('\n③ 左下角同步状态：成功绿、失败红');
{
  const { ctx, p } = await open();
  await p.evaluate(() => { BIG.hwTask(0, 0, '语文作业B'); });
  await p.waitForTimeout(3000);
  const good = await p.evaluate(() => {
    const el = document.getElementById('syncToast');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return {
      cls: el.className, txt: el.textContent.trim(),
      bg: getComputedStyle(el).backgroundImage + getComputedStyle(el).backgroundColor,
      x: Math.round(r.x), y: Math.round(r.y), h: Math.round(r.height),
      vh: window.innerHeight
    };
  });
  ok('成功后出现提示条', !!good, good && good.cls);
  ok('提示条是绿色', !!good && /ok/.test(good.cls) && /47, ?158, ?95|2f9e5f|33, ?115, ?70/i.test(good.bg.replace(/\s/g, '')), good && good.bg);
  ok('文案是「作业已同步」', !!good && /作业已同步/.test(good.txt), good && good.txt);
  ok('位置在左下角', !!good && good.x < 40 && good.y > good.vh * 0.6, good);
  await ctx.close();

  const f = await open({ failPut: true });
  await f.p.evaluate(() => { BIG.hwTask(0, 0, '语文作业C'); });
  await f.p.waitForTimeout(3200);
  const bad = await f.p.evaluate(() => {
    const el = document.getElementById('syncToast');
    return el ? { cls: el.className, txt: el.textContent.trim() } : null;
  });
  ok('失败后出现提示条', !!bad, bad && bad.cls);
  ok('提示条是红色', !!bad && /err/.test(bad.cls), bad && bad.cls);
  ok('文案说明同步失败', !!bad && /失败/.test(bad.txt), bad && bad.txt);
  const pend = await f.p.evaluate(() => BIG.hwLocalPending && BIG.hwLocalPending());
  ok('失败后本机改动仍然保留，等补传', pend === true, pend);
  await f.ctx.close();
}

/* ===================== ④ 跨设备合流 ===================== */
console.log('\n④ 手机端的化学与本机的语文同时存在');
{
  const chem = { id: 'w2', title: '本周化学', start: '2026-11-16', end: '2026-11-20', items: [{ subject: '化学', tasks: [{ text: '化学卷子' }] }] };
  const { ctx, p } = await open({ extraList: [chem] });
  /* 直接改 w 那一期再触发保存 —— 不经过「当前视图是哪一期」，
     这样测的确定是「本机改过的那条」会不会被云端冲掉 */
  await p.evaluate(() => {
    const l = BIG.hwList();
    const w = l.filter(h => String(h.id) === 'w')[0];
    w.items[0].tasks[0].text = '语文作业D';
    BIG.touch();
  });
  await p.waitForTimeout(3200);
  const txt = await p.evaluate(() => {
    const l = BIG.hwList();
    const w = l.filter(h => String(h.id) === 'w')[0];
    return { list: l.map(h => h.id), w: w ? JSON.stringify(w) : '' };
  });
  ok('云端新加的化学期次进了本机列表', txt.list.indexOf('w2') >= 0, txt.list);
  ok('本机的语文期次也还在', txt.list.indexOf('w') >= 0, txt.list);
  ok('本机的语文内容没有被覆盖', /语文作业D/.test(txt.w), txt.w.slice(0, 140));
  await ctx.close();
}

/* ===================== ⑤ 分贝仪 ===================== */
console.log('\n⑤ 大屏底部最右侧的分贝仪');
{
  const { ctx, p } = await open();
  await p.waitForTimeout(2200);
  const db = await p.evaluate(() => {
    const box = document.getElementById('bhwDb');
    if (!box) return null;
    const bar = document.querySelector('.bhw-bar').getBoundingClientRect();
    const r = box.getBoundingClientRect();
    return {
      num: (document.getElementById('bhwDbNum') || {}).textContent,
      lvl: box.getAttribute('data-lvl'),
      rightGap: Math.round(bar.right - r.right),
      inside: r.top >= bar.top - 1 && r.bottom <= bar.bottom + 1,
      ledBg: getComputedStyle(document.querySelector('.bhw-db-led')).backgroundColor
    };
  });
  ok('分贝仪在底部功能栏里', !!db, db);
  ok('贴着功能栏最右侧', !!db && db.rightGap < 40 && db.inside, db);
  ok('显示了数字（不是 --）', !!db && /^\d+$/.test(String(db.num).trim()), db && db.num);
  ok('分档在 0–3 之间', !!db && ['0', '1', '2', '3'].includes(String(db.lvl)), db && db.lvl);
  ok('呼吸灯有颜色', !!db && !/rgba\(0, 0, 0, 0\)/.test(db.ledBg), db && db.ledBg);

  await p.evaluate(() => document.getElementById('bhwDbNum').click());
  await p.waitForTimeout(400);
  const panel = await p.evaluate(() => {
    const m = document.getElementById('bhwDbMask');
    if (!m) return null;
    return {
      show: m.classList.contains('show'),
      rules: [...m.querySelectorAll('.bhw-dbrule')].map(e => e.textContent.trim()),
      now: (document.getElementById('bhwDbNow') || {}).textContent
    };
  });
  ok('点数字打开设置界面', !!panel && panel.show, panel && panel.show);
  ok('四档说明齐全', !!panel && panel.rules.length === 4 && /安静/.test(panel.rules[0]) && /吵闹/.test(panel.rules[3]), panel && panel.rules);
  ok('设置页显示当前分贝', !!panel && /^\d+$/.test(String(panel.now).trim()), panel && panel.now);

  await p.evaluate(() => BIG.dbClose());
  await p.waitForTimeout(200);
  ok('能关掉设置界面', await p.evaluate(() => !document.getElementById('bhwDbMask').classList.contains('show')));
  await ctx.close();
}

await browser.close();
console.log('\n结果：' + pass + ' 项通过，' + fail + ' 项失败');
process.exit(fail ? 1 : 0);
