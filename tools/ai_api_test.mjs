/* v3.17.0：AI 查询接口的源码级检查 + 纯函数单测
   跑法：node tools/ai_api_test.mjs（不需要数据库） */
import fs from 'node:fs';

const SRC = fs.readFileSync(new URL('../api/scores.js', import.meta.url), 'utf8');

let pass = 0, fail = 0;
const t = (name, ok, extra) => {
  ok ? pass++ : fail++;
  console.log((ok ? '  ✓ ' : '  ✗ ') + name + (ok || !extra ? '' : '  → ' + extra));
};

/* ---------- 1. 结构 ---------- */
t('GET 路由里有 action=ai', /case 'ai':\s+return await aiQuery\(req, res\);/.test(SRC));
t('POST 路由里有 action=ai-key', /case 'ai-key':\s+return await aiKeyGen\(req, res\);/.test(SRC));
t('配置默认关闭接口', /aiApi: 'off'/.test(SRC));
t('配置默认密钥为空', /aiKey: ''/.test(SRC));
t('sanitizeConfig 只认 off/on', /pick\('aiApi', \['off', 'on'\]\)/.test(SRC));
t('sanitizeConfig 允许写 aiKey', /patch\.aiKey !== undefined/.test(SRC));

/* 非管理员不能拿到密钥 */
t('非管理员读配置时删掉 aiKey',
  /if \(!isAdmin\) \{ delete safe\.nameMap; delete safe\.aiKey; \}/.test(SRC));

/* ---------- 2. 鉴权顺序 ---------- */
const fn = SRC.slice(SRC.indexOf('async function aiQuery'), SRC.indexOf('/** 生成 / 重置 AI 查询密钥'));
t('先判开关再判密钥',
  fn.indexOf("!== 'on'") < fn.indexOf('req.query.k') && fn.indexOf('req.query.k') > 0);
t('密钥不对返回 401', /fail\(res, 401/.test(fn));
t('接口关闭返回 403', /fail\(res, 403, 'AI 查询接口未开启/.test(fn));
t('个人查询必须给学号', /缺少学号/.test(fn));

/* ---------- 3. 隐私：响应里不能出现姓名 ---------- */
/* 只需要盯 ok(res, ...) / aiSend 里带出去的对象。整段里 student_name 只应出现在 SQL 与内部变量。 */
const respBlocks = fn.split('return aiSend(').slice(1);
t('至少有一处返回（aiSend）', respBlocks.length > 0, String(respBlocks.length));
/* 个人返回对象（const mine = {...}）里不允许出现 name 字段 —— 姓名只在服务端内存里串历次 */
const mineBlock = fn.slice(fn.indexOf('const mine = {'), fn.indexOf('/* 历次'));
t('个人返回对象里没有 name 字段', mineBlock.length > 100 && !/\bname:\s*p\.name|\bname:\s*String\(/.test(mineBlock),
  mineBlock.slice(0, 80));
t('姓名字段有内部用途注释（历次兜底）', /不会出现在任何响应里/.test(fn));
t('个人返回只回显调用方输入的学号', /no: p\.no \|\| no/.test(fn));

/* ---------- 4. 纯函数 ---------- */
function grab(name) {
  const i = SRC.indexOf('function ' + name);
  if (i < 0) return null;
  /* 从 function 起到下一个顶格 } 为止 */
  const rest = SRC.slice(i);
  const end = rest.indexOf('\n}\n');
  return rest.slice(0, end + 3);
}
const normFn = grab('aiNormNo');
const scoreFn = grab('aiScoreOf');
t('aiNormNo 能取到', !!normFn);
t('aiScoreOf 能取到', !!scoreFn);

const aiNormNo = new Function(normFn + '\nreturn aiNormNo;')();
t('学号去前导 0', aiNormNo('07') === '7', aiNormNo('07'));
t('学号去空格', aiNormNo(' 7 ') === '7');
t('空学号归一为空', aiNormNo(null) === '' && aiNormNo('   ') === '');

const aiScoreOf = new Function(scoreFn + '\nreturn aiScoreOf;')();
const subG = { key: 'chem', graded: true, full: 100 };
const subR = { key: 'math', graded: false, full: 150 };
t('赋分口径取 assigned', aiScoreOf({ chem: { raw: 80, assigned: 88 } }, subG, 'graded') === 88);
t('原始口径取 raw', aiScoreOf({ chem: { raw: 80, assigned: 88 } }, subG, 'raw') === 80);
t('非赋分科目永远取 raw', aiScoreOf({ math: { raw: 120, assigned: 130 } }, subR, 'graded') === 120);
t('缺考返回 null', aiScoreOf({ math: { raw: 0 } }, subR, 'raw') === 0 && aiScoreOf({}, subR, 'raw') === null);

/* ---------- 5. 文档一致性 ---------- */
t('接口说明写在注释里（what/fmt/exam/no）',
  /what=me/.test(SRC) && /fmt=md\|json/.test(SRC) && /exam=<id>/.test(SRC) && /no=<学号>/.test(SRC));
const WORKER = fs.readFileSync(new URL('../api/worker.mjs', import.meta.url), 'utf8');
t('后端版本号已升到 3.17', /const API_VER = '3\.17\.0'/.test(WORKER),
  (WORKER.match(/const API_VER = '([^']+)'/) || [])[1]);

console.log('\n' + pass + ' / ' + (pass + fail));
process.exit(fail ? 1 : 0);
