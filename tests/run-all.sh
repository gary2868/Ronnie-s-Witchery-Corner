#!/bin/sh
# 一鍵測試（POSIX sh）。於任何目錄執行皆可：  sh tests/run-all.sh [--quick] [--mutation-only]
#   預設        ：原有單元測試 + Worker 單元/整合測試（約 5~10 秒）
#   --quick     ：同預設（明確表示不跑突變測試）
#   --mutation  ：額外跑突變測試（35 項；單核心機器約 3~4 分鐘，請勿設太短的逾時）
# 結束碼：0 = 全部通過；1 = 有測試失敗；2 = 環境不符（Node 版本）；124 = 逾時
set -u
cd "$(dirname "$0")/.." || exit 2

major=$(node -p "process.versions.node.split('.')[0]" 2>/dev/null || echo 0)
echo "== 環境 =="; PY=$(python3 -c "import sys;print(sys.version.split()[0])" 2>/dev/null || echo "未安裝（只有突變測試需要）")
echo "node $(node --version 2>&1)  |  python3 $PY  |  CPU 核心數 $(nproc 2>/dev/null || echo '?')"
if [ "$major" -lt 18 ]; then echo "需要 Node.js 18 以上（建議 20+）"; exit 2; fi
FLAG=""; [ "$major" -ge 20 ] && FLAG="--test-timeout=60000"
TMO=""; command -v timeout >/dev/null 2>&1 && TMO="timeout 300"

status=0
echo; echo "== 1/2 原有單元測試 =="
$TMO node tests/sync-dataset-isolated.test.cjs >/tmp/ronnie-unit.log 2>&1; rc=$?
tail -3 /tmp/ronnie-unit.log; [ $rc -eq 0 ] || { echo "❌ 失敗（結束碼 $rc）"; status=1; }

echo; echo "== 2/2 Worker 單元 + 整合測試（真實 server.js） =="
$TMO node --test $FLAG ${RONNIE_REPORTER:+--test-reporter=$RONNIE_REPORTER} tests/worker/worker.test.mjs tests/worker/integration.test.mjs >/tmp/ronnie-worker.log 2>&1; rc=$?
SUMMARY=$(grep -E "^(# |ℹ )(tests|pass|fail|cancelled|skipped) " /tmp/ronnie-worker.log)
if [ -n "$SUMMARY" ]; then echo "$SUMMARY"; else echo "（無法解析測試摘要，以下為輸出尾端）"; tail -15 /tmp/ronnie-worker.log; fi
# 保險：以「失敗/取消筆數」再判斷一次，不單靠結束碼
FAILN=$(echo "$SUMMARY" | grep -E "^(# |ℹ )(fail|cancelled) " | awk '{s+=$3} END {print s+0}')
[ "$FAILN" -gt 0 ] && [ $rc -eq 0 ] && rc=1
if [ $rc -eq 124 ]; then echo "❌ 逾時（請檢視 /tmp/ronnie-worker.log）"; status=124
elif [ $rc -ne 0 ]; then echo "❌ 失敗（結束碼 $rc；詳見 /tmp/ronnie-worker.log）"; status=1; fi

if [ "${1:-}" = "--mutation" ]; then
  echo; echo "== 突變測試（35 項，請耐心等待） =="
  python3 tests/mutation-check.py; rc=$?; [ $rc -eq 0 ] || status=1
fi
echo; [ $status -eq 0 ] && echo "✅ 全部通過" || echo "❌ 有項目未通過（結束碼 $status）"
exit $status
