/**
 * 愷樂生醫｜試吃申請 API + 管理後台（Cloudflare Worker + D1 + Resend Email）
 *
 * 路由：
 *   POST /api/trial-apply           公開：接收試吃申請 → 寫入 D1 → 寄 Email 通知（防重複）
 *   GET  /admin/trials              後台頁面（Basic 驗證）
 *   GET  /admin/api/list            後台資料 API（Basic 驗證）：搜尋/篩選，最新在最上面
 *   POST /admin/api/status          後台：修改申請狀態（Basic 驗證）
 *   其他                            交給靜態網站（env.ASSETS）—— 網站照常運作
 *
 * 綁定 / Secrets（見 TRIAL-SETUP.md，皆不寫死在程式碼）：
 *   env.DB                D1 資料庫綁定
 *   env.ASSETS            靜態資產綁定（Workers Static Assets）
 *   env.RESEND_API_KEY    Email 服務金鑰（secret）
 *   env.NOTIFY_TO         收件信箱（例：lawrenceyu911@gmail.com）
 *   env.NOTIFY_FROM       寄件人（驗證網域後改 no-reply@cash-bio.com；未驗證前用 onboarding@resend.dev）
 *   env.ADMIN_USER        後台帳號（secret）
 *   env.ADMIN_PASSWORD    後台密碼（secret）
 *   env.ADMIN_URL         後台網址（放進 Email 內文；例 https://cash-bio.com/admin/trials）
 *   env.LINE_LIFF_CHANNEL_ID  （選用）用於驗證 LIFF idToken 的 LINE Login channel ID
 */

const STATUSES = ['new', 'contacted', 'done', 'invalid'];
const STATUS_LABEL = { new: '🟡 新申請', contacted: '🔵 已聯絡', done: '🟢 已完成', invalid: '⚪ 無效申請' };

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    try {
      if (path === '/api/trial-apply' && request.method === 'POST') return await handleApply(request, env, ctx);
      if (path === '/api/line-webhook' && request.method === 'POST') return await handleLineWebhook(request, env, ctx);
      if (path === '/admin' || path === '/admin/' || path === '/admin/trials') return await adminPage(request, env);
      if (path === '/admin/api/list') return await adminList(request, env, url);
      if (path === '/admin/api/status' && request.method === 'POST') return await adminStatus(request, env);
      // 其餘一律交給靜態網站
      if (env.ASSETS) return env.ASSETS.fetch(request);
      return new Response('Not found', { status: 404 });
    } catch (err) {
      return json({ ok: false, error: 'server_error', message: String((err && err.message) || err) }, 500);
    }
  },
};

/* ---------------- 公開：接收申請 ---------------- */
async function handleApply(request, env, ctx) {
  if (!env.DB) return json({ ok: false, error: 'db_not_configured' }, 503);

  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: 'bad_json' }, 400); }

  // 蜜罐：機器人會填 company，直接靜默丟棄（回成功以免被偵測）
  if (body.company) return json({ ok: true, id: 0 });

  const name = String(body.name || '').trim();
  const phone = String(body.phone || '').trim();
  if (!name || !phone) return json({ ok: false, error: 'missing_name_or_phone' }, 400);
  if (name.length > 100 || phone.length > 50) return json({ ok: false, error: 'too_long' }, 400);

  let lineUserId = String(body.line_user_id || '').slice(0, 120) || null;
  let lineName = String(body.line_display_name || '').slice(0, 120) || null;

  // 選用：若前端帶 LIFF idToken，且設定了 channel id，就伺服器端驗證取得可信的 LINE 身分
  if (body.id_token && env.LINE_LIFF_CHANNEL_ID) {
    const v = await verifyLiffIdToken(body.id_token, env.LINE_LIFF_CHANNEL_ID).catch(() => null);
    if (v) { lineUserId = v.sub || lineUserId; lineName = v.name || lineName; }
  }

  const rec = {
    line_user_id: lineUserId,
    line_display_name: lineName,
    name: name.slice(0, 100),
    phone: phone.slice(0, 50),
    email: String(body.email || '').slice(0, 150) || null,
    location: String(body.location || '').slice(0, 120) || null,
    product: String(body.product || '').slice(0, 120) || null,
    notes: String(body.notes || '').slice(0, 1000) || null,
    source: String(body.source || 'LINE').slice(0, 60),
  };

  const insert = await env.DB.prepare(
    `INSERT INTO trial_applications (line_user_id,line_display_name,name,phone,email,location,product,notes,source)
     VALUES (?,?,?,?,?,?,?,?,?)`
  ).bind(rec.line_user_id, rec.line_display_name, rec.name, rec.phone, rec.email, rec.location, rec.product, rec.notes, rec.source).run();

  const id = insert.meta && insert.meta.last_row_id;
  const row = await env.DB.prepare(`SELECT * FROM trial_applications WHERE id=?`).bind(id).first();

  // 寄 Email 通知（只在成功寫入後、且只寄一次）。用 waitUntil 不阻塞回應
  ctx.waitUntil(notifyByEmail(env, row).catch((e) => console.log('email error', String(e))));

  return json({ ok: true, id });
}

