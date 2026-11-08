import { chromium } from '/root/.nvm/versions/node/v22.13.1/lib/node_modules/playwright/index.mjs';
const BASE='http://localhost:8112';
let pass=0, fail=0;
const t=(name,ok,extra)=>{ if(ok){pass++;console.log('  ✓ '+name+(extra?'  ['+extra+']':''));} else {fail++;console.log('  ✗ '+name+(extra?'  ['+extra+']':''));} };

const browser=await chromium.launch({args:['--no-sandbox']});

/* ---------- 场景 1：后台 → 返回前台 → 落地首页 ---------- */
console.log('\n【场景 1】后台点「返回前台」落地首页（核心修复）');
{
  const ctx=await browser.newContext({viewport:{width:1600,height:900}});
  const page=await ctx.newPage();
  await page.addInitScript(()=>{
    localStorage.setItem('cls_auth', JSON.stringify({token:'TESTTOKEN', user:{username:'aibot',role:'admin'}}));
    localStorage.setItem('cls_login_guide_v1','1');
    localStorage.setItem('cls_welcome_v1','1');
  });
  await page.route('**/api/**',(route)=>{
    const u=route.request().url();
    if(u.includes('/auth?action=me')) return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({ok:true,user:{username:'aibot',role:'admin'}})});
    return route.fulfill({status:200,contentType:'application/json',body:'{"ok":true}'});
  });
  await page.goto(BASE+'/admin.html?_r='+Date.now(),{waitUntil:'domcontentloaded',timeout:60000});
  await page.waitForTimeout(3000);
  const inApp = await page.evaluate(()=>document.getElementById('gate').classList.contains('hide'));
  t('后台正常进入（不是停在登录门）', inApp);

  await page.click('#btnToFront').catch(e=>console.log('    click err',e.message));
  await page.waitForTimeout(3500);

  const st = await page.evaluate(()=>({
    url: location.href,
    isAdmin: !!document.getElementById('btnToFront'),
    gate: document.getElementById('gate') ? !document.getElementById('gate').classList.contains('hide') : 'no-gate',
    home: (()=>{const h=document.getElementById('homeView');return h?getComputedStyle(h).display:'n/a';})(),
    grid: (()=>{const g=document.getElementById('grid');return g?getComputedStyle(g).display:'n/a';})(),
    hash: location.hash,
    hasAuth: !!localStorage.getItem('cls_auth'),
    next: sessionStorage.getItem('cls_next'),
    ret: sessionStorage.getItem('cls_return_view'),
    force: sessionStorage.getItem('cls_force_home'),
  }));
  console.log('    ', JSON.stringify(st));
  t('落在前台 index.html（不是 admin.html）', !st.isAdmin && /index\.html/.test(st.url), st.url);
  t('前台没有登录门', st.gate===false||st.gate==='no-gate');
  t('首页视图可见', st.home==='block');
  t('地址栏 hash 为空（不会刷新又跳回别处）', !st.hash || st.hash==='' , 'hash='+st.hash);
  t('共享登录态还在（没被连坐删掉）', st.hasAuth);
  t('cls_next 已清空', st.next===null, 'next='+st.next);
  t('cls_return_view 已清空', st.ret===null, 'ret='+st.ret);

  /* 刷新一次，确认不会跳走 */
  await page.reload({waitUntil:'domcontentloaded'});
  await page.waitForTimeout(2500);
  const st2 = await page.evaluate(()=>({
    isAdmin: !!document.getElementById('btnToFront'),
    home: (()=>{const h=document.getElementById('homeView');return h?getComputedStyle(h).display:'n/a';})(),
    hash: location.hash,
  }));
  t('刷新后仍停在首页（不会又跳回后台）', !st2.isAdmin && st2.home==='block', JSON.stringify(st2));
  await ctx.close();
}

