/* ============================================================================
 * /api/geo —— 按访客 IP 定位（v4.7.11 站主第 3 条）
 * ----------------------------------------------------------------------------
 * 站主原话：「班级岛的天气不一定是修水，你的建议是根据用户的 IP 去获取，
 *   但默认一般是显示修水，如果你实在不知道用户在哪里，那就显示修水。」
 *
 * 数据来源：
 *   ① Cloudflare 自带（request.cf）：经纬度一定有，城市名多半是拼音；
 *   ② 反查中文地名（nominatim，免费、免 key）：把 29.03/114.55 变成「修水县」；
 *   ③ 都失败 → 修水（站主的兜底要求）。
 *
 * 只在服务端查，前端拿到的是一份小 JSON，不暴露任何第三方地址。
 * 结果进边缘缓存 12 小时 —— IP 定位不需要秒级新鲜。
 * ========================================================================= */

import { handlePreflight } from './_lib/http.js';

const FALLBACK = { city: '修水', region: '江西九江', lat: 29.03, lon: 114.55, src: 'default' };

function ok(res, obj) {
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, max-age=43200');
  res.end(JSON.stringify({ ok: true, ...obj }));
}

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;

  const cf = (req && req.cf) || {};
  let lat = Number(cf.latitude);
  let lon = Number(cf.longitude);
  const cfCity = String(cf.city || '').trim();
  const cfRegion = String(cf.region || '').trim();

  /* 没有坐标（本地调试 / 非 Cloudflare 环境）→ 直接修水 */
  if (!isFinite(lat) || !isFinite(lon) || (lat === 0 && lon === 0)) {
    return ok(res, { ...FALLBACK, src: 'default' });
  }

  /* 已经是中文城市名就不用再反查了 */
  const isZh = /[\u4e00-\u9fa5]/.test(cfCity);
  if (isZh) {
    return ok(res, {
      city: cfCity,
      region: cfRegion || '',
      lat, lon, src: 'cf',
    });
  }

  /* 反查中文地名。失败不影响坐标 —— 照旧按坐标取天气，只是名字退回拼音。 */
  try {
    const u = 'https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=10'
      + '&accept-language=zh-CN&lat=' + lat.toFixed(4) + '&lon=' + lon.toFixed(4);
    const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const tm = ctl ? setTimeout(() => { try { ctl.abort(); } catch (e) {} }, 3500) : null;
    const r = await fetch(u, {
      headers: {
        'User-Agent': 'class-site/4.7 (school class website)',
        'Accept': 'application/json',
      },
      signal: ctl ? ctl.signal : undefined,
    });
    if (tm) clearTimeout(tm);
    if (r.ok) {
      const j = await r.json();
      const a = (j && j.address) || {};
      const city = a.city || a.town || a.county || a.district || a.state || '';
      const region = [a.state, a.city && a.state !== a.city ? a.city : ''].filter(Boolean).join(' ');
      if (city) {
        return ok(res, { city, region: region || cfRegion || '', lat, lon, src: 'rev' });
      }
    }
  } catch (e) {
    /* 超时 / 网络问题都静默，走下面的兜底 */
  }

  return ok(res, {
    city: cfCity || '当前位置',
    region: cfRegion || '',
    lat, lon,
    src: 'cf-pinyin',
  });
}
