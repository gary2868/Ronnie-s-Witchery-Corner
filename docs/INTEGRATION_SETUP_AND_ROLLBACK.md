# 整合功能：上線步驟、驗證與回退計畫

適用：Render（網站）＋ Supabase（資料庫）＋ Cloudflare Worker（排程／整合）＋ Google 日曆 ＋ LINE 官方帳號 ＋ Google Drive

> **一句話版本**：所有新功能都有開關，預設全部關閉；每一項都先用 `dry`（只記錄、不對外）試跑，再改 `on`；任何一項出問題，把開關改回 `off` 即可（約 1 分鐘，不需重新部署）。

---

## 1. 這次做了什麼

| 項目 | 位置 | 說明 |
|---|---|---|
| Render 端：補齊事件 | `server.js` | 後台「取消」「恢復預約」「公休新增／刪除」也會通知 Worker。**受 `INTEGRATION_ADMIN_EVENTS` 控制，預設關閉**，未設定時與舊版行為完全相同。事件失敗只記警告，不影響後台操作。 |
| Cloudflare Worker | `worker/index.js` | LINE 通知管理者、前一天 17:00 提醒客人、LINE 綁定、Google 日曆同步（預約＋公休）、Google Drive 定時備份。 |
| 測試 | `tests/` | 119 項自動測試（含「真實 server.js ＋ Worker」整合測試）＋ 76 項突變測試。一鍵執行：`sh tests/run-all.sh`。 |
| 上線前檢查工具 | `worker/preflight.mjs` | 檢查**你真實的** Supabase 資料表欄位、狀態值、唯一約束（見 §4.1）。 |
| 回退素材 | `rollback/`、git tag `baseline-pre-integration` | 改動前的 `server.js`、`admin.html` 備份與 git 基準點。 |

**沒有更動任何資料表結構。** Worker 只使用既有欄位與 `app_state` 通用表（見 §6）。

### 資料流

```
客人預約/修改/取消 ─┐
後台取消/恢復/公休 ─┴→ Render(server.js) ─→ Supabase.integration_jobs ─→ POST /wake ─→ Cloudflare Worker
                                                                                       │
        每 5 分鐘 cron ────────────────────────────────────────────────────────────────┤
        每日 03:00(台北) cron ───→ 備份                                                  │
                                                                                       ├─→ LINE：通知你 / 提醒客人
                                                                                       ├─→ Google 日曆：預約＋公休（單向：網站 → 日曆）
                                                                                       └─→ Google Drive：備份檔
客人把 6 碼綁定碼傳給官方帳號 ─→ Worker /line/webhook ─→ Supabase.app_state（line_bind:電話）
```

---

## 2. 測試結果

| 套件 | 項目數 | 結果 |
|---|---|---|
| Worker 單元測試（`tests/worker/worker.test.mjs`） | 108 | 全過 |
| 整合測試：真實 `server.js` ＋ Worker（`integration.test.mjs`） | 11 | 全過 |
| 原有單元測試（`sync-dataset-isolated.test.cjs`） | 7 | 全過 |
| 突變測試（`tests/mutation-check.py`，故意改壞 76 處） | 76 | **76/76 被測試抓到** |
| 既有回歸：後台介面、手機版（3 種螢幕）、Supabase 模式、恢復預約 | 先前全部套件 | 旗標關閉／開啟兩種狀態皆全過 |

> 以上數字是**我在自己的環境（Node 22、單核心）實際執行**的結果，不是沿用舊紀錄。你的環境請自行重跑，指令見下。

**重現指令**（Node 18+；建議 20+）：
```bash
sh tests/run-all.sh               # 約 5~10 秒：原有單元 + Worker 單元/整合；會印出 Node/CPU 版本與明確結束碼
sh tests/run-all.sh --mutation    # 另外跑突變測試（76 項）：單核心機器約 20 分鐘（建議用 --only 分批）
python3 tests/mutation-check.py --only M1,N2   # 只跑指定突變
```
> ⚠️ **逾時注意**：突變測試會逐項複製專案並重跑整組測試，單核心機器要約 20 分鐘。若你用有逾時限制的工具（例如 60～120 秒）執行，請分開跑 `run-all.sh` 與突變測試，或用 `--only`。測試結束碼：0 通過、1 失敗、124 逾時。

**曾經發生的問題（已修）**：測試輔助程式的 `stop()` 在伺服器子行程「已提前結束」（例如埠被占用、設定錯誤）時，會永遠等不到結束事件，造成整組測試卡住直到逾時。現在改為：偵測提前結束 → 立即失敗並附上伺服器啟動日誌；`stop()` 可重複呼叫；測試使用系統配置的空閒埠；測試結束時一併關閉閒置連線。另有自動測試把關。

涵蓋的重點情境：17:00:00 才送、16:59:59 不送（以 UTC 驗證）；取消／改期後不送舊提醒；LINE 失敗重試且不重複送（含「已送出但來不及更新 job」的當機情境）；LINE Webhook 暫時性故障回 500 讓 LINE 重送、綁定碼不會遺失、重送不會重複綁定；綁定碼原子領取與猜碼限制；Google 429／403／授權失效；日曆重複執行不產生重複事件、不動你自己的行程；備份檔可直接用後台「匯入」還原（整合測試有實際還原演練）；Worker 或外部服務全部故障時，網站預約與後台操作照常成功。

### ⚠️ 我在沙盒裡「無法」驗證的事（請在上線階段逐項確認）

測試用的是**模擬的** Supabase／LINE／Google，驗證的是邏輯，不代表真實服務已測通：

