// FB 薪資 pipeline 的純函式（無瀏覽器、無網路、無 Supabase），供 fetch-fb-salary.mjs 與單元測試共用。

// FB m 版相對時間 → 距今天數；認不得回 null。now 可注入方便測試。
export function ageDays(t, now = new Date()) {
  if (!t) return null;
  if (/分鐘|小時/.test(t)) return 0;
  if (t === '昨天') return 1;
  let m = t.match(/(\d+)\s*天/); if (m) return +m[1];
  m = t.match(/(?:(\d{4})年)?(\d{1,2})月(\d{1,2})日/);
  if (m) {
    let d = new Date(m[1] ? +m[1] : now.getFullYear(), +m[2] - 1, +m[3]);
    if (!m[1] && d > now) d.setFullYear(d.getFullYear() - 1);   // 跨年：12 月的貼文在 1 月看
    return Math.floor((now - d) / 86400e3);
  }
  return null;
}

// `claude -p --output-format json` 的輸出 → 薪資陣列。
// 與舊版相同的容錯：wrapper.result 是字串就抓第一個 [...]；整段不是 JSON 也嘗試抓 [...]。
// 抓不到陣列回 []；[...] 本身壞掉會拋錯（由呼叫端決定是否重試）。
export function parseAIResult(result) {
  let parsed;
  try {
    const wrapper = JSON.parse(result);
    const content = wrapper.result || wrapper;
    if (typeof content === 'string') {
      const match = content.match(/\[[\s\S]*\]/);
      parsed = match ? JSON.parse(match[0]) : [];
    } else {
      parsed = Array.isArray(content) ? content : [];
    }
  } catch {
    const match = String(result).match(/\[[\s\S]*\]/);
    parsed = match ? JSON.parse(match[0]) : [];
  }
  return parsed;
}

// 醫院比對：完全相同 → aliases → 去掉「醫院」後互相包含（雙方都 > 2 字）。
// ⚠️ 第三條是模糊比對，find() 取第一個命中，分院／本院可能誤配（見 docs/review 報告 M-5）。
export function findHospital(hospitals, inputName) {
  return hospitals.find(h => {
    if (h.name === inputName) return true;
    if (h.aliases && h.aliases.some(a => a === inputName)) return true;
    const n1 = h.name.replace(/醫院/g, '');
    const n2 = inputName.replace(/醫院/g, '');
    if (n1.length > 2 && n2.length > 2 && (n1.includes(n2) || n2.includes(n1))) return true;
    return false;
  });
}

export const SHIFT_KEYS = ['s10', 's12', 's14', 's15', 's16'];

// 薪資數字是否「沒變」：兩邊都空（null/0/undefined）視為相同，否則寬鬆相等（'45' == 45）。
export function isSameSalary(entry, current) {
  return SHIFT_KEYS.every(k => (!entry[k] && !current[k]) || entry[k] == current[k]);
}
