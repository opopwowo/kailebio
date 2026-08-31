# 試吃申請系統｜上線設定步驟（愷樂生醫）

這份文件是「把試吃申請存進資料庫＋後台查看＋Email 通知」上線前，**你要在自己的 Cloudflare / Resend / LINE 帳號**做的設定。
程式碼我已寫好並在本機測過（寫入資料庫、後台搜尋/篩選/改狀態、權限保護、防機器人都正常）。
下面每一步都很短，照著做即可；卡住就把畫面截圖給我。

> 為什麼要你做：資料庫、密鑰、Email 網域、LINE LIFF 都在**你的帳號**裡，我沒有你的登入權限，不能代做。

---

## 已完成（在程式碼裡，尚未啟用）
- `worker/index.js`：API `POST /api/trial-apply` + 後台 `/admin/trials`（含搜尋/篩選/改狀態/Basic 密碼保護/noindex）+ Email 通知（防重複 `email_notified`）。
- `db/schema.sql`：資料表 `trial_applications`（姓名/電話/Email/地區/產品/備註/狀態/來源＋**LINE 名稱與 LINE User ID 分開存**）。
- `apply.html`：申請表單（在 LINE 內開啟＝LIFF，可抓 LINE 名稱/ID；一般瀏覽器開＝普通表單）。
- `robots.txt` / `.assetsignore`：後台與程式碼不被搜尋引擎索引、不對外公開。

> 目前**線上網站與 LINE 流程完全沒被改動**（`wrangler.jsonc` 仍是純靜態）。啟用要做完下面 4 步。

---

## 步驟 1｜建立 Cloudflare D1 資料庫
1. 登入 Cloudflare → 左側 **Workers & Pages** → **D1 SQL Database** → **Create**。
2. 名稱填 `trial-db` → 建立。
3. 複製它的 **Database ID**（像 `xxxxxxxx-xxxx-...`）。
4. 建立資料表：在該 D1 的 **Console** 貼上 `db/schema.sql` 的內容並執行；
   （或用指令：`npx wrangler d1 execute trial-db --remote --file db/schema.sql`）

## 步驟 2｜申請 Email 服務（Resend，最省事）
1. 到 **resend.com** 用 **lawrenceyu911@gmail.com** 註冊（用這個信箱，未驗證網域前也能寄信到自己這個信箱測試）。
2. **API Keys** → 建一把 → 複製 `re_....`（等一下設成 secret，**不要貼進程式碼／GitHub**）。
3. （之後要美化寄件人）Domains → 加入 `cash-bio.com` → 依指示到網域 DNS 加幾筆記錄；驗證後就能用 `no-reply@cash-bio.com` 當寄件人。未驗證前先用預設 `onboarding@resend.dev`。

## 步驟 3｜在 Worker 設定 Secrets / 變數
到 Cloudflare → 你的 Worker 專案（`case-55`）→ **Settings → Variables and Secrets**，新增：

| 名稱 | 類型 | 值 |
|---|---|---|
| `RESEND_API_KEY` | Secret | 剛剛的 `re_...` |
| `ADMIN_USER` | Secret | 後台帳號（自訂，例 `kaile`） |
| `ADMIN_PASSWORD` | Secret | 後台密碼（設**長一點**的強密碼） |
| `NOTIFY_TO` | 變數 | `lawrenceyu911@gmail.com` |
| `NOTIFY_FROM` | 變數 | 先填 `onboarding@resend.dev`（驗證網域後改 `no-reply@cash-bio.com`） |
| `ADMIN_URL` | 變數 | `https://cash-bio.com/admin/trials` |

## 步驟 4｜啟用 Worker（把 `wrangler.jsonc` 換成下面內容）
把 `<步驟1的 Database ID>` 換成你的真實 ID，再讓我把它合併上線：

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "case-55",
  "compatibility_date": "2026-06-26",
  "observability": { "enabled": true },
  "main": "worker/index.js",
  "assets": {
    "directory": ".",
    "binding": "ASSETS",
    "not_found_handling": "404-page"
  },
  "d1_databases": [
    { "binding": "DB", "database_name": "trial-db", "database_id": "<步驟1的 Database ID>" }
  ],
  "compatibility_flags": ["nodejs_compat"]
}
```

> 完成步驟 1–3 後告訴我 Database ID，我幫你改好 `wrangler.jsonc` 並合併到 `main` 上線。
> 上線後：**測試 email** 可先在 Resend 後台用「Send test」寄到 lawrenceyu911@gmail.com；或直接送一筆真實申請。

---

## 步驟 5｜（要抓 LINE 身分才需要）建立 LINE LIFF，把「點我試吃」改開表單
> 這一步會**改變**你目前的 LINE 試吃流程（把步驟訊息表單改成 LIFF 網頁表單），所以**先確認再做**。不做也行——不做的話，LINE 申請仍留在 LINE 聊天室，新表單只服務網站訪客。

1. 到 **developers.line.biz** → 你的 Provider → 建（或用現有）**LINE Login** channel → **LIFF** 分頁 → **Add**。
2. Endpoint URL 填 `https://cash-bio.com/apply`；Size 選 `Full`；Scope 勾 `profile`、`openid`。
3. 複製 **LIFF ID**（像 `2000000000-xxxxxxxx`），把 `apply.html` 裡的 `REPLACE_WITH_LIFF_ID` 換成它（告訴我，我幫你換並上線）。
4. （選用，更防偽）把該 channel 的 **Channel ID** 設成 Worker 變數 `LINE_LIFF_CHANNEL_ID`，系統會在後端驗證 LINE 身分。
5. 到 LINE 官方帳號後台，把「🎁 點我試吃」的動作改成**開啟這個 LIFF 網址**（可帶產品：`.../apply?product=GABA鈣鎂晶凍`）。

---

## 你之後要去哪裡看申請名單？
- 後台網址：**https://cash-bio.com/admin/trials**
- 進去時瀏覽器會跳出帳號/密碼輸入框 → 填你在步驟 3 設的 `ADMIN_USER` / `ADMIN_PASSWORD`。
- 功能：所有申請（**最新在最上面**）、搜尋姓名/電話、篩選產品/狀態/日期、改狀態（🟡新申請→🔵已聯絡→🟢已完成／⚪無效）。

## 現在（還沒上線前）就能看申請人的方法
你之前那幾筆申請都在 **LINE 官方帳號後台 → 聊天** 裡（每個人回答的姓名/電話就是聊天訊息）。
開新申請通知：LINE 官方帳號 App → 設定 → 通知（開新訊息推播）；或在 manager.line.biz 設定通知信箱。
