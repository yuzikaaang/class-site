/* 隔离测试：/api/content 读取为什么拿到 0 行
   写入明明成功（/api/auth?action=me 的 cloudKeys 能看到 cls_site_contents），
   但 readContent 查出来是空的。
   怀疑点：sql`... where data_key in (${a}, ${b})` 这种「多参数 IN」的写法。 */

const API = 'https://api.classsite.dpdns.org';

const login = await fetch(API + '/api/auth?action=login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'aibot', password: 'ai202505' }),
}).then((r) => r.json());

const token = login.token;
const uid = login.user.id;
console.log('登录用户 id =', uid);

/* 1) 走 /api/data 读，验证这两个键确实存在于该用户名下 */
const data = await fetch(API + '/api/data', {
  headers: { Authorization: 'Bearer ' + token },
}).then((r) => r.json());
console.log('\n[/api/data] count =', data.count,
  ' 含这两个键吗：',
  data.items && data.items.cls_site_contents ? '是' : '否',
  data.items && data.items.cls_site_announcements ? '(公告键也在)' : '');

if (data.items && data.items.cls_site_contents) {
  const doc = data.items.cls_site_contents;
  console.log('  cls_site_contents 里的内容键：',
    typeof doc === 'object' ? Object.keys(doc).join(', ') : typeof doc);
  if (doc.announcements) console.log('  公告条数：', doc.announcements.length);
  if (doc.important_dates) console.log('  重要日期条数：', doc.important_dates.length);
  if (doc.daily_quote) console.log('  每日一言条数：', doc.daily_quote.length);
}

/* 2) 再走 /api/content 读，对比 */
const content = await fetch(API + '/api/content').then((r) => r.json());
console.log('\n[/api/content] ok =', content.ok, ' count =', content.count,
  ' items 键 =', Object.keys(content.items || {}).join(', ') || '(空)');

/* 3) 关键对照：/api/data 能读到、/api/content 读不到
      → 2026-10-06 定案：根因不是 SQL，而是 data_value 是 **jsonb 列**，
        Neon 驱动返回已解析的对象，对它 JSON.parse 抛错被 catch 吞掉。
        修法：统一走 _lib/db.js 的 jsonCol()。 */
console.log('\n===== 结论 =====');
if (data.items && data.items.cls_site_contents && content.count === 0) {
  console.log('数据确实在库里（/api/data 读到了），但 /api/content 读不到。');
  console.log('→ 若线上还是旧代码：先确认 X-Build-Sha 是不是最新 commit；');
  console.log('→ 已是新代码仍为 0：检查 readContent 是否对 data_value 做了裸 JSON.parse');
  console.log('  （jsonb 列返回对象，parse 会抛错被吞，表现为永远 count=0）');
} else if (content.count > 0) {
  console.log('两边都读到了，问题不存在。');
} else {
  console.log('数据可能没写进去，需要换角度排查。');
}
