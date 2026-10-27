#!/bin/bash
# 每小時從「台灣 IP（Bear 的 Mac）」抓健保署急診壅塞 → commit/push。
# 取代 GitHub Actions 每小時 cron：境外 runner IP 會被健保署偶發 ECONNRESET，台灣 IP 不會。
# 由 launchd com.ersalary.congestion-hourly 每小時 :05 呼叫，跑在「專用 clone」上，完全不碰 Bear 的工作目錄。
# main 與下面的輔助函式都在「呼叫 main」之前解析完。git pull 即使把本檔換掉，也不會執行到一半讀到新內容。
# 因此 main "$@" 必須是檔案最後一列。
#
# 雲端主路徑成功時會打 Supabase RPC log_cron_run。這裡一開始先問 has_cron_success，
# 本小時（UTC 整點，與 Actions 的 p_scheduled_at 同一瞬間）已成功就退出。
# SUPABASE_URL / SUPABASE_ANON_KEY 來自環境變數，或 ~/.config/er-congestion-env（KEY=VALUE，可加 export 與引號）。
# 沒有設定、查詢失敗、或寫 log 失敗：一律照舊抓取，而且不以非 0 結束，避免弄壞 launchd。
set -uo pipefail

main() {
  export PATH="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
  local REPO; REPO="$(cd "$(dirname "$0")/.." && pwd)"
  local LOG="/tmp/er-congestion-cron.log"
  local TS; TS="$(date '+%Y-%m-%d %H:%M:%S')"
  cd "$REPO" || { echo "$TS cd 失敗 $REPO" >>"$LOG"; exit 0; }

  # 與 GitHub Actions 相同：目前小時的 UTC 整點
  local SCHED; SCHED="$(date -u '+%Y-%m-%dT%H:00:00Z')"

  load_supabase_env || true

  if supabase_ready; then
    local chk=1
    has_cron_success "$SCHED"
    chk=$?
    if [ "$chk" -eq 0 ]; then
      echo "$TS ☁️ 本小時雲端已成功（$SCHED），略過" >>"$LOG"
      exit 0
    fi
    if [ "$chk" -ne 1 ]; then
      echo "$TS ⚠️ has_cron_success 查詢失敗，改照舊抓取" >>"$LOG"
    fi
  fi

  # 1) 同步遠端（手動觸發 / 其他來源可能有新 commit）；rebase 失敗就 abort + 略過本次，不留半套狀態
  if ! git pull --rebase --autostash origin main >>"$LOG" 2>&1; then
    git rebase --abort >/dev/null 2>&1 || true
    echo "$TS ⚠️ pull/rebase 失敗，略過本次" >>"$LOG"
    log_cron "skipped" "pull/rebase failed" "" || true
    exit 0
  fi

  # 2) 抓資料；網路被擋（ECONNRESET/逾時）就軟跳過——不視為失敗、不留爛 commit
  if ! node scripts/fetch-congestion.mjs >>"$LOG" 2>&1; then
    echo "$TS ⚠️ fetch 失敗（多半健保署瞬斷），略過本次" >>"$LOG"
    log_cron "failed" "fetch failed" "" || true
    exit 0
  fi

  local notes; notes="$(notes_from_latest || true)"

  # 3) 只動這三個資料檔；有變動才 commit/push
  if [ -n "$(git status --porcelain data/congestion-latest.json data/congestion-history.json data/congestion-hosp-history.json)" ]; then
    git add data/congestion-latest.json data/congestion-history.json data/congestion-hosp-history.json
    git commit -m "chore(congestion): 每小時更新急診壅塞資料 [skip ci]" >>"$LOG" 2>&1 || echo "$TS ⚠️ commit 失敗" >>"$LOG"
    if git push origin main >>"$LOG" 2>&1; then
      echo "$TS ✅ 更新並 push" >>"$LOG"
      log_cron "success" "" "$notes" || true
    else
      echo "$TS ⚠️ push 失敗（下次重試）" >>"$LOG"
      log_cron "failed" "push failed" "$notes" || true
    fi
  else
    echo "$TS ＝ 無變化" >>"$LOG"
    log_cron "success" "" "$notes" || true
  fi

  # log 控大小：保留最後 500 行
  tail -n 500 "$LOG" >"$LOG.tmp" 2>/dev/null && mv "$LOG.tmp" "$LOG"
}