1. **真實的 LINE、Google、Cloudflare 帳號與金鑰**：OAuth、Webhook 簽章設定、cron 實際觸發，都要靠 §5 的 `dry` → `on` 階段實測。
2. **你的 Supabase 實際資料表限制**：倉庫裡沒有 SQL，我無法存取你的資料庫，**這項尚未核實**。請先執行 §4.1 的 `preflight.mjs`（含唯讀模式），確認欄位齊全、`integration_jobs.status` 接受 `pending / done / failed`、`dedupe_key` 有唯一約束。
3. **你現有的 Cloudflare Worker**：文件提到 Render 已預留 `/backup-now`，但倉庫裡沒有 Worker 程式，我無法得知現有版本內容。新 Worker 沿用同一組介面（`/wake`、`/backup-now`、`X-Worker-Secret`），建議**用新名稱部署**，避免覆蓋舊的。
4. **Cloudflare 免費方案限制**（每次執行最多 50 個對外請求）：已用批次上限因應（見 §7），但實際表現請觀察 `/status`。

---

## 3. 事前準備

### 3.1 Git 與備份（回退的基礎）
```bash
git tag baseline-pre-integration     # 已建立；若你用自己的倉庫，請在合併前先打這個 tag
```
合併前，先在 Supabase 做一次**手動備份**（後台「一鍵匯出後台資料」下載 JSON，另存一份）。

### 3.2 LINE 官方帳號（Messaging API）
1. LINE Developers → 你的 Messaging API channel：取得 **Channel secret**、發行 **Channel access token（long-lived）**。
2. **Webhook URL**：`https://<你的worker網域>/line/webhook`，啟用「Use webhook」。
3. 在 Messaging API 分頁開啟 **「Webhook redelivery（重送）」**。Worker 遇到暫時性故障（資料庫／LINE 暫時不通）會回 500，LINE 才會重送該事件；沒開的話，這類事件不會重送（使用者仍會收到「系統忙碌，請稍後再傳一次」的訊息，可自行重傳）。
4. LINE Official Account Manager → 回應設定：**關閉**「自動回應訊息」與「加入好友的歡迎訊息」（否則會和 Worker 的回覆重複）。
5. 取得**你自己**的 userId：用個人 LINE 加官方帳號好友 → 傳 `ID` → 機器人回覆你的 userId（需 `FEATURE_LINE_BINDING=on`）。把它設成 `ADMIN_LINE_USER_ID`。
6. **用量**：每則通知／提醒都算一則推播（含傳給你的）。免費方案每月有則數上限，請到 Official Account Manager 確認你的額度。綁定時的回覆使用 reply，不計推播；僅在 reply 失敗時才改用 push 補送結果。

### 3.3 Google（日曆＋Drive，使用你自己的帳號授權）
1. Google Cloud Console 建立專案 → 啟用 **Google Calendar API**、**Google Drive API**。
2. OAuth 同意畫面 → 建立 OAuth 用戶端（類型：網頁應用程式），重新導向 URI 加入 `https://developers.google.com/oauthplayground`。
3. ⚠️ **同意畫面要「發布到正式版」**。（Google 規定：測試中的授權 7 天失效；6 個月沒使用也會失效；同一個 client 的授權數量有上限，超過時最舊的會被悄悄作廢——所以請**不要反覆重新產生授權**，產生一次、妥善保存。）若停留在「測試中」，refresh token 約 7 天就會失效，備份與日曆會突然中斷。（個人使用無須送審，畫面會出現「未驗證」警告，屬正常。）
4. 用 OAuth Playground（右上齒輪勾「Use your own OAuth credentials」）取得 **refresh token**，範圍：
   - `https://www.googleapis.com/auth/calendar.events`
   - `https://www.googleapis.com/auth/drive`
   > 備份寫入「你手動建立的資料夾」，我無法確認較小權限的 `drive.file` 是否允許，所以採 `drive`。若你想要最小權限，需改成由程式自動建立資料夾（本版未實作）。
5. **強烈建議：為網站新建一個專用日曆**（Google 日曆 → 建立新日曆），把它的「日曆 ID」設為 `GOOGLE_CALENDAR_ID`。這樣就算要回退，也不會碰到你的主日曆。
6. Drive 建一個專用資料夾，網址最後那段是 `GOOGLE_DRIVE_FOLDER_ID`。**備份檔含客人個資，請勿共用此資料夾。**

### 3.4 部署 Worker
```bash
cd worker
npx wrangler deploy                  # 用新名稱 ronnie-integration-worker，不覆蓋舊 Worker
# 機密（逐一執行並貼上值）：
npx wrangler secret put INTEGRATION_WORKER_SECRET     # 與 Render 的同名變數「必須相同」，請用長隨機字串
npx wrangler secret put RENDER_BASE_URL               # 例如 https://ronnie-s-witchery-corner.onrender.com
npx wrangler secret put SUPABASE_URL
npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY
npx wrangler secret put LINE_CHANNEL_ACCESS_TOKEN
npx wrangler secret put LINE_CHANNEL_SECRET
npx wrangler secret put ADMIN_LINE_USER_ID
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler secret put GOOGLE_REFRESH_TOKEN
npx wrangler secret put GOOGLE_CALENDAR_ID
npx wrangler secret put GOOGLE_DRIVE_FOLDER_ID
```
（選用的非機密調整項：`BACKUP_UPLOAD_MODE`、`BACKUP_STREAM_MAX_BYTES`、`BACKUP_MAX_BYTES`、`BACKUP_UPLOAD_TIMEOUT_MS`、`WEBHOOK_DEADLINE_MS`、`SUBREQUEST_BUDGET`、`FETCH_TIMEOUT_MS`，放在 `wrangler.toml` 的 `[vars]`，預設值即可。）
`wrangler.toml` 已設定兩個排程（UTC）：`*/5 * * * *`（每 5 分鐘）與 `0 19 * * *`（每日台北 03:00 備份），並把所有 `FEATURE_*` 預設為 `off`。

