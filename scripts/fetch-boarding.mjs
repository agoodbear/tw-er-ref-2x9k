#!/usr/bin/env node
// 抓醫療品質資訊公開網「急診轉住院暫留急診超過48小時案件比率」(ind=1652)
// 來源（已逆向）：med.nhi.gov.tw/ihqe0000/IHQE0020S12.ashx，免認證，每季更新。
// 用途：per-hospital 結構性壅塞指標（標準化 %），給薪資×壅塞散點圖 y 軸。
import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dir = dirname(fileURLToPath(import.meta.url));
const DATA = join(__dir, '..', 'data');
if (!existsSync(DATA)) mkdirSync(DATA, { recursive: true });

const BASE = 'https://med.nhi.gov.tw/ihqe0000';
const UA = { 'User-Agent': 'Mozilla/5.0' };
const num = v => (v === null || v === undefined || v === '') ? null : Number(v);

// 1) 找最新季度（S17 回傳 099Q1…的清單，取最後一筆）
const years = await (await fetch(`${BASE}/IHQE0020S17.ashx?q5id=2&ind=1652`, { headers: UA })).json();
const latest = years[years.length - 1];           // { DataTimeID:'114Q3', DataTimeName:'114年第三季' }
const quarter = latest.DataTimeID;

// 2) 抓該季全國資料
const url = `${BASE}/IHQE0020S12.ashx?year=${quarter}&city=&name=&hosp=&special=&q5id=2&ind=1652&bc=`;
const rows = await (await fetch(url, { headers: UA })).json();
if (!Array.isArray(rows) || !rows.length) throw new Error('48hr API 回傳空資料 quarter=' + quarter);

const LEVEL = { '1': '醫學中心', '2': '區域醫院', '3': '地區醫院' };
const hospitals = rows.map(r => ({
  hosp_id: r.HOSP_ID,
  name: r.HOSP_NAME,
  level: r.SPECIAL_NAME || LEVEL[r.SPECIAL_ID] || r.SPECIAL_ID,
  area: r.AREA_NAME,
  ratio: num(r.INDEX1),          // 該院 48hr 暫留比率 %
  n: num(r.NUMERATOR ?? r.N),    // 暫留>48h 案件數
  d: num(r.DENOMINATOR ?? r.D)   // 急診轉住院總案件數
})).filter(h => h.ratio !== null);

const nationalAvg = num(rows[0].INDEX3);  // 全國平均 %

const out = {
  quarter,
  quarterName: latest.DataTimeName,
  nationalAvg,
  fetchedAt: new Date().toISOString(),
  source: 'med.nhi.gov.tw/ihqe0000 (ind=1652)',
  hospitals
};
writeFileSync(join(DATA, 'boarding-latest.json'), JSON.stringify(out, null, 2));

const ranked = [...hospitals].sort((a, b) => b.ratio - a.ratio);
console.log(`OK ${latest.DataTimeName} — ${hospitals.length} 家、全國平均 ${nationalAvg}%`);
console.log('48hr 暫留比率 Top5：', ranked.slice(0, 5).map(h => `${h.name.slice(-6)}(${h.ratio}%)`).join('、'));
