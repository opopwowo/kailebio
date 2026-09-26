# AGENTS.md — 愷樂生醫 / cash-bio.com

Operating guide for AI agents working on this repo. Read this **before** touching anything.

---

## 1. What this project is

A Traditional-Chinese (zh-Hant) marketing site for **愷樂生醫 (Cash Biomedical)**, a Taiwanese
health-food brand (jelly-format supplements: 樂暢適 PLUS / GABA鈣鎂晶凍 / 左旋麩醯胺酸晶凍),
plus a trial-application (試吃申請) pipeline and an internal admin backend.

- **147 HTML pages** (count with `git ls-files "*.html"`). **No build step, no package.json.** Plain HTML +
  a pre-compiled Tailwind CSS file. Edit HTML directly.
- One Cloudflare Worker (`worker/index.js`) adds the API + admin on top of the
  static site.

---

## 2. ⚠️ THE MOST IMPORTANT THING: there are TWO separate Cloudflare Workers

Almost every past mistake came from conflating these. They are **different deployments**.

| | **case-55** | **kaile-line-bot** |
|---|---|---|
| Serves | `cash-bio.com` (the website) | The LINE Official Account webhook |
| Source in this repo? | ✅ Yes — `worker/index.js` | ✅ Backup only — `line-bot/kaile-line-bot.js` |
| How to deploy | Merge to `main` → Cloudflare auto-deploys | Cloudflare dashboard → *Edit code* → Deploy |
| Can an agent deploy it? | ✅ Yes (via git) | ✅ Through an owner-signed-in Cloudflare dashboard session; Git alone does not deploy it |

**`/api/line-webhook` in `worker/index.js` is DORMANT.** It is a second, unused conversational
bot. The live LINE Official Account webhook points at **kaile-line-bot**, *not* at this Worker.
Do not "fix" the LINE flow by editing `/api/line-webhook` — it changes nothing for customers.

---

## 3. Deployment (how code actually goes live)

```
feature branch → PR → merge to `main` → Cloudflare Git integration auto-deploys case-55
```