### 3.5 Render 環境變數
| 變數 | 值 | 說明 |
|---|---|---|
| `INTEGRATION_WORKER_URL` | `https://<worker網域>` | 既有變數 |
| `INTEGRATION_WORKER_SECRET` | 與 Worker 相同 | 既有變數 |
| `INTEGRATION_ADMIN_EVENTS` | `on` | **新增，階段 2 才開**；移除即回退 |

---

## 3.6 Windows（Git Bash / MSYS2）注意事項
- `python3 was` 之類的輸出代表**沒有安裝 Python**（Windows 商店的假捷徑）。只有突變測試需要 Python；其餘測試與 Worker 部署都不需要。
- 在 Git Bash 設定環境變數的寫法：`SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node worker/preflight.mjs`（同一行、變數在指令前）。若用 PowerShell 則是 `$env:SUPABASE_URL="..."; node worker/preflight.mjs`。
- 請在**專案資料夾內**執行（`worker/preflight.mjs` 就在專案裡，不需要另外複製）。`sh tests/run-all.sh` 不接受額外參數（只有 `--mutation`）。
- Node 版本：Node 23 以上的測試輸出格式與舊版不同，`run-all.sh` 已兩種都支援。
- ⚠️ `server.js` 若沒有設定 `ADMIN_PASSWORD` 環境變數，後台預設密碼是 `5144`。請確認 Render 上已設定自己的強密碼。

**PowerShell 5.1 常用指令**（Windows 內建的 PowerShell；`curl` 在其中是 `Invoke-WebRequest` 的別名，請用 `curl.exe` 或下列寫法）。把整段包在 `& { … }` 裡一次貼上，避免 `try/finally` 被拆成多段而出現「無法辨識 finally」：
```powershell
& {
  $S = Read-Host "INTEGRATION_WORKER_SECRET（輸入會隱藏）" -AsSecureString
  $B = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($S)
  try {
    $Secret = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($B)
    $r = Invoke-RestMethod -Uri "https://<worker網域>/status" -Headers @{ "X-Worker-Secret" = $Secret }
    $r | ConvertTo-Json -Depth 8
  } catch { "檢查失敗：$($_.Exception.Message)" }
  finally { $Secret = $null; if ($B -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($B) } }
}
```
（`Invoke-WebRequest` 在 5.1 沒有 `-SkipHttpErrorCheck` 參數。）

## 4. 上線前檢查

### 4.1 Supabase 資料表檢查（上線前必做；**請用最新版重跑 `--write-test`**）

```bash
# 唯讀：只做 SELECT，檢查各資料表欄位是否存在。⚠️ 它「不會」驗證約束與寫入行為，這些會顯示為 ⏭️ 略過。
SUPABASE_URL=https://xxxx.supabase.co SUPABASE_SERVICE_ROLE_KEY=... node worker/preflight.mjs

# 完整驗證：加上 --write-test（會對 3 張表各新增並「立即刪除」帶 preflight 標記的測試列）
SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node worker/preflight.mjs --write-test
```
每項結果分為 ✅ 通過、❌ 失敗、⏭️ 略過（尚未驗證）。**結束碼：0 = 全部執行且通過；1 = 有失敗；2 = 無失敗但有略過（驗證不完整，不可視為通過）。** 唯讀模式一定是 2。

`--write-test` 驗證的項目：
- `integration_jobs`：可新增；`status` 可設為 `pending / done / failed`；`dedupe_key` 具唯一約束；`on_conflict + ignore-duplicates` 可用。
- `line_bind_tokens`（**綁定流程依賴**）：可新增；`code` 具唯一約束；`on_conflict=code` 可用（綁定失敗還原綁定碼時用到）；**原子領取查詢**（`DELETE … RETURNING`）能正確處理「已過期不領取」「有效只領 1 次」「重複領取為 0」。
- `app_state`：`key` 具唯一約束；upsert 與 JSON 欄位篩選（`value->>…`）可用。

**清理保證**：所有測試資料都在 `finally` 統一清除，且逐項重新查詢驗證確實已刪除（即使中途某步出錯或丟出例外）。若清除失敗，會列出殘留資料的識別資訊（例如 `integration_jobs dedupe_key=preflight:…`），請照它手動刪除。

> ⚠️ **只執行過舊版 `--write-test` 的人請重跑**：舊版沒有驗證 `line_bind_tokens.code` 的唯一約束與原子領取查詢。**在最新版 `--write-test` 全部 ✅ 之前，不要進行階段 3（客人綁定與提醒）。**

**REST API 讀不到索引資訊**，所以唯一約束只能用寫入測試做「行為驗證」。你也可以在 Supabase SQL Editor 執行這段**唯讀** SQL 人工確認 `dedupe_key`、`code`、`key` 是否具唯一索引：
```sql
select tablename, indexname, indexdef from pg_indexes
 where schemaname = 'public' and tablename in ('integration_jobs','line_bind_tokens','app_state') order by 1, 2;
select conrelid::regclass as tbl, conname, contype, pg_get_constraintdef(oid) as definition
  from pg_constraint
 where conrelid in ('public.integration_jobs'::regclass, 'public.line_bind_tokens'::regclass, 'public.app_state'::regclass);
```
**請不要為了讓它通過而直接修改正式資料表或刪除既有約束**，把 ❌ 項目貼給我評估。我在模擬環境測過「缺欄位、status 不接受 failed、dedupe_key／code 無唯一約束、DELETE 不回傳被刪列、清理失敗」都能被抓出，但**尚未對你的真實資料庫執行過最新版**。

