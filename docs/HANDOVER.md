# 專案交接文件 / Project Handover — 愷樂生醫 cash-bio.com

**For the incoming agent (Codex) and the site owner.**
Written 2026-09-25. Read `AGENTS.md` first for operating rules; this file is the context and history.

---

## 0. TL;DR — current state

| Thing | Status |
|---|---|
| Website `cash-bio.com` (Worker `case-55`) | ✅ Live, deploys from `main` via Cloudflare Git |
| Trial application → D1 database | ✅ Working (real applications are landing) |
| Email notification (Resend) | ⚠️ Wired and believed working — **owner has not confirmed receipt** |
| Admin backend `/admin/trials` | ✅ Live, CRM-style UI (PR #54) |
| 醫師推薦 banners on homepage | ✅ Live (PR #55) |
| LINE bot step-3 "stuck" bug | ⚠️ Fix written and owner says it was pasted/deployed — **end-to-end result never confirmed** |
| LINE bot source code in version control | ❌ **NO — see §1. Biggest risk in this project.** |

---

## 1. 🔴 Highest-priority risk: the LINE bot source is not in git

The LINE Official Account webhook is served by a Cloudflare Worker named **`kaile-line-bot`**,
which is **not in this repository and not in any repository**. It was authored directly in the
Cloudflare dashboard ("Edit code"), and the only copy of its source is **inside that dashboard**.

A working copy previously existed in an agent sandbox; that sandbox has since been recycled and
**the copy is gone**. It is also no longer recoverable from the session transcript (compacted).

**Consequences**
- If that Worker is deleted, corrupted, or overwritten, the LINE trial flow is unrecoverable.
- No agent can review, diff, test, or deploy it.
- Every change requires the owner to hand-paste ~630 KB of code into a browser textarea.

**Recommended first action for whoever takes over**

1. Ask the owner to open Cloudflare → Workers & Pages → **kaile-line-bot** → *Edit code*,
   select all, and save the source to a file.
2. Commit it (e.g. `line-bot/kaile-line-bot.js`) **and add `line-bot/` to `.assetsignore`**
   so it is not publicly served (`assets.directory` is `"."`).
3. Optionally then connect that Worker to Git so it can be deployed by push. This needs a
   one-time Cloudflare setup by the owner **and** the `COUPONS` KV namespace ID, which must be
   declared in its `wrangler` config — otherwise the first Git build will drop the KV binding
   and break session/lead storage.

> Note: the file is large mostly because the rich-menu image is embedded as base64.

---

## 2. System map

### Cloudflare (owner's account)

| Worker | Domain | Source | Bindings |
|---|---|---|---|
| `case-55` | `cash-bio.com` | **this repo** (`worker/index.js` + static assets) | D1 `DB` → `trial-db`; `ASSETS` |
| `kaile-line-bot` | `kaile-line-bot.opopwowo.workers.dev` | dashboard only (§1) | KV `COUPONS` |

- **D1**: database `trial-db`, id `7d1e7789-afb6-4ff0-9b61-0a1d03947ab8`.
  Tables: `trial_applications` (live), `line_sessions` (used only by the dormant webhook).
- **KV `COUPONS`** (bot only): conversation sessions (`sess:<userId>`), leads (`lead:<...>`),
  `notify_owner` (owner's LINE userId for push notifications), `richmenu_version`.

### Third-party

- **LINE Official Account** — Messaging API. Webhook → `kaile-line-bot`.
  The bot also has its own mini admin page at `/admin/leads?key=…` (auth via `ADMIN_KEY` or the
  channel secret) — so leads are stored in KV *as well as* in D1. Nothing was lost during the D1 migration.
- **Resend** — transactional email. Sender is still the shared
  `onboarding@resend.dev` because `cash-bio.com` was **not yet verified** as a Resend domain.
  Verifying it and switching `NOTIFY_FROM` to `no-reply@cash-bio.com` is a pending improvement.
- **GitHub** — `opopwowo/kailebio` (public). Production branch: `main`.

### Secrets — names only; values live in the Cloudflare dashboard

| Worker | Secret / var | Where |
|---|---|---|
| case-55 | `RESEND_API_KEY`, `ADMIN_USER`, `ADMIN_PASSWORD` | dashboard secrets |
| case-55 | `NOTIFY_TO`, `NOTIFY_FROM`, `ADMIN_URL` | plain vars in `wrangler.jsonc` |
| kaile-line-bot | `CHANNEL_ACCESS_TOKEN`, `CHANNEL_SECRET`, `ADMIN_KEY` | dashboard secrets |

⚠️ `keep_vars: true` in `wrangler.jsonc` exists because a deploy once **wiped all three
case-55 secrets** (the deploy command is `wrangler versions upload`). Do not remove it.

---

## 3. Incident log — bugs already solved, and why

Re-solving these would be expensive. Each was a real production issue.

**A. `/admin/trials` returned the site's 404 page.**
Static Assets answered before the Worker. Fixed by adding
`assets.run_worker_first: ["/api/*","/admin","/admin/*"]`.

**B. `/admin/trials` returned `{"ok":false,"error":"admin_not_configured"}` after secrets were set.**
The deploy had wiped the dashboard secrets. Fixed with `keep_vars: true` + re-adding the secrets.

**C. LINE applications never reached the database (admin showed 共 0 筆).**
The bot was posting to `https://case-55.opopwowo.workers.dev/api/trial-apply`; that request did
not succeed from the bot, and the error was swallowed by a `try/catch`. **Fix: post to
`https://cash-bio.com/api/trial-apply`** (the custom domain). Applications have landed since.

**D. A diagnostic build leaked `HTTP 200 {"ok":true,"id":1}` into the customer's LINE chat.**
Removed. Standing rule: customers must never see technical output (see `AGENTS.md` §8).

**E. LINE step 3 (address) froze — no reply at all.**
Root cause: the customer `reply()` was the **last** statement, after an `await`ed cross-post to
cash-bio.com. The whole webhook handler is awaited before returning 200, so if that network call
stalled, `reply()` was never reached. **Fix: reply first, then do all backend work in
`try/catch`**, and use `AbortController` + `setTimeout` for timeouts rather than
`AbortSignal.timeout` (not reliably available in that Worker runtime).
⚠️ The owner pasted this fix but never reported the test result — **confirm it.**

**F. Admin mobile layout overflowed horizontally.**
Two causes: a `flex: 1 1 220px` basis became a huge *height* in the mobile column layout, and a
broad `width: 100%` rule hit the two side-by-side date inputs. Fixed with targeted overrides,
`min-width: 0`, `flex-wrap`, and an `overflow-x: hidden` guard.

**G. New Tailwind classes silently did nothing.**
`assets/css/tailwind.css` is a fixed pre-compiled build. Always grep for a class before using it.

---

## 4. Recent work (this engagement)

- **PR #49–#53** — trial-application system: `/api/trial-apply`, D1 schema, admin page,
  Basic auth, Resend email, `run_worker_first`, `keep_vars`.
- **PR #54** — `/admin/trials` rebuilt as a CRM list: large name/phone, copy + tel: buttons,
  copy-address, shortened LINE ID with copy, hide-empty fields, editable 客服備註
  (new `POST /admin/api/note`), 6 statuses with instant save, clickable stat chips
  (new `GET /admin/api/stats`, "today" in Taiwan time), brand `#8B1025`, mobile-first.
  Email subject standardised to 【愷樂生醫】新的試吃申請通知.
- **PR #55** — homepage `#reviews` became **🩺 醫師推薦 & 體驗分享**: five real dentist
  endorsement banners (`assets/img/doctors/`), 2-up on desktop with the 5th centred, single
  column on mobile; existing user testimonials kept verbatim; food-not-drug disclaimer added.
- **kaile-line-bot** (dashboard, not in git): cross-post to `/api/trial-apply`, background
  LINE display-name lookup, silent operation, and the step-3 reply-first fix.

---

## 5. Open items / suggested next steps

1. **Rescue the bot source into git** (§1). Highest value, lowest effort.
2. **Confirm the step-3 fix** end to end: in LINE send 王小明 / 0912345678 /
   台中市太平區測試路100號 → expect "🎉 收到您的試吃申請！", a new row in `/admin/trials`,
   and an email. Also send `1` as the address → expect the "請輸入完整收件地址" prompt, not a freeze.
3. **Confirm Resend delivery** to `lawrenceyu911@gmail.com`; then verify the `cash-bio.com`
   domain in Resend and switch `NOTIFY_FROM` to `no-reply@cash-bio.com`.
4. **Decide the fate of `/api/line-webhook`** in `worker/index.js` — it is dead code (a second
   bot the owner did not want). Removing it would shrink the Worker and remove confusion; it is
   currently harmless.
5. `/admin/api/list` caps at **500 rows** and the admin has no pagination. Fine now; revisit as
   applications grow.
6. Consider a lightweight visual-regression check — there is no test suite of any kind.

---

## 6. Working with this owner

- Communicates in **Traditional Chinese**; prefers short, concrete answers and screenshots of results.
- **Strongly prefers not to touch code, deploy steps, or dashboards.** Expects the agent to make
  and ship changes end to end. Where that is genuinely impossible (the LINE bot, §1/§6 of
  `AGENTS.md`), say so plainly **and state exactly which one-time permission would remove the
  blocker** — don't hand back a tutorial.
- Has been burned by scope creep: **do only what was asked.** Do not redesign the LINE
  questionnaire, rebuild the bot, or "improve" copy that wasn't mentioned.
- Verify before asserting. When something can't be verified from the sandbox (production is
  unreachable), say which specific checks the owner needs to run.
