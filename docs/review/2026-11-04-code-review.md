# Code Review 報告：急診薪資 × 健保署壅塞爬蟲與網站

- 日期：2026-11-04
- 範圍：`scripts/`（爬蟲、對照表、排程腳本）、`.github/workflows/`、`index.html`（只看安全面）
- 重點：①爬蟲失敗時的重試與告警 ②資料解析邊界 ③排程 commit 的正確性 ④相依套件安全
- 分支：`claude/friendly-wozniak-qqhg8w`（沒有 push main、沒有 merge、沒有 deploy、沒有寫入任何正式資料庫）

> ⚠️ 本站的 `deploy.yml` 會把整個 repo（`path: .`）上傳到 GitHub Pages，**合併後這份報告也會公開在網站上**。報告裡沒有任何密鑰，但寫了弱點細節。如果不想公開，請先把 `docs/` 排除在 Pages artifact 之外（見 §5 S-4）。

---

## 0. 結論先講

| 等級 | 數量 | 本 PR 已修 | 待你決定 |
|---|---|---|---|
| 🔴 高 | 4 | 1 | 3 |
| 🟠 中 | 10 | 3 | 7 |
| 🟡 低 | 14 | 4 | 10 |

最該優先處理的三件事：

1. **H-1（已修）健保署回應壞掉時，舊版會 exit 0 並清空 8 天逐院歷史**，workflow 照樣 commit，Supabase 還記成 `success`。已實際重現。
2. **H-3 告警形同虛設**：從 repo 裡的資料算出，近 30 天 `congestion-history.json` 有 **28 次 ≥2 小時、10 次 ≥6 小時的斷層，最長 24 小時（10-28 08:00 → 10-29 08:00）**，總共缺了約 140 小時。程式只「寫 log」，沒有任何東西會主動通知人。
3. **H-2 雙來源 push 的 commit 策略會卡死**：雲端（Actions）和 Mac launchd 都改同樣三個 JSON 檔，`pull --rebase` 必定發生內容衝突；Actions 的「重試 3 次」對內容衝突完全沒用；Mac 只要 push 失敗一次，之後每小時都會 rebase 衝突並記成 `skipped`，**永久停擺直到有人手動處理**。

---

## 1. 本 PR 做了什麼

### 1.1 重構（行為不變）

把可測的純邏輯從腳本抽到 `scripts/lib/`，腳本只剩 I/O：

| 新模組 | 內容 | 使用者 |
|---|---|---|
| `lib/congestion.mjs` | `num`／`score`／`validateRaw`／排名／區平均／歷史 upsert／7 日平均／`staleAgainst` | `fetch-congestion.mjs` |
| `lib/http.mjs` | `fetchJsonWithRetry`（fetch、sleep、warn 都可注入） | `fetch-congestion.mjs`、`fetch-boarding.mjs` |
| `lib/boarding.mjs` | 季度挑選、S12 解析、輸出組裝、Worker payload 驗證 | `fetch-boarding.mjs`、`write-boarding-payload.mjs` |
| `lib/salary.mjs` | `ageDays`／`parseAIResult`／`findHospital`／`isSameSalary` | `fetch-fb-salary.mjs` |
| `build_boarding_map.py` | 拆成 `match_hospitals()`／`build_doc()`／`main()`＋`if __name__ == '__main__'` | — |

**等價驗證**：把原版 `fetch-congestion.mjs` 與新版分別放在兩份 `data/` 複本上，用同一組 fixture 連跑兩個時點，三個輸出檔（扣掉 `fetchedAt`）**逐位元組相同**。

### 1.2 修掉的 bug