/* ---------------- Email 通知（防重複） ---------------- */
async function notifyByEmail(env, row) {
  if (!row || row.email_notified) return;                 // 已通知過 → 不再寄
  if (!env.RESEND_API_KEY || !env.NOTIFY_TO) return;      // 尚未設定 Email 服務 → 略過（資料仍已存）
  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: env.NOTIFY_FROM || 'onboarding@resend.dev',
      to: [env.NOTIFY_TO],
      subject: '【愷樂生醫】🎉 有新的試吃申請',
      html: renderEmail(row, env.ADMIN_URL || ''),
    }),
  });
  if (resp.ok) {
    await env.DB.prepare(`UPDATE trial_applications SET email_notified=1, updated_at=datetime('now') WHERE id=?`).bind(row.id).run();
  } else {
    console.log('resend failed', resp.status, await resp.text().catch(() => ''));
  }
}

function renderEmail(r, adminUrl) {
  const esc = (s) => String(s == null ? '' : s).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
  const rowize = (label, val) => `<tr><td style="padding:6px 12px;color:#7A1024;font-weight:700;white-space:nowrap;vertical-align:top">${label}</td><td style="padding:6px 12px;color:#222">${esc(val) || '—'}</td></tr>`;
  return `<div style="font-family:-apple-system,'Noto Sans TC',sans-serif;max-width:560px;margin:0 auto;background:#FAFAF8;padding:24px;border-radius:14px;border:1px solid #E7DcC2">
    <h2 style="margin:0 0 4px;color:#7A1024;font-size:20px">🎉 新的試吃申請</h2>
    <p style="margin:0 0 16px;color:#8a7a55;font-size:13px">愷樂生醫 CASH BIOMEDICAL</p>
    <table style="width:100%;border-collapse:collapse;background:#fff;border-radius:10px;overflow:hidden;font-size:14px">
      ${rowize('申請時間', r.created_at)}
      ${rowize('姓名', r.name)}
      ${rowize('電話', r.phone)}
      ${rowize('選擇產品', r.product)}
      ${rowize('Email', r.email)}
      ${rowize('地區', r.location)}
      ${rowize('LINE 名稱', r.line_display_name)}
      ${rowize('LINE User ID', r.line_user_id)}
      ${rowize('備註', r.notes)}
      ${rowize('申請來源', r.source)}
      ${rowize('申請編號', '#' + r.id)}
    </table>
    ${adminUrl ? `<p style="margin:18px 0 0"><a href="${esc(adminUrl)}" style="display:inline-block;background:#7A1024;color:#fff;text-decoration:none;padding:10px 20px;border-radius:999px;font-weight:700;font-size:14px">👉 登入後台查看完整資料</a></p>` : ''}
  </div>`;
}