### 4.2 部署後確認（不啟用任何功能）
```bash
curl https://<worker網域>/health                                  # {"ok":true}
curl -H "X-Worker-Secret: <密鑰>" https://<worker網域>/status      # 應顯示五項 FEATURE 皆為 off；啟用某功能後，若缺少必要設定，missingConfig 會列出『變數名稱』（不含值）
```

---

## 5. 分階段上線（每一階段都有驗證與回退）

> 每階段建議觀察 1–3 天。
>
> **如何切換開關（兩種方式，擇一並固定使用，避免互相覆蓋）**
> - **推薦：改 `worker/wrangler.toml` 的 `[vars]` → `npx wrangler deploy`**（約 10 秒）。優點：開關狀態有版本紀錄，可用 git 回退。
> - 或在 Cloudflare 儀表板改（Workers → 你的 Worker → Settings → Variables），即時生效。⚠️ 但之後只要再執行 `npx wrangler deploy`，**`wrangler.toml` 的值會覆蓋儀表板的設定**（除非在 toml 加 `keep_vars = true`）。若你混用兩種方式，開關可能被悄悄改回去——每次部署後請用 `/status` 確認目前的模式。
> - **機密（金鑰、token）一律用 `npx wrangler secret put` 設定，不要放進 `[vars]` 或 git。**
> - 即時查看日誌：`npx wrangler tail`（保持開著，再到網站操作，就能看到 Worker 的 JSON 日誌）。

**`dry` 的精確定義**（避免誤以為完全不碰外部系統）：

| 功能 | `dry` 會做 | `dry` **不會**做 |
|---|---|---|
| 備份 | 讀取 Render 的 `/api/integration/export`（**唯讀**，需密鑰、會留存取紀錄）、驗證格式、計算檔名與筆數 | 不上傳到 Google Drive、不清理舊備份 |
| 管理者通知 | 讀取資料庫、組出訊息並寫入日誌 | 不呼叫 LINE |
| 客人提醒 | 掃描預約、建立提醒 job、檢查綁定、組出訊息寫入日誌 | 不呼叫 LINE（job 仍會被標為完成） |
| 日曆 | 檢查設定與資料庫 | 不呼叫 Google；日曆對帳整輪略過 |

所有模式都會檢查必要設定是否齊全：`dry` 的目的之一就是在試跑時發現漏設的變數。

### 階段 0 ─ 全關部署（風險：無）
做什麼：只部署 Worker，所有開關維持 `off`。
驗證：§4.2 的兩個指令。cron 觸發後 `/status` 的 `lastRuns` 會出現 `jobs` 紀錄。
回退：不需要（沒有對外動作）。

### 階段 1 ─ 備份（風險：低，只寫入你的 Drive 資料夾）

> 🔒 **順序很重要**：先把新版 `server.js` 部署到 Render（匯出才會帶串流所需的標頭），再開啟備份。用 `dry` 的日誌檢查 `"path":"stream"`；若顯示 `"path":"buffered"`，代表 Render 還沒更新。
1. `FEATURE_BACKUP = dry` → 後台按「備份到 Google Drive」→ 應顯示成功，Worker 日誌有 `backup … dry:true`，**Drive 沒有新檔案**。
2. 改 `on` → 再按一次 → Drive 資料夾出現 `Ronnie-Witchery-Corner-backup-v2-YYYYMMDD-HHmm.json`。
3. **還原演練（必做）**：下載該檔 → 在**測試環境**用後台「匯入後台資料」匯入 → 確認預約數、客人數、公休數一致。
4. 隔天確認 03:00 自動產生新檔。
回退：`FEATURE_BACKUP = off`。已上傳的備份保留（無害）。
> 保留份數預設 60（`BACKUP_KEEP`），多的只會「移到垃圾桶」，不會永久刪除，且只處理符合本系統命名規則的檔案。

### 階段 2 ─ LINE 通知你自己（風險：低，只傳訊息給你）
1. 設定 LINE Webhook、`FEATURE_LINE_BINDING = on`，傳 `ID` 取得你的 userId，設 `ADMIN_LINE_USER_ID`。
2. Render 設 `INTEGRATION_ADMIN_EVENTS = on`（會重新部署）。
3. `FEATURE_ADMIN_NOTIFY = dry` → 建立一筆測試預約 → 看 Worker 日誌有 `admin_notify … dry:true`，**你的 LINE 沒收到**。
4. 改 `on` → 再建立測試預約、修改、取消、後台取消 → 你的 LINE 各收到一則。
回退：`FEATURE_ADMIN_NOTIFY = off`；需要時再移除 Render 的 `INTEGRATION_ADMIN_EVENTS`。

### 階段 3 ─ 客人綁定與前一天 17:00 提醒（風險：中，會傳訊息給客人）

> 🔒 **前置條件**：必須先用**最新版** `node worker/preflight.mjs --write-test` 跑到「失敗 0、略過 0、結束碼 0」（特別是 `line_bind_tokens.code` 唯一約束與原子領取查詢）。未滿足前，不要開 `FEATURE_REMINDERS`，也不要請客人綁定。
1. `FEATURE_REMINDERS = dry`，用**你自己的手機號碼**建立「明天」的測試預約，並把預約完成頁的 6 碼綁定碼傳給官方帳號 → 應回覆「綁定成功」。
2. 今天 17:00（台北）後，看日誌 `reminder … dry:true`（內容含明天日期與時間）。
3. 改 `on` → 用另一筆「明天」測試預約，確認 17:00 後你的 LINE 收到提醒。
4. 上線後第一週，每天 17:05 檢查 `/status` 的 `failedJobs`。
回退：`FEATURE_REMINDERS = off`；已綁定資料保留（無害）。

