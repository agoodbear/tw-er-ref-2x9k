// 重試／告警行為的離線測試：fetch 與 sleep 都是假的，不連網、不真的等待
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { fetchJsonWithRetry, isRetryable, HttpError } from '../lib/http.mjs';

const res = (status, body) => ({ ok: status >= 200 && status < 300, status, text: async () => body });
const netErr = code => Object.assign(new TypeError('fetch failed'), { cause: { code } });

// 依序回傳 script 裡的結果（Error 會被 throw）
function fakeFetch(script) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    const next = script[Math.min(calls.length - 1, script.length - 1)];
    if (next instanceof Error) throw next;
    return next;
  };
  fn.calls = calls;
  return fn;
}
const harness = script => {
  const sleeps = [], warns = [];
  return {
    fetchImpl: fakeFetch(script),
    sleep: async ms => { sleeps.push(ms); },
    warn: m => warns.push(m),
    sleeps, warns
  };
};

describe('isRetryable()', () => {
  test('5xx / 429 / 網路錯 / 壞 JSON 要重試；其他 4xx 不重試', () => {
    assert.equal(isRetryable(new HttpError(500, 'x')), true);
    assert.equal(isRetryable(new HttpError(520, 'x')), true);
    assert.equal(isRetryable(new HttpError(429, 'x')), true);
    assert.equal(isRetryable(new HttpError(404, 'x')), false);
    assert.equal(isRetryable(new HttpError(403, 'x')), false);
    assert.equal(isRetryable(netErr('ECONNRESET')), true);
    assert.equal(isRetryable(new SyntaxError('bad json')), true);
  });
});

describe('fetchJsonWithRetry()', () => {
  test('一次成功：不 sleep、不 warn', async () => {
    const h = harness([res(200, '{"ok":1}')]);
    assert.deepEqual(await fetchJsonWithRetry('u', h), { ok: 1 });
    assert.equal(h.fetchImpl.calls.length, 1);
    assert.deepEqual(h.sleeps, []);
    assert.deepEqual(h.warns, []);
  });

  test('ECONNRESET 兩次後成功：照退避表 sleep', async () => {
    const h = harness([netErr('ECONNRESET'), netErr('ECONNRESET'), res(200, '[1]')]);
    assert.deepEqual(await fetchJsonWithRetry('u', { ...h, backoffMs: [2000, 4000, 6000] }), [1]);
    assert.deepEqual(h.sleeps, [2000, 4000]);
    assert.equal(h.warns.length, 2);
    assert.match(h.warns[0], /ECONNRESET/);
    assert.match(h.warns[0], /第 1\/4 次/);
  });

  test('一直 5xx：用完次數後拋最後的錯，帶 attempts', async () => {
    const h = harness([res(503, 'busy')]);
    await assert.rejects(fetchJsonWithRetry('u', { ...h, backoffMs: [1, 2] }), err => {
      assert.ok(err instanceof HttpError);
      assert.equal(err.status, 503);
      assert.equal(err.attempts, 3);
      return true;
    });
    assert.equal(h.fetchImpl.calls.length, 3);
    assert.deepEqual(h.sleeps, [1, 2], '最後一次失敗後不再 sleep');
  });

  test('4xx 立刻放棄，不重試', async () => {
    const h = harness([res(404, 'nf'), res(200, '{}')]);
    await assert.rejects(fetchJsonWithRetry('u', h), err => err.status === 404 && err.attempts === 1);
    assert.equal(h.fetchImpl.calls.length, 1);
    assert.deepEqual(h.sleeps, []);
  });

  test('429 會重試', async () => {
    const h = harness([res(429, ''), res(200, '{"a":1}')]);
    assert.deepEqual(await fetchJsonWithRetry('u', h), { a: 1 });
  });

  test('200 但回 HTML 維護頁：視為可重試，最後訊息帶內容片段', async () => {
    const h = harness([res(200, '<html>系統維護中</html>')]);
    await assert.rejects(fetchJsonWithRetry('u', { ...h, backoffMs: [1] }), /不是合法 JSON.*系統維護中/);
    assert.equal(h.fetchImpl.calls.length, 2);
  });

  test('BOM 開頭的 JSON 可解析', async () => {
    const h = harness([res(200, '﻿{"x":2}')]);
    assert.deepEqual(await fetchJsonWithRetry('u', h), { x: 2 });
  });

  test('init（method/headers/body）原樣傳給 fetch，並附 timeout signal', async () => {
    const h = harness([res(200, '{}')]);
    await fetchJsonWithRetry('https://x', { ...h, init: { method: 'POST', body: 'b' } });
    const { url, init } = h.fetchImpl.calls[0];
    assert.equal(url, 'https://x');
    assert.equal(init.method, 'POST');
    assert.equal(init.body, 'b');
    assert.ok(init.signal instanceof AbortSignal);
  });

  test('自訂 parse（例如 raw_url 的字串包一層）', async () => {
    const h = harness([res(200, '"{\\"k\\":1}"')]);
    const parse = t => { let j = JSON.parse(t); if (typeof j === 'string') j = JSON.parse(j); return j; };
    assert.deepEqual(await fetchJsonWithRetry('u', { ...h, parse }), { k: 1 });
  });
});
