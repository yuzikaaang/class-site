/* v3.9.19：所见即所得编辑器（看不到 ** 和 {} 也能设单字格式） */
import { chromium } from 'playwright-core';

const browser = await chromium.launch({
  executablePath: '/root/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome',
  args: ['--no-sandbox'],
});
const page = await (await browser.newContext({ viewport: { width: 1280, height: 1000 } })).newPage();

let pass = 0, fail = 0;
const t = (n, c, d) => {
  if (c) { pass++; console.log('  ✓ ' + n); }
  else { fail++; console.log('  ✗ ' + n + (d ? '  → ' + d : '')); }
};

await page.route('**/api/**', async (route) => {
  const req = route.request(), url = req.url();
  if (url.includes('/api/island'))
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, data: {
      on: true, term: '2026 年秋季 · 高二上', startDate: '2026-09-01',
      components: ['time', 'weather', 'week'], banner: { mon: '数数语英化' },
      days: { '2026-11-02': { text: '{26b考}试 08:00\n# 记得带准考证', off: false, bold: true, center: true, size: 0 } },
      holidays: [] } }) });
  if (url.includes('/api/auth?action=me'))
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true,"user":{"id":4,"username":"aibot","displayName":"AI","role":"admin"}}' });
  return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
});

await page.goto('http://localhost:8111/admin.html', { waitUntil: 'domcontentloaded' });
await page.evaluate(() => localStorage.setItem('cls_auth', JSON.stringify({
  token: 'x', user: { id: 4, username: 'aibot', displayName: 'AI', role: 'admin', status: 'active', title: '' } })));
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(1200);
await page.evaluate(() => {
  const el = [...document.querySelectorAll('a,button,li,div,span')]
    .find((e) => /班级岛/.test(e.textContent) && e.textContent.trim().length < 20);
  if (el) el.click();
});
await page.waitForTimeout(1200);

const raw = () => page.evaluate(() => document.getElementById('adText').value);
const html = () => page.evaluate(() => document.getElementById('adRich').innerHTML);
const setBody = async (txt) => {
  await page.evaluate((txt) => {
    const box = document.getElementById('adRich');
    box.innerHTML = String(txt).split('\n')
      .map((l) => l.replace(/&/g, '&amp;').replace(/</g, '&lt;')).join('<br>');
    box.dispatchEvent(new Event('input', { bubbles: true }));
  }, txt);
  await page.waitForTimeout(150);
};
/* 在编辑器里选中「第 a 个到第 b 个字符」（按纯文字计） */
const selectChars = async (a, b) => {
  await page.evaluate(({ a, b }) => {
    const box = document.getElementById('adRich');
    const walker = document.createTreeWalker(box, NodeFilter.SHOW_TEXT, null);
    let idx = 0, startNode = null, startOff = 0, endNode = null, endOff = 0, n;
    while ((n = walker.nextNode())) {
      const len = n.nodeValue.length;
      if (startNode === null && idx + len > a) { startNode = n; startOff = a - idx; }
      if (idx + len >= b) { endNode = n; endOff = b - idx; break; }
      idx += len;
    }
    if (!startNode || !endNode) return false;
    const r = document.createRange();
    r.setStart(startNode, startOff);
    r.setEnd(endNode, endOff);
    const s = window.getSelection();
    s.removeAllRanges();
    s.addRange(r);
    document.getElementById('adRich').focus();
    return true;
  }, { a, b });
  await page.waitForTimeout(100);
};

await setBody('数学 08:00-09:30\n语文 10:00-11:30');

t('输入区里没有星号/花括号', !/\*\*|\{|\}/.test(await page.evaluate(() => document.getElementById('adRich').innerText)), await page.evaluate(() => document.getElementById('adRich').innerText));
t('输入区按所见即所得显示两行', (await page.evaluate(() => document.getElementById('adRich').querySelectorAll('br').length)) === 1);

/* 1. 选中「数学」加粗 */
await selectChars(0, 2);
await page.evaluate(() => document.querySelector('[data-rt="b"]').click());
await page.waitForTimeout(150);
t('编辑器里出现真正的加粗', (await html()).indexOf('<b>数学</b>') >= 0, await html());
t('隐藏字段转成标记', (await raw()) === '**数学** 08:00-09:30\n语文 10:00-11:30', await raw());
t('预览里也是粗的', await page.evaluate(() => {
  const b = document.querySelector('#adPrev b');
  return !!b && b.textContent === '数学';
}));

