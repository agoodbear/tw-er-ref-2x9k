// 共用的「抓 JSON + 重試」：fetch / sleep / 日誌都可注入，單元測試不需網路。
//
// 重試策略：
//   - 重試：網路錯誤（ECONNRESET 等）、逾時、HTTP 5xx、HTTP 429、回應不是合法 JSON（維護頁常回 200 + HTML）
//   - 不重試：其他 4xx（參數錯／被封鎖，重打也不會好，只會拖長 job 時間）
//   - 每次失敗都 warn，最後一次失敗拋出「最後的錯誤」，訊息帶嘗試次數，方便在告警裡判讀。

export class HttpError extends Error {
  constructor(status, label) {
    super(`${label} 回傳 HTTP ${status}`);
    this.name = 'HttpError';
    this.status = status;
  }
}

export function isRetryable(err) {
  if (err instanceof HttpError) return err.status >= 500 || err.status === 429;
  return true;  // 網路錯、逾時、壞 JSON
}

const defaultSleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * @param {string} url
 * @param {object} opts
 * @param {RequestInit} [opts.init]     fetch 的 init（method/headers/body）
 * @param {number[]} [opts.backoffMs]  每次失敗後的等待；長度 = 重試次數（總嘗試 = 長度 + 1）
 * @param {number} [opts.timeoutMs]
 * @param {string} [opts.label]        錯誤訊息前綴
 * @param {Function} [opts.fetchImpl]
 * @param {Function} [opts.sleep]
 * @param {Function} [opts.warn]
 * @param {Function} [opts.parse]      text → 資料；預設 JSON.parse（去 BOM）
 */
export async function fetchJsonWithRetry(url, {
  init = {},
  backoffMs = [2000, 4000, 6000],
  timeoutMs = 20000,
  label = '健保署 API',
  fetchImpl = globalThis.fetch,
  sleep = defaultSleep,
  warn = console.warn,
  parse = text => JSON.parse(text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text)
} = {}) {
  const tries = backoffMs.length + 1;
  let lastErr, attempts = 0;
  for (let i = 1; i <= tries; i++) {
    attempts = i;
    try {
      const res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) throw new HttpError(res.status, label);
      const text = await res.text();
      try {
        return parse(text);
      } catch (e) {
        throw new Error(`${label} 回應不是合法 JSON（${String(text).slice(0, 80).replace(/\s+/g, ' ')}…）：${e.message}`);
      }
    } catch (e) {
      lastErr = e;
      const retry = isRetryable(e) && i < tries;
      warn(`第 ${i}/${tries} 次抓取失敗（${e.cause?.code || e.message}）${retry ? `，${backoffMs[i - 1]}ms 後重試…` : ''}`);
      if (!isRetryable(e)) break;
      if (retry) await sleep(backoffMs[i - 1]);
    }
  }
  lastErr.attempts = attempts;
  throw lastErr;
}