/* ---------- 场景 2：后台 401 —— 不能连坐删主站登录态 ---------- */
console.log('\n【场景 2】后台会话 401 —— 不许删掉主站共享登录态');
{
  const ctx=await browser.newContext({viewport:{width:1400,height:900}});
  const page=await ctx.newPage();
  await page.addInitScript(()=>{
    localStorage.setItem('cls_auth', JSON.stringify({token:'OLDTOKEN', user:{username:'aibot',role:'admin'}}));
  });
  await page.route('**/api/**',(route)=>{
    const u=route.request().url();
    if(u.includes('/auth?action=me')) return route.fulfill({status:401,contentType:'application/json',body:JSON.stringify({ok:false,error:'登录已过期'})});
    return route.fulfill({status:200,contentType:'application/json',body:'{"ok":true}'});
  });
  await page.goto(BASE+'/admin.html?_r='+Date.now(),{waitUntil:'domcontentloaded',timeout:60000});
  await page.waitForTimeout(3500);
  const st = await page.evaluate(()=>({
    hasAuth: !!localStorage.getItem('cls_auth'),
    gate: !document.getElementById('gate').classList.contains('hide'),
  }));
  t('401 后主站共享登录态 cls_auth 仍然保留', st.hasAuth, 'hasAuth='+st.hasAuth);
  t('401 后后台回到登录门（后台自己登出）', st.gate===true);
  await ctx.close();
}

/* ---------- 场景 3：网络错误 —— 保留登录态 + 给重试按钮 ---------- */
console.log('\n【场景 3】后台连不上服务器 —— 保留登录态并给重试');
{
  const ctx=await browser.newContext({viewport:{width:1400,height:900}});
  const page=await ctx.newPage();
  await page.addInitScript(()=>{
    localStorage.setItem('cls_auth', JSON.stringify({token:'TESTTOKEN', user:{username:'aibot',role:'admin'}}));
  });
  await page.route('**/api/**',(route)=>route.abort('failed'));
  await page.goto(BASE+'/admin.html?_r='+Date.now(),{waitUntil:'domcontentloaded',timeout:60000});
  await page.waitForTimeout(5000);
  const st = await page.evaluate(()=>({
    hasAuth: !!localStorage.getItem('cls_auth'),
    retry: !!document.getElementById('gRetry'),
    msg: (document.getElementById('gMsg')||{}).textContent || '',
  }));
  console.log('    ', JSON.stringify(st));
  t('网络故障时保留登录态（不再自动登出）', st.hasAuth, 'hasAuth='+st.hasAuth);
  t('给出「重试进入后台」按钮', st.retry);
  await ctx.close();
}

/* ---------- 场景 4：作业编辑 → 点完成，卡片不重复 ---------- */
console.log('\n【场景 4】作业编辑不套两层、点完成能恢复');
{
  const ROSTER=[]; for(let i=1;i<=24;i++) ROSTER.push({studentId:'2505'+String(i).padStart(2,'0'),name:'学生'+String(i).padStart(2,'0'),gender:i%2===0?'男':'女',role:'学生'});
  const ctx=await browser.newContext({viewport:{width:1920,height:1080}});
  const page=await ctx.newPage();
  /* v4.10.8：大屏作业看板只给管理员进，测试也用管理员身份 */
  await page.addInitScript(()=>{localStorage.setItem('cls_login_guide_v1','1');localStorage.setItem('cls_welcome_v1','1');
    localStorage.setItem('cls_auth', JSON.stringify({token:'TESTTOKEN', user:{username:'aibot', role:'admin'}}));});
  await page.route('**/api/**',(route)=>{
    const u=route.request().url();
    if(u.includes('/auth?action=me')) return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({ok:true,user:{username:'aibot',role:'admin'},cloudKeys:[]})});
    if(u.includes('/api/content')) return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({ok:true,items:{announcements:[],holiday_homeworks:[{id:'hw1',start:'2026-11-01',end:'2026-11-30',items:[{subject:'语文',tasks:[{text:'默写《岳阳楼记》第三段'}]},{subject:'数学',tasks:[{text:'课本 P42 习题'}]}]}]},serverTime:1,count:1})});
    if(u.includes('action=roster')||u.includes('/api/profile')) return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({ok:true,students:ROSTER})});
    return route.fulfill({status:200,contentType:'application/json',body:'{"ok":true}'});
  });
  await page.goto(BASE+'/index.html?_r='+Date.now(),{waitUntil:'domcontentloaded',timeout:60000});
  await page.waitForTimeout(2500);
  await page.evaluate(()=>{try{BIG.setMode(true);}catch(e){}});
  await page.waitForTimeout(500);
  await page.evaluate(()=>{try{BIG.openHw();}catch(e){}});
  await page.waitForTimeout(1200);
  const snap = async ()=> await page.evaluate(()=>{
    const cols=[...document.querySelectorAll('#bhwColA .bhw-subj, #bhwColB .bhw-subj')];
    return {
      count: cols.length,
      keys: cols.map(c=>c.getAttribute('data-hwkey')),
      nested: cols.filter(c=>c.querySelector('.bhw-subj')).length,
    };
  });
  const ro = await snap();
  await page.evaluate(()=>{try{BIG.hwEditToggle();}catch(e){}});
  await page.waitForTimeout(900);
  const ed = await snap();
  await page.evaluate(()=>{try{BIG.hwEditToggle();}catch(e){}});
  await page.waitForTimeout(900);
  const back = await snap();
  console.log('    只读', JSON.stringify(ro), '\n    编辑', JSON.stringify(ed), '\n    完成', JSON.stringify(back));
  t('只读态 2 张卡片', ro.count===2, JSON.stringify(ro.keys));
  t('编辑态仍是 2 张（不再变 4 张）', ed.count===2, JSON.stringify(ed.keys));
  t('编辑态没有卡片里再套卡片', ed.nested===0, 'nested='+ed.nested);
  t('点「完成」后恢复 2 张且无嵌套', back.count===2 && back.nested===0, JSON.stringify(back));
  await ctx.close();
}

