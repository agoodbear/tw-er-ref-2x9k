// 急診壅塞解析器的離線單元測試（fixture 在 test/fixtures/，不連網）
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  num, score, tsOf, validateRaw, mapHospital, rankHospitals, aggregateRegions,
  upsertLast, updateHospHistory, applyHospAvg7d, applyRegionAvg7d, avgOrNull,
  processCongestion, parseRawText, MIN_N, CODE2REGION, staleAgainst
} from '../lib/congestion.mjs';

const FX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const load = name => JSON.parse(readFileSync(join(FX, name), 'utf8'));
const HOUR = 3600e3;
// 由 sysdate 往前推 k 小時的 sysdate 字串（台灣時間）
const sdMinus = (sd, k) => {
  const d = new Date(tsOf(sd) - k * HOUR + 8 * HOUR);
  return d.toISOString().slice(0, 16).replace('T', ' ');
};

describe('num()', () => {
  test('數字與數字字串', () => {
    assert.equal(num(0), 0);
    assert.equal(num('0'), 0);
    assert.equal(num('12'), 12);
    assert.equal(num(' 7 '), 7);
    assert.equal(num('3.5'), 3.5);
  });
  test('未通報類值一律 null（不可當 0）', () => {
    for (const v of [null, undefined, '', ' ', '\t', '-', 'N/A', 'abc', NaN, Infinity, '1,234']) {
      assert.equal(num(v), null, `num(${JSON.stringify(v)})`);
    }
  });
});

describe('score()', () => {
  test('四佇列相加', () => {
    assert.equal(score({ waiT_GENERAL_CNT: '20', waiT_ICU_CNT: '2', waiT_BED_CNT: '3', waiT_SEE_CNT: '10' }), 35);
  });
  test('部分缺值視為 0、全部缺值為 null', () => {
    assert.equal(score({ waiT_GENERAL_CNT: null, waiT_ICU_CNT: '1', waiT_BED_CNT: 'N/A', waiT_SEE_CNT: '7' }), 8);
    assert.equal(score({ waiT_GENERAL_CNT: '', waiT_ICU_CNT: '-', waiT_BED_CNT: ' ', waiT_SEE_CNT: null }), null);
    assert.equal(score({}), null);
  });
  test('全 0 是 0 不是 null', () => {
    assert.equal(score({ waiT_GENERAL_CNT: 0, waiT_ICU_CNT: 0, waiT_BED_CNT: 0, waiT_SEE_CNT: 0 }), 0);
  });
});

describe('tsOf()', () => {
  test('台灣時間 → UTC epoch', () => {
    assert.equal(tsOf('2026-11-04 08:00'), Date.UTC(2026, 10, 4, 0, 0));
  });
  test('格式不符回 NaN', () => {
    for (const v of ['2026/11/04 08:00', '2026-11-04T08:00', '2026-11-04 8:00', '', null, undefined, 123]) {
      assert.ok(Number.isNaN(tsOf(v)), JSON.stringify(v));
    }
  });
});

describe('validateRaw()', () => {
  test('正常 fixture 通過', () => {
    const r = validateRaw(load('congestion-raw.json'));
    assert.equal(r.rows.length, 59);
    assert.equal(r.reported, 55);
  });
  test('非物件 / 陣列', () => {
    assert.throws(() => validateRaw(null), /不是 JSON 物件/);
    assert.throws(() => validateRaw([]), /不是 JSON 物件/);
    assert.throws(() => validateRaw('x'), /不是 JSON 物件/);
  });
  test('sysdate 缺或格式變了 → 拒絕（避免清空 hosp-history）', () => {
    const raw = load('congestion-raw-edge.json');
    assert.throws(() => validateRaw({ ...raw, sysdate: undefined }), /sysdate/);
    assert.throws(() => validateRaw({ ...raw, sysdate: '2026/11/04 08:00' }), /sysdate/);
  });
  test('data 空或缺 → 拒絕', () => {
    assert.throws(() => validateRaw({ sysdate: '2026-11-04 08:00', data: [] }), /data 為空/);
    assert.throws(() => validateRaw({ sysdate: '2026-11-04 08:00' }), /data 為空/);
  });
  test('欄位改名導致全部無通報 → 拒絕', () => {
    const data = [{ hosP_ID: 'X', HOSP_NAME: 'x', wait_general: 3 }];
    assert.throws(() => validateRaw({ sysdate: '2026-11-04 08:00', data }), /全部無通報/);
  });
});