/* ---------------- 後台：Basic 驗證 ---------------- */
function requireAuth(request, env) {
  if (!env.ADMIN_USER || !env.ADMIN_PASSWORD) {
    return { ok: false, resp: json({ ok: false, error: 'admin_not_configured' }, 503, noindexHeaders()) };
  }
  const h = request.headers.get('Authorization') || '';
  if (h.startsWith('Basic ')) {
    let decoded = '';
    try { decoded = atob(h.slice(6)); } catch { decoded = ''; }
    const idx = decoded.indexOf(':');
    const u = decoded.slice(0, idx), p = decoded.slice(idx + 1);
    if (safeEqual(u, env.ADMIN_USER) && safeEqual(p, env.ADMIN_PASSWORD)) return { ok: true };
  }
  return {
    ok: false,
    resp: new Response('需要登入', { status: 401, headers: { 'WWW-Authenticate': 'Basic realm="Trial Admin", charset="UTF-8"', ...noindexHeaders() } }),
  };
}
function safeEqual(a, b) {
  a = String(a); b = String(b);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
function noindexHeaders(extra = {}) { return { 'X-Robots-Tag': 'noindex, nofollow, noarchive', ...extra }; }

/* ---------------- 後台：資料 API ---------------- */
async function adminList(request, env, url) {
  const auth = requireAuth(request, env); if (!auth.ok) return auth.resp;
  if (!env.DB) return json({ ok: false, error: 'db_not_configured' }, 503, noindexHeaders());

  const q = (url.searchParams.get('query') || '').trim();
  const product = (url.searchParams.get('product') || '').trim();
  const status = (url.searchParams.get('status') || '').trim();
  const from = (url.searchParams.get('from') || '').trim();
  const to = (url.searchParams.get('to') || '').trim();

  const where = []; const bind = [];
  if (q) { where.push('(name LIKE ? OR phone LIKE ? OR line_display_name LIKE ?)'); bind.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  if (product) { where.push('product = ?'); bind.push(product); }
  if (status && STATUSES.includes(status)) { where.push('status = ?'); bind.push(status); }
  if (from) { where.push('created_at >= ?'); bind.push(from + ' 00:00:00'); }
  if (to) { where.push('created_at <= ?'); bind.push(to + ' 23:59:59'); }

  const sql = `SELECT * FROM trial_applications ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC, id DESC LIMIT 500`;
  const { results } = await env.DB.prepare(sql).bind(...bind).all();
  return json({ ok: true, count: results.length, items: results }, 200, noindexHeaders());
}

async function adminStatus(request, env) {
  const auth = requireAuth(request, env); if (!auth.ok) return auth.resp;
  if (!env.DB) return json({ ok: false, error: 'db_not_configured' }, 503, noindexHeaders());
  let body; try { body = await request.json(); } catch { return json({ ok: false, error: 'bad_json' }, 400, noindexHeaders()); }
  const id = parseInt(body.id, 10);
  const status = String(body.status || '');
  if (!id || !STATUSES.includes(status)) return json({ ok: false, error: 'bad_params' }, 400, noindexHeaders());
  await env.DB.prepare(`UPDATE trial_applications SET status=?, updated_at=datetime('now') WHERE id=?`).bind(status, id).run();
  return json({ ok: true }, 200, noindexHeaders());
}

/* ---------------- 後台：頁面 ---------------- */
async function adminPage(request, env) {
  const auth = requireAuth(request, env); if (!auth.ok) return auth.resp;
  return new Response(ADMIN_HTML, { headers: { 'Content-Type': 'text/html; charset=utf-8', ...noindexHeaders() } });
}

/* ---------------- LIFF idToken 驗證（選用） ---------------- */
async function verifyLiffIdToken(idToken, channelId) {
  const resp = await fetch('https://api.line.me/oauth2/v2.1/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ id_token: idToken, client_id: channelId }),
  });
  if (!resp.ok) return null;
  return resp.json(); // { sub, name, ... }
}

/* ============================================================
   LINE Messaging API 對話式試吃問卷（客人全程留在 LINE 聊天室）
   流程：點「我要試吃」→ 選產品 → 打姓名 → 打電話 → 完成
   完成後：寫入 trial_applications（source=LINE）＋ 寄 Email
   ============================================================ */
const LINE_TRIGGERS = ['我要試吃', '試吃', '三種擇一試吃', '申請試吃', '點我試吃'];
const LINE_PRODUCTS = ['左旋麩醯胺酸晶凍', 'GABA鈣鎂晶凍', '樂暢適PLUS加強版', '三款都想試'];
let sessionsReady = false;

async function ensureSessions(env) {
  if (sessionsReady) return;
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS line_sessions (line_user_id TEXT PRIMARY KEY, step TEXT, data TEXT, updated_at TEXT DEFAULT (datetime('now')))`
  ).run();
  sessionsReady = true;
}
async function getSession(env, uid) {
  const r = await env.DB.prepare(`SELECT step,data FROM line_sessions WHERE line_user_id=?`).bind(uid).first();
  return r ? { step: r.step, data: JSON.parse(r.data || '{}') } : null;
}
async function setSession(env, uid, step, data) {
  await env.DB.prepare(
    `INSERT INTO line_sessions (line_user_id,step,data,updated_at) VALUES (?,?,?,datetime('now'))
     ON CONFLICT(line_user_id) DO UPDATE SET step=excluded.step, data=excluded.data, updated_at=datetime('now')`
  ).bind(uid, step, JSON.stringify(data)).run();
}
async function clearSession(env, uid) {
  await env.DB.prepare(`DELETE FROM line_sessions WHERE line_user_id=?`).bind(uid).run();
}

async function handleLineWebhook(request, env, ctx) {
  const bodyText = await request.text();
  // 驗證 LINE 簽章（設定 channel secret 後啟用）
  if (env.LINE_CHANNEL_SECRET) {
    const ok = await verifyLineSignature(bodyText, request.headers.get('x-line-signature') || '', env.LINE_CHANNEL_SECRET);
    if (!ok) return new Response('bad signature', { status: 403 });
  }
  let payload; try { payload = JSON.parse(bodyText); } catch { return new Response('bad json', { status: 400 }); }
  const events = payload.events || [];
  // 先回 200 給 LINE，事件在背景處理
  ctx.waitUntil(Promise.all(events.map((ev) => handleLineEvent(ev, env).catch((e) => console.log('line event err', String(e))))));
  return new Response('OK', { status: 200 });
}

async function handleLineEvent(ev, env) {
  if (!env.DB || !env.LINE_CHANNEL_ACCESS_TOKEN) return;
  if (ev.type !== 'message' || !ev.message || ev.message.type !== 'text') return;
  const uid = ev.source && ev.source.userId;
  const replyToken = ev.replyToken;
  const text = String(ev.message.text || '').trim();
  if (!uid || !replyToken) return;
  await ensureSessions(env);

  if (text === '取消') { await clearSession(env, uid); return replyText(env, replyToken, '已取消試吃申請 🙂 需要時再點「我要試吃」即可。'); }

  let session = await getSession(env, uid);

  // 尚未進行問卷：只有觸發字才開始（其他訊息不干擾）
  if (!session) {
    if (LINE_TRIGGERS.includes(text)) {
      await setSession(env, uid, 'await_product', {});
      return replyProduct(env, replyToken);
    }
    return;
  }

  // 問卷進行中，逐題收集
  if (session.step === 'await_product') {
    session.data.product = text.slice(0, 60);
    await setSession(env, uid, 'await_name', session.data);
    return replyText(env, replyToken, `好的，你選擇了「${session.data.product}」😊\n\n請輸入您的「大名」：`);
  }
  if (session.step === 'await_name') {
    session.data.name = text.slice(0, 100);
    await setSession(env, uid, 'await_phone', session.data);
    return replyText(env, replyToken, `${session.data.name} 您好 💛\n請輸入您的「電話」：`);
  }
  if (session.step === 'await_phone') {
    const digits = text.replace(/\D/g, '');
    if (digits.length < 8) return replyText(env, replyToken, '電話看起來怪怪的，請重新輸入您的電話號碼（例：0912345678）：');
    session.data.phone = text.slice(0, 50);
    let displayName = null;
    try { const p = await getLineProfile(env, uid); displayName = p && p.displayName; } catch {}
    const insert = await env.DB.prepare(
      `INSERT INTO trial_applications (line_user_id,line_display_name,name,phone,product,source) VALUES (?,?,?,?,?,?)`
    ).bind(uid, displayName, session.data.name, session.data.phone, session.data.product || null, 'LINE').run();
    const row = await env.DB.prepare(`SELECT * FROM trial_applications WHERE id=?`).bind(insert.meta && insert.meta.last_row_id).first();
    await notifyByEmail(env, row).catch((e) => console.log('email err', String(e)));
    await clearSession(env, uid);
    return replyText(env, replyToken,
      `🎉 收到您的試吃申請！\n謝謝您 💛\n資料已成功送出～\n\n📦 產品：${session.data.product}\n🙍 姓名：${session.data.name}\n📞 電話：${session.data.phone}\n\n接下來會由愷樂生醫專員與您電話聯絡，請留意您的電話 😊`);
  }
}

async function replyText(env, replyToken, text, quickItems) {
  const msg = { type: 'text', text };
  if (quickItems) msg.quickReply = { items: quickItems };
  return fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}` },
    body: JSON.stringify({ replyToken, messages: [msg] }),
  });
}
function replyProduct(env, replyToken) {
  const items = LINE_PRODUCTS.map((p) => ({ type: 'action', action: { type: 'message', label: p.slice(0, 20), text: p } }));
  return replyText(env, replyToken, '想先試哪一款呢？✨\n請點下方按鈕，或直接輸入產品名稱：', items);
}
async function getLineProfile(env, uid) {
  const r = await fetch(`https://api.line.me/v2/bot/profile/${uid}`, { headers: { Authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}` } });
  return r.ok ? r.json() : null;
}
async function verifyLineSignature(bodyText, signature, channelSecret) {
  try {
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(channelSecret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(bodyText));
    const b64 = btoa(String.fromCharCode(...new Uint8Array(mac)));
    return b64 === signature;
  } catch { return false; }
}

/* ---------------- utils ---------------- */
function json(obj, status = 200, extra = {}) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...extra } });
}

/* ---------------- 後台 HTML（單頁，資料以 API 載入） ---------------- */
const ADMIN_HTML = `<!doctype html><html lang="zh-Hant"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>愷樂生醫｜試吃申請管理</title>
<style>
:root{--wine:#7A1024;--gold:#C8A24D;--ivory:#FAFAF8;--ink:#2b2b2b}
*{box-sizing:border-box}body{margin:0;font-family:-apple-system,"Noto Sans TC",sans-serif;background:var(--ivory);color:var(--ink)}
header{background:var(--wine);color:#fff;padding:14px 18px;display:flex;align-items:center;gap:10px;flex-wrap:wrap}
header h1{font-size:17px;margin:0;font-weight:800}header .count{margin-left:auto;font-size:13px;opacity:.85}
.wrap{max-width:1100px;margin:0 auto;padding:16px}
.filters{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px}
.filters input,.filters select{padding:9px 11px;border:1px solid #d8cba6;border-radius:9px;font-size:14px;background:#fff}
.filters input[type=text]{min-width:180px}
button{cursor:pointer;border:none;border-radius:9px;font-size:13px;padding:9px 14px;font-weight:700}
.btn{background:var(--wine);color:#fff}.btn2{background:#eee;color:#333}
.card{background:#fff;border:1px solid #ecdfbf;border-radius:12px;padding:14px;margin-bottom:10px;box-shadow:0 8px 22px -16px rgba(122,16,36,.25)}
.card .top{display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;align-items:center}
.card .nm{font-weight:800;font-size:16px}.card .tel{color:var(--wine);font-weight:700}
.badge{font-size:12px;padding:3px 9px;border-radius:999px;background:#f3ead2;color:#7a5}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:6px 16px;margin-top:10px;font-size:13px;color:#555}
.grid b{color:#333}
.muted{color:#999}
select.status{padding:6px 8px;border-radius:8px;border:1px solid #d8cba6;font-size:13px}
.empty{text-align:center;color:#999;padding:40px}
@media(max-width:520px){.card .top{flex-direction:column;align-items:flex-start}}
</style></head><body>
<header><h1>📋 試吃申請管理</h1><span class="count" id="count"></span></header>
<div class="wrap">
  <div class="filters">
    <input type="text" id="query" placeholder="搜尋姓名 / 電話 / LINE 名稱">
    <select id="product"><option value="">全部產品</option>
      <option>左旋麩醯胺酸晶凍</option><option>GABA鈣鎂晶凍</option><option>樂暢適PLUS加強版</option><option>三款產品</option></select>
    <select id="status"><option value="">全部狀態</option>
      <option value="new">🟡 新申請</option><option value="contacted">🔵 已聯絡</option><option value="done">🟢 已完成</option><option value="invalid">⚪ 無效申請</option></select>
    <input type="date" id="from"><input type="date" id="to">
    <button class="btn" onclick="load()">搜尋</button>
    <button class="btn2" onclick="clearF()">清除</button>
  </div>
  <div id="list"></div>
</div>
<script>
var STL={new:'🟡 新申請',contacted:'🔵 已聯絡',done:'🟢 已完成',invalid:'⚪ 無效申請'};
function esc(s){return String(s==null?'':s).replace(/[<>&]/g,function(c){return{'<':'&lt;','>':'&gt;','&':'&amp;'}[c]})}
function qs(){var p=new URLSearchParams();['query','product','status','from','to'].forEach(function(k){var v=document.getElementById(k).value.trim();if(v)p.set(k,v)});return p.toString()}
function clearF(){['query','product','status','from','to'].forEach(function(k){document.getElementById(k).value=''});load()}
async function load(){
  var r=await fetch('/admin/api/list?'+qs(),{headers:{'Accept':'application/json'}});
  if(!r.ok){document.getElementById('list').innerHTML='<div class="empty">載入失敗（'+r.status+'）</div>';return}
  var d=await r.json();document.getElementById('count').textContent='共 '+d.count+' 筆';
  if(!d.items.length){document.getElementById('list').innerHTML='<div class="empty">目前沒有符合的申請</div>';return}
  document.getElementById('list').innerHTML=d.items.map(card).join('');
}
function card(x){
  var opts=Object.keys(STL).map(function(k){return '<option value="'+k+'"'+(k===x.status?' selected':'')+'>'+STL[k]+'</option>'}).join('');
  return '<div class="card"><div class="top">'
    +'<div><span class="nm">'+esc(x.name)+'</span> &nbsp;<span class="tel">'+esc(x.phone)+'</span></div>'
    +'<div><span class="muted">#'+x.id+'　'+esc(x.created_at)+'</span> &nbsp;'
    +'<select class="status" onchange="setStatus('+x.id+',this.value)">'+opts+'</select></div></div>'
    +'<div class="grid">'
    +'<div><b>產品：</b>'+(esc(x.product)||'—')+'</div>'
    +'<div><b>Email：</b>'+(esc(x.email)||'—')+'</div>'
    +'<div><b>地區：</b>'+(esc(x.location)||'—')+'</div>'
    +'<div><b>LINE 名稱：</b>'+(esc(x.line_display_name)||'—')+'</div>'
    +'<div><b>LINE ID：</b>'+(esc(x.line_user_id)||'—')+'</div>'
    +'<div><b>來源：</b>'+(esc(x.source)||'—')+'</div>'
    +(x.notes?'<div style="grid-column:1/-1"><b>備註：</b>'+esc(x.notes)+'</div>':'')
    +'</div></div>';
}
async function setStatus(id,status){
  await fetch('/admin/api/status',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:id,status:status})});
}
document.getElementById('query').addEventListener('keydown',function(e){if(e.key==='Enter')load()});
load();
</script></body></html>`;
