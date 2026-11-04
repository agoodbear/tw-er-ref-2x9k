#!/usr/bin/env node
// 把 cf-trigger Worker 帶來的 payload（gzip+base64 JSON）寫成 data/boarding-latest.json，格式跟 fetch-boarding.mjs 一模一樣。
// 驗證邏輯在 lib/boarding.mjs decodeBoardingPayload（有離線單元測試）。
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { decodeBoardingPayload } from './lib/boarding.mjs';

const out = decodeBoardingPayload(process.env.PAYLOAD || '');
const DATA = join(dirname(fileURLToPath(import.meta.url)), '..', 'data');
writeFileSync(join(DATA, 'boarding-latest.json'), JSON.stringify(out, null, 2));
console.log(`OK ${out.quarterName} — ${out.hospitals.length} 家、全國平均 ${out.nationalAvg}%（Worker 抓取 ${out.fetchedAt}）`);
