// 48hr 暫留比率（醫療品質資訊公開網 ind=1652）的純函式，供 fetch-boarding.mjs、
// write-boarding-payload.mjs 與單元測試共用。
import { gunzipSync } from 'node:zlib';
import { num } from './congestion.mjs';

export { num };
export const LEVEL = { '1': '醫學中心', '2': '區域醫院', '3': '地區醫院' };
export const SOURCE = 'med.nhi.gov.tw/ihqe0000 (ind=1652)';
export const OUTPUT_KEYS = ['quarter', 'quarterName', 'nationalAvg', 'fetchedAt', 'source', 'hospitals'];
export const QUARTER_RE = /^\d{3}Q[1-4]$/;
export const MIN_HOSPITALS = 100;

// S17 季度清單 → 最新一季。
// 防禦：清單 ascending 屬官方 API 未文件化行為，不依賴——自行取 DataTimeID 字典序最大
// （'099Q1'<'114Q3'，三位年+固定寬度季，字典序＝時間序）。格式不符的項目忽略。
export function pickLatestQuarter(years) {
  if (!Array.isArray(years) || !years.length) throw new Error('S17 季度清單空回應（官方 API 行為可能已變）');
  const valid = years.filter(y => y && QUARTER_RE.test(String(y.DataTimeID)));
  if (!valid.length) throw new Error('S17 季度清單沒有合法 DataTimeID（格式可能已變）');
  return valid.reduce((a, b) => (String(b.DataTimeID) > String(a.DataTimeID) ? b : a));
}

export function mapBoardingRow(r) {
  return {
    hosp_id: r.HOSP_ID,
    name: r.HOSP_NAME,
    level: r.SPECIAL_NAME || LEVEL[r.SPECIAL_ID] || r.SPECIAL_ID,
    area: r.AREA_NAME,
    ratio: num(r.INDEX1),          // 該院 48hr 暫留比率 %
    n: num(r.NUMERATOR ?? r.N),    // 暫留>48h 案件數
    d: num(r.DENOMINATOR ?? r.D)   // 急診轉住院總案件數
  };
}

// S12 回應 → { hospitals, nationalAvg, warnings }
export function parseBoardingRows(rows, quarter) {
  if (!Array.isArray(rows) || !rows.length) throw new Error('48hr API 回傳空資料 quarter=' + quarter);
  const hospitals = rows.map(mapBoardingRow).filter(h => h.ratio !== null);
  const warnings = [];
  // 全國平均：依賴 rows[0] 帶 INDEX3 的未文件化行為
  const nationalAvg = num(rows[0].INDEX3);
  if (nationalAvg === null) warnings.push('rows[0].INDEX3 取不到全國平均（官方 API 行為可能已變），nationalAvg 將為 null');
  const outOfRange = hospitals.filter(h => h.ratio < 0 || h.ratio > 100);
  if (outOfRange.length) warnings.push(`${outOfRange.length} 家 ratio 超出 0–100：${outOfRange.slice(0, 3).map(h => h.name).join('、')}`);
  return { hospitals, nationalAvg, warnings };
}

export function buildBoardingOutput({ latest, hospitals, nationalAvg, fetchedAt = new Date().toISOString() }) {
  return {
    quarter: latest.DataTimeID,
    quarterName: latest.DataTimeName,
    nationalAvg,
    fetchedAt,
    source: SOURCE,
    hospitals
  };
}

// Worker 帶來的 payload（gzip+base64 JSON）→ 驗證過的輸出物件；格式跟 fetch-boarding.mjs 一模一樣。
export function decodeBoardingPayload(payload) {
  if (!payload) throw new Error('PAYLOAD 是空的');
  const out = JSON.parse(gunzipSync(Buffer.from(payload, 'base64')).toString('utf8'));
  if (JSON.stringify(Object.keys(out)) !== JSON.stringify(OUTPUT_KEYS)) throw new Error('payload 欄位不對：' + Object.keys(out));
  if (!QUARTER_RE.test(out.quarter) || !Array.isArray(out.hospitals) || out.hospitals.length < MIN_HOSPITALS)
    throw new Error(`payload 內容可疑 quarter=${out.quarter} n=${out.hospitals?.length}`);
  const bad = out.hospitals.filter(h => !h || typeof h.name !== 'string' || typeof h.ratio !== 'number' || !Number.isFinite(h.ratio));
  if (bad.length) throw new Error(`payload 有 ${bad.length} 筆醫院缺 name 或 ratio 非數字`);
  return out;
}