| ID | 修正 | 測試 |
|---|---|---|
| H-1 | `validateRaw()`：`sysdate` 格式不符、`data` 空、全部醫院沒有通報數字 → 拋錯、**一個檔都不寫**、exit 1（走既有的失敗告警路徑） | `congestion.test.mjs`、`fetch-congestion.cli.test.mjs` |
| M-1 | `staleAgainst()`：本次 `sysdate` 比歷史末筆舊（Worker 重送或快取）→ `STALE_SKIP`、exit 0、不寫檔 | 同上 |
| M-8 | `num(' ')` 舊版回 `0`（未通報被當成 0 參與排名）；`'-'`、`'N/A'` 回 `NaN`。現在一律回 `null` | `num()` 測試 |
| M-10 | 重試策略：舊版 4xx 也重試（白等 12 秒）；`200`＋HTML 維護頁在重試迴圈外才 `res.json()`，不會重試。現在 5xx／429／網路錯／壞 JSON 才重試 | `http.test.mjs` |
| L-1 | 三個壅塞檔改成「先寫 `.tmp` 再 rename」，中斷時不會留下半截 JSON（`.tmp` 在 `data/*` 的 ignore 範圍內） | CLI 測試檢查沒有殘留 `.tmp` |
| L-2 | 未知縣市碼原本靜默排除在區平均之外，現在印出警告 | CLI 測試 |
| L-3 | `pickLatestQuarter()` 忽略格式不符的 `DataTimeID`（如 `115Q9`），避免被當成最新季度 | `boarding.test.mjs` |
| L-4 | Worker payload 原本只驗欄位名稱和筆數，現在也驗每筆 `name` 是字串、`ratio` 是有限數字 | `boarding.test.mjs` |

### 1.3 新增測試與 build

```
scripts/
├── check.mjs                         # npm run build：語法＋資料檔結構＋index.html 內嵌 script
└── test/
    ├── fixtures/                     # 離線 fixture（說明見 §6）
    ├── congestion.test.mjs           # 解析器、排名、區平均、歷史、7 日平均
    ├── http.test.mjs                 # 重試／退避／不重試的條件
    ├── boarding.test.mjs             # 季度挑選、S12 解析、payload 驗證
    ├── salary.test.mjs               # 相對時間、AI 輸出解析、醫院比對
    ├── fetch-congestion.cli.test.mjs # 端到端：壞回應不動到既有檔案
    └── test_build_boarding_map.py    # Python 對照表比對邏輯＋回歸
```

- `npm test`：Node 90 項（89 pass、1 todo）＋Python 10 項，全部通過
- `npm run build`：42 項檢查通過
- `.github/workflows/test.yml`：PR 時自動跑 test、build、`npm audit`（只讀權限，不部署）
- 1 個 `todo` 是刻意留的：它證明 M-5（醫院誤配）真的存在，修好後會自動轉綠

---

## 2. 重試與告警

### H-3 🔴 沒有主動告警，斷層沒人知道（未修）

**證據**（從 repo 裡已 commit 的 `data/congestion-history.json` 算出）：

```
近 30 天 ≥2h 斷層 28 次，≥6h 10 次，累計缺 140 小時
最長：2026-10-28 08:00 → 2026-10-29 08:00（24h）
```

**原因**：

- `fetch-congestion.mjs` 失敗 → workflow 把 `failed` 寫進 Supabase `log_cron_run`，但**沒有任何東西讀這張表並通知人**（至少 repo 裡沒有）。
- `cron-congestion.sh` 一律 exit 0（刻意的，避免弄壞 launchd），所以 macOS 不會有任何提示。
- `~/.config/er-congestion-env` 沒設定時，Mac 端的失敗**連 log_cron_run 都不會寫**，只剩 `/tmp/er-congestion-cron.log`（重開機就沒了）。
- pull／rebase 失敗記成 `skipped` 而不是 `failed`，見 H-2。

**建議**（擇一即可，由簡到繁）：

1. **資料新鮮度監控（推薦）**：Cloudflare Worker 本來就每小時跑，多加一個檢查：抓 Pages 上的 `data/congestion-latest.json`，`sysdate` 超過 2 小時沒前進就發通知（Email／LINE Notify 的替代方案／Discord webhook）。這能涵蓋「所有來源都壞」的情況，不依賴哪條路徑記 log。
2. Supabase `pg_cron` 每小時查 `log_cron_run`：近 3 小時內沒有任何 `success` → 呼叫 webhook。
3. `congestion.yml` 失敗時用 `actions/github-script` 開 issue（同一個 issue 累加留言，避免洗版）。

### M-4 🟠 FB 薪資 pipeline 會「靜默成功」（未修）