# 只補目前還沒有的那兩個變數。檔案壞掉或讀不到就當沒設定，不讓腳本中止。
load_supabase_env() {
  if [ -n "${SUPABASE_URL:-}" ] && [ -n "${SUPABASE_ANON_KEY:-}" ]; then
    return 0
  fi
  local f="${HOME:-}/.config/er-congestion-env"
  [ -n "${HOME:-}" ] && [ -f "$f" ] && [ -r "$f" ] || return 0
  local line key val first last
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%$'\r'}"
    case "$line" in
      ''|\#*) continue ;;
    esac
    case "$line" in
      export\ *) line="${line#export }" ;;
    esac
    case "$line" in
      SUPABASE_URL=*|SUPABASE_ANON_KEY=*) ;;
      *) continue ;;
    esac
    key="${line%%=*}"
    val="${line#*=}"
    if [ "${#val}" -ge 2 ]; then
      first="${val%"${val#?}"}"
      last="${val#"${val%?}"}"
      if [ "$first" = '"' ] && [ "$last" = '"' ]; then
        val="${val#\"}"
        val="${val%\"}"
      elif [ "$first" = "'" ] && [ "$last" = "'" ]; then
        val="${val#\'}"
        val="${val%\'}"
      fi
    fi
    if [ "$key" = "SUPABASE_URL" ] && [ -z "${SUPABASE_URL:-}" ]; then
      SUPABASE_URL="$val"
      export SUPABASE_URL
    elif [ "$key" = "SUPABASE_ANON_KEY" ] && [ -z "${SUPABASE_ANON_KEY:-}" ]; then
      SUPABASE_ANON_KEY="$val"
      export SUPABASE_ANON_KEY
    fi
  done < "$f" || true
  return 0
}

supabase_ready() {
  [ -n "${SUPABASE_URL:-}" ] && [ -n "${SUPABASE_ANON_KEY:-}" ]
}

# 0 = 本小時已有成功紀錄；1 = 沒有；2 = 查詢本身失敗（呼叫端應照舊跑）
has_cron_success() {
  local sched="$1"
  local body resp
  body="$(printf '{"p_task_name":"er-congestion","p_scheduled_at":"%s"}' "$sched")"
  resp="$(curl -fsS --max-time 20 -X POST "${SUPABASE_URL%/}/rest/v1/rpc/has_cron_success" \
    -H "apikey: ${SUPABASE_ANON_KEY}" \
    -H "Authorization: Bearer ${SUPABASE_ANON_KEY}" \
    -H "Content-Type: application/json" \
    -d "$body" 2>>"$LOG")" || return 2
  resp="$(printf '%s' "$resp" | tr -d '[:space:]')"
  if [ "$resp" = "true" ]; then
    return 0
  fi
  return 1
}

notes_from_latest() {
  node --input-type=commonjs -e '
    const fs = require("fs");
    try {
      const j = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      const n = Array.isArray(j.hospitals) ? j.hospitals.length : 0;
      process.stdout.write("sysdate=" + j.sysdate + " hospitals=" + n);
    } catch (e) {}
  ' "$REPO/data/congestion-latest.json" 2>/dev/null || true
}

# 失敗只寫 log，不改變呼叫端的退出碼
log_cron() {
  local status="$1"
  local err="${2:-}"
  local notes="${3:-}"
  local body
  if ! supabase_ready; then
    return 0
  fi
  body="$(node --input-type=commonjs -e '
    const [status, err, notes, sched] = process.argv.slice(1);
    process.stdout.write(JSON.stringify({
      p_task_name: "er-congestion",
      p_status: status,
      p_trigger_source: "launchd",
      p_scheduled_at: sched,
      p_error_msg: err ? err : null,
      p_notes: notes ? notes : null
    }));
  ' "$status" "$err" "$notes" "$SCHED" 2>>"$LOG")" || {
    echo "$TS ⚠️ 組 log_cron_run body 失敗（不影響本次）" >>"$LOG"
    return 0
  }
  if curl -fsS --max-time 20 -o /dev/null -X POST "${SUPABASE_URL%/}/rest/v1/rpc/log_cron_run" \
    -H "apikey: ${SUPABASE_ANON_KEY}" \
    -H "Authorization: Bearer ${SUPABASE_ANON_KEY}" \
    -H "Content-Type: application/json" \
    -d "$body" 2>>"$LOG"; then
    echo "$TS 📝 log_cron_run $status" >>"$LOG"
  else
    echo "$TS ⚠️ log_cron_run 失敗（不影響本次）" >>"$LOG"
  fi
  return 0
}

# 必須留在檔案最後：上面的函式要先解析完，main 裡的 git pull 才不會改到執行中的腳本。
main "$@"