> **測試提醒時的時間陷阱**：提醒時間（前一天 17:00）**之後**才建立的預約不會補發提醒。所以要測試，請在**今天 17:00（台北）之前**，為「明天」建立測試預約；17:00 後 5 分鐘內會收到（Worker 每 5 分鐘掃描一次）。

**行為規則（請確認符合你的期望）**
- 只提醒「已綁定 LINE」的客人；沒綁定的略過並記錄原因。
- 提醒時間（前一天 17:00）**之後**才建立的預約，不補發提醒。
- 提醒前若預約被取消或改期，該則提醒不送；改期後會依新時間重新提醒一次。
- Worker 當機後恢復，只要預約還沒開始就會補發。

### 階段 4 ─ Google 日曆（風險：中，會在日曆建立事件）
1. **只對專用日曆**（§3.3 第 5 點）。`FEATURE_CALENDAR = dry` 觀察日誌。
2. 改 `on` → 約 15 分鐘內，既有的未來預約與公休會陸續出現。免費方案每輪最多寫入 25 筆，筆數多時會分數輪完成（見 §7）。
3. 驗證：新增／修改／取消／恢復預約、新增／刪除公休，日曆都對應變化；你手動在該日曆建立的其他事件**不會被動到**。
回退：`FEATURE_CALENDAR = "off"` 只會**停止同步**，已建立的日曆事件會保留；要清掉網站建立的事件，請依 §6.2「先預覽 → 確認 → 分批清除 → 驗證」。

---

## 6. 回退計畫（Rollback Plan）

> **先搞清楚：「回退」有兩件事，而且互相獨立。**
> 1. **停止後續動作**：讓系統不再產生新的對外效果。簡單、快速、可逆。
> 2. **清理已產生的外部副作用**：已送出的 LINE、已建立的日曆事件、已上傳的備份、已寫入的資料。**這些不會因為關掉開關而自動消失**，有些甚至無法撤回，必須先預覽、再由你明確確認後才清理。

### 6.0 回退層級與「回退到哪個版本」（先讀這段，避免用錯備份）

回退有兩個層級，**基準不同**，請勿混用：

| 層級 | 目的 | 回退基準（版本） | 做法 | 後果 |
|---|---|---|---|---|
| **A. 只撤銷 V6** | V6 的變更有問題，回到 V6 之前正在運作的版本 | 你 GitHub 上 V6 之前的 `server.js`（git 標籤 `baseline-before-v6`；`server.js` 內容雜湊 `4780eb662a7713c5c644f8c08d59d4549fe708eb`） | `git checkout baseline-before-v6 -- server.js` 後提交推送；Worker 用 `npx wrangler rollback` 回到上一個已部署版本 | 保留整合功能（事件、匯出標頭等），只拿掉 V6 的修正 |
| **B. 撤銷整個整合** | 完全不要整合功能，回到整合開始之前 | `rollback/server.js.before_integration.js`（內容雜湊 `d8d8191c871546c9a334fd8f5089276b9b1b0bed`） | 以該檔覆蓋 `server.js`，並把五個 `FEATURE_*` 全設 `off` | ⚠️ Render 會失去 `/api/integration/export` 與所有整合事件，Worker 的備份與同步會因此停擺 |

**`rollback/server.js.before_integration.js` 與你 GitHub 目前的 `server.js` 內容不同是正常的**：前者是「整合開始之前」的版本（層級 B），後者已經包含整合（層級 A 的基準）。

**`rollback/admin.html.before_integration.html` 不是你正式站目前的 `admin.html`**：它是我交付的 `admin.html`（內容雜湊 `e340aae57e409cd10e6c8bdfd33f5e23b68964e0`），而你 GitHub 上的是 `2c3cba743ce3054418ac85abb078f4ed7e917328`，兩者不同，且後者不是我歷史上任何一個版本。**整合（含 V6）沒有修改 `admin.html`**，所以回退時不需要、也**不應該**用這份備份覆蓋正式站的 `admin.html`，否則會把你正式站的後台介面換成另一個版本。要回退 `admin.html`，請以你 git 歷史中的版本為準。

### 6.1 停止後續動作（不會刪除任何既有東西）

| 層級 | 情境 | 做法 | 所需時間 |
|---|---|---|---|
| **功能開關** | 任一功能異常 | 把該 `FEATURE_*` 改回 `"off"`（改 `wrangler.toml` 後 `npx wrangler deploy`） | 約 1 分鐘 |
| **備份上傳方式** | 串流上傳在你的真實環境失敗 | 設 `BACKUP_UPLOAD_MODE = "buffered"`（只適合 1MB 以內的小檔）維持備份，再回報錯誤訊息 | 約 1 分鐘 |
| **全部停用** | 想完全回到舊行為 | 五個 `FEATURE_*` 全改 `"off"`，並移除 Render 的 `INTEGRATION_ADMIN_EVENTS` | 約 5 分鐘 |
| **Render 程式碼** | `server.js` 本身有問題 | ① Render → Deploys → 選上一個版本 **Rollback**；或 ② 還原整個整合範圍：`git revert --no-edit baseline-pre-integration..HEAD`（整合分成多個提交，必須一次還原全部，只還原其中幾個會衝突）；或 ③ 用 `rollback/server.js.before_integration.js` 覆蓋 `server.js`（**這是「撤銷整個整合」的層級 B，見 6.0**；只想撤銷 V6 請用層級 A） | 約 5 分鐘 |
| **Worker 程式碼** | Worker 新版本有問題 | `npx wrangler rollback`（回到上一版）；或刪除 Worker／移除 cron | 約 2 分鐘 |