- `parsePostsWithAI()`：`claude -p` 逾時、輸出壞掉、解析出的 JSON 本身壞掉（例如 greedy regex `\[[\s\S]*\]` 跨到後面的說明文字，見 L-10）→ 一律 `return []` → `writeToSupabase([])` → 最後印「✅ Pipeline 完成！」並以 exit 0 結束。`weekly-fetch.sh` 會記成「✅ 成功」。
- 重試設計互相矛盾：`main()` 失敗後**在行程內 sleep 1 小時**再重試，但同一個 catch 區塊裡的註解（2026-10-31）寫著外層 wrapper 30 分鐘就會逾時 → 重試永遠不會發生，只是讓 wrapper 逾時、看不到真正原因。
- **建議**：AI 解析失敗改成拋錯（讓外層知道）；`posts.length > 0 && candidates.length > 0 && parsed.length === 0` 時至少印出 `PARSE_EMPTY` 讓 wrapper 抓；1 小時重試交給排程器處理，不要放在行程內。

### 已確認沒問題的地方

- `fetch-boarding.mjs` 的退避（5／15／30 秒、4xx 不重試）原本就合理，現在改用共用模組，行為一樣。
- `congestion.yml` 處理 `repository_dispatch` 的 payload 都經過 `jq` 或環境變數傳遞，`trigger_source` 有做白名單過濾，**沒有 script injection**。

---

## 3. 排程 commit 的正確性

### H-2 🔴 兩個來源同時 push，rebase 必定衝突；Mac 端會永久卡住（未修）

**機制**：三個資料檔每次都會被整份改寫（`congestion-latest.json` 每一行都可能不同，history 的末段也一樣）。只要雲端和 Mac 在同一個小時都跑了：

| 路徑 | 會發生什麼 |
|---|---|
| `congestion.yml` | `git pull --rebase` 遇到內容衝突 → `rebase --abort` → 再 pull 一次，**衝突一模一樣** → 3 次都失敗 → job 失敗。重試只對「沒有內容重疊的 non-fast-forward」有用，這裡幾乎不會出現那種情況。 |
| `cron-congestion.sh` | `git push` 失敗後**本地 commit 留著**。下一小時 `git pull --rebase --autostash` 和遠端衝突 → abort → 記成 `skipped` → exit 0。**之後每一小時都一樣**，Mac 備援就此停擺，而且狀態是 `skipped`，不是 `failed`。 |

另外 `git commit` 失敗時（第 59 行）只印警告，還是會繼續 push。

**觸發條件**：Mac 在 :05 問 `has_cron_success`，但雲端那次可能晚一點才完成（Worker 的時間點、Actions 排隊），於是兩邊都跑。

**建議修法**（兩邊都一樣的思路：**不要 rebase 資料檔，改成從最新的遠端重新產生**）：

```bash
# cron-congestion.sh（專用 clone，可以放心 reset）
git fetch origin main && git reset --hard origin/main   # 取代 pull --rebase
node scripts/fetch-congestion.mjs || { log_cron failed ...; exit 0; }
git add ... && git commit ... || exit 0
git push origin HEAD:main || { git reset --hard origin/main; log_cron failed "push failed"; }
```

```bash
# congestion.yml：push 失敗時，回到最新的遠端，用同一份 raw 重新跑一次
for i in 1 2 3; do
  git push origin HEAD:main && break
  git fetch origin main && git reset --hard origin/main
  node scripts/fetch-congestion.mjs --raw-file "$RUNNER_TEMP/congestion-raw.json"
  git add ... && git commit -m ... || break   # 遠端已經有同一個 sysdate → 沒有變化，直接結束
done
```

（手動備援的 `workflow_dispatch` 沒有 raw 檔，要先把第一次抓到的回應存成檔案。）

### M-2 🟠 每次都會 commit，而且偵測不到「資料停更」（未修）

`latest.json` 有 `fetchedAt`，每次執行都會變，所以「Commit if changed」**永遠成立**。健保署如果卡在同一個 `sysdate` 好幾個小時，repo 還是每小時多一個 commit，看起來一切正常。

**建議**：`sysdate` 與 `latest.json` 現有的 `sysdate` 相同時不寫 `latest.json`（或不更新 `fetchedAt`）；`sysdate` 距今超過 N 小時就印出 `STALE_SOURCE`，並且把 log 狀態記成 `failed`，讓 H-3 的監控抓得到。

### M-7 🟠 `boarding.yml` 的幾個問題（未修）

