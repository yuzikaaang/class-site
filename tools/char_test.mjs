/* v3.9.18：逐字编辑（单字字号 / 加粗 / 横线）真浏览器验证 */
import { chromium } from 'playwright-core';

const browser = await chromium.launch({
  executablePath: '/root/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome',
  args: ['--no-sandbox'],
});
const page = await (await browser.newContext({ viewport: { width: 1280, height: 1000 } })).newPage();

let pass = 0, fail = 0;
const t = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (detail ? '  → ' + detail : '')); }
};

await page.route('**/api/**', async (route) => {
  const req = route.request(), url = req.url();
  if (req.method() === 'POST' && url.includes('/api/island'))
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
  if (url.includes('/api/island'))
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, data: {
      on: true, term: '2026 年秋季 · 高二上', startDate: '2026-09-01',
      components: ['time', 'weather', 'week', 'term'],
      banner: { mon: '数数语英化', tue: '', wed: '', thu: '', fri: '', sat: '', sun: '' },
      days: (function(){
        const d = new Date(); d.setDate(d.getDate() + 1);
        const k = d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2);
        const o = {}; o[k] = { text: '{22b数}学 08:00-09:30', off: false, bold: true, center: true, size: 0 };
        return o;
      })(), holidays: [],
    } }) });
  if (url.includes('/api/auth?action=me'))
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, user: { id: 4, username: 'aibot', displayName: 'AI 助手', role: 'admin' } }) });
  return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
});

await page.goto('http://localhost:8111/admin.html', { waitUntil: 'domcontentloaded' });
await page.evaluate(() => localStorage.setItem('cls_auth', JSON.stringify({
  token: 'x', user: { id: 4, username: 'aibot', displayName: 'AI 助手', role: 'admin', status: 'active', title: '' } })));
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(1200);
await page.evaluate(() => {
  const el = [...document.querySelectorAll('a,button,li,div,span')]
    .find((e) => /班级岛/.test(e.textContent) && e.textContent.trim().length < 20);
  if (el) el.click();
});
await page.waitForTimeout(1200);

const ta = () => page.evaluate(() => document.getElementById('adText').value);
const setText = async (v) => {
  await page.evaluate((v) => {
    const el = document.getElementById('adText');
    el.value = v;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, v);
  await page.waitForTimeout(150);
};
const clickChar = async (i) => {
  await page.evaluate((i) => {
    const el = document.querySelector('#adChars [data-ci="' + i + '"]');
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  }, i);
  await page.waitForTimeout(120);
};

await setText('数学 08:00-09:30');
t('字符面板渲染出每个字', await page.evaluate(() => document.querySelectorAll('#adChars [data-ci]').length) === 14,
  '实际 ' + await page.evaluate(() => document.querySelectorAll('#adChars [data-ci]').length));

/* 1. 只选第一个字加粗 */
await clickChar(0);
await page.evaluate(() => document.querySelector('[data-ch="b"]').click());
await page.waitForTimeout(150);
t('单个字加粗写回文本', (await ta()) === '**数**学 08:00-09:30', await ta());
t('加粗只影响那一个字', await page.evaluate(() => {
  const b = document.querySelectorAll('#adChars .ad-ch');
  return b.length === 14 && b[0].style.fontWeight === '900' && !b[1].style.fontWeight;
}));
t('预览里只有「数」是粗的', await page.evaluate(() => {
  const b = document.querySelectorAll('#adPrev b');
  return b.length === 1 && b[0].textContent === '数';
}));

/* 2. 再点一次取消 */
await page.evaluate(() => document.querySelector('[data-ch="b"]').click());
await page.waitForTimeout(150);
t('再点一次取消加粗', (await ta()) === '数学 08:00-09:30', await ta());

/* 3. 单字字号 */
await clickChar(0);
await page.evaluate(() => {
  const s = document.getElementById('adChSize');
  s.value = '22';
  s.dispatchEvent(new Event('change', { bubbles: true }));
});
await page.waitForTimeout(150);
t('单字字号写回', (await ta()) === '{22数}学 08:00-09:30', await ta());
t('单字字号只作用一个字', await page.evaluate(() => {
  const b = document.querySelectorAll('#adChars .ad-ch');
  return b[0].style.fontSize === '22px' && !b[1].style.fontSize;
}));

/* 4. 拖动选一串加横线 */
await page.evaluate(() => {
  const box = document.getElementById('adChars');
  const a = box.querySelector('[data-ci="3"]'), b = box.querySelector('[data-ci="5"]');
  a.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  b.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
  document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
});
await page.waitForTimeout(120);
const selCount = await page.evaluate(() => document.querySelectorAll('#adChars .ad-ch.on').length);
t('拖动可以选中一串（3 个字）', selCount === 3, '实际 ' + selCount);
await page.evaluate(() => document.querySelector('[data-ch="s"]').click());
await page.waitForTimeout(150);
t('横线写回', (await ta()) === '{22数}学 ~~08:~~00-09:30', await ta());

/* 5. 整行强调：面板选字 + # */
await clickChar(1);
await page.evaluate(() => document.querySelector('[data-fmt="h"]').click());
await page.waitForTimeout(150);
t('面板选中也能整行强调', (await ta()).indexOf('# ') === 0, await ta());

/* 6. 清格式 */
await page.evaluate(() => {
  const box = document.getElementById('adChars');
  box.querySelector('[data-ci="1"]').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
});
await page.evaluate(() => document.querySelector('[data-ch="clear"]').click());
await page.waitForTimeout(150);
t('清格式只清选中的字', (await ta()) === '# 数学 ~~08:~~00-09:30', await ta());
t('# 标记不算一个字，不会让后面的字错位', await page.evaluate(() => {
  const b = document.querySelectorAll('#adChars .ad-ch');
  return b.length === 14 && b[0].textContent === '数';
}));

/* 7. 前端渲染同一套标记（真打开首页看 DOM） */
await page.goto('http://localhost:8111/index.html', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2500);
const fe = await page.evaluate(() => {
  const sp = document.querySelector('#islBannerRow .island-banner .txt span[style]');
  if (!sp) return null;
  return { txt: sp.textContent, fs: sp.style.fontSize, fw: sp.style.fontWeight };
});
t('首页把 {22b数} 渲染成 22px 粗体', fe && fe.txt === '数' && fe.fs === '22px' && fe.fw === '900', JSON.stringify(fe));
t('首页只放大一个字，后面的字没被吃掉', await page.evaluate(() => {
  const t = document.querySelector('#islBannerRow .island-banner .txt');
  return t && t.textContent.indexOf('学 08:00-09:30') > 0;
}));

await browser.close();
console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