describe('mapHospital() / rank / regions（edge fixture）', () => {
  const raw = load('congestion-raw-edge.json');
  const hs = raw.data.map(mapHospital);
  const byId = Object.fromEntries(hs.map(h => [h.id, h]));

  test('欄位映射', () => {
    const a = byId.A001;
    assert.deepEqual(
      { region: a.region, level: a.level, wait_admit: a.wait_admit, wait_icu: a.wait_icu, wait_push: a.wait_push, wait_see: a.wait_see, full: a.full, score: a.score },
      { region: '台北', level: '醫學中心', wait_admit: 20, wait_icu: 2, wait_push: 3, wait_see: 10, full: true, score: 35 }
    );
    assert.equal(byId.A002.score, 5, '數字型欄位也要能算');
    assert.equal(byId.A003.score, null);
    assert.equal(byId.A003.wait_push, null, "' ' 是未通報，不是 0");
    assert.equal(byId.A004.wait_push, null, "'N/A' → null");
    assert.equal(byId.A004.score, 8);
  });
  test('未知縣市碼與層級：region null、level 保留原值', () => {
    assert.equal(byId.A005.region, null);
    assert.equal(byId.A005.level, '9');
    assert.equal(byId.A006.region, '金門');
  });
  test('排名只算有分數者、由高到低', () => {
    const ranked = rankHospitals(hs);
    assert.deepEqual(ranked.map(h => h.id), ['A005', 'A001', 'A004', 'A002', 'A006']);
    assert.equal(byId.A001.rank, 2);
    assert.equal(byId.A001.rankTotal, 5);
    assert.equal(byId.A003.rank, undefined);
  });
  test('區平均：排除 null region 與 null score，四捨五入到 0.1', () => {
    const regions = aggregateRegions(hs);
    const m = Object.fromEntries(regions.map(r => [r.region, r]));
    assert.deepEqual(m['台北'], { region: '台北', n: 2, avgScore: 20, hospitals: ['甲醫院', '乙醫院（數字型）'] });
    assert.equal(m['高雄'].n, 1, '丙未通報不算');
    assert.equal(m['高雄'].avgScore, 8);
    assert.ok(!regions.some(r => r.region === null));
    assert.deepEqual(regions.map(r => r.avgScore), [...regions.map(r => r.avgScore)].sort((a, b) => b - a));
  });
  test('平均四捨五入', () => {
    const r = aggregateRegions([
      { region: '台中', score: 1, name: 'a' }, { region: '台中', score: 2, name: 'b' }, { region: '台中', score: 2, name: 'c' }
    ]);
    assert.equal(r[0].avgScore, 1.7);
  });
});

describe('歷史與 7 日平均', () => {
  test('upsertLast：末筆同 sysdate 覆蓋、否則 append、不改原陣列', () => {
    const base = [{ sysdate: 'a', v: 1 }, { sysdate: 'b', v: 1 }];
    assert.deepEqual(upsertLast(base, { sysdate: 'b', v: 2 }), [{ sysdate: 'a', v: 1 }, { sysdate: 'b', v: 2 }]);
    assert.equal(upsertLast(base, { sysdate: 'c', v: 1 }).length, 3);
    assert.equal(base[1].v, 1);
    assert.deepEqual(upsertLast([], { sysdate: 'x' }), [{ sysdate: 'x' }]);
  });
  test('hosp-history 只留 8 天、壞時間戳的舊筆被丟掉', () => {
    const now = '2026-11-04 08:00';
    const hh = [
      { sysdate: sdMinus(now, 8 * 24 + 1), s: { A: 1 } },  // 超過 8 天
      { sysdate: sdMinus(now, 8 * 24 - 1), s: { A: 2 } },  // 8 天內
      { sysdate: 'garbage', s: { A: 3 } }
    ];
    const out = updateHospHistory(hh, now, [{ id: 'A', score: 9 }, { id: 'B', score: null }]);
    assert.deepEqual(out.map(e => e.s.A), [2, 9]);
    assert.deepEqual(out.at(-1), { sysdate: now, s: { A: 9 } }, 'null score 不寫進緊湊格式');
  });
  test('avgOrNull：樣本數門檻', () => {
    assert.equal(avgOrNull(Array(MIN_N - 1).fill(10)), null);
    assert.equal(avgOrNull(Array(MIN_N).fill(10)), 10);
    assert.equal(avgOrNull([]), null);
  });
  test('醫院 avg7d：只取 168 小時視窗內、未來時點不算', () => {
    const now = '2026-11-04 08:00';
    const nowTs = tsOf(now);
    const hh = [];
    for (let k = 0; k < 200; k++) hh.push({ sysdate: sdMinus(now, 199 - k), s: { A: k < 32 ? 1000 : 10 } });
    hh.push({ sysdate: sdMinus(now, -1), s: { A: 9999 } });  // 未來（時鐘錯亂／重送）
    const hs = [{ id: 'A' }, { id: 'Z' }];
    const win = applyHospAvg7d(hs, hh, nowTs);
    assert.equal(win.length, 168);
    assert.equal(hs[0].n7d, 168);
    assert.equal(hs[0].avg7d, 10, '視窗外的 1000 與未來的 9999 都不能混進來');
    assert.equal(hs[1].n7d, 0);
    assert.equal(hs[1].avg7d, null);
  });
  test('區 avg7d', () => {
    const now = '2026-11-04 08:00';
    const hist = [];
    for (let k = 0; k < 100; k++) hist.push({ sysdate: sdMinus(now, k), regions: [{ region: '台北', avgScore: k % 2 ? 10 : 20, n: 2 }] });
    const regions = [{ region: '台北' }, { region: '花蓮' }];
    applyRegionAvg7d(regions, hist, tsOf(now));
    assert.equal(regions[0].n7d, 100);
    assert.equal(regions[0].avg7d, 15);
    assert.equal(regions[1].avg7d, null);
  });
});

