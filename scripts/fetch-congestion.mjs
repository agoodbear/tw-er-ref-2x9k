#!/usr/bin/env node
// 抓健保署「重度級急救責任醫院急診即時訊息」→ 產生急診壅塞資料
// 來源（已逆向）：POST https://info.nhi.gov.tw/api/inae4000/inae4001s01/SQL0002
// 免認證、無 CAPTCHA、每小時整點更新，回傳全國 ~59 家急救責任醫院。
//
// 沒有額外輸入時，行為與以前相同：自己 POST 健保署（含重試）。
// Cloudflare Worker 改由 repository_dispatch 送原始回應時：
//   --raw-file <path>   或環境變數 CONGESTION_RAW_FILE  直接處理該 JSON 檔
//   --raw-url  <https>  或環境變數 CONGESTION_RAW_URL   先 GET 該 URL 再處理
// 兩者都給時以檔案為準。歷史、同 sysdate 去重、7 日平均都走 lib/congestion.mjs 同一段。
//
// 回應驗證不過（空 data、sysdate 格式不符、全部無通報）→ 不寫任何檔、以非 0 結束，
// 讓 workflow / launchd 走失敗告警路徑，而不是把壞資料寫進 history。
import { writeFileSync, readFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { processCongestion, parseRawText, validateRaw, staleAgainst } from './lib/congestion.mjs';
import { fetchJsonWithRetry } from './lib/http.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));
const DATA = process.env.CONGESTION_DATA_DIR || join(__dir, '..', 'data');
if (!existsSync(DATA)) mkdirSync(DATA, { recursive: true });

const API = 'https://info.nhi.gov.tw/api/inae4000/inae4001s01/SQL0002';
// 健保署 API 偶發連線重置（ECONNRESET）/ 逾時 → 重試 + 退避（2s → 4s → 6s，共 4 次）
const BACKOFF_MS = [2000, 4000, 6000];

function cliFlag(flag) {
  const pref = flag + '=';
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a === flag) {
      const v = process.argv[i + 1];
      if (v === undefined || v.startsWith('--')) {
        console.error(`${flag} 需要一個參數`);
        process.exit(1);
      }
      return v;
    }
    if (a.startsWith(pref)) return a.slice(pref.length);
  }
  return '';
}

// 先寫暫存檔再 rename，避免寫到一半被中斷留下半截 JSON
function writeJsonAtomic(path, obj, pretty) {
  const tmp = path + '.tmp';
  writeFileSync(tmp, pretty ? JSON.stringify(obj, null, 2) : JSON.stringify(obj));
  renameSync(tmp, path);
}

const rawFile = cliFlag('--raw-file') || process.env.CONGESTION_RAW_FILE || '';
const rawUrl = cliFlag('--raw-url') || process.env.CONGESTION_RAW_URL || '';

let json;
if (rawFile) {
  json = parseRawText(readFileSync(rawFile, 'utf8'));
} else if (rawUrl) {
  let url;
  try { url = new URL(rawUrl); } catch { url = null; }
  if (!url || (url.protocol !== 'https:' && url.protocol !== 'http:')) {
    console.error('raw url 必須是 http(s)：' + rawUrl);
    process.exit(1);
  }
  json = await fetchJsonWithRetry(rawUrl, {
    init: { method: 'GET', headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' } },
    backoffMs: BACKOFF_MS, label: 'raw_url', parse: parseRawText
  });
} else {
  json = await fetchJsonWithRetry(API, {
    init: {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0' },
      body: JSON.stringify({ AREA_NO: '', CONT_TYPE: '' })
    },
    backoffMs: BACKOFF_MS, label: '健保署 API'
  });
}

const hhPath = join(DATA, 'congestion-hosp-history.json');
const histPath = join(DATA, 'congestion-history.json');
const hh = existsSync(hhPath) ? JSON.parse(readFileSync(hhPath, 'utf8')) : [];
const hist = existsSync(histPath) ? JSON.parse(readFileSync(histPath, 'utf8')) : [];

// 驗證在這裡發生；拋錯就一個檔都不寫
const stale = staleAgainst([hist, hh], validateRaw(json).sysdate);
if (stale) {
  // 不是錯誤（不需告警），但也不能寫：exit 0、檔案不動 → 後面的 commit 步驟會看到「無變化」
  console.warn(`STALE_SKIP 本次 sysdate ${json.sysdate} 比歷史末筆 ${stale} 舊，略過不寫`);
  process.exit(0);
}
const { latest, hh: hhOut, hist: histOut, ranked, hWin, unknownAreaCodes } = processCongestion(json, { hh, hist });

writeJsonAtomic(hhPath, hhOut, false);
writeJsonAtomic(histPath, histOut, true);
writeJsonAtomic(join(DATA, 'congestion-latest.json'), latest, true);

const { sysdate, hospitals, regions } = latest;
if (unknownAreaCodes.length) console.warn(`⚠️ 未知縣市碼（不進區平均）：${unknownAreaCodes.join(', ')}`);
console.log(`OK ${sysdate} — ${hospitals.length} 家醫院 / ${ranked.length} 家有通報 / ${regions.length} 區 / 7 天視窗 ${hWin.length} 個時點、${hospitals.filter(h => h.avg7d != null).length} 家有 avg7d`);
console.log('滯留人數 Top5：', ranked.slice(0, 5).map(h => `${h.name}(${h.score})`).join('、'));
console.log('各區平均 Top5：', regions.slice(0, 5).map(r => `${r.region}(${r.avgScore},n=${r.n})`).join('、'));