- **Pushing to a feature branch does NOT deploy anything.** Production is `main` only.
  (Confirmed: the admin redesign sat unpublished on a branch until PR #54 was merged.)
- There is **no CI** in this repo (no `.github/workflows`). Cloudflare builds on push to `main`.
- After merging, allow ~1–3 min, then hard-refresh. If it's still stale, the Worker version may
  need promoting to 100% in Cloudflare → *Deployments*.

---

## 4. Config you must not break

`wrangler.jsonc` (Worker name `case-55`):

- **`"run_worker_first": ["/api/*", "/admin", "/admin/*"]`** — without this, Static Assets answers
  first and `/admin/trials` returns the site's 404 page. Do not remove.
- **`"keep_vars": true`** — the deploy command is `wrangler versions upload`, which otherwise
  **wipes dashboard-set secrets**. This already happened once. Do not remove.
- `"assets": { "directory": "." }` — **the whole repo is publicly served.** Anything you add is
  reachable at `https://cash-bio.com/<path>` unless it is listed in **`.assetsignore`**.
  Currently ignored: `worker/`, `db/`, `docs/`, `TRIAL-SETUP.md`, `AGENTS.md`, `*.sql`, `line-bot/`.
- D1 binding `DB` → database `trial-db`.

**Secrets live in the Cloudflare dashboard, never in git:**
`RESEND_API_KEY`, `ADMIN_USER`, `ADMIN_PASSWORD`.
Plain vars in `wrangler.jsonc`: `NOTIFY_TO`, `NOTIFY_FROM`, `ADMIN_URL`.

---

## 5. The trial-application pipeline (end to end)

```
Customer in LINE chat
  → kaile-line-bot  (Q1 姓名 → Q2 電話 → Q3 收件地址)
  → on success: reply "🎉 收到您的試吃申請！" FIRST, then in background:
      POST https://cash-bio.com/api/trial-apply
  → case-55 handleApply(): INSERT into D1 `trial_applications`
      + Resend email → lawrenceyu911@gmail.com
  → visible at https://cash-bio.com/admin/trials  (Basic auth)
```

Two hard-won rules in that flow:

1. **Post to `https://cash-bio.com`, NOT `case-55.opopwowo.workers.dev`.** The workers.dev URL
   did not work from the bot; the custom domain does.
2. **Reply to the customer FIRST, then do backend work.** The bot's webhook handler is fully
   `await`ed before returning 200, so a slow/hanging cross-post meant `reply()` was never
   reached → the customer got *no response at all* and the flow appeared frozen. That was a
   real production bug at the address step. Never put a network call before the reply.

### Worker routes (`worker/index.js`)

| Route | Method | Auth | Purpose |
|---|---|---|---|
| `/api/trial-apply` | POST | public | Accept application → D1 → email |
| `/api/line-webhook` | POST | signature | **DORMANT** — not the live bot |
| `/admin`, `/admin/trials` | GET | Basic | Admin UI (CRM-style list) |
| `/admin/api/list` | GET | Basic | Search / filter / pagination (50 per page) |
| `/admin/api/status` | POST | Basic | Change status |
| `/admin/api/note` | POST | Basic | Save 客服備註 |
| `/admin/api/stats` | GET | Basic | Totals, today (Taiwan tz), per-status, product list |

### Data model — `db/schema.sql`

`trial_applications`: `id, created_at, updated_at, line_user_id, line_display_name, name,
phone, email, location, product, notes, source, status, email_notified` (+3 indexes).

- `name` and `phone` are **required**; everything else optional.
- `location` holds the **full shipping address** (label in the UI is 收件地址).
- `status` is free TEXT, validated in code against
  `new / contacted / processing / shipped / done / cancelled` (+ legacy `invalid`).
  **Adding a status needs no migration** — just update `STATUSES` and the client `STL` map.
- `created_at` is stored in **UTC**; the UI converts to `Asia/Taipei` for display, and
  date filters convert Taiwan calendar boundaries to UTC;
  `adminStats` computes "today" with `date(created_at,'+8 hours')`.

`line_sessions` exists only for the dormant webhook.

---

## 6. Deployment and live-verification limits

- **`kaile-line-bot` is not Git-deployed.** There is no Cloudflare API token in the environment,
  and outbound access to `api.cloudflare.com` is blocked by the proxy. With the owner's logged-in
  Cloudflare dashboard session and deployment authorization, an agent deployed the backup through
  *Edit code → Deploy* on 2026-09-26 (version `12592454`, 100% traffic). The bot is still not
  connected to a Git repo. To enable Git deployment, the owner must connect it and configure the
  correct `COUPONS` KV namespace ID; never reuse the website Worker configuration.
- **Cannot reach the live site from the sandbox.** `cash-bio.com` and `*.workers.dev` are
  blocked by the proxy (403 on CONNECT). You cannot curl-test production or read Worker logs.
  Verify by reading code + rendering locally; ask the owner for the live check.

---

## 7. Front-end gotchas

- **`assets/css/tailwind.css` is a pre-compiled, fixed build.** Many utility classes are simply
  **not in it**. Verified missing: `grid-cols-1`, `md:col-span-2`, `md:w-1/2`, `md:mx-auto`,
  `m-0`, `h-auto`. **Always check before using a new class:**
  ```bash
  grep -q '\.md\\:col-span-2[{:, ]' assets/css/tailwind.css && echo OK || echo MISSING
  ```
  If missing, add a scoped rule to `assets/css/style.css` instead (see `.doc-gallery`).
- **`ADMIN_HTML` in `worker/index.js` is a backtick template literal** containing the admin
  page's own `<script>`. Inside it you must avoid **backticks**, **`${`**, and **backslashes** —
  a regex like `/^\s+/` silently becomes `/^s+/`. The client JS there deliberately uses
  string concatenation, `data-act` event delegation, and backslash-free regexes. Keep it that way.
- Mobile: every flex row must `flex-wrap` or carry `min-width: 0`, or content overflows.
  There is a hard `overflow-x: hidden` guard on `html, body` in the admin page.
- The site has a strict **CSP** in `_headers` (`script-src 'self' 'unsafe-inline'`). External
  scripts will be blocked. Fonts are allowed only from `fonts.googleapis.com` / `fonts.gstatic.com`.

---

## 8. Content & compliance rules (from the site owner — treat as hard constraints)

These are the owner's own standing instructions. Violating them has real legal risk in Taiwan
(食品安全衛生管理法 — health-food advertising).

- ❌ **No medical-efficacy claims.** It is a **food (食品), not a drug (藥品)**, and cannot replace
  medical treatment. Keep the existing disclaimers.
- ❌ **Never fabricate** company facts, certifications, patents, studies, reviews, ratings,
  stock or promotions. Use only real, owner-supplied material.
- ❌ **Don't keyword-stuff.** SEO must serve the reader.
- ✅ Doctor-recommendation banners (`assets/img/doctors/`) are **real, owner-supplied** endorsements
  from named dentists and carry their own on-image disclaimers
  ("＊請遵循醫囑飲食" / "＊此為個人意見，非醫療建議"). Keep those visible; don't crop them out.
- ✅ User testimonials must stay labelled as personal experience ("實際感受因人而異").

### LINE-specific rules (the owner has been emphatic about these)

- ❌ **Do not change** the LINE questionnaire's wording, emoji, step order, or the
  姓名 → 電話 → 地址 flow. Do not convert it to LIFF. Do not make the customer leave LINE.
- ❌ **Never send technical output to a customer** — no HTTP status codes, no JSON, no
  `{"ok":true}`, no debug text. All DB/email work is background-only; failures log to the
  Worker console and are invisible to the customer. (A temporary diagnostic that echoed
  `HTTP 200 {"ok":true,"id":1}` into the chat was a real incident.)

---

## 9. Useful commands

```bash
# syntax-check the Worker (no build step exists)
node --check worker/index.js

# is a Tailwind class actually compiled in?
grep -q '\.CLASS[{:, ]' assets/css/tailwind.css && echo OK || echo MISSING

# render a page/section headlessly to verify layout (Chromium is preinstalled)
/opt/pw-browsers/chromium-*/chrome-linux/chrome --headless=new --no-sandbox \
  --hide-scrollbars --virtual-time-budget=5000 --window-size=1200,1400 \
  --screenshot=out.png "file:///home/user/kailebio/index.html"
```

---

Run regression checks with Node.js 22.13+ / 24: `node docs/check-trials.mjs` (in-memory SQLite; no live services).

## 10. Before you finish

1. `node --check worker/index.js` passes.
2. New CSS classes verified present in the compiled Tailwind (or scoped CSS added).
3. Layout rendered and eyeballed at desktop **and** ~390px mobile (no horizontal scroll).
4. Nothing new is publicly exposed — check `.assetsignore`.
5. Merged to **`main`**, or the change is not live.
6. State plainly what you could **not** verify (you cannot reach production).
