#!/usr/bin/env node
// 抓健保署「重度級急救責任醫院急診即時訊息」→ 產生急診壅塞資料
// 來源（已逆向）：POST https://info.nhi.gov.tw/api/inae4000/inae4001s01/SQL0002
// 免認證、無 CAPTCHA、每小時整點更新，回傳全國 ~59 家急救責任醫院。
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dir = dirname(fileURLToPath(import.meta.url));
const DATA = join(__dir, '..', 'data');
if (!existsSync(DATA)) mkdirSync(DATA, { recursive: true });

const API = 'https://info.nhi.gov.tw/api/inae4000/inae4001s01/SQL0002';

// 縣市碼 → 薪資 Dashboard 的 17 區名（地圖用「台」不是「臺」、市縣合併）。
// 外島（金門90/連江91/澎湖44）保留：地圖無 path，但全國排名仍納入。
const CODE2REGION = {
  '01': '台北', '11': '基隆', '31': '新北', '34': '宜蘭', '12': '新竹', '32': '桃園',
  '33': '新竹', '35': '苗栗', '03': '台中', '37': '彰化', '38': '南投', '05': '台南',
  '22': '嘉義', '39': '雲林', '40': '嘉義', '07': '高雄', '43': '屏東', '45': '花蓮',
  '46': '台東', '90': '金門', '91': '連江', '44': '澎湖'
};
const LEVEL = { '1': '醫學中心', '2': '區域醫院', '3': '地區醫院' };

const num = v => (v === null || v === undefined || v === '') ? null : Number(v);

// 急診滯留總人數（census）＝ 等待看診 + 等待住院 + 推床 + 等待加護病房（不加權）。
// 依據：boarding（等住院）是國際文獻＋健保署即時系統公認的壅塞核心；四佇列加總≈ ED census，
// 文獻（PMC8742612 系統性回顧）指 census 為效力不輸 NEDOCS 的最簡單即時指標。
// NEDOCS/EDWIN 需 ED 床數/全院床數/最久等待時數/插管數等本 API 未提供之欄位，故無法採用。
// ⚠️ 限制：無床數資料 → 未做占床率正規化，屬「絕對負荷量」、天生偏向大醫院。
// 四項全缺 → null（該院未通報，不參與排名/平均，不可當 0）。
function score(h) {
  const bed = num(h.waiT_GENERAL_CNT);  // 等待住院（boarding，核心指標）
  const icu = num(h.waiT_ICU_CNT);      // 等待加護病房
  const push = num(h.waiT_BED_CNT);     // 推床
  const see = num(h.waiT_SEE_CNT);      // 等待看診
  if (bed === null && icu === null && push === null && see === null) return null;
  return (bed || 0) + (icu || 0) + (push || 0) + (see || 0);
}

// 健保署 API 偶發連線重置（ECONNRESET）/ 逾時 → 重試 + 退避，避免單次瞬斷就讓整個排程失敗寄錯誤信
async function fetchWithRetry(url, opts, tries = 4) {
  let lastErr;
  for (let i = 1; i <= tries; i++) {
    try {
      const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(20000) });
      if (!res.ok) throw new Error('健保署 API 回傳 ' + res.status);
      return res;
    } catch (e) {
      lastErr = e;
      if (i < tries) {
        const wait = 2000 * i;  // 2s → 4s → 6s 退避
        console.warn(`第 ${i}/${tries} 次抓取失敗（${e.cause?.code || e.message}），${wait}ms 後重試…`);
        await new Promise(r => setTimeout(r, wait));
      }
    }
  }
  throw lastErr;
}

const res = await fetchWithRetry(API, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0' },
  body: JSON.stringify({ AREA_NO: '', CONT_TYPE: '' })
});
const json = await res.json();
const sysdate = json.sysdate;
const rows = json.data || [];

const hospitals = rows.map(h => ({
  id: h.hosP_ID,
  name: h.hosP_NAME,
  region: CODE2REGION[h.areA_NO_N] || null,
  areaCode: h.areA_NO_N,
  level: LEVEL[h.conT_TYPE] || h.conT_TYPE,
  wait_admit: num(h.waiT_GENERAL_CNT),
  wait_icu: num(h.waiT_ICU_CNT),
  wait_push: num(h.waiT_BED_CNT),
  wait_see: num(h.waiT_SEE_CNT),
  full: h.inform === 'Y',
  score: score(h),
  txt_date: h.txT_DATE
}));

// 全國壅塞排名（只排有通報分數的）
const ranked = hospitals.filter(h => h.score !== null).sort((a, b) => b.score - a.score);
ranked.forEach((h, i) => { h.rank = i + 1; h.rankTotal = ranked.length; });