1. `actions/checkout@v4` 沒有加 `fetch-depth: 0`，但 `congestion.yml` 的註解明講 `pull --rebase` 需要它；push 也沒有重試。每小時都有壅塞 commit 進來，碰撞機率不低。
2. 判斷「新一季」的依據是 `boarding-by-hospital.json` 有沒有變，但這個檔也取決於 **Supabase 的薪資醫院清單**。有人新增一家醫院，就會被 commit 成「更新 48hr 暫留比率（新一季）」。建議改成比較 `quarter`。
3. `build_boarding_map.py` 要連 Supabase（唯讀）。Supabase 掛掉時整個 job 失敗，連已經抓到的 48hr 資料都不會 commit。
4. 沒有「命中數驟降」的保護：例如 `matched` 從 58 掉到 10（官方改了醫院全名），照樣 commit，前端會靜靜少掉很多點。建議 `matched < 舊值 × 0.8` 時讓 job 失敗。

### 🟡 低

- **L-9** `congestion.yml` 的 `scheduled_at` 用的是 job **開始**時的 UTC 整點；job 排隊跨過整點時，會和 Mac 端的 `has_cron_success` 對不上，導致重複執行（進而觸發 H-2）。建議由 Worker 在 `client_payload` 裡帶入 `scheduled_at`。
- **L-5** `--raw-url` 也接受 `http://`（註解寫的是 https），可能被中間人竄改內容。建議只收 `https:`。

---

## 4. 資料解析邊界

### H-1 🔴 壞回應會清空歷史（✅ 已修）

**重現**（用原版腳本跑在 `data/` 的複本上）：

| 輸入 | 原版結果 |
|---|---|
| `sysdate` 從 `2026-11-04 13:15` 變成 `2026/11/04 13:15` | exit **0**，`congestion-hosp-history.json` 從 468 筆變成 **0 筆**（`tsOf()` 回 `NaN`，8 天過濾條件全部為 false） |
| `data: []` | exit **0**，`latest.hospitals` 變成 0 家，history append 一筆 `regions: []`，污染 7 日平均 |

兩種情況 workflow 都會 commit，`log_cron_run` 都會記 `success`。新版兩種情況都 exit 1、檔案不動。

### M-3 🟠 7 日平均的取樣假設不成立（未修，需要你判斷）

實際資料顯示健保署 `sysdate` 是**每 15 分鐘**更新一次（`hosp-history` 相鄰間隔：15 分鐘 292 次、30 分鐘 156 次），近 191 小時有 470 個時點（約每小時 2.5 個）。

- `MIN_N = 84` 的註解是「168 小時的 50% 覆蓋率」，但以目前的頻率，**約 34 小時就達到門檻**，前端標示的「近 7 天平均」實際可能只涵蓋 1.5 天。
- 每個時點權重相同 → 抓得比較密的時段（雲端＋Mac 都跑）權重比較高。
- `HISTORY_MAX = 3000` 的註解假設每小時 1 筆（約 125 天），以目前頻率約 50 天就會被滾掉。

**建議**：先把每家醫院依「小時」分桶取平均，再對小時做 7 日平均；`MIN_N` 改成「至少有 84 個不同的小時」。這會改變前端顯示的數字，所以本 PR 沒有動。

### M-5 🟠 FB 薪資的醫院模糊比對會配錯醫院（未修，有 todo 測試）

`findHospital()` 的第三條規則是「去掉『醫院』後互相包含，雙方都 >2 字」，而且 `find()` 取第一個命中。測試證實：輸入「馬偕紀念醫院」→ `'馬偕紀念'` 包含在 `'台東馬偕紀念'` 裡 → **被配到台東馬偕**，薪資會寫進錯的醫院。

**建議**：模糊比對改成「收集所有命中，剛好一個才採用」（和 `build_boarding_map.py` 的原則一致）；多個命中時列為新醫院候選並印出警告，不要猜。修好後 `salary.test.mjs` 的 todo 會轉綠。

### M-6 🟠 讀 Supabase 時沒有分頁，去重可能失效（未修，需要你確認筆數）

`writeToSupabase()` 用 `GET /rest/v1/salary_reports?select=...` 讀**全部**既有報告來去重。Supabase PostgREST 預設 `max-rows = 1000`。一旦 `salary_reports` 超過 1000 筆，`existingKey` 會不完整 → **同一家醫院、同一個 `source_date` 會被重複寫入**；`latestReportByHosp` 也會選錯筆。`hospitals` 表同理。

**建議**：去重改用 DB 唯一索引 `(hospital_id, source_date)`＋`Prefer: resolution=ignore-duplicates`；或至少分頁讀（`Range` header）。

### 🟡 低

