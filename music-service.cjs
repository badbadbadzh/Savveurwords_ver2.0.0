'use strict';
// Read-only search of Bilibili's public, server-rendered results.
// Playback goes directly through their official embedded player.
const http=require('node:http'),fs=require('node:fs'),path=require('node:path');
const {readState}=require('./bili-state.cjs');
const PORT=8765,APP_ID='savveurwords-music-2.0.0',ROOT=__dirname;
const PAGE=path.join(ROOT,'SavveurWords_v2.0.0.html');
const KEY_FILE=path.join(ROOT,'.service-key'),stopKey=require('node:crypto').randomBytes(32).toString('hex');
const cache=new Map(),pending=new Map();
function decode(s=''){let out=String(s).replace(/<[^>]*>/g,'');for(let i=0;i<2;i++)out=out.replace(/&(#x[0-9a-f]+|#\d+|amp|quot|apos|lt|gt|nbsp);/gi,(_,v)=>{const n=v[0]==='#'?(v[1].toLowerCase()==='x'?parseInt(v.slice(2),16):+v.slice(1)):NaN;return Number.isFinite(n)?(n<=0x10ffff?String.fromCodePoint(n):''):({amp:'&',quot:'"',apos:"'",lt:'<',gt:'>',nbsp:' '})[v.toLowerCase()]||''});return out.trim()}
function parseResults(html){
 const seen=new Set(),results=[];
 for(const chunk of html.split(/class="bili-video-card__wrap"/).slice(1)){
  const bvid=chunk.match(/href="(?:https:)?\/\/www\.bilibili\.com\/video\/(BV[\da-zA-Z]{10})\//)?.[1];
  const title=chunk.match(/<h3\b[^>]*class="[^"]*bili-video-card__info--tit[^"]*"[^>]*title="([^"]*)"/i)?.[1];
  if(!bvid||!title||seen.has(bvid))continue;seen.add(bvid);
  const author=chunk.match(/<span\b[^>]*class="bili-video-card__info--author"[^>]*>([\s\S]*?)<\/span>/)?.[1]||'';
  const duration=chunk.match(/<span\b[^>]*class="bili-video-card__stats__duration"[^>]*>([\s\S]*?)<\/span>/)?.[1]||'';
  let cover=decode(chunk.match(/<img\b[^>]*src="([^"]+)"/)?.[1]||'');if(cover.startsWith('//'))cover='https:'+cover;
  try{const u=new URL(cover);if(u.protocol!=='https:'||!u.hostname.endsWith('.hdslb.com'))cover=''}catch{cover=''}
  results.push({bvid,title:decode(title),author:decode(author),duration:decode(duration),cover});
 }
 return results.slice(0,60);
}
function searchPage(html,page){
 let state;try{state=readState(html)}catch{}
 const typed=state?.searchTypeResponse?.searchTypeResponse,all=state?.searchResponse?.searchAllResponse;
 const data=typed?.page===page?typed:all?.page===page?all:null;
 if(data&&Array.isArray(data.result)){
  const raw=data===all?(data.result.find(g=>g.result_type==='video')?.data||[]):data.result;
  const seen=new Set();const rows=raw.filter(r=>r.type==='video'&&/^BV[\da-zA-Z]{10}$/.test(r.bvid)&&!r.is_pay&&!seen.has(r.bvid)&&(seen.add(r.bvid),true)).map(r=>{
   let cover=String(r.pic||'');if(cover.startsWith('//'))cover='https:'+cover;try{const u=new URL(cover);if(u.protocol!=='https:'||!u.hostname.endsWith('.hdslb.com'))cover=''}catch{cover=''}
   return {bvid:r.bvid,title:decode(r.title),author:decode(r.author),duration:decode(r.duration),cover};
  });return {results:rows,hasMore:page<Math.min(10,data.numPages||1)};
 }
 const rows=page===1?parseResults(html):[];if(rows.length)return {results:rows,hasMore:false};
 if(/没有找到|未找到|暂无相关|没有相关|啥都没搜到|没有搜到/.test(html))return {results:[],hasMore:false};
 throw Object.assign(Error('Bilibili 暂时没返回可用结果，请稍后再试。'),{status:502});
}
async function search(q,page){
 const key=q+'\0'+page,cached=cache.get(key);if(cached&&Date.now()-cached.time<300000)return cached.data;
 if(pending.has(key))return pending.get(key);if(pending.size>=3)throw Object.assign(Error('搜索有点忙，等几秒再试。'),{status:429});
 const task=(async()=>{
  const url=new URL('https://search.bilibili.com/all');url.searchParams.set('keyword',q);url.searchParams.set('page',String(page));
  const response=await fetch(url,{signal:AbortSignal.timeout(15000),redirect:'error'});
  if(!response.ok)throw Object.assign(Error('Bilibili 搜索暂时不可用，稍后再试。'),{status:502});
  const text=await response.text();if(text.length>5000000)throw Error('搜索结果太大了，请换个关键词。');
  const data={query:q,page,source:'bilibili',...searchPage(text,page)};
  cache.set(key,{time:Date.now(),data});if(cache.size>60)cache.delete(cache.keys().next().value);return data;
 })().finally(()=>pending.delete(key));pending.set(key,task);return task;
}
function json(res,status,data){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data))}
function makeServer(){return http.createServer(async(req,res)=>{
 try{
  if(!['127.0.0.1:'+PORT,'localhost:'+PORT].includes(req.headers.host))return json(res,403,{error:'无效的本地地址。'});
  const allowed=['http://127.0.0.1:'+PORT,'http://localhost:'+PORT,'null'];const origin=req.headers.origin;
  if(origin&&!allowed.includes(origin))return json(res,403,{error:'不允许的来源。'});
  if(origin){res.setHeader('Access-Control-Allow-Origin',origin);res.setHeader('Vary','Origin')}
  res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','strict-origin-when-cross-origin');
  const url=new URL(req.url,'http://127.0.0.1:'+PORT);
  if(url.pathname==='/api/service/stop'&&req.method==='POST'){
   if(req.headers['x-savveur-key']!==stopKey)return json(res,403,{error:'需要从关闭入口操作。'});
   json(res,200,{ok:true});try{fs.unlinkSync(KEY_FILE)}catch{};setTimeout(()=>process.exit(0),200);return;
  }
  if(req.method!=='GET')return json(res,405,{error:'只支持读取。'});
  if(url.pathname==='/api/health')return json(res,200,{app:APP_ID,version:'2.0.0'});
  if(url.pathname==='/api/music/search'){
   const q=(url.searchParams.get('q')||'').trim(),page=+(url.searchParams.get('page')||1);
   if(!q||q.length>100||/[\u0000-\u001f]/.test(q)||!Number.isInteger(page)||page<1||page>10)return json(res,400,{error:'请输入 1–100 个字的歌名或歌手。'});
   try{return json(res,200,await search(q,page))}catch(e){return json(res,e.status||502,{error:e.name==='TimeoutError'?'搜索有点慢，过一会儿再试。':e.message})}
  }
  if(url.pathname.startsWith('/ocr/')){
   const relative=decodeURIComponent(url.pathname.slice('/ocr/'.length));
   if(!relative||relative.includes('\0')||relative.includes('..')||!/^[-A-Za-z0-9_./]+$/.test(relative))return json(res,403,{error:'无效的 OCR 资源路径。'});
   const file=path.resolve(ROOT,'ocr',relative);
   const ocrRoot=path.resolve(ROOT,'ocr');
   if(file!==ocrRoot&&!file.startsWith(ocrRoot+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile())return json(res,404,{error:'找不到 OCR 资源。'});
   const ext=path.extname(file).toLowerCase();
   const types={'.js':'application/javascript; charset=utf-8','.wasm':'application/wasm','.gz':'application/gzip'};
   const stat=fs.statSync(file);res.writeHead(200,{'Content-Type':types[ext]||'application/octet-stream','Content-Length':stat.size,'Cache-Control':'public, max-age=31536000, immutable'});
   fs.createReadStream(file).pipe(res);return;
  }
  if(url.pathname==='/favicon.ico'){res.writeHead(204);return res.end()}
  if(url.pathname==='/'||url.pathname==='/SavveurWords_v2.0.0.html'){
   if(!fs.existsSync(PAGE))return json(res,500,{error:'找不到拯词页面，请把程序文件放在同一文件夹。'});
   const stat=fs.statSync(PAGE);res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Content-Length':stat.size,'Cache-Control':'no-cache'});fs.createReadStream(PAGE).pipe(res);return;
  }
  json(res,404,{error:'找不到这个页面。'});
 }catch{if(!res.headersSent)json(res,500,{error:'连接出了点问题，请重新启动拯词。'});else res.end()}
})}
async function health(){try{const r=await fetch('http://127.0.0.1:'+PORT+'/api/health',{signal:AbortSignal.timeout(1200)});return await r.json()}catch{return null}}
async function stopPreviousVersion(h){
 if(!h?.app || h.app===APP_ID || !/^savveurwords-music-/.test(h.app))return false;
 // Older 1.4/1.5 builds use the same local port. Prefer their authenticated
 // stop endpoint, then fall back to the PID listening on 8765 if an old build
 // was left running after its temporary key file was removed.
 const versionMatch=String(h.version||'').match(/^\d+\.\d+\.\d+$/);
 const candidates=[];
 if(versionMatch)candidates.push(path.resolve(ROOT,'..','SavveurWords_v'+h.version,'.service-key'));
 candidates.push(path.resolve(ROOT,'..','SavveurWords_v1.5.2','.service-key'),path.resolve(ROOT,'..','SavveurWords_v1.5.1','.service-key'),path.resolve(ROOT,'..','SavveurWords_v1.5.0','.service-key'),path.resolve(ROOT,'..','SavveurWords_v1.4.0','.service-key'),path.resolve(ROOT,'..','SavveurWords_v1.3.0','.service-key'));
 let stopped=false;
 for(const legacyKeyFile of [...new Set(candidates)]){
  let legacyKey='';try{legacyKey=fs.readFileSync(legacyKeyFile,'utf8').trim()}catch{}
  if(!/^[0-9a-f]{64}$/i.test(legacyKey))continue;
  try{
   const response=await fetch('http://127.0.0.1:'+PORT+'/api/service/stop',{method:'POST',headers:{'X-Savveur-Key':legacyKey},signal:AbortSignal.timeout(2000)});
   if(response.ok){stopped=true;break;}
  }catch{}
 }
 if(!stopped && process.platform==='win32'){
  const cp=require('node:child_process');
  try{
   const output=cp.execFileSync('cmd.exe',['/c','netstat -ano -p tcp | findstr LISTENING | findstr :'+PORT],{encoding:'utf8',windowsHide:true});
   const pids=[...output.matchAll(/\s(\d+)\s*$/gm)].map(match=>Number(match[1])).filter(pid=>pid>0);
   for(const pid of [...new Set(pids)]){try{cp.execFileSync('taskkill.exe',['/PID',String(pid),'/T','/F'],{stdio:'ignore',windowsHide:true});stopped=true;}catch{}}
  }catch{}
 }
 if(!stopped)throw Error('旧版拯词还开着，请先点旧版文件夹里的「关闭音乐连接」，再打开 2.0.0。');
 for(let i=0;i<25;i++){
  await new Promise(resolve=>setTimeout(resolve,100));
  const current=await health();
  if(!current)return true;
  if(current.app!==h.app)throw Error('连接已被另一程序接管，未继续启动。');
 }
 throw Error('旧版还没有关闭，请稍后再打开 2.0.0。');
}
async function launch(){
 const cp=require('node:child_process');let h=await health();
 if(await stopPreviousVersion(h))h=null;
 if(h&&h.app!==APP_ID)throw Error('8765 端口被其他程序占用，请先关闭那个程序，再打开拯词。');
 if(!h){const log=fs.openSync(path.join(ROOT,'启动日志.txt'),'a');const child=cp.spawn(process.execPath,[__filename],{detached:true,windowsHide:true,cwd:ROOT,stdio:['ignore',log,log]});child.unref();fs.closeSync(log);for(let i=0;i<25;i++){await new Promise(r=>setTimeout(r,200));h=await health();if(h?.app===APP_ID)break}}
 if(h?.app!==APP_ID)throw Error('拯词没能启动，请查看同文件夹的启动日志。');
 cp.spawn('explorer.exe',['http://127.0.0.1:'+PORT],{detached:true,windowsHide:true,stdio:'ignore'}).unref();
}
async function stop(){const h=await health();if(!h)return;if(h.app!==APP_ID)throw Error('这个端口不是拯词服务，未关闭。');const key=fs.readFileSync(KEY_FILE,'utf8').trim();const r=await fetch('http://127.0.0.1:'+PORT+'/api/service/stop',{method:'POST',headers:{'X-Savveur-Key':key}});if(!r.ok)throw Error('未能关闭，请确认使用的是同一个拯词文件夹。')}
if(require.main===module){if(process.argv.includes('--launch'))launch().catch(e=>{console.error(e.message);process.exitCode=1});else if(process.argv.includes('--stop'))stop().catch(e=>{console.error(e.message);process.exitCode=1});else makeServer().listen(PORT,'127.0.0.1',()=>{fs.writeFileSync(KEY_FILE,stopKey);console.log('SavveurWords ready at http://127.0.0.1:'+PORT)}).on('error',e=>{console.error(e.message);process.exitCode=1})}
module.exports={parseResults,searchPage,makeServer,decode};
