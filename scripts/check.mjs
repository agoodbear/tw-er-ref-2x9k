#!/usr/bin/env node
// 「build」檢查：本站是純靜態（index.html + data/*.json），沒有編譯步驟，
// 這裡把「部署前會壞掉的東西」全部離線檢查一遍。任何一項失敗 → exit 1。
//   1. scripts/**/*.mjs 語法（node --check）
//   2. scripts/**/*.py 語法（py_compile）
//   3. scripts/*.sh 語法（bash -n）
//   4. data/*.json 可解析、核心資料檔結構合理
//   5. index.html 內嵌 <script> 語法、引用的 data/*.json 都存在且有進版控白名單
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';
import vm from 'node:vm';
import { tsOf } from './lib/congestion.mjs';
import { OUTPUT_KEYS, QUARTER_RE } from './lib/boarding.mjs';

const SCRIPTS = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SCRIPTS, '..');
const failures = [];
let checks = 0;
const ok = (cond, msg) => { checks++; if (!cond) failures.push(msg); };

function walk(dir, exts, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.') || name === '__pycache__') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, exts, out);
    else if (exts.some(e => name.endsWith(e))) out.push(p);
  }
  return out;
}
const sh = (cmd, args) => spawnSync(cmd, args, { encoding: 'utf8' });

// 1–3 語法
for (const f of walk(SCRIPTS, ['.mjs'])) {
  const r = sh(process.execPath, ['--check', f]);
  ok(r.status === 0, `node --check ${relative(ROOT, f)}\n${r.stderr}`);
}
for (const f of walk(SCRIPTS, ['.py'])) {
  const r = sh('python3', ['-c', 'import ast,sys; ast.parse(open(sys.argv[1], encoding="utf-8").read(), sys.argv[1])', f]);
  ok(r.status === 0, `python 語法 ${relative(ROOT, f)}\n${r.stderr}`);
}
for (const f of walk(SCRIPTS, ['.sh'])) {
  const r = sh('bash', ['-n', f]);
  ok(r.status === 0, `bash -n ${relative(ROOT, f)}\n${r.stderr}`);
}

// 4 資料檔
const DATA = join(ROOT, 'data');
const json = {};
for (const name of readdirSync(DATA).filter(n => n.endsWith('.json'))) {
  try { json[name] = JSON.parse(readFileSync(join(DATA, name), 'utf8')); ok(true); }
  catch (e) { ok(false, `data/${name} 不是合法 JSON：${e.message}`); }
}
const cl = json['congestion-latest.json'];
if (cl) {
  ok(Number.isFinite(tsOf(cl.sysdate)), `congestion-latest.sysdate 格式不符：${cl.sysdate}`);
  ok(Array.isArray(cl.hospitals) && cl.hospitals.length > 0, 'congestion-latest.hospitals 為空');
  ok(Array.isArray(cl.regions) && cl.regions.length > 0, 'congestion-latest.regions 為空');
}
const ch = json['congestion-history.json'];
if (ch) ok(Array.isArray(ch) && ch.every(e => Number.isFinite(tsOf(e.sysdate))), 'congestion-history 有壞 sysdate');
const chh = json['congestion-hosp-history.json'];
if (chh) ok(Array.isArray(chh) && chh.length > 0 && chh.every(e => Number.isFinite(tsOf(e.sysdate)) && e.s && typeof e.s === 'object'), 'congestion-hosp-history 為空或有壞筆');
const bl = json['boarding-latest.json'];
if (bl) {
  ok(JSON.stringify(Object.keys(bl)) === JSON.stringify(OUTPUT_KEYS), 'boarding-latest 欄位不符');
  ok(QUARTER_RE.test(bl.quarter), `boarding-latest.quarter 格式不符：${bl.quarter}`);
}
const bb = json['boarding-by-hospital.json'];
if (bb) ok(bb.meta && bb.hospitals && Object.keys(bb.hospitals).length === bb.meta.matched, 'boarding-by-hospital meta.matched 與內容不符');

// 5 index.html
const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
const inline = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
ok(inline.length > 0, 'index.html 找不到內嵌 <script>');
inline.forEach((code, i) => {
  try { new vm.Script(code, { filename: `index.html#script${i}` }); ok(true); }
  catch (e) { ok(false, `index.html 第 ${i} 段 <script> 語法錯誤：${e.message}`); }
});
const gitignore = readFileSync(join(ROOT, '.gitignore'), 'utf8');
for (const ref of new Set([...html.matchAll(/['"`](data\/[\w.-]+\.json)['"`]/g)].map(m => m[1]))) {
  ok(existsSync(join(ROOT, ref)), `index.html 引用的 ${ref} 不存在`);
  ok(gitignore.includes('!' + ref), `index.html 引用的 ${ref} 沒在 .gitignore 白名單（data/* 預設忽略，部署會缺檔）`);
}

if (failures.length) {
  console.error(`❌ build 檢查失敗 ${failures.length} / ${checks} 項：\n- ` + failures.join('\n- '));
  process.exit(1);
}
console.log(`✅ build 檢查通過（${checks} 項）`);
