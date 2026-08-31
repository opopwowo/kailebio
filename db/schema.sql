-- 愷樂生醫｜試吃申請資料表（Cloudflare D1 / SQLite）
-- 建立方式見 TRIAL-SETUP.md
CREATE TABLE IF NOT EXISTS trial_applications (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at        TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT    NOT NULL DEFAULT (datetime('now')),
  -- LINE 身分（與姓名/電話分開存，避免混在一起）
  line_user_id      TEXT,
  line_display_name TEXT,
  -- 申請人填寫
  name              TEXT    NOT NULL,
  phone             TEXT    NOT NULL,
  email             TEXT,
  location          TEXT,
  product           TEXT,
  notes             TEXT,
  -- 系統欄位
  source            TEXT    NOT NULL DEFAULT 'LINE',   -- 申請來源：LINE / 網站 / 其他
  status            TEXT    NOT NULL DEFAULT 'new',     -- new｜contacted｜done｜invalid
  email_notified    INTEGER NOT NULL DEFAULT 0          -- 0=尚未寄通知，1=已寄（防重複）
);

CREATE INDEX IF NOT EXISTS idx_trial_created ON trial_applications(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_trial_status  ON trial_applications(status);
CREATE INDEX IF NOT EXISTS idx_trial_product ON trial_applications(product);