// 各區聚合：平均壅塞分數
const agg = {};
for (const h of hospitals) {
  if (!h.region || h.score === null) continue;
  (agg[h.region] ||= { region: h.region, scores: [], hospitals: [] });
  agg[h.region].scores.push(h.score);
  agg[h.region].hospitals.push(h.name);
}
const regions = Object.values(agg).map(r => ({
  region: r.region,
  n: r.scores.length,
  avgScore: Math.round(r.scores.reduce((a, b) => a + b, 0) / r.scores.length * 10) / 10,
  hospitals: r.hospitals
})).sort((a, b) => b.avgScore - a.avgScore);

// ── 近 7 天平均（散點圖縱軸用；單一時點太吵，一個尖峰就能讓一家醫院換象限）──
// 每家醫院的逐時分數另存 congestion-hosp-history.json（緊湊格式、只留 8 天），
// 區平均沿用 congestion-history.json 的 regions。視窗＝本次 sysdate 往前 168 小時。
// 覆蓋率 < 50%（84 個小時點）就不給 avg7d，前端退回當下數字並標示。
const WINDOW_H = 168, MIN_N = 84;
const tsOf = sd => Date.parse(sd.replace(' ', 'T') + ':00+08:00');
const nowTs = tsOf(sysdate);
const hhPath = join(DATA, 'congestion-hosp-history.json');
let hh = existsSync(hhPath) ? JSON.parse(readFileSync(hhPath, 'utf8')) : [];
const hEntry = { sysdate, s: Object.fromEntries(hospitals.filter(h => h.score !== null).map(h => [h.id, h.score])) };
if (hh.length && hh[hh.length - 1].sysdate === sysdate) hh[hh.length - 1] = hEntry; else hh.push(hEntry);
hh = hh.filter(e => nowTs - tsOf(e.sysdate) < 8 * 24 * 3600e3);
writeFileSync(hhPath, JSON.stringify(hh));
const inWin = e => { const d = nowTs - tsOf(e.sysdate); return d >= 0 && d < WINDOW_H * 3600e3; };
const r1 = v => Math.round(v * 10) / 10;
const hWin = hh.filter(inWin);
for (const h of hospitals) {
  const v = hWin.map(e => e.s[h.id]).filter(x => x != null);
  h.n7d = v.length;
  h.avg7d = v.length >= MIN_N ? r1(v.reduce((a, b) => a + b, 0) / v.length) : null;
}
const out = { sysdate, fetchedAt: new Date().toISOString(), window7d: { hours: WINDOW_H, minN: MIN_N, snapshots: hWin.length }, hospitals, regions };
writeFileSync(join(DATA, 'congestion-latest.json'), JSON.stringify(out, null, 2));

// 時間序列歷史（給「近 7 天平均」用），上限 ~3000 筆防爆
// 同 sysdate 去重：手動補跑＋launchd 同一小時各跑一次時，覆蓋末筆而非重複 append（避免未來平均重複加權）
const histPath = join(DATA, 'congestion-history.json');
const hist = existsSync(histPath) ? JSON.parse(readFileSync(histPath, 'utf8')) : [];
const entry = { sysdate, regions: regions.map(r => ({ region: r.region, avgScore: r.avgScore, n: r.n })) };
if (hist.length && hist[hist.length - 1].sysdate === sysdate) hist[hist.length - 1] = entry;
else hist.push(entry);
writeFileSync(histPath, JSON.stringify(hist.slice(-3000), null, 2));

// 區平均的近 7 天值（regions 已排序，直接補欄位後重寫 latest）
const rWin = hist.filter(inWin);
for (const r of regions) {
  const v = rWin.map(e => e.regions.find(x => x.region === r.region)?.avgScore).filter(x => x != null);
  r.n7d = v.length;
  r.avg7d = v.length >= MIN_N ? r1(v.reduce((a, b) => a + b, 0) / v.length) : null;
}
writeFileSync(join(DATA, 'congestion-latest.json'), JSON.stringify(out, null, 2));

console.log(`OK ${sysdate} — ${hospitals.length} 家醫院 / ${ranked.length} 家有通報 / ${regions.length} 區 / 7 天視窗 ${hWin.length} 個時點、${hospitals.filter(h => h.avg7d != null).length} 家有 avg7d`);
console.log('滯留人數 Top5：', ranked.slice(0, 5).map(h => `${h.name}(${h.score})`).join('、'));
console.log('各區平均 Top5：', regions.slice(0, 5).map(r => `${r.region}(${r.avgScore},n=${r.n})`).join('、'));