關閉開關後，**既有的 LINE 訊息、日曆事件、Drive 備份、資料庫列都原封不動**——這是刻意的（不會誤刪），但也代表你要自己決定是否清理。

### 6.2 清理既有的外部副作用（一律：先預覽 → 你確認 → 再執行 → 驗證）

| 副作用 | 能否撤回 | 預覽（只讀，不改任何東西） | 清理（你確認後才執行） |
|---|---|---|---|
| **已送出的 LINE 訊息**（通知你／提醒客人） | ❌ **無法撤回**（LINE 沒有收回已送達推播的功能）。只能事後說明；沒有清理動作 | 在 Supabase 執行下方「LINE 發送紀錄」SQL，可列出哪些預約曾被送過通知／提醒 | 無。若需要告知客人，請人工處理 |
| **Google 日曆事件**（預約＋公休） | ✅ 可刪（只刪本系統建立、帶 `ronnie=1` 標記者，不動你自己的行程） | `curl -X POST …/calendar-purge … -d '{"preview":true}'`：列出將刪除的數量與前 5 筆摘要 | 見下方「清除日曆事件」：分批、每批驗證，重複到 `remaining:false` |
| **Drive 備份檔** | ✅ 可刪（建議保留，備份無害） | 在 Drive 該資料夾搜尋 `Ronnie-Witchery-Corner-backup-v2-`，檢視清單與日期 | 在 Drive 手動選取後「移到垃圾桶」（約 30 天內可從垃圾桶還原）。程式不提供自動清除端點，避免誤刪 |
| **Supabase 列**（job、綁定、執行紀錄） | ✅ 可刪，但**留著也無害** | 下方「Supabase 清理預覽」SQL | 下方「Supabase 清理」SQL（建議先備份）。刪除 `line_bind:*` 會讓客人需要重新綁定 |
| **Render 事件旗標** | ✅ | 看 Render 環境變數 | 移除 `INTEGRATION_ADMIN_EVENTS`，網站恢復舊行為 |

**LINE 發送紀錄（預覽用，只讀）**
```sql
select type, reservation_id, created_at, payload->'steps' as steps
from integration_jobs
where payload->'steps'->>'adminNotify' = 'sent' or payload->'steps'->>'customerReminder' = 'sent'
order by created_at desc limit 200;
```

**清除日曆事件**（需密鑰；預覽不需確認字串、不刪除任何東西；刪除需確認字串；不受開關限制）：
```bash
# 1) 預覽：只列出會被刪除的數量與前 5 筆摘要
curl -X POST https://<worker網域>/calendar-purge -H "X-Worker-Secret: <密鑰>" \
  -H "Content-Type: application/json" -d '{"preview":true}'

# 2) 你確認清單無誤後，才執行刪除。每批預設最多 10 筆（可用 "limit" 調整，上限 25），
#    重複執行直到回應 "remaining": false
curl -X POST https://<worker網域>/calendar-purge -H "X-Worker-Secret: <密鑰>" \
  -H "Content-Type: application/json" -d '{"confirm":"DELETE-ALL-RONNIE-EVENTS"}'
```
每批的回應會告訴你：`deleted`（刪了幾筆）、`verified`（刪除後重新查詢，確認這批事件真的不存在）、`stillPresent`（若 `verified:false`，列出仍存在的事件 ID，請到日曆確認後再試）、`remaining`（是否還有）、`stoppedBy:"budget"`（本次請求預算用完提早停止，再執行一次即可）。刪除前會逐筆再驗證事件確實帶有本系統的 `ronnie=1` 標記，即使 Google 的篩選失效也不會刪到你自己的行程。**請不要在你的正式主日曆上做壓力測試；一律使用專用日曆。**

**Supabase 清理預覽（只讀）**
```sql
select count(*) as reminder_jobs from integration_jobs where type = 'reminder.customer';
select key from app_state where key like 'worker_last_run:%';
select key from app_state where key like 'line_attempts:%';
select key from app_state where key like 'line_bind:%';      -- 客人的 LINE 綁定（刪除後需重新綁定）
```
**Supabase 清理（確認預覽結果後才執行；建議先備份）**
```sql
delete from integration_jobs where type = 'reminder.customer';
delete from app_state where key like 'worker_last_run:%' or key like 'line_attempts:%';
-- 以下會讓客人需要重新綁定 LINE，通常不要刪：
-- delete from app_state where key like 'line_bind:%';
```

### 6.3 我已實際演練過的回退
- 把舊版 `server.js` 換回去 → 後台介面與恢復預約的全部測試仍通過。
- `git revert --no-edit baseline-pre-integration..HEAD` → `server.js`、`admin.html` 與基準點 `baseline-pre-integration` **完全一致**（逐位元），原有測試仍通過。（第一次演練我只還原了部分提交而失敗，已改正並重做。）
- 旗標關閉時，後台取消／公休**不產生任何新事件**（有自動測試把關）。
- 日曆清除的預覽、分批、驗證、預算限制都有自動測試；**尚未在你的真實日曆上執行過**。

## 6.5 Cloudflare / LINE / Google 的實際限制與本系統的因應（已查證官方文件）

