import fs from 'node:fs';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { DatabaseSync } from 'node:sqlite';
const src=fs.readFileSync('worker/index.js','utf8');
const {default:worker}=await import('data:text/javascript;base64,'+Buffer.from(src).toString('base64'));
export const db=new DatabaseSync(':memory:');db.exec(fs.readFileSync('db/schema.sql','utf8'));
const ins=db.prepare('INSERT INTO trial_applications (name,phone,created_at,product,status,location) VALUES (?,?,?,?,?,?)');
for(let i=0;i<503;i++)ins.run('測試申請人'+i,'0912345678','2026-09-26 04:00:00','樂暢適 PLUS',i%2?'new':'done','台北市信義區測試路123號');
for(const t of ['2026-09-25 15:59:59','2026-09-25 16:00:00','2026-09-26 15:59:59','2026-09-26 16:00:00'])ins.run('邊界','0900000000',t,'邊界測試','new','測試地址');
export const env={ADMIN_USER:'test',ADMIN_PASSWORD:'test',DB:{prepare(sql){return{args:[],bind(...args){this.args=args;return this},async first(){return db.prepare(sql).get(...this.args)},async all(){return{results:db.prepare(sql).all(...this.args)}},async run(){const r=db.prepare(sql).run(...this.args);return{meta:{last_row_id:Number(r.lastInsertRowid),changes:r.changes}}}}}}};
export const headers={Authorization:'Basic '+Buffer.from('test:test').toString('base64')};
export { worker };
async function list(query=''){return worker.fetch(new Request('https://local/admin/api/list?'+query,{headers}),env,{})}
assert.equal((await worker.fetch(new Request('https://local/admin/api/list'),env,{})).status,401);
const edge=await (await list('product='+encodeURIComponent('邊界測試')+'&from=2026-09-26&to=2026-09-26')).json();assert.equal(edge.total,2);assert.deepEqual(edge.items.map(x=>x.created_at),['2026-09-26 15:59:59','2026-09-25 16:00:00']);
for(const q of ['from=2026-02-30','from=no','from=2026-09-27&to=2026-09-26','page=0','page=1.5'])assert.equal((await list(q)).status,400,q);
let ids=[];for(let page=1;page<=11;page++){let d=await(await list('page='+page)).json();assert.equal(d.total,507);ids.push(...d.items.map(x=>x.id));}assert.equal(ids.length,507);assert.equal(new Set(ids).size,507);
assert.equal((await(await list('page=999')).json()).page,11);
assert.equal((await(await list('query=doesnotexist')).json()).pages,1);
const filter=await(await list('status=new&product='+encodeURIComponent('樂暢適 PLUS')+'&page=2')).json();assert.equal(filter.total,251);assert.equal(filter.items.length,50);assert(filter.items.every(x=>x.status==='new'));
const html=await(await worker.fetch(new Request('https://local/admin/trials',{headers}),env,{})).text();new vm.Script(html.match(/<script>([\s\S]*?)<\/script>/)[1]);
// Run the real LINE address handler with isolated network/KV fakes.
const bot=fs.readFileSync('line-bot/kaile-line-bot.js','utf8').replace(/export\s*\{\s*worker_default as default\s*\};/,'');
let calls=[],logs=[],syncResponse;
const context=vm.createContext({console:{log(...x){logs.push(x.join(' '))}},setTimeout,clearTimeout,AbortController,fetch:async(url)=>{calls.push(url);if(url.includes('/reply'))return new Response('{}');if(url.includes('/profile/'))return new Response('{}');if(url.includes('/trial-apply')){if(syncResponse instanceof Error)throw syncResponse;return syncResponse}throw Error('unexpected '+url)}});
vm.runInContext(bot,context);
const kv={async delete(){calls.push('clear')},async put(){calls.push('save')},async get(k){return k.startsWith('sess:')?JSON.stringify({step:'address',name:'測試',phone:'0912345678',product:'test',ts:Date.now()}):null}};
for(const [response,expectLog] of [[new Response('{"ok":true,"id":1}'),false],[new Response('{}',{status:500}),true],[new Response('{"ok":false}'),true],[new Response('not json'),true],[new Error('timeout'),true]]){calls=[];logs=[];syncResponse=response;const tasks=[];await context.handleEvent({type:'message',message:{type:'text',text:'台北市測試地址'},source:{userId:'fake-user'},replyToken:'fake'}, {COUPONS:kv}, {waitUntil(p){calls.push('waitUntil');tasks.push(p)}});assert(calls[0].includes('/reply'));assert(calls.includes('waitUntil'));assert.equal(calls.filter(x=>x.includes('/reply')).length,1);await Promise.all(tasks);assert.equal(logs.some(x=>x.includes('sync to cash-bio failed')),expectLog);}
console.log('PASS: Taiwan date boundaries, invalid dates, 507-row pagination, filters, auth, admin script, LINE success/HTTP failure/bad JSON/timeout and reply-first waitUntil handling.');
