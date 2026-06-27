#!/bin/bash
# 每小時從「台灣 IP（Bear 的 Mac）」抓健保署急診壅塞 → commit/push。
# 取代 GitHub Actions 每小時 cron：境外 runner IP 會被健保署偶發 ECONNRESET，台灣 IP 不會。
# 由 launchd com.ersalary.congestion-hourly 每小時 :05 呼叫，跑在「專用 clone」上，完全不碰 Bear 的工作目錄。
# 全部包進 main(){…}; main —— 即使 git pull 把本檔更新掉，bash 已先解析完整個函式，避免「自我修改」執行到一半炸裂。
set -uo pipefail

main() {
  export PATH="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
  local REPO; REPO="$(cd "$(dirname "$0")/.." && pwd)"
  local LOG="/tmp/er-congestion-cron.log"
  local TS; TS="$(date '+%Y-%m-%d %H:%M:%S')"
  cd "$REPO" || { echo "$TS cd 失敗 $REPO" >>"$LOG"; exit 0; }

  # 1) 同步遠端（手動觸發 / 其他來源可能有新 commit）；rebase 失敗就 abort + 略過本次，不留半套狀態
  if ! git pull --rebase --autostash origin main >>"$LOG" 2>&1; then
    git rebase --abort >/dev/null 2>&1 || true
    echo "$TS ⚠️ pull/rebase 失敗，略過本次" >>"$LOG"
    exit 0
  fi

  # 2) 抓資料；網路被擋（ECONNRESET/逾時）就軟跳過——不視為失敗、不留爛 commit
  if ! node scripts/fetch-congestion.mjs >>"$LOG" 2>&1; then
    echo "$TS ⚠️ fetch 失敗（多半健保署瞬斷），略過本次" >>"$LOG"
    exit 0
  fi

  # 3) 只動這兩個資料檔；有變動才 commit/push
  if [ -n "$(git status --porcelain data/congestion-latest.json data/congestion-history.json)" ]; then
    git add data/congestion-latest.json data/congestion-history.json
    git commit -m "chore(congestion): 每小時更新急診壅塞資料 [skip ci]" >>"$LOG" 2>&1
    if git push origin main >>"$LOG" 2>&1; then
      echo "$TS ✅ 更新並 push" >>"$LOG"
    else
      echo "$TS ⚠️ push 失敗（下次重試）" >>"$LOG"
    fi
  else
    echo "$TS ＝ 無變化" >>"$LOG"
  fi

  # log 控大小：保留最後 500 行
  tail -n 500 "$LOG" >"$LOG.tmp" 2>/dev/null && mv "$LOG.tmp" "$LOG"
}

main "$@"
