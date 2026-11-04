#!/usr/bin/env node
// 抓醫療品質資訊公開網「急診轉住院暫留急診超過48小時案件比率」(ind=1652)
// 來源（已逆向）：med.nhi.gov.tw/ihqe0000/IHQE0020S12.ashx，免認證，每季更新。
// 用途：per-hospital 結構性壅塞指標（標準化 %），給薪資×壅塞散點圖 y 軸。
// 解析邏輯在 lib/boarding.mjs（有離線單元測試）。
import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { fetchJsonWithRetry } from './lib/http.mjs';
import { pickLatestQuarter, parseBoardingRows, buildBoardingOutput } from './lib/boarding.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));
const DATA = join(__dir, '..', 'data');
if (!existsSync(DATA)) mkdirSync(DATA, { recursive: true });

const BASE = 'https://med.nhi.gov.tw/ihqe0000';
// 健保署偶爾 520／ECONNRESET：只重試 5xx/429、網路錯誤、逾時、壞 JSON，退避 5s/15s/30s；其他 4xx 直接放棄。
const opts = { init: { headers: { 'User-Agent': 'Mozilla/5.0' } }, backoffMs: [5000, 15000, 30000], label: '健保署' };

// 1) 找最新季度（S17 回傳 099Q1…的清單）
const years = await fetchJsonWithRetry(`${BASE}/IHQE0020S17.ashx?q5id=2&ind=1652`, opts);
const latest = pickLatestQuarter(years);  // { DataTimeID:'114Q3', DataTimeName:'114年第三季' }
const quarter = latest.DataTimeID;

// 2) 抓該季全國資料
const url = `${BASE}/IHQE0020S12.ashx?year=${quarter}&city=&name=&hosp=&special=&q5id=2&ind=1652&bc=`;
const rows = await fetchJsonWithRetry(url, opts);
const { hospitals, nationalAvg, warnings } = parseBoardingRows(rows, quarter);
for (const w of warnings) console.warn('⚠️ ' + w);

const out = buildBoardingOutput({ latest, hospitals, nationalAvg });
writeFileSync(join(DATA, 'boarding-latest.json'), JSON.stringify(out, null, 2));

const ranked = [...hospitals].sort((a, b) => b.ratio - a.ratio);
console.log(`OK ${latest.DataTimeName} — ${hospitals.length} 家、全國平均 ${nationalAvg}%`);
console.log('48hr 暫留比率 Top5：', ranked.slice(0, 5).map(h => `${h.name.slice(-6)}(${h.ratio}%)`).join('、'));