- **L-6** `--days abc` → `parseInt` 得到 `NaN` → 捲動 0 輪 → 0 篇貼文 → 印「Pipeline 完成」。建議驗證參數。
- **L-7** `ageDays()` 不認得「1週」「剛剛」→ 回 `null`，這些貼文不會計入「已看到比窗口還舊的貼文」，會一直捲到上限。
- **L-8** `NAME_KEY` 有 3 個 key 在本季（115Q1）48hr 名單裡零命中：`樂生療養院`、`路竹`、`竹東`（可能是該季沒申報，也可能是官方改名）。Python 測試設定最多容忍 5 個。
- **L-10** `parseAIResult()` 用 greedy 的 `\[[\s\S]*\]`。AI 在 JSON 後面又寫了含 `[` `]` 的說明文字時會解析失敗 → 被 M-4 吞掉變成 `[]`。建議先嘗試抓 ```` ```json ```` 區塊。

---

## 5. 安全性與相依套件

### 5.1 相依套件掃描

| 項目 | 結果 |
|---|---|
| `npm audit --package-lock-only`（`scripts/package-lock.json`） | **0 個弱點**（info/low/moderate/high/critical 都是 0） |
| 鎖定版本 | `playwright` 1.59.1、`playwright-core` 1.59.1、`fsevents` 2.3.2（optional，僅 macOS） |
| 最新版本 | `playwright` 1.64.1（`^1.50.0` 範圍內，不是安全性問題；建議找時間在 Mac 上 `npm update` 並重跑一次 `--dry-run`） |
| Python | 只用標準函式庫（`json`、`urllib`、`pathlib`），沒有第三方套件 |
| 密鑰掃描（`git grep`：`service_role`、JWT、`ghp_`、`github_pat_`、私鑰、AWS key） | 沒有發現。repo 只有 Supabase **publishable** key，本來就是設計成公開的（安全性完全取決於 RLS，見 H-4） |
| 註 | clone 的歷史只有最近 50 個 commit（shallow），更早的歷史沒有掃到 |

### H-4 🔴 Supabase 匿名 key 似乎有寫入權限（未修，需要你到 Supabase 後台確認）

`fetch-fb-salary.mjs` 用 **publishable key** 對 `salary_reports` 做 `POST` 和 **`PATCH ?id=eq.<id>`**，對 `hospitals` 做 `POST`；而 `index.html` 把同一把 key 公開在網頁上。只有兩種可能：

1. **RLS 允許 anon UPDATE `salary_reports`** → 任何人打開 DevTools 就能修改任何一筆薪資的 `source_date`（可能還包括薪資數字）。這是資料完整性問題。
2. **RLS 不允許** → PostgREST 被 RLS 過濾時仍然回 `2xx`（只是影響 0 列），所以「🔄 refresh 新鮮度」**一直是靜默失敗**，程式卻記成 `refreshed++`。

不管是哪一種都要修。**建議**：pipeline 改用只存在 Mac 上的 service key（或專用 RPC，用 `security definer` 限制只能改 `source_date`），anon 只保留 INSERT（如果網頁投稿需要）＋SELECT。本次審查**沒有**查詢正式資料庫，所以無法確認是哪一種。

### M-9 🟠 index.html 有幾個欄位沒有跳脫就放進 innerHTML（未修）

大部分使用者可控的字串都有用 `escapeHtml()`，但以下這幾處直接拼接：

- 第 1874 行：`x.region`、`x.id`
- 第 2071 行：`h.region`、`h.s15`、`h.id`

`hospitals` 表允許網頁端用 anon key `insert`（第 1987 行），`region` 是字串欄位。如果 DB 沒有 `CHECK (region IN (...))` 這類限制，就可以存入 `<img onerror=...>` 造成 stored XSS。**建議**：這幾處也包上 `escapeHtml()`，並在 DB 加上 CHECK 限制。

### 🟡 其他供應鏈與部署面

- **S-1** `supabase-js@2` 用**浮動的 major 版本**，而且沒有 SRI：jsDelivr 上任何新的 2.x 版本（包括被入侵發布的版本）都會直接在網站上執行。建議鎖定確切版本並加上 `integrity=`。`chart.js@4.4.0` 有鎖版本但也沒有 SRI。
- **S-2** GitHub Actions 用 tag（`@v4`）而不是 commit SHA。`congestion.yml` 和 `boarding.yml` 有 `contents: write`，建議改成 SHA pin（可以用 Dependabot 自動更新）。
- **S-3** `fetch-fb-salary.mjs` 的暫存檔用固定路徑 `os.tmpdir()/er-salary-posts.txt`。單人 Mac 上風險很低，但改用 `mkdtemp` 比較乾淨。
- **S-4** `deploy.yml` 用 `upload-pages-artifact` 加上 `path: .`，**整個 repo 都會公開在網站上**（`scripts/`、`.github/`、`docs/`，包括這份報告）。如果 repo 是 private，等於透過 Pages 公開了原始碼。建議只上傳 `index.html` 和 `data/` 白名單裡的檔案。

---

## 6. 驗證方式與限制

### 怎麼驗的

1. 修改前的基準：repo 原本沒有測試也沒有 build，所以先跑了 `node --check`（所有 `.mjs`）、`py_compile`（所有 `.py`）、`bash -n`（所有 `.sh`）、所有 `data/*.json` 的 JSON 解析，全部通過。
2. 修改後：`cd scripts && npm test && npm run build` 全部通過。
3. 等價性：原版和新版 `fetch-congestion.mjs` 在兩份 `data/` 複本上連跑兩個時點，輸出逐位元組相同。
4. Bug 重現：原版在 `sysdate` 格式改變、`data` 為空時的行為如 §4 H-1 所述，已實際執行確認。
5. 回歸：`congestion.test.mjs` 確認從 fixture 算出的結果和 repo 已 commit 的 `congestion-latest.json` 一致；`test_build_boarding_map.py` 確認重算出的對照表和已 commit 的 `boarding-by-hospital.json` 一模一樣。

### Fixture 怎麼來的（重要）

這個執行環境的網路政策**擋掉了 `info.nhi.gov.tw` 和 `med.nhi.gov.tw`**，所以抓不到健保署的原始回應。fixture 是這樣做出來的：

- `congestion-raw.json`：用 repo 內 `data/congestion-latest.json`（2026-11-04 11:15，59 家）依照 `fetch-congestion.mjs` 讀取的欄位名稱（`hosP_ID`、`waiT_GENERAL_CNT`…）**反推**回原始格式，數值存成字串。
- `boarding-s12.json`：用 `data/boarding-latest.json` 前 12 家反推。
- `congestion-raw-edge.json`、`congestion-raw-wrapped-bom.txt`、`ai-output-wrapper.json`、`fb-raw-posts.json`：手工建構的邊界案例。

**限制**：健保署實際回傳的數值是字串還是數字，沒有經過實際驗證（測試兩種都涵蓋了）。建議找時間在 Mac 上把一次真實回應存進 `scripts/test/fixtures/`，取代反推的版本。

### 刻意沒有做的事

- 沒有執行 `fetch-fb-salary.mjs`（會寫入正式的 Supabase）、沒有執行 `build_boarding_map.py main()`（會連正式的 Supabase）。只測試抽出來的純函式。
- 沒有修改 `congestion.yml`、`boarding.yml`、`deploy.yml`、`cron-congestion.sh`：這些會直接影響正式排程和部署，H-2、H-3、M-2、M-7 的修法需要你決定（也需要在 Mac 和 Worker 端一起調整）。
- 沒有修改 `index.html`（M-9、S-1）。
- 沒有查詢 Supabase 的 RLS 設定與資料筆數（H-4、M-6），因為規則不允許碰正式資料庫。

---

## 7. 建議的後續順序

| 順序 | 項目 | 估計工作量 | 理由 |
|---|---|---|---|
| 1 | H-4 到 Supabase 後台看 RLS | 10 分鐘 | 可能已經可以被任何人竄改 |
| 2 | H-3 Worker 加資料新鮮度監控 | 半天 | 一個月缺了 140 小時沒人知道 |
| 3 | H-2 兩邊都改成 reset＋重新產生 | 半天 | 避免 Mac 備援永久停擺 |
| 4 | M-9＋S-1 index.html 跳脫＋鎖定 CDN 版本 | 1 小時 | 改動小、效益明確 |
| 5 | M-5、M-6 FB pipeline 比對與去重 | 半天 | 防止寫錯醫院、重複寫入 |
| 6 | M-3 7 日平均改成依小時分桶 | 2 小時 | 會改變前端數字，需要搭配說明 |
| 7 | M-2、M-7、S-2、S-4 | 各 30 分鐘 | 清理 |