describe('processCongestion()（整合，純函式）', () => {
  test('真實快照 fixture：59 家、55 家有通報、17 區', () => {
    const { latest, hh, hist, ranked, unknownAreaCodes } = processCongestion(load('congestion-raw.json'), { fetchedAt: 'FIXED' });
    assert.equal(latest.fetchedAt, 'FIXED');
    assert.equal(latest.hospitals.length, 59);
    assert.equal(ranked.length, 55);
    assert.equal(latest.regions.length, 17);
    assert.deepEqual(unknownAreaCodes, []);
    assert.equal(hh.length, 1);
    assert.equal(hist.length, 1);
    assert.deepEqual(latest.window7d, { hours: 168, minN: 84, snapshots: 1 });
    // 所有區名都在 CODE2REGION 的值域內
    const valid = new Set(Object.values(CODE2REGION));
    assert.ok(latest.regions.every(r => valid.has(r.region)));
    // 單一時點不足 MIN_N → avg7d 全 null
    assert.ok(latest.hospitals.every(h => h.avg7d === null));
  });
  test('與 repo 內已 commit 的 congestion-latest.json 一致（除 fetchedAt / 7 日欄位）', () => {
    const committed = JSON.parse(readFileSync(join(FX, '..', '..', '..', 'data', 'congestion-latest.json'), 'utf8'));
    const { latest } = processCongestion(load('congestion-raw.json'));
    const strip = h => { const { n7d, avg7d, ...rest } = h; return rest; };
    assert.equal(latest.sysdate, committed.sysdate);
    assert.deepEqual(latest.hospitals.map(strip), committed.hospitals.map(strip));
    assert.deepEqual(latest.regions.map(strip), committed.regions.map(strip));
  });
  test('同 sysdate 重跑不重複 append', () => {
    const raw = load('congestion-raw-edge.json');
    const first = processCongestion(raw);
    const second = processCongestion(raw, { hh: first.hh, hist: first.hist });
    assert.equal(second.hh.length, 1);
    assert.equal(second.hist.length, 1);
  });
  test('history 上限 3000 筆', () => {
    const raw = load('congestion-raw-edge.json');
    const hist = Array.from({ length: 3005 }, (_, k) => ({ sysdate: sdMinus(raw.sysdate, 3005 - k), regions: [] }));
    const { hist: out } = processCongestion(raw, { hist });
    assert.equal(out.length, 3000);
    assert.equal(out.at(-1).sysdate, raw.sysdate);
  });
  test('回報未知縣市碼', () => {
    assert.deepEqual(processCongestion(load('congestion-raw-edge.json')).unknownAreaCodes, ['99']);
  });
  test('驗證失敗時直接拋錯（呼叫端不會寫檔）', () => {
    assert.throws(() => processCongestion({ sysdate: 'bad', data: [] }));
  });
});

describe('parseRawText()', () => {
  test('BOM + 字串包一層', () => {
    const j = parseRawText(readFileSync(join(FX, 'congestion-raw-wrapped-bom.txt'), 'utf8'));
    assert.equal(j.sysdate, '2026-11-04 09:00');
    assert.equal(j.data[0].hosP_NAME, '包裝醫院');
  });
  test('一般 JSON', () => {
    assert.deepEqual(parseRawText('{"a":1}'), { a: 1 });
  });
  test('壞 JSON 拋錯', () => {
    assert.throws(() => parseRawText('<html>維護中</html>'));
  });
});

describe('staleAgainst()', () => {
  test('比末筆舊 → 回傳末筆 sysdate', () => {
    assert.equal(staleAgainst([[{ sysdate: '2026-11-04 09:00' }]], '2026-11-04 08:45'), '2026-11-04 09:00');
  });
  test('相同或較新 → null（相同 sysdate 照舊覆蓋末筆）', () => {
    assert.equal(staleAgainst([[{ sysdate: '2026-11-04 09:00' }]], '2026-11-04 09:00'), null);
    assert.equal(staleAgainst([[{ sysdate: '2026-11-04 09:00' }]], '2026-11-04 09:15'), null);
  });
  test('任一份歷史比較新就算舊；空歷史、壞末筆不擋', () => {
    assert.equal(staleAgainst([[], [{ sysdate: '2026-11-04 10:00' }]], '2026-11-04 09:00'), '2026-11-04 10:00');
    assert.equal(staleAgainst([[], []], '2026-11-04 09:00'), null);
    assert.equal(staleAgainst([[{ sysdate: 'garbage' }]], '2026-11-04 09:00'), null);
  });
});
