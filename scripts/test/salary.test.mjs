// FB 薪資 pipeline 純函式的離線測試（不開瀏覽器、不呼叫 claude、不碰 Supabase）
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { ageDays, parseAIResult, findHospital, isSameSalary } from '../lib/salary.mjs';

const FX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const NOW = new Date(2026, 10, 4, 10, 0);   // 2026-11-04 10:00（本機時區）

describe('ageDays()', () => {
  test('相對時間', () => {
    assert.equal(ageDays('5分鐘', NOW), 0);
    assert.equal(ageDays('3小時', NOW), 0);
    assert.equal(ageDays('昨天', NOW), 1);
    assert.equal(ageDays('6天', NOW), 6);
    assert.equal(ageDays('6 天', NOW), 6);
  });
  test('絕對日期（含跨年）', () => {
    assert.equal(ageDays('11月1日', NOW), 3);
    assert.equal(ageDays('2025年11月4日', NOW), 365);
    // 1 月看到「12月30日」→ 去年
    assert.equal(ageDays('12月30日', new Date(2027, 0, 2, 10, 0)), 3);
  });
  test('認不得 → null', () => {
    for (const t of ['', null, undefined, '剛剛', 'Just now']) assert.equal(ageDays(t, NOW), null);
  });
  test('raw 檔的 [貼文時間：X] 前綴可被取出算天數', () => {
    const posts = JSON.parse(readFileSync(join(FX, 'fb-raw-posts.json'), 'utf8'));
    const ages = posts.map(p => ageDays((p.match(/^\[貼文時間：(.*?)\]/) || [])[1], NOW));
    assert.deepEqual(ages, [0, 2, 7, null]);
  });
});

describe('parseAIResult()', () => {
  test('claude -p JSON wrapper，result 內含 markdown code fence', () => {
    const r = parseAIResult(readFileSync(join(FX, 'ai-output-wrapper.json'), 'utf8'));
    assert.equal(r.length, 1);
    assert.equal(r[0].hospital, '部立桃園醫院');
    assert.equal(r[0].s15, 45);
  });
  test('wrapper.result 直接是陣列', () => {
    assert.deepEqual(parseAIResult(JSON.stringify({ result: [{ a: 1 }] })), [{ a: 1 }]);
  });
  test('直接輸出陣列', () => {
    assert.deepEqual(parseAIResult('[{"a":1}]'), [{ a: 1 }]);
  });
  test('非 JSON 的純文字中夾陣列', () => {
    assert.deepEqual(parseAIResult('好的：[{"a":2}] 以上'), [{ a: 2 }]);
  });
  test('沒有任何陣列 → []（注意：呼叫端目前把這當成功，見報告 M-4）', () => {
    assert.deepEqual(parseAIResult(JSON.stringify({ result: '沒有可提取的資料' })), []);
    assert.deepEqual(parseAIResult('error: overloaded'), []);
  });
  test('result 是空字串 → 退回整個 wrapper（物件）→ []', () => {
    assert.deepEqual(parseAIResult(JSON.stringify({ result: '' })), []);
  });
  test('陣列本身壞掉 → 拋錯', () => {
    assert.throws(() => parseAIResult(JSON.stringify({ result: '[{"a":1,}]' })));
  });
});

describe('findHospital()', () => {
  const hospitals = [
    { id: 1, name: '部立桃園醫院', aliases: ['部桃'] },
    { id: 2, name: '馬偕醫院', aliases: [] },
    { id: 3, name: '台東馬偕紀念醫院', aliases: null },
    { id: 4, name: '成大醫院', aliases: ['國立成功大學醫學院附設醫院'] }
  ];
  test('完全相同', () => assert.equal(findHospital(hospitals, '馬偕醫院').id, 2));
  test('aliases', () => {
    assert.equal(findHospital(hospitals, '部桃').id, 1);
    assert.equal(findHospital(hospitals, '國立成功大學醫學院附設醫院').id, 4);
  });
  test('去掉「醫院」後互相包含', () => assert.equal(findHospital(hospitals, '台東馬偕紀念').id, 3));
  test('兩字簡稱不做模糊比對', () => assert.equal(findHospital(hospitals, '馬偕'), undefined));
  test('找不到 → undefined', () => assert.equal(findHospital(hospitals, '不存在醫院'), undefined));
  test('aliases 為 null 不會炸', () => assert.equal(findHospital([{ id: 9, name: 'X醫院', aliases: null }], 'Y醫院'), undefined));
  test('模糊比對會把分院配到本院（已知風險，見報告 M-5）', { todo: '需改成「多命中不猜」' }, () => {
    // 現況：輸入「馬偕紀念醫院」去「醫院」= '馬偕紀念'，包含於 '台東馬偕紀念' 之中，
    // 於是被配到台東馬偕（id 3），而不是馬偕本院（id 2）→ 薪資寫到錯的醫院。修好後這個 todo 會轉綠。
    assert.notEqual(findHospital(hospitals, '馬偕紀念醫院')?.id, 3);
  });
});

describe('isSameSalary()', () => {
  test('null / 0 / undefined 視為相同', () => {
    assert.equal(isSameSalary({ s15: 45, s14: null }, { s15: 45, s14: 0 }), true);
    assert.equal(isSameSalary({ s15: 45 }, { s15: 45, s16: null }), true);
  });
  test('字串數字寬鬆相等', () => assert.equal(isSameSalary({ s15: '45' }, { s15: 45 }), true));
  test('任一班數不同 → false', () => {
    assert.equal(isSameSalary({ s15: 45, s16: 48 }, { s15: 45, s16: 47 }), false);
    assert.equal(isSameSalary({ s15: 45 }, { s15: 45, s10: 30 }), false);
  });
});
