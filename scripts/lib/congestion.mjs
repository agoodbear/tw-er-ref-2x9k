// 急診壅塞資料的純函式（無 I/O），供 fetch-congestion.mjs 與單元測試共用。
// 任何網路／檔案存取都留在 fetch-congestion.mjs，這裡只做「原始 JSON → 輸出結構」。

// 縣市碼 → 薪資 Dashboard 的 17 區名（地圖用「台」不是「臺」、市縣合併）。
// 外島（金門90/連江91/澎湖44）保留：地圖無 path，但全國排名仍納入。
export const CODE2REGION = {
  '01': '台北', '11': '基隆', '31': '新北', '34': '宜蘭', '12': '新竹', '32': '桃園',
  '33': '新竹', '35': '苗栗', '03': '台中', '37': '彰化', '38': '南投', '05': '台南',
  '22': '嘉義', '39': '雲林', '40': '嘉義', '07': '高雄', '43': '屏東', '45': '花蓮',
  '46': '台東', '90': '金門', '91': '連江', '44': '澎湖'
};
export const LEVEL = { '1': '醫學中心', '2': '區域醫院', '3': '地區醫院' };

export const WINDOW_H = 168;   // 7 天視窗（小時）
export const MIN_N = 84;       // 覆蓋率 < 50% 不給 avg7d
export const HOSP_HISTORY_DAYS = 8;
export const HISTORY_MAX = 3000;

// 欄位值 → 數字或 null。
// 空字串、純空白、非數字（'-'、'N/A'）、Infinity 一律視為「未通報」(null)，不可當 0。
// （舊版 Number(' ') === 0、Number('-') === NaN，前者會把未通報算成 0 參與排名）
export const num = v => {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string' && v.trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

// 急診滯留總人數（census）＝ 等待看診 + 等待住院 + 推床 + 等待加護病房（不加權）。
// 依據：boarding（等住院）是國際文獻＋健保署即時系統公認的壅塞核心；四佇列加總≈ ED census，
// 文獻（PMC8742612 系統性回顧）指 census 為效力不輸 NEDOCS 的最簡單即時指標。
// NEDOCS/EDWIN 需 ED 床數/全院床數/最久等待時數/插管數等本 API 未提供之欄位，故無法採用。
// ⚠️ 限制：無床數資料 → 未做占床率正規化，屬「絕對負荷量」、天生偏向大醫院。
// 四項全缺 → null（該院未通報，不參與排名/平均，不可當 0）。
export function score(h) {
  const bed = num(h.waiT_GENERAL_CNT);  // 等待住院（boarding，核心指標）
  const icu = num(h.waiT_ICU_CNT);      // 等待加護病房
  const push = num(h.waiT_BED_CNT);     // 推床
  const see = num(h.waiT_SEE_CNT);      // 等待看診
  if (bed === null && icu === null && push === null && see === null) return null;
  return (bed || 0) + (icu || 0) + (push || 0) + (see || 0);
}

// 健保署 sysdate（'YYYY-MM-DD HH:mm'，台灣時間）→ epoch ms；格式不符回傳 NaN。
export const tsOf = sd => {
  if (typeof sd !== 'string' || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(sd)) return NaN;
  return Date.parse(sd.replace(' ', 'T') + ':00+08:00');
};

// 原始回應的「能不能寫檔」檢查。任何一項不過就拋錯 → 腳本非 0 結束 → workflow／launchd 走失敗告警路徑，
// 而不是把空資料或壞時間寫進 history（壞 sysdate 會讓 8 天過濾把整份 hosp-history 清空）。
export function validateRaw(json) {
  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    throw new Error('健保署回應不是 JSON 物件');
  }
  if (!Number.isFinite(tsOf(json.sysdate))) {
    throw new Error(`健保署回應 sysdate 格式不符：${JSON.stringify(json.sysdate)}`);
  }
  if (!Array.isArray(json.data) || json.data.length === 0) {
    throw new Error('健保署回應 data 為空（官方 API 行為可能已變）');
  }
  const reported = json.data.filter(h => score(h) !== null).length;
  if (reported === 0) {
    throw new Error(`健保署回應 ${json.data.length} 家全部無通報數字（欄位名稱可能已變）`);
  }
  return { sysdate: json.sysdate, rows: json.data, reported };
}

export function mapHospital(h) {
  return {
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
  };
}

// 全國壅塞排名（只排有通報分數的）。會就地補 rank / rankTotal，回傳排好的陣列。
export function rankHospitals(hospitals) {
  const ranked = hospitals.filter(h => h.score !== null).sort((a, b) => b.score - a.score);
  ranked.forEach((h, i) => { h.rank = i + 1; h.rankTotal = ranked.length; });
  return ranked;
}

