這個資料夾的兩個檔案，是「整合功能開始之前」的版本。請先讀 docs/INTEGRATION_SETUP_AND_ROLLBACK.md 的 6.0 再使用。

server.js.before_integration.js
  - 內容雜湊（git blob）：d8d8191c871546c9a334fd8f5089276b9b1b0bed
  - 這是「撤銷整個整合」(層級 B) 才用的版本：還原後 Render 會失去 /api/integration/export 與所有整合事件。
  - 它與你 GitHub 目前的 server.js 不同是正常的（GitHub 目前的版本已包含整合）。
  - 只想撤銷 V6 時，不要用它；請用 git 標籤 baseline-before-v6（層級 A）。

admin.html.before_integration.html
  - 內容雜湊（git blob）：e340aae57e409cd10e6c8bdfd33f5e23b68964e0
  - 這是「我交付的 admin.html」，不是你正式站目前的 admin.html（你的 GitHub 版本是 2c3cba74…，與它不同）。
  - 整合（含 V6）沒有修改 admin.html。回退時請「不要」用這個檔案覆蓋正式站的 admin.html。
