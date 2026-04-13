#!/bin/bash
# 每週自動爬取 FB 急診薪資
# 由 crontab 呼叫：0 10 * * 1  （每週一早上 10:00）

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LOG_DIR="$SCRIPT_DIR/../data"
mkdir -p "$LOG_DIR"

TIMESTAMP=$(date +%Y%m%d_%H%M%S)
LOG_FILE="$LOG_DIR/cron-${TIMESTAMP}.log"

echo "=== 急診薪資爬取 $TIMESTAMP ===" > "$LOG_FILE"

# 確保 Node.js 可用
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

cd "$SCRIPT_DIR"
node fetch-fb-salary.mjs --days 7 >> "$LOG_FILE" 2>&1

EXIT_CODE=$?

if [ $EXIT_CODE -eq 0 ]; then
  echo "✅ 成功" >> "$LOG_FILE"
else
  echo "❌ 失敗 (exit $EXIT_CODE)" >> "$LOG_FILE"
fi

echo "=== 結束 $(date +%H:%M:%S) ===" >> "$LOG_FILE"
