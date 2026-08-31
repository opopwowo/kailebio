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

// 狀態值：new 新申請 / contacted 已聯絡 / processing 處理中 / shipped 已寄出 / done 已完成 / cancelled 已取消
// invalid 為舊資料保留值（仍可篩選、仍可顯示），介面不再提供選擇
const STATUSES = ['new', 'contacted', 'processing', 'shipped', 'done', 'cancelled', 'invalid'];
const STATUS_LABEL = { new: '🟡 新申請', contacted: '🔵 已聯絡', processing: '🟣 處理中', shipped: '🟢 已寄出', done: '⚫ 已完成', cancelled: '🔴 已取消', invalid: '⚪ 無效' };

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
      if (path === '/admin/api/note' && request.method === 'POST') return await adminNote(request, env);
      if (path === '/admin/api/stats') return await adminStats(request, env);
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
      subject: '【愷樂生醫】新的試吃申請通知',
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
      ${rowize('收件地址', r.location)}
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

// 儲存客服備註（不影響其他欄位）
async function adminNote(request, env) {
  const auth = requireAuth(request, env); if (!auth.ok) return auth.resp;
  if (!env.DB) return json({ ok: false, error: 'db_not_configured' }, 503, noindexHeaders());
  let body; try { body = await request.json(); } catch { return json({ ok: false, error: 'bad_json' }, 400, noindexHeaders()); }
  const id = parseInt(body.id, 10);
  if (!id) return json({ ok: false, error: 'bad_params' }, 400, noindexHeaders());
  const notes = String(body.notes == null ? '' : body.notes).slice(0, 1000);
  await env.DB.prepare(`UPDATE trial_applications SET notes=?, updated_at=datetime('now') WHERE id=?`).bind(notes || null, id).run();
  return json({ ok: true }, 200, noindexHeaders());
}