/* 2. 再点一次取消 */
await selectChars(0, 2);
await page.evaluate(() => document.querySelector('[data-rt="b"]').click());
await page.waitForTimeout(150);
t('再点一次取消加粗', (await raw()) === '数学 08:00-09:30\n语文 10:00-11:30', await raw());
t('编辑器里 b 标签也没了', (await html()).indexOf('<b>') < 0, await html());

/* 3. 只给「语」加字号 26 */
await selectChars(14, 15);
await page.evaluate(() => {
  const s = document.getElementById('adChSize');
  s.value = '26';
  s.dispatchEvent(new Event('change', { bubbles: true }));
});
await page.waitForTimeout(150);
t('单字字号写回标记', (await raw()).indexOf('{26语}') >= 0, await raw());
t('编辑器里只有那一个字变大', await page.evaluate(() => {
  const sp = document.querySelectorAll('#adRich span[style]');
  return sp.length === 1 && sp[0].style.fontSize === '26px' && sp[0].textContent === '语';
}));
t('4px 也在选项里', await page.evaluate(() => !!document.querySelector('#adChSize option[value="4"]')));

/* 4. 在句子中间插字（用户最在意的场景） */
await page.evaluate(() => {
  const box = document.getElementById('adRich');
  const walker = document.createTreeWalker(box, NodeFilter.SHOW_TEXT, null);
  let idx = 0, node = null, off = 0, n;
  while ((n = walker.nextNode())) {
    if (n.nodeValue.length === 0) continue;
    if (idx + n.nodeValue.length >= 2) { node = n; off = 2 - idx; break; }
    idx += n.nodeValue.length;
  }
  const r = document.createRange();
  r.setStart(node, off);
  r.collapse(true);
  const s = window.getSelection();
  s.removeAllRanges(); s.addRange(r);
  box.focus();
  document.execCommand('insertText', false, '（测验）');
});
await page.waitForTimeout(200);
t('句子里能直接插字', (await page.evaluate(() => document.getElementById('adRich').innerText)).indexOf('数学（测验） 08:00-09:30') === 0,
  await page.evaluate(() => document.getElementById('adRich').innerText));
t('插字后格式没乱', (await raw()).indexOf('{26语}') >= 0);

/* 5. 整行强调 */
await selectChars(0, 2);
await page.evaluate(() => document.querySelector('[data-rt="h"]').click());
await page.waitForTimeout(150);
t('整行强调进标记', (await raw()).indexOf('# ') === 0, await raw());
t('编辑器里那一行有底色', await page.evaluate(() => !!document.querySelector('#adRich .ln-em')));

/* 6. 清格式（不碰整行强调） */
await selectChars(0, 2);
await page.evaluate(() => document.querySelector('[data-rt="clear"]').click());
await page.waitForTimeout(150);
t('清格式后整行强调还在', (await raw()).indexOf('# ') === 0, await raw());

/* 7. 编辑器内容 → 保存时拿到的就是标记 */
const payload = await page.evaluate(() => document.getElementById('adText').value);
t('隐藏字段始终是干净的标记文本', typeof payload === 'string' && payload.indexOf('<') < 0, payload);

/* 8. 空编辑器显示占位提示 */
await page.evaluate(() => {
  const box = document.getElementById('adRich');
  box.innerHTML = '';
  box.dispatchEvent(new Event('input', { bubbles: true }));
});
await page.waitForTimeout(100);
t('空内容时占位提示可见', await page.evaluate(() => {
  const b = document.getElementById('adRich');
  return b.textContent === '' && !!b.getAttribute('data-ph');
}));

/* 9. 打开一条已有临时安排：编辑器里直接是效果，不是符号 */
await page.evaluate(() => {
  const el = document.querySelector('[data-dayedit="2026-11-02"]');
  if (el) el.click();
});
await page.waitForTimeout(300);
const ed = await page.evaluate(() => {
  const b = document.getElementById('adRich');
  return {
    txt: b.innerText,
    hasB: !!b.querySelector('b') || !!b.querySelector('span[style*="font-weight"]'),
    hasSize: !!b.querySelector('span[style*="26px"]'),
    hasHead: !!b.querySelector('.ln-em'),
    hasMark: /\*\*|\{|\}/.test(b.innerText),
  };
});
t('打开已有安排时编辑器显示真格式', ed.hasB && ed.hasSize && ed.hasHead, JSON.stringify(ed));
t('打开已有安排时看不到符号', ed.hasMark === false && ed.txt.indexOf('考试') === 0, ed.txt);
t('已有安排的标记没被改写', (await raw()) === '{26b考}试 08:00\n# 记得带准考证', await raw());

await browser.close();
console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
