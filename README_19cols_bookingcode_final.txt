# 19 欄 Schema 測試版（booking_code 修正版）

此版本以既有 `reservations` 19 欄 Schema 為唯一資料庫欄位基準。

修正：
- reservations 寫入只送 19 欄
- 不送 my_note / status_label / other_status / tags / customer_id
- 建立新預約時自動產生必要的 booking_code
- booking_code 只作為資料庫必要欄位，不改變目前「電話查詢／修改預約」流程
- 不要求修改 Supabase Schema

測試：
1. 將此檔改名為 server.js，放入測試資料夾。
2. `node --check server.js`
3. `node server.js`
4. 用瀏覽器建立一筆測試預約。
5. 到 Supabase reservations 確認寫入成功。

回退：
保留原本的 server.js.before_19cols_test.js，不要刪除。
