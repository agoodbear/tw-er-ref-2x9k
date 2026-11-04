// fetch-congestion.mjs 的端到端測試：用 --raw-file + 暫存資料夾，不連網、不動 repo 的 data/
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, '..', 'fetch-congestion.mjs');
const FX = join(HERE, 'fixtures');

function run(args, dataDir) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    env: { ...process.env, CONGESTION_DATA_DIR: dataDir, CONGESTION_RAW_FILE: '', CONGESTION_RAW_URL: '' },
    encoding: 'utf8'
  });
}
const tmp = () => mkdtempSync(join(tmpdir(), 'cong-test-'));

describe('fetch-congestion.mjs --raw-file', () => {
  test('正常：寫出三個檔、exit 0、沒有殘留 .tmp', () => {
    const dir = tmp();
    try {
      const r = run(['--raw-file', join(FX, 'congestion-raw.json')], dir);
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /OK 2026-11-04 11:15 — 59 家醫院 \/ 55 家有通報/);
      assert.deepEqual(readdirSync(dir).sort(), ['congestion-history.json', 'congestion-hosp-history.json', 'congestion-latest.json']);
      const latest = JSON.parse(readFileSync(join(dir, 'congestion-latest.json'), 'utf8'));
      assert.equal(latest.hospitals.length, 59);
      assert.ok(latest.regions.every(r => 'avg7d' in r), '最後寫出的 latest 要含區 avg7d');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('--raw-file=path 形式也可、BOM + 字串包一層可解', () => {
    const dir = tmp();
    try {
      const r = run([`--raw-file=${join(FX, 'congestion-raw-wrapped-bom.txt')}`], dir);
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /OK 2026-11-04 09:00 — 1 家醫院/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('未知縣市碼 → 警告但仍成功', () => {
    const dir = tmp();
    try {
      const r = run(['--raw-file', join(FX, 'congestion-raw-edge.json')], dir);
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stderr, /未知縣市碼.*99/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  for (const [name, raw] of [
    ['data 為空', { sysdate: '2026-11-04 12:15', data: [] }],
    ['sysdate 格式改變', { ...JSON.parse(readFileSync(join(FX, 'congestion-raw.json'), 'utf8')), sysdate: '2026/11/04 12:15' }],
    ['欄位全改名', { sysdate: '2026-11-04 12:15', data: [{ id: 1, wait: 3 }] }]
  ]) {
    test(`壞回應（${name}）：exit ≠ 0，既有歷史檔一個 byte 都不動`, () => {
      const dir = tmp();
      try {
        assert.equal(run(['--raw-file', join(FX, 'congestion-raw.json')], dir).status, 0);
        const before = Object.fromEntries(readdirSync(dir).map(f => [f, readFileSync(join(dir, f), 'utf8')]));
        const bad = join(dir, 'bad.json');
        writeFileSync(bad, JSON.stringify(raw));
        const r = run(['--raw-file', bad], dir);
        assert.notEqual(r.status, 0);
        for (const [f, content] of Object.entries(before)) {
          assert.equal(readFileSync(join(dir, f), 'utf8'), content, `${f} 被改了`);
        }
        assert.ok(!existsSync(join(dir, 'congestion-latest.json.tmp')));
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });
  }

  test('舊 sysdate（Worker 重送／快取）：exit 0、STALE_SKIP、檔案不動', () => {
    const dir = tmp();
    try {
      assert.equal(run(['--raw-file', join(FX, 'congestion-raw.json')], dir).status, 0);  // 11:15
      const before = Object.fromEntries(readdirSync(dir).map(f => [f, readFileSync(join(dir, f), 'utf8')]));
      const r = run(['--raw-file', join(FX, 'congestion-raw-edge.json')], dir);              // 08:00
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stderr, /STALE_SKIP/);
      for (const [f, content] of Object.entries(before)) assert.equal(readFileSync(join(dir, f), 'utf8'), content);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('--raw-file 沒給值 → exit 1', () => {
    const dir = tmp();
    try {
      const r = run(['--raw-file'], dir);
      assert.equal(r.status, 1);
      assert.match(r.stderr, /需要一個參數/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('--raw-url 不是 http(s) → exit 1（不發請求）', () => {
    const dir = tmp();
    try {
      const r = run(['--raw-url', 'file:///etc/passwd'], dir);
      assert.equal(r.status, 1);
      assert.match(r.stderr, /必須是 http\(s\)/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