/* ---------- 场景 5：字号 100 = 1.5 倍 ---------- */
console.log('\n【场景 5】字号刻度：显示 100 时倍率 = 1.5');
{
  const ctx=await browser.newContext({viewport:{width:1920,height:1080}});
  const page=await ctx.newPage();
  await page.addInitScript(()=>{localStorage.setItem('cls_login_guide_v1','1');localStorage.setItem('cls_welcome_v1','1');});
  await page.route('**/api/**',(route)=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({ok:true,items:{announcements:[],holiday_homeworks:[]}})}));
  await page.goto(BASE+'/index.html?_r='+Date.now(),{waitUntil:'domcontentloaded',timeout:60000});
  await page.waitForTimeout(2000);
  await page.evaluate(()=>{try{BIG.setMode(true);}catch(e){}});
  await page.waitForTimeout(400);
  await page.evaluate(()=>{try{BIG.openHw();}catch(e){}});
  await page.waitForTimeout(800);
  await page.evaluate(()=>{try{BIG.fsSet(100);}catch(e){}});
  await page.waitForTimeout(400);
  const r = await page.evaluate(()=>({
    fs: getComputedStyle(document.getElementById('bigHw')).getPropertyValue('--bhw-fs').trim(),
    fx: getComputedStyle(document.getElementById('bigHw')).getPropertyValue('--bhw-fx').trim(),
    brand: getComputedStyle(document.getElementById('bigHw')).getPropertyValue('--bhw-fbrand').trim(),
    shown: (document.getElementById('bhwFsVal')||{}).value,
  }));
  console.log('    ', JSON.stringify(r));
  t('显示 100 时倍率 = 1.5', Math.abs(parseFloat(r.fs)-1.5)<0.01, '--bhw-fs='+r.fs);
  t('顶栏字号固定 1.5', Math.abs(parseFloat(r.fx)-1.5)<0.01, '--bhw-fx='+r.fx);
  t('站名字号固定 1.8', Math.abs(parseFloat(r.brand)-1.8)<0.01, '--bhw-fbrand='+r.brand);
  t('滑块读数显示 100', r.shown==='100', 'shown='+r.shown);
  await ctx.close();
}

await browser.close();
console.log('\n'+'='.repeat(50));
console.log('结果: '+pass+' 通过, '+fail+' 失败');
console.log('='.repeat(50));
process.exit(fail?1:0);