| 限制 | 官方規定（查證） | 風險 | 本系統做法 |
|---|---|---|---|
| **CPU 時間** | Cloudflare 免費方案每次執行（HTTP 與 cron）只有 **10 毫秒**；付費方案預設 30 秒 | 備份若「解析 JSON 再重新輸出」，約 **2,000 筆預約（約 1.4MB）就會超過**；一天 10 筆不到一年就會達到，備份會某天悄悄開始失敗 | 備份改為**位元組串流**：Worker 不解碼、不解析，直接把 Render 的回應接到 Drive 可續傳上傳（見下） |
| **記憶體** | 128 MB | 緩衝大檔可能撐爆 | 串流模式不佔記憶體；緩衝模式（後備）設 1MB 上限 |
| **每次執行的對外請求數** | 免費 50 / 付費 1000 | 見 §7 | 實際計數的請求預算 |
| **LINE Webhook 逾時** | **2 秒**內要回應，否則記為 `request_timeout`（開啟重送時會重送） | 資料庫較慢時，重送可能與仍在處理的原請求競爭 | Webhook 在 1.5 秒內完成就回真實結果；來不及就先回 200、背景完成；背景若失敗，客人會收到「系統忙碌，請再傳一次」 |
| **Google 授權** | 授權畫面「測試中」的 refresh token **7 天失效**；**6 個月沒使用**會失效；使用者撤銷會失效；同一個 client 的授權數量有上限，超過時**最舊的會被悄悄作廢** | 授權失效後日曆與備份會靜默停擺 | access token 每次執行自動以 refresh token 換新（約 1 小時過期，不是問題）；**授權失效時主動用 LINE 通知你**；功能開啟時每 5 分鐘會用到授權，不會因閒置失效 |
| **時區** | Cloudflare Cron 以 **UTC** 計 | 若把「17:00」直接寫成 `0 17 * * *`，實際是台北凌晨 01:00 | cron 只負責「每 5 分鐘醒來檢查」；「前一天 17:00」在程式內以 `Asia/Taipei` 計算（有以 UTC 為基準的測試）。備份 cron 是 `0 19 * * *`（= 台北 03:00）與 `0 20 * * *`（04:00 重試）。**測試會比對 `wrangler.toml` 與程式的排程是否一致，並明確拒絕 `0 17 * * *`** |

**Render 前端代理會壓縮回應並移除 `Content-Length`（實測）**：在你的環境用 PowerShell 請求匯出端點，回應有 `x-export-format`、`x-export-counts`，但**沒有 `content-length`**。這會讓「以 Content-Length 決定上傳長度」的串流失效，所以：
- Render 的匯出另外送出自訂標頭 `X-Export-Bytes`（解壓縮後的位元組數）。代理不會改寫自訂標頭；Worker 以它為準，沒有時才退回 `Content-Length`。
- Worker 取得匯出時要求 `Accept-Encoding: identity`（不壓縮）。
- 若回應仍帶有 `Content-Encoding`（被壓縮），Worker 不走串流，改用緩衝模式讀取解碼後的內容（長度以 `X-Export-Bytes` 驗證）。
- 標頭謊報大小時，Drive 會因長度不符拒絕，或大小驗證失敗，**不會留下壞檔**。
- ⚠️ 真實 Cloudflare 對「已壓縮回應」的處理細節尚未驗證；階段 1 的 `dry` 日誌會顯示 `"path":"stream"` 或 `"path":"buffered"`，請以它為準。

**備份的串流設計與驗證**
1. 前置條件：**Render 必須先部署新版 `server.js`**（匯出回應會帶 `Content-Length` 與 `X-Export-Format`、`X-Export-Counts` 標頭）。Worker 沒看到這些標頭時，會自動退回「緩衝模式」，此時檔案超過 1MB 會明確報錯並提示你更新 Render。
2. 串流：Worker 以標頭驗證格式與筆數 → 建立 Drive 可續傳上傳 → 以固定長度（非 chunked）直接串流位元組 → **用 Drive 回報的檔案大小驗證**，不符就把壞檔移到垃圾桶並視為失敗。
3. `dry`：只讀取 Render 回應的**標頭**（唯讀），不讀內容、不連 Google、不上傳。
4. **每日冪等＋重試**：每天 03:00（台北）備份，04:00 重試；04:00 發現當天已有成功備份就略過（不產生重複檔）。手動備份一律執行。
5. 回退開關：`BACKUP_UPLOAD_MODE = "buffered"` 可手動切回緩衝模式（只適合小檔）。上限可用 `BACKUP_STREAM_MAX_BYTES`（預設 200MB）、`BACKUP_MAX_BYTES`（緩衝，預設 1MB）調整。
6. ⚠️ **串流上傳在真實的 Cloudflare 與 Google Drive 上尚未驗證**（沙盒只能用模擬服務測協定行為）。階段 1 的「備份 on」就是這個驗證：第一次手動備份成功並確認 Drive 檔案大小正確，才算通過；若失敗，先設 `BACKUP_UPLOAD_MODE="buffered"` 維持備份，再把錯誤訊息貼給我。

**管理者警示**（需 `FEATURE_ADMIN_NOTIFY` 為 `on`；`dry` 只記錄；同類警示 12 小時內最多一則；警示失敗不影響主流程）
- Google 授權失效（invalid_grant）→ 通知重新授權。
- 自動備份「最後一次嘗試」仍失敗 → 通知（第一次失敗不通知，避免雜訊）。
- 任務重試 5 次仍失敗 → 通知。

---

## 7. 維運與已知限制

