#!/usr/bin/env node
// 把 cf-trigger Worker 帶來的 payload（gzip+base64 JSON）寫成 data/boarding-latest.json，格式跟 fetch-boarding.mjs 一模一樣。
import { writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const out = JSON.parse(gunzipSync(Buffer.from(process.env.PAYLOAD || '', 'base64')).toString('utf8'));
const keys = ['quarter', 'quarterName', 'nationalAvg', 'fetchedAt', 'source', 'hospitals'];
if (JSON.stringify(Object.keys(out)) !== JSON.stringify(keys)) throw new Error('payload 欄位不對：' + Object.keys(out));
if (!/^\d{3}Q[1-4]$/.test(out.quarter) || !Array.isArray(out.hospitals) || out.hospitals.length < 100)
  throw new Error(`payload 內容可疑 quarter=${out.quarter} n=${out.hospitals?.length}`);
const DATA = join(dirname(fileURLToPath(import.meta.url)), '..', 'data');
writeFileSync(join(DATA, 'boarding-latest.json'), JSON.stringify(out, null, 2));
console.log(`OK ${out.quarterName} — ${out.hospitals.length} 家、全國平均 ${out.nationalAvg}%（Worker 抓取 ${out.fetchedAt}）`);