// 名單統計：全部/今日（台灣時間）/各狀態筆數 + 目前有的產品清單（供後台儀表板與篩選使用）
async function adminStats(request, env) {
  const auth = requireAuth(request, env); if (!auth.ok) return auth.resp;
  if (!env.DB) return json({ ok: false, error: 'db_not_configured' }, 503, noindexHeaders());
  const grouped = await env.DB.prepare(`SELECT status, COUNT(*) AS c FROM trial_applications GROUP BY status`).all();
  const byStatus = {}; let total = 0;
  for (const row of (grouped.results || [])) { byStatus[row.status] = row.c; total += row.c; }
  const todayRow = await env.DB.prepare(
    `SELECT COUNT(*) AS c FROM trial_applications WHERE date(created_at,'+8 hours') = date('now','+8 hours')`
  ).first();
  const prod = await env.DB.prepare(
    `SELECT DISTINCT product AS p FROM trial_applications WHERE product IS NOT NULL AND product <> '' ORDER BY product`
  ).all();
  const products = (prod.results || []).map((r) => r.p);
  return json({ ok: true, total, today: (todayRow && todayRow.c) || 0, byStatus, products }, 200, noindexHeaders());
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
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex,nofollow">
<title>愷樂生醫｜試吃申請管理</title>
<style>
:root{--wine:#8B1025;--wine2:#a3203a;--wine-tint:#f7ecef;--bg:#f4f2ee;--card:#fff;--ink:#2b2530;--muted:#8b8592;--line:#ece7e0}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
html,body{overflow-x:hidden;max-width:100%}
body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Noto Sans TC","PingFang TC","Segoe UI",sans-serif;background:var(--bg);color:var(--ink)}
header{background:linear-gradient(135deg,var(--wine),var(--wine2));color:#fff;padding:15px 18px;display:flex;align-items:center;gap:12px;flex-wrap:wrap;position:sticky;top:0;z-index:5}
header h1{font-size:18px;margin:0;font-weight:800;letter-spacing:.5px}
header .brand{font-size:10px;opacity:.82;font-weight:600;margin-top:3px;letter-spacing:1.5px}
header .hstat{margin-left:auto;text-align:right;font-size:13px;line-height:1.55;opacity:.96}
header .hstat span{display:block}
header .hstat b{font-size:17px;font-weight:800}
.wrap{max-width:960px;margin:0 auto;padding:14px 14px 48px}
.chips{display:flex;gap:8px;flex-wrap:wrap;margin:2px 0 13px}
.chip{display:inline-flex;align-items:center;gap:6px;background:#fff;border:1px solid var(--line);color:#4a444f;border-radius:999px;padding:7px 13px;font-size:13px;font-weight:600;cursor:pointer;line-height:1}
.chip b{font-size:14px;color:var(--ink)}
.chip .dot{width:9px;height:9px;border-radius:50%;flex:none}
.chip.active{border-color:var(--wine);background:var(--wine-tint);color:var(--wine)}
.chip.active b{color:var(--wine)}
.filters{display:flex;gap:8px;flex-wrap:wrap;align-items:center;background:#fff;border:1px solid var(--line);border-radius:12px;padding:10px;margin-bottom:12px}
.filters input,.filters select{padding:0 11px;height:40px;border:1px solid var(--line);border-radius:9px;font-size:14px;background:#fff;color:var(--ink)}
.filters .search{flex:1 1 220px;min-width:150px}
.filters .dates{display:inline-flex;align-items:center;gap:6px;color:var(--muted);font-size:13px}
.btn{background:var(--wine);color:#fff;border:none;border-radius:9px;font-size:14px;height:40px;padding:0 18px;font-weight:700;cursor:pointer}
.btn.ghost{background:#f0ebe4;color:#5a545f}
.listinfo{color:var(--muted);font-size:12px;margin:0 2px 10px}
.card{background:var(--card);border:1px solid var(--line);border-left:4px solid #ccc;border-radius:14px;padding:14px 15px;margin-bottom:12px;box-shadow:0 2px 10px rgba(30,15,20,.05)}
.r1{display:flex;justify-content:space-between;align-items:flex-start;gap:10px}
.name{font-size:20px;font-weight:800;line-height:1.25}
.sbadge{font-size:12px;font-weight:700;padding:4px 10px;border-radius:999px;white-space:nowrap;background:#faf7f3;border:1px solid currentColor}
.phone{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:9px}
.phone .num{font-size:18px;font-weight:800;color:var(--wine);letter-spacing:.5px}
.mini{border:1px solid var(--line);background:#faf8f5;color:#5a545f;border-radius:8px;padding:0 11px;height:34px;font-size:12px;font-weight:600;cursor:pointer;text-decoration:none;display:inline-flex;align-items:center;gap:4px}
.mini:active{background:#efe9e2}
.block{margin-top:10px;display:flex;flex-direction:column;gap:7px}
.row{display:flex;align-items:flex-start;gap:8px;font-size:14px;color:#3f3a45;flex-wrap:wrap}
.row .k{width:18px;text-align:center;flex:none}
.row .v{flex:1 1 auto;min-width:0;word-break:break-word;line-height:1.45}
.meta{margin-top:9px;font-size:13px;color:var(--muted);display:flex;gap:6px 14px;flex-wrap:wrap;align-items:center}
.lid{margin-top:8px;font-size:12px;color:var(--muted);display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.lid code{background:#f3efe9;padding:3px 8px;border-radius:6px;color:#5a545f}
.note{margin-top:12px}
.note label{font-size:12px;color:var(--muted);font-weight:700;display:block;margin-bottom:5px}
.note textarea{width:100%;border:1px solid var(--line);border-radius:9px;padding:9px 10px;font-size:14px;font-family:inherit;resize:vertical;min-height:44px;color:var(--ink);background:#fff}
.note textarea:focus{outline:none;border-color:var(--wine)}
.note .save{margin-top:7px}
.statusbar{display:flex;align-items:center;gap:9px;margin-top:12px;padding-top:12px;border-top:1px dashed var(--line)}
.statusbar label{font-size:12px;color:var(--muted);font-weight:700;flex:none}
select.status{flex:1 1 auto;min-width:0;max-width:100%;padding:0 10px;height:42px;border-radius:9px;border:1px solid var(--line);font-size:14px;font-weight:700;background:#fff;color:var(--ink)}
.empty{text-align:center;color:var(--muted);padding:54px 20px;font-size:14px}
#toast{position:fixed;left:50%;bottom:calc(22px + env(safe-area-inset-bottom));transform:translateX(-50%) translateY(18px);background:#2b2530;color:#fff;padding:10px 18px;border-radius:999px;font-size:13px;font-weight:700;opacity:0;pointer-events:none;transition:.25s;z-index:50}
#toast.show{opacity:1;transform:translateX(-50%) translateY(0)}
@media(max-width:560px){
 .wrap{padding:12px 11px 48px}
 header .hstat{margin-left:0;width:100%;text-align:left;display:flex;gap:18px}
 .filters{flex-direction:column;align-items:stretch}
 .filters .search,.filters input,.filters select,.btn{width:100%;flex:0 0 auto}
 .filters .dates{width:100%;justify-content:space-between}
 .filters .dates input{flex:1 1 0;min-width:0;width:auto}
 .name{font-size:19px}
}
</style></head><body>
<header>
 <div><h1>📋 試吃申請管理</h1><div class="brand">愷樂生醫 CASH BIOMEDICAL</div></div>
 <div class="hstat"><span>今日申請 <b id="hdrToday">0</b> 件</span><span>全部申請 <b id="hdrTotal">0</b> 件</span></div>
</header>
<div class="wrap">
 <div class="chips" id="chips"></div>
 <div class="filters">
  <input class="search" type="text" id="query" placeholder="🔍 搜尋姓名、電話、LINE名稱">
  <select id="product"><option value="">全部產品</option></select>
  <select id="status"><option value="">全部狀態</option><option value="new">🟡 新申請</option><option value="contacted">🔵 已聯絡</option><option value="processing">🟣 處理中</option><option value="shipped">🟢 已寄出</option><option value="done">⚫ 已完成</option><option value="cancelled">🔴 已取消</option><option value="invalid">⚪ 無效</option></select>
  <span class="dates"><input type="date" id="from"> ～ <input type="date" id="to"></span>
  <button class="btn" data-act="go">搜尋</button>
  <button class="btn ghost" data-act="clear">清除</button>
 </div>
 <div class="listinfo" id="listinfo"></div>
 <div id="list"></div>
</div>
<div id="toast"></div>
<script>
var STL={new:{t:'🟡 新申請',n:'新申請',c:'#E0A400'},contacted:{t:'🔵 已聯絡',n:'已聯絡',c:'#2F80ED'},processing:{t:'🟣 處理中',n:'處理中',c:'#8B5CF6'},shipped:{t:'🟢 已寄出',n:'已寄出',c:'#27AE60'},done:{t:'⚫ 已完成',n:'已完成',c:'#4B5563'},cancelled:{t:'🔴 已取消',n:'已取消',c:'#D64545'},invalid:{t:'⚪ 無效',n:'無效',c:'#9AA0A6'}};
var UI_ORDER=['new','contacted','processing','shipped','done','cancelled'];
var CHIP_ORDER=['new','contacted','processing','shipped','done','cancelled'];
var ITEMS=[];
function esc(s){return String(s==null?'':s).replace(/[<>&"']/g,function(c){return{'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&#39;'}[c]})}
function byId(id){for(var i=0;i<ITEMS.length;i++){if(ITEMS[i].id===id)return ITEMS[i]}return null}
function shortId(s){s=String(s||'');return s.length>12?(s.slice(0,5)+'…'+s.slice(-5)):s}
function fmtTime(s){if(!s)return '';try{var d=new Date(String(s).replace(' ','T')+'Z');var p=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Taipei',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).formatToParts(d);var o={};p.forEach(function(x){o[x.type]=x.value});return o.year+'-'+o.month+'-'+o.day+' '+o.hour+':'+o.minute}catch(e){return String(s)}}
function toast(m){var el=document.getElementById('toast');el.textContent=m;el.className='show';clearTimeout(window._tt);window._tt=setTimeout(function(){el.className=''},1600)}
function copyText(t){t=String(t==null?'':t);if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(t).then(function(){toast('已複製 ✓')},function(){fbCopy(t)})}else{fbCopy(t)}}
function fbCopy(t){var ta=document.createElement('textarea');ta.value=t;ta.style.position='fixed';ta.style.opacity='0';document.body.appendChild(ta);ta.focus();ta.select();try{document.execCommand('copy');toast('已複製 ✓')}catch(e){toast('複製失敗')}document.body.removeChild(ta)}
function copyField(id,f){var x=byId(id);if(x)copyText(x[f])}
function qs(){var p=new URLSearchParams();['query','product','status','from','to'].forEach(function(k){var v=document.getElementById(k).value.trim();if(v)p.set(k,v)});return p.toString()}
function setActiveChip(k){var cs=document.querySelectorAll('#chips .chip');for(var i=0;i<cs.length;i++){cs[i].classList.toggle('active',(cs[i].getAttribute('data-k')||'')===(k||''))}}
function populateProducts(products){var sel=document.getElementById('product');var cur=sel.value;var h='<option value="">全部產品</option>';(products||[]).forEach(function(p){h+='<option value="'+esc(p)+'">'+esc(p)+'</option>'});sel.innerHTML=h;sel.value=cur}
function renderChips(s){var cur=document.getElementById('status').value;var h='<button class="chip'+(cur===''?' active':'')+'" data-act="filter" data-k="">全部 <b>'+(s.total||0)+'</b></button>';CHIP_ORDER.forEach(function(k){var n=(s.byStatus&&s.byStatus[k])||0;h+='<button class="chip'+(cur===k?' active':'')+'" data-act="filter" data-k="'+k+'"><span class="dot" style="background:'+STL[k].c+'"></span>'+STL[k].n+' <b>'+n+'</b></button>'});document.getElementById('chips').innerHTML=h}
async function loadStats(){try{var r=await fetch('/admin/api/stats',{headers:{'Accept':'application/json'}});if(!r.ok)return;var s=await r.json();document.getElementById('hdrToday').textContent=s.today||0;document.getElementById('hdrTotal').textContent=s.total||0;populateProducts(s.products);renderChips(s)}catch(e){}}
async function load(){var info=document.getElementById('listinfo');var list=document.getElementById('list');info.textContent='載入中…';try{var r=await fetch('/admin/api/list?'+qs(),{headers:{'Accept':'application/json'}});if(!r.ok){list.innerHTML='<div class="empty">載入失敗（'+r.status+'）</div>';info.textContent='';return}var d=await r.json();ITEMS=d.items||[];info.textContent='符合條件：'+ITEMS.length+' 筆';list.innerHTML=ITEMS.length?ITEMS.map(card).join(''):'<div class="empty">目前沒有符合的申請</div>';setActiveChip(document.getElementById('status').value)}catch(e){list.innerHTML='<div class="empty">載入失敗，請重新整理</div>';info.textContent=''}}
function card(x){
 var st=STL[x.status]||{t:x.status,n:x.status,c:'#9AA0A6'};
 var opts='';
 if(UI_ORDER.indexOf(x.status)<0){opts+='<option value="'+esc(x.status)+'" selected>'+esc(st.t)+'</option>'}
 UI_ORDER.forEach(function(k){opts+='<option value="'+k+'"'+(k===x.status?' selected':'')+'>'+STL[k].t+'</option>'});
 var dial=String(x.phone||'').replace(/[^0-9+]/g,'');
 var h='<div class="card" id="card-'+x.id+'" style="border-left-color:'+st.c+'">';
 h+='<div class="r1"><div class="name">👤 '+(esc(x.name)||'—')+'</div><span class="sbadge" style="color:'+st.c+'">'+esc(st.n)+'</span></div>';
 h+='<div class="phone"><span class="num">📱 '+(esc(x.phone)||'—')+'</span><button class="mini" data-act="copy" data-id="'+x.id+'" data-f="phone">📋 複製</button>'+(dial?'<a class="mini" href="tel:'+dial+'">📞 撥打</a>':'')+'</div>';
 h+='<div class="block">';
 h+='<div class="row"><span class="k">📦</span><span class="v">'+(esc(x.product)||'—')+'</span></div>';
 if(x.location){h+='<div class="row"><span class="k">📍</span><span class="v">'+esc(x.location)+'</span><button class="mini" data-act="copy" data-id="'+x.id+'" data-f="location">📋 複製地址</button></div>'}
 if(x.email){h+='<div class="row"><span class="k">✉️</span><span class="v">'+esc(x.email)+'</span></div>'}
 h+='</div>';
 h+='<div class="meta"><span>🕒 '+esc(fmtTime(x.created_at))+'</span><span>💬 '+(esc(x.source)||'—')+'</span>'+(x.line_display_name?('<span>👥 '+esc(x.line_display_name)+'</span>'):'')+'</div>';
 if(x.line_user_id){h+='<div class="lid">LINE ID：<code>'+esc(shortId(x.line_user_id))+'</code><button class="mini" data-act="copy" data-id="'+x.id+'" data-f="line_user_id">📋 複製 ID</button></div>'}
 h+='<div class="note"><label>📝 客服備註</label><textarea id="note-'+x.id+'" placeholder="例如：已電話聯絡／客戶晚上方便接電話／已於 8/31 寄出">'+esc(x.notes||'')+'</textarea><div class="save"><button class="mini" data-act="note" data-id="'+x.id+'">💾 儲存備註</button></div></div>';
 h+='<div class="statusbar"><label>狀態</label><select class="status" data-act="status" data-id="'+x.id+'">'+opts+'</select></div>';
 h+='</div>';
 return h;
}
async function onStatusChange(id,val){var x=byId(id);var prev=x?x.status:null;try{var r=await fetch('/admin/api/status',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:id,status:val})});if(!r.ok)throw 0;if(x)x.status=val;var cd=document.getElementById('card-'+id);if(cd){cd.style.borderLeftColor=((STL[val]||{}).c)||'#ccc';var sb=cd.querySelector('.sbadge');if(sb){sb.textContent=(STL[val]||{}).n||val;sb.style.color=((STL[val]||{}).c)||'#888'}}var sf=document.getElementById('status').value;if(sf&&sf!==val&&cd){cd.parentNode.removeChild(cd);ITEMS=ITEMS.filter(function(it){return it.id!==id});var info=document.getElementById('listinfo');if(info)info.textContent='符合條件：'+ITEMS.length+' 筆';if(!ITEMS.length){document.getElementById('list').innerHTML='<div class="empty">目前沒有符合的申請</div>'}}loadStats();toast('狀態已更新 ✓')}catch(e){var sel=document.querySelector('select.status[data-id="'+id+'"]');if(sel&&prev!=null)sel.value=prev;toast('更新失敗，請重試')}}
async function saveNote(id){var ta=document.getElementById('note-'+id);if(!ta)return;var v=ta.value;try{var r=await fetch('/admin/api/note',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:id,notes:v})});if(!r.ok)throw 0;var x=byId(id);if(x)x.notes=v;toast('備註已儲存 ✓')}catch(e){toast('儲存失敗，請重試')}}
function filterStatus(k){document.getElementById('status').value=k;load()}
document.addEventListener('click',function(e){var b=e.target.closest?e.target.closest('[data-act]'):null;if(!b)return;var a=b.getAttribute('data-act');if(a==='filter'){filterStatus(b.getAttribute('data-k')||'')}else if(a==='copy'){copyField(parseInt(b.getAttribute('data-id'),10),b.getAttribute('data-f'))}else if(a==='note'){saveNote(parseInt(b.getAttribute('data-id'),10))}else if(a==='go'){load()}else if(a==='clear'){['query','product','status','from','to'].forEach(function(k){document.getElementById(k).value=''});load()}});
document.addEventListener('change',function(e){var s=e.target;if(s&&s.getAttribute&&s.getAttribute('data-act')==='status'){onStatusChange(parseInt(s.getAttribute('data-id'),10),s.value)}});
document.getElementById('query').addEventListener('keydown',function(e){if(e.key==='Enter')load()});
loadStats();load();
</script></body></html>`;
