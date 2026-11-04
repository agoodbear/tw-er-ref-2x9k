// 48hr 暫留比率解析器的離線測試
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  pickLatestQuarter, mapBoardingRow, parseBoardingRows, buildBoardingOutput,
  decodeBoardingPayload, OUTPUT_KEYS
} from '../lib/boarding.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const load = name => JSON.parse(readFileSync(join(HERE, 'fixtures', name), 'utf8'));
const encode = obj => gzipSync(Buffer.from(JSON.stringify(obj))).toString('base64');

describe('pickLatestQuarter()', () => {
  test('不依賴排序，取字典序最大', () => {
    assert.equal(pickLatestQuarter(load('boarding-s17.json')).DataTimeID, '115Q1');
  });
  test('空清單 / 非陣列拋錯', () => {
    assert.throws(() => pickLatestQuarter([]), /空回應/);
    assert.throws(() => pickLatestQuarter(null), /空回應/);
    assert.throws(() => pickLatestQuarter({ DataTimeID: '115Q1' }), /空回應/);
  });
  test('格式不符的項目忽略（避免 "999" 或 "115Q9" 被當最新）', () => {
    const r = pickLatestQuarter([{ DataTimeID: '114Q4' }, { DataTimeID: '115Q9' }, { DataTimeID: 'ZZZ' }, null]);
    assert.equal(r.DataTimeID, '114Q4');
    assert.throws(() => pickLatestQuarter([{ DataTimeID: 'x' }]), /沒有合法/);
  });
});

describe('parseBoardingRows()', () => {
  test('fixture 欄位映射與數字轉換', () => {
    const rows = load('boarding-s12.json');
    const { hospitals, nationalAvg, warnings } = parseBoardingRows(rows, '115Q1');
    assert.equal(hospitals.length, rows.length);
    assert.equal(nationalAvg, 4.6);
    assert.deepEqual(warnings, []);
    const committed = load('boarding-latest-snapshot.json');
    assert.deepEqual(hospitals, committed.hospitals.slice(0, rows.length), '與同季快照的輸出一致');
  });
  test('ratio 缺／非數字的醫院被濾掉（不是當 0）', () => {
    const rows = [
      { HOSP_ID: '1', HOSP_NAME: 'A', INDEX1: '', INDEX3: '4' },
      { HOSP_ID: '2', HOSP_NAME: 'B', INDEX1: '-', INDEX3: '4' },
      { HOSP_ID: '3', HOSP_NAME: 'C', INDEX1: '0', INDEX3: '4' }
    ];
    const { hospitals } = parseBoardingRows(rows, 'q');
    assert.deepEqual(hospitals.map(h => [h.hosp_id, h.ratio]), [['3', 0]]);
  });
  test('NUMERATOR/DENOMINATOR 缺時退回 N/D；層級名退回代碼對照', () => {
    const h = mapBoardingRow({ HOSP_ID: 'x', HOSP_NAME: 'y', SPECIAL_ID: '2', INDEX1: '1.5', N: '3', D: '200' });
    assert.deepEqual([h.level, h.ratio, h.n, h.d], ['區域醫院', 1.5, 3, 200]);
    assert.equal(mapBoardingRow({ SPECIAL_ID: '7', INDEX1: '1' }).level, '7');
  });
  test('rows[0] 無 INDEX3 → nationalAvg null + 警告', () => {
    const { nationalAvg, warnings } = parseBoardingRows([{ HOSP_NAME: 'A', INDEX1: '1' }], 'q');
    assert.equal(nationalAvg, null);
    assert.match(warnings[0], /INDEX3/);
  });
  test('ratio 超出 0–100 → 警告', () => {
    const { warnings } = parseBoardingRows([{ HOSP_NAME: '怪醫院', INDEX1: '180', INDEX3: '4' }], 'q');
    assert.match(warnings.join(), /超出 0–100.*怪醫院/);
  });
  test('空回應拋錯', () => {
    assert.throws(() => parseBoardingRows([], '115Q1'), /空資料 quarter=115Q1/);
    assert.throws(() => parseBoardingRows({ error: 'x' }, '115Q1'), /空資料/);
  });
});

describe('buildBoardingOutput()', () => {
  test('欄位順序固定（write-boarding-payload 用欄位順序驗證）', () => {
    const out = buildBoardingOutput({ latest: { DataTimeID: '115Q1', DataTimeName: '115年第一季' }, hospitals: [], nationalAvg: 4.6, fetchedAt: 'T' });
    assert.deepEqual(Object.keys(out), OUTPUT_KEYS);
    assert.equal(out.quarter, '115Q1');
  });
});

describe('decodeBoardingPayload()', () => {
  const good = load('boarding-latest-snapshot.json');

  test('真實快照 round-trip 通過', () => {
    assert.deepEqual(decodeBoardingPayload(encode(good)), good);
  });
  test('空 payload', () => {
    assert.throws(() => decodeBoardingPayload(''), /空的/);
  });
  test('不是 gzip / base64 垃圾', () => {
    assert.throws(() => decodeBoardingPayload('bm90IGd6aXA='));
  });
  test('欄位順序或名稱不對', () => {
    const { quarter, ...rest } = good;
    assert.throws(() => decodeBoardingPayload(encode({ ...rest, quarter })), /欄位不對/);
  });
  test('季度格式不對 / 醫院太少', () => {
    assert.throws(() => decodeBoardingPayload(encode({ ...good, quarter: '115Q5' })), /可疑/);
    assert.throws(() => decodeBoardingPayload(encode({ ...good, hospitals: good.hospitals.slice(0, 99) })), /可疑.*n=99/);
  });
  test('醫院 ratio 非數字 → 拒絕', () => {
    const hospitals = good.hospitals.map((h, i) => (i === 5 ? { ...h, ratio: '3.2' } : h));
    assert.throws(() => decodeBoardingPayload(encode({ ...good, hospitals })), /ratio 非數字/);
  });
});