// 各區聚合：平均壅塞分數（無 region 或無分數者不納入）
export function aggregateRegions(hospitals) {
  const agg = {};
  for (const h of hospitals) {
    if (!h.region || h.score === null) continue;
    (agg[h.region] ||= { region: h.region, scores: [], hospitals: [] });
    agg[h.region].scores.push(h.score);
    agg[h.region].hospitals.push(h.name);
  }
  return Object.values(agg).map(r => ({
    region: r.region,
    n: r.scores.length,
    avgScore: Math.round(r.scores.reduce((a, b) => a + b, 0) / r.scores.length * 10) / 10,
    hospitals: r.hospitals
  })).sort((a, b) => b.avgScore - a.avgScore);
}

export const r1 = v => Math.round(v * 10) / 10;

// 時間序列 upsert：末筆同 sysdate 就覆蓋，否則 append（同一小時手動補跑＋launchd 不重複加權）。
export function upsertLast(list, entry) {
  const out = list.slice();
  if (out.length && out[out.length - 1].sysdate === entry.sysdate) out[out.length - 1] = entry;
  else out.push(entry);
  return out;
}

// 本次 sysdate 比既有歷史末筆「舊」→ 回傳末筆 sysdate（呼叫端應略過、不寫檔）；否則 null。
// 情境：Worker 重送舊的 raw、或手動備援抓到快取的舊回應。舊版會照樣 append，
// 造成 history 時間倒序、latest.json 退回舊資料。
export function staleAgainst(lists, sysdate) {
  const now = tsOf(sysdate);
  for (const list of lists) {
    const last = list.length ? list[list.length - 1].sysdate : null;
    if (last && Number.isFinite(tsOf(last)) && tsOf(last) > now) return last;
  }
  return null;
}

// 每家醫院逐時分數（緊湊格式）：upsert 後只留 nowTs 往前 8 天。
// 時間戳解析不了的舊筆直接丟掉（不讓單筆壞資料拖垮整份）。
export function updateHospHistory(hh, sysdate, hospitals) {
  const nowTs = tsOf(sysdate);
  const hEntry = { sysdate, s: Object.fromEntries(hospitals.filter(h => h.score !== null).map(h => [h.id, h.score])) };
  return upsertLast(hh, hEntry).filter(e => nowTs - tsOf(e.sysdate) < HOSP_HISTORY_DAYS * 24 * 3600e3);
}

export function inWindow(nowTs, e) {
  const d = nowTs - tsOf(e.sysdate);
  return d >= 0 && d < WINDOW_H * 3600e3;
}

// 平均；樣本數 < MIN_N 回 null（前端退回當下數字並標示）
export function avgOrNull(values) {
  return values.length >= MIN_N ? r1(values.reduce((a, b) => a + b, 0) / values.length) : null;
}

export function applyHospAvg7d(hospitals, hh, nowTs) {
  const hWin = hh.filter(e => inWindow(nowTs, e));
  for (const h of hospitals) {
    const v = hWin.map(e => e.s[h.id]).filter(x => x != null);
    h.n7d = v.length;
    h.avg7d = avgOrNull(v);
  }
  return hWin;
}

export function regionHistoryEntry(sysdate, regions) {
  return { sysdate, regions: regions.map(r => ({ region: r.region, avgScore: r.avgScore, n: r.n })) };
}

export function applyRegionAvg7d(regions, hist, nowTs) {
  const rWin = hist.filter(e => inWindow(nowTs, e));
  for (const r of regions) {
    const v = rWin.map(e => e.regions.find(x => x.region === r.region)?.avgScore).filter(x => x != null);
    r.n7d = v.length;
    r.avg7d = avgOrNull(v);
  }
}

// 主流程（純函式版）：原始 JSON + 既有歷史 → 三份輸出。
// fetchedAt 由呼叫端給，方便測試固定值。
export function processCongestion(json, { hh = [], hist = [], fetchedAt = new Date().toISOString() } = {}) {
  const { sysdate } = validateRaw(json);
  const nowTs = tsOf(sysdate);
  const hospitals = json.data.map(mapHospital);
  const ranked = rankHospitals(hospitals);
  const regions = aggregateRegions(hospitals);

  const hhOut = updateHospHistory(hh, sysdate, hospitals);
  const hWin = applyHospAvg7d(hospitals, hhOut, nowTs);

  const histOut = upsertLast(hist, regionHistoryEntry(sysdate, regions)).slice(-HISTORY_MAX);
  applyRegionAvg7d(regions, histOut, nowTs);

  const latest = {
    sysdate, fetchedAt,
    window7d: { hours: WINDOW_H, minN: MIN_N, snapshots: hWin.length },
    hospitals, regions
  };
  const unknownAreaCodes = [...new Set(hospitals.filter(h => !h.region).map(h => h.areaCode))];
  return { latest, hh: hhOut, hist: histOut, ranked, hWin, unknownAreaCodes };
}

// 把 body 再包成字串的情況（repository_dispatch）解開一層；去 BOM。
export function parseRawText(text) {
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  let parsed = JSON.parse(text);
  if (typeof parsed === 'string') parsed = JSON.parse(parsed);
  return parsed;
}