**日常檢查**：`GET /status`（需密鑰）會顯示各功能模式、待處理／失敗的 job 數，以及各任務最近一次執行結果。Worker 日誌（Cloudflare → Logs）是結構化 JSON。

**重送失敗的 job**（先在日誌找出原因並排除）：
```sql
update integration_jobs set status='pending', attempts=0, run_after=now()
where status='failed' and id = '<job id>';
```
失敗的 job 會自動以 1 → 5 → 15 → 60 → 180 分鐘退避重試，共 5 次。超過 6 小時的舊通知會被略過（避免開啟功能時湧入過期訊息）。

**Cloudflare 免費方案限制**：每次執行最多 50 個對外請求。**Worker 會實際計算每次執行已用的請求數**（HTTP 請求或 cron 各自重新計算），預設預算 40（留 10 個緩衝；付費方案請把 `SUBREQUEST_BUDGET` 設為 900）。預算不足時各功能會提早停止、留待下一輪，不會硬撐到超過限制：
- 處理 job：每個 job 開始前檢查剩餘預算；未領取的 job 不消耗重試次數。
- 日曆對帳／清除：每筆寫入前檢查；清除另保留 1 個請求做「刪除後驗證」。
- 除了預算，另有筆數上限，兩者取較嚴格者：
- 每輪處理 job 數預設 4（`JOB_BATCH`）；日曆對帳每輪最多寫入 25 筆（`RECONCILE_MAX_OPS`）；日曆清除每批預設 10 筆（上限 25）。其餘下一輪繼續，**不會遺漏**，只是首次大量建立日曆事件要多幾輪。
- ⚠️ 「每 15 分鐘對帳」是**觸發頻率**，不保證每次都能同步完所有差異：實際完成時間取決於差異筆數（每輪 25 筆）、Google API 限流與錯誤重試。`/status` 的 `calendar_reconcile` 結果若含 `partial: true`，代表還有剩餘，下一輪會繼續。
- 若升級付費方案，可把這兩個值調大。

**預約已儲存之後，附加動作失敗不影響預約結果**
- 建立預約、客人修改、客人取消，在「預約資料已儲存」之後才會建立 LINE 綁定碼與整合任務。這些附加動作失敗時**不再讓 API 回 500**（舊行為：客人以為預約失敗，重試又被擋成「時段已被其他使用者預約」）。
- 做法：自動重試一次；仍失敗就照常回成功，並在 Render 日誌留下 `[integration] … failed after 2 attempt(s) (non-fatal)`。綁定碼失敗時 `lineBindCode` 回 `null`（客人頁面會自動隱藏綁定提示）。
- ⚠️ 代價：任務寫入失敗時，那一筆預約的「LINE 通知管理者」不會發出（日曆會在 15 分鐘內的對帳補上）。請定期在 Render 日誌搜尋 `non-fatal`；出現時請人工留意該筆預約。

**綁定安全性**
- 綁定碼為 6 位十六進位（約 1,677 萬種）、24 小時有效、一次性：領取是**原子操作**（資料庫一次完成「檢查未過期＋作廢」），同一個碼同時被多人送出，只有一人成功。
- 防猜測：同一個 LINE 使用者 1 小時內輸入錯誤綁定碼 5 次即暫停（連正確碼也先擋），1 小時後恢復；成功後歸零。
- 日誌不記錄綁定碼與完整電話（電話只顯示末 4 碼）。
- 暫時性故障（資料庫／LINE／網路）：Worker 回 500 讓 LINE 重送，綁定碼會還原，重送不會重複綁定；永久性錯誤（如 400）回 200，不引發無限重送。

**CPU 時間（免費方案 10 毫秒）— 我的量測**（Node/V8，僅供量級參考；Workers 實際值可能不同）

| 項目 | 量測結果 | 建議 |
|---|---|---|
| 備份（舊做法：解析＋重新序列化） | 1,000 筆 ≈ 6ms；3,000 筆 ≈ 16ms | 已改串流，與資料量無關 |
| 備份（緩衝模式：解碼＋編碼） | 約 1.5MB ≈ 9ms；3MB ≈ 30ms | 所以緩衝模式上限定為 1MB |
| 日曆對帳（讀取＋建事件＋指紋） | 100 筆 ≈ 1ms；300 筆 ≈ 4ms；**1,000 筆 ≈ 21ms** | 「未來預約」超過約 300 筆時，日誌會出現 `cpu_risk` 警告、對帳結果帶 `warn:"large_dataset"`；請升級付費方案（約 US$5/月，CPU 上限 30 秒） |

小型工作室的「未來預約數」通常遠低於 300，免費方案可用；但請定期看 `/status` 與日誌是否出現 `cpu_risk`。

**其他限制與決策**
- 日曆同步是**單向**（網站 → 日曆）。在 Google 日曆直接改動網站建立的事件，會在下一次對帳（約 15 分鐘）被網站資料覆蓋；網站不會讀回日曆的修改。
- 日曆事件內含客人姓名、電話、備註，請確認該日曆的分享設定。
- Render 免費方案閒置會休眠：Worker 備份與喚醒第一次可能需要等待數十秒（備份已設 90 秒逾時，失敗會在下一輪重試）。
- 時區固定為 `Asia/Taipei`（無日光節約）。
- 後台只改備註／標籤／狀態標籤（Finished、No-show、Other）不會觸發日曆或 LINE 事件。
- 恢復預約（已取消 → 改狀態）會視為「預約已修改」通知你，並讓日曆事件回來；**不會**通知客人。
- 客人的 LINE 綁定碼用過即作廢，且 24 小時過期；同一電話可重新綁定新的 LINE 帳號。
