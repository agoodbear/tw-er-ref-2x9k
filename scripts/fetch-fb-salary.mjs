#!/usr/bin/env node
/**
 * FB 急診薪資爬取 Pipeline
 *
 * 策略：
 * - 用 m.facebook.com（行動版）— HTML 結構較簡單，反爬較少
 * - 從系統 Chrome 複製 cookie，不鎖 profile
 * - 每個動作間隔 3-5 秒，模擬人類行為
 * - 展開所有「更多」按鈕取得完整文字
 * - claude -p 解析 → 寫入 Supabase
 *
 * Usage:
 *   node scripts/fetch-fb-salary.mjs [--days 7] [--dry-run] [--group URL]
 *
 * 首次執行前：
 *   1. 用系統 Chrome 登入 Facebook
 *   2. 安裝 "EditThisCookie" 之類擴充，匯出 FB cookies 到 ~/.fb-cookies.json
 *      或直接手動執行 --export-cookies 來互動式擷取
 */

import { chromium } from 'playwright';
import { execSync } from 'child_process';
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';
import { randomInt } from 'crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Config ──────────────────────────────────────
const SB_URL = 'https://gjpvzqlsfimuqwditeqf.supabase.co';
const SB_KEY = 'sb_publishable_P0gPzbp1mg8pgYJumikvTg_RJj8PHYS';
const CHROMIUM_PATH = '/Users/tsaojian-hsiung/Library/Caches/ms-playwright/chromium-1217/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const COOKIE_FILE = join(process.env.HOME, '.fb-cookies.json');
const RESULTS_DIR = join(__dirname, '..', 'data');
const LOG_FILE = join(RESULTS_DIR, 'fetch-log.json');

// 預設社團 URL（行動版）
const DEFAULT_GROUP = 'https://m.facebook.com/groups/Taiwan.ER';

const args = process.argv.slice(2);
const DAYS = parseInt(args.find((_, i, a) => a[i - 1] === '--days') || '7');
const DRY_RUN = args.includes('--dry-run');
const GROUP_URL = args.find((_, i, a) => a[i - 1] === '--group') || DEFAULT_GROUP;
const EXPORT_COOKIES = args.includes('--export-cookies');

console.log(`\n🏥 急診薪資爬取 Pipeline`);
console.log(`   社團：${GROUP_URL}`);
console.log(`   期間：最近 ${DAYS} 天`);
console.log(`   模式：${DRY_RUN ? '🔍 Dry Run（不寫入）' : '✍️ 寫入 Supabase'}`);
console.log('');

// 確保 data 目錄存在
if (!existsSync(RESULTS_DIR)) mkdirSync(RESULTS_DIR, { recursive: true });

// ── Helpers ──────────────────────────────────────
function sleep(ms) {
  return new Promise(r => setTimeout(r, ms + randomInt(500, 2000)));
}

function log(msg) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] ${msg}`);
}

// ── Step 0: Cookie 管理 ──────────────────────────
async function exportCookiesInteractive() {
  log('🍪 互動式 Cookie 擷取：開啟 Facebook 登入頁面...');
  log('   請在瀏覽器中登入 Facebook，完成後按 Enter...');

  const browser = await chromium.launch({
    executablePath: CHROMIUM_PATH,
    headless: false,
    args: ['--disable-blink-features=AutomationControlled']
  });

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    viewport: { width: 390, height: 844 }
  });

  const page = await context.newPage();
  await page.goto('https://m.facebook.com/', { waitUntil: 'networkidle' });

  // 等使用者登入
  console.log('\n⏳ 請在開啟的瀏覽器中登入 Facebook...');
  console.log('   登入完成後，腳本會自動偵測並儲存 cookie。\n');

  // 持續檢查是否已登入
  for (let i = 0; i < 120; i++) { // 最多等 10 分鐘
    await sleep(5000);
    const cookies = await context.cookies();
    const hasCUser = cookies.some(c => c.name === 'c_user');
    if (hasCUser) {
      log('✅ 偵測到登入狀態！儲存 cookie...');
      writeFileSync(COOKIE_FILE, JSON.stringify(cookies, null, 2));
      log(`   已儲存至 ${COOKIE_FILE}`);
      await browser.close();
      return;
    }
  }

  await browser.close();
  throw new Error('等待登入逾時');
}

function loadCookies() {
  if (!existsSync(COOKIE_FILE)) {
    throw new Error(
      `找不到 FB cookie 檔案 (${COOKIE_FILE})。\n` +
      `請先執行：node scripts/fetch-fb-salary.mjs --export-cookies\n` +
      `在開啟的瀏覽器中登入 Facebook，cookie 會自動儲存。`
    );
  }

  const raw = JSON.parse(readFileSync(COOKIE_FILE, 'utf-8'));
  // 確認 cookie 未過期
  const cUser = raw.find(c => c.name === 'c_user');
  if (!cUser) throw new Error('Cookie 檔案中沒有 c_user，可能需要重新登入');

  log(`🍪 載入 cookie（c_user: ${cUser.value.slice(0, 4)}...）`);
  return raw;
}

// ── Step 1: 爬取 FB 社團貼文 ──────────────────────
async function fetchFBPosts() {
  log('📱 Step 1: 爬取 Facebook 社團...');

  const cookies = loadCookies();

  const browser = await chromium.launch({
    executablePath: CHROMIUM_PATH,
    headless: false,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-first-run',
    ]
  });

  const context = await browser.newContext({
    // 用 iPhone user agent — FB 行動版結構較簡單
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
    viewport: { width: 390, height: 844 },
    locale: 'zh-TW',
    timezoneId: 'Asia/Taipei'
  });

  // 注入 cookie
  await context.addCookies(cookies);

  const page = await context.newPage();

  try {
    log('   導航至社團頁面...');
    await page.goto(GROUP_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(3000);

    // 檢查是否登入成功
    const url = page.url();
    if (url.includes('/login') || url.includes('checkpoint')) {
      throw new Error('Cookie 已過期或無效。請重新執行 --export-cookies');
    }

    log('   ✅ 已進入社團頁面');

    // 行動版 FB 的捲動載入
    const scrollRounds = Math.min(Math.ceil(DAYS * 1.5), 20);
    for (let i = 0; i < scrollRounds; i++) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await sleep(3000);
      process.stdout.write(`\r   📜 捲動載入 ${i + 1}/${scrollRounds}...`);
    }
    console.log('');

    // 展開所有「更多」按鈕
    log('   📖 展開截斷的貼文...');
    const seeMoreCount = await page.evaluate(async () => {
      let count = 0;
      // m.facebook.com 的「更多」按鈕
      const btns = document.querySelectorAll(
        'div[data-sigil="more"] a, ' +
        'span.see_more_link_inner, ' +
        'a[href*="see_more"], ' +
        'div.text_exposed_link a'
      );
      for (const btn of btns) {
        try {
          btn.click();
          count++;
          await new Promise(r => setTimeout(r, 500));
        } catch {}
      }
      return count;
    });
    log(`   展開了 ${seeMoreCount} 個「更多」按鈕`);
    await sleep(2000);

    // 擷取貼文 — 用多種選擇器適配不同 FB 版本
    log('   📋 擷取貼文內容...');
    const posts = await page.evaluate(() => {
      const results = [];

      // m.facebook.com 行動版的貼文結構
      // 嘗試多種選擇器
      const selectors = [
        'article',                          // 標準 article
        '[data-sigil="feed-story"]',        // FB feed story
        'div[data-ft]',                     // data-ft 標記的貼文
        '.story_body_container',            // story body
        '[role="article"]',                 // ARIA article
      ];

      let articles = [];
      for (const sel of selectors) {
        const found = document.querySelectorAll(sel);
        if (found.length > articles.length) articles = [...found];
      }

      // 如果上面都抓不到，fallback：掃整個 feed
      if (articles.length === 0) {
        // 最後手段：找所有包含大量文字的 div
        const allDivs = document.querySelectorAll('div');
        for (const div of allDivs) {
          const text = div.innerText || '';
          if (text.length > 100 && text.length < 5000) {
            const hasNumbers = /\d{2,3}\s*萬/.test(text) || /月薪/.test(text) || /時薪/.test(text);
            if (hasNumbers) {
              // 檢查不是子元素已經被收錄
              const isDuplicate = results.some(r => text.includes(r.text) || r.text.includes(text));
              if (!isDuplicate) {
                results.push({ text, source: 'fallback' });
              }
            }
          }
        }
        return results;
      }

      for (const el of articles) {
        const text = el.innerText || '';
        if (text.length < 50) continue;

        // 薪資關鍵字檢查
        const keywords = ['薪', '月薪', '時薪', '班', '待遇', '徵才', '誠徵', '招募', '急診'];
        const hasSalary = keywords.some(kw => text.includes(kw));
        if (!hasSalary) continue;

        // 嘗試取時間
        const timeEl = el.querySelector('abbr, time, [data-utime], a[href*="/story"]');
        const timeText = timeEl ? (timeEl.getAttribute('title') || timeEl.textContent || '') : '';

        results.push({
          text: text.slice(0, 4000),
          timeText,
          source: 'structured'
        });
      }

      return results;
    });

    log(`   ✅ 找到 ${posts.length} 筆可能包含薪資的貼文`);

    // 截圖留存
    const screenshotPath = join('/tmp', `fb-salary-${Date.now()}.png`);
    await page.screenshot({ path: screenshotPath, fullPage: false });
    log(`   📸 截圖已存：${screenshotPath}`);

    await browser.close();

    // 儲存原始爬取結果
    const rawPath = join(RESULTS_DIR, `raw-${new Date().toISOString().slice(0, 10)}.json`);
    writeFileSync(rawPath, JSON.stringify(posts, null, 2));
    log(`   💾 原始資料存於：${rawPath}`);

    return posts;

  } catch (err) {
    await browser.close();
    throw err;
  }
}

// ── Step 2: AI 解析貼文 ──────────────────────────
function parsePostsWithAI(posts) {
  log('\n🤖 Step 2: AI 解析貼文內容...');

  if (posts.length === 0) {
    log('   ⚠️ 沒有找到新貼文，跳過');
    return [];
  }

  const postsText = posts.map((p, i) =>
    `--- 貼文 #${i + 1} ---\n時間：${p.timeText || '未知'}\n內容：\n${p.text}\n`
  ).join('\n');

  const prompt = `你是急診薪資資料分析助手。以下是從 Facebook 急診醫師社團爬到的貼文。
請從中提取出「急診醫師薪資」相關資訊。

規則：
1. 只提取明確提到月薪數字的貼文（不含模糊的「待遇優」、「面議」等）
2. 薪資單位統一為「萬」（例如 450000 → 45, 55萬 → 55）
3. 班數通常是 10/14/15/16 班
4. 醫院名稱盡量用社群常用簡稱（如「台大雲林」而非全名）
5. 地區：基隆/台北/新北/桃園/新竹/苗栗/台中/彰化/南投/雲林/嘉義/台南/高雄/屏東/宜蘭/花蓮/台東
6. 醫院層級：醫學中心/區域醫院/地區醫院/部立醫院
7. 如果同一篇貼文提到多個薪資方案（如不同班數），s10/s14/s15/s16 可以同時填入
8. source_date 填貼文的日期（如果能辨識的話），否則填今天

請只回覆 JSON array，不加任何說明：
[
  {
    "hospital": "醫院名稱",
    "region": "地區",
    "level": "醫院層級",
    "s10": null,
    "s14": null,
    "s15": 45,
    "s16": null,
    "visits": null,
    "note": "簡短備註（班制、特殊條件等）",
    "source_date": "2026-04-10"
  }
]

如果沒有任何可提取的薪資資料，回覆 []

以下是貼文：

${postsText}`;

  const tmpFile = join(tmpdir(), 'er-salary-posts.txt');
  writeFileSync(tmpFile, prompt);

  try {
    const result = execSync(
      `cat "${tmpFile}" | claude -p --output-format json 2>/dev/null`,
      { encoding: 'utf-8', timeout: 120000, maxBuffer: 10 * 1024 * 1024 }
    );

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
      const match = result.match(/\[[\s\S]*\]/);
      parsed = match ? JSON.parse(match[0]) : [];
    }

    log(`   ✅ AI 提取到 ${parsed.length} 筆薪資資料`);

    // 儲存 AI 解析結果
    const parsedPath = join(RESULTS_DIR, `parsed-${new Date().toISOString().slice(0, 10)}.json`);
    writeFileSync(parsedPath, JSON.stringify(parsed, null, 2));
    log(`   💾 解析結果存於：${parsedPath}`);

    return parsed;

  } catch (err) {
    console.error('   ❌ AI 解析失敗:', err.message);
    return [];
  }
}

// ── Step 3: 比對並寫入 Supabase ──────────────────
async function writeToSupabase(entries) {
  log('\n💾 Step 3: 比對 Supabase 現有資料並寫入...');

  if (entries.length === 0) {
    log('   ⚠️ 沒有新資料需要寫入');
    return { added: 0, skipped: 0, newHospitals: 0 };
  }

  const headers = {
    'apikey': SB_KEY,
    'Authorization': `Bearer ${SB_KEY}`,
    'Content-Type': 'application/json',
    'Prefer': 'return=representation'
  };

  // 取得現有醫院 + 最新薪資
  const [hospResp, dashResp] = await Promise.all([
    fetch(`${SB_URL}/rest/v1/hospitals?select=id,name,aliases`, { headers }),
    fetch(`${SB_URL}/rest/v1/dashboard_data?select=hospital,s10,s14,s15,s16`, { headers })
  ]);

  const hospitals = await hospResp.json();
  const currentData = await dashResp.json();

  let added = 0, skipped = 0, newHospitals = 0;

  for (const entry of entries) {
    try {
      // 模糊比對醫院
      let hospital = hospitals.find(h => {
        const n1 = h.name.replace(/[醫院]/g, '');
        const n2 = entry.hospital.replace(/[醫院]/g, '');
        if (h.name === entry.hospital) return true;
        if (n1.includes(n2) || n2.includes(n1)) return true;
        if (h.aliases && h.aliases.some(a =>
          a === entry.hospital || entry.hospital.includes(a) || a.includes(entry.hospital)
        )) return true;
        return false;
      });

      // 檢查是否真的是「新」資料（跟現有薪資不同）
      if (hospital) {
        const current = currentData.find(d => d.hospital === hospital.name);
        if (current) {
          const sameS15 = (!entry.s15 && !current.s15) || (entry.s15 == current.s15);
          const sameS16 = (!entry.s16 && !current.s16) || (entry.s16 == current.s16);
          const sameS10 = (!entry.s10 && !current.s10) || (entry.s10 == current.s10);
          if (sameS15 && sameS16 && sameS10) {
            log(`   ⏭️ ${entry.hospital}: 薪資未變動，跳過`);
            skipped++;
            continue;
          }
        }
      }

      if (!hospital) {
        log(`   🆕 新醫院：${entry.hospital}（${entry.region}）`);
        newHospitals++;

        if (DRY_RUN) {
          log(`      [DRY RUN] 跳過建立`);
          continue;
        }

        const areaLookup = {
          '基隆':'北部','台北':'北部','新北':'北部','桃園':'北部','新竹':'北部','苗栗':'北部','宜蘭':'北部',
          '台中':'中部','彰化':'中部','南投':'中部','雲林':'中部',
          '嘉義':'南部','台南':'南部','高雄':'南部','屏東':'南部',
          '花蓮':'東部','台東':'東部'
        };

        const createResp = await fetch(`${SB_URL}/rest/v1/hospitals`, {
          method: 'POST', headers,
          body: JSON.stringify({
            name: entry.hospital,
            region: entry.region,
            area: areaLookup[entry.region] || '北部',
            level: entry.level || '地區醫院'
          })
        });

        if (!createResp.ok) {
          log(`      ❌ 建立醫院失敗: ${await createResp.text()}`);
          continue;
        }
        const created = await createResp.json();
        hospital = created[0];
        hospitals.push(hospital);
      }

      // 寫入薪資報告
      const report = {
        hospital_id: hospital.id,
        s10: entry.s10 || null,
        s14: entry.s14 || null,
        s15: entry.s15 || null,
        s16: entry.s16 || null,
        visits: entry.visits || null,
        note: entry.note || null,
        source_date: entry.source_date || new Date().toISOString().slice(0, 10),
        submitter_token: 'auto_pipeline'
      };

      if (DRY_RUN) {
        log(`   📋 [DRY RUN] ${entry.hospital}: s15=${report.s15 || '—'}萬`);
        added++;
        continue;
      }

      const insertResp = await fetch(`${SB_URL}/rest/v1/salary_reports`, {
        method: 'POST', headers,
        body: JSON.stringify(report)
      });

      if (insertResp.ok) {
        log(`   ✅ ${entry.hospital}: s15=${report.s15 || '—'}萬 已寫入`);
        added++;
      } else {
        log(`   ❌ ${entry.hospital} 寫入失敗: ${await insertResp.text()}`);
      }

    } catch (err) {
      console.error(`   ❌ ${entry.hospital}:`, err.message);
    }
  }

  return { added, skipped, newHospitals };
}

// ── Main ──────────────────────────────────────
async function main() {
  if (EXPORT_COOKIES) {
    await exportCookiesInteractive();
    return;
  }

  try {
    const posts = await fetchFBPosts();
    const entries = parsePostsWithAI(posts);
    const result = await writeToSupabase(entries);

    // 寫入執行紀錄
    const logEntry = {
      date: new Date().toISOString(),
      postsFound: posts.length,
      entriesParsed: entries.length,
      ...result
    };

    let logs = [];
    if (existsSync(LOG_FILE)) {
      try { logs = JSON.parse(readFileSync(LOG_FILE, 'utf-8')); } catch {}
    }
    logs.push(logEntry);
    writeFileSync(LOG_FILE, JSON.stringify(logs, null, 2));

    console.log(`\n${'═'.repeat(50)}`);
    console.log(`✅ Pipeline 完成！`);
    console.log(`   爬到貼文：${posts.length} 篇`);
    console.log(`   解析薪資：${entries.length} 筆`);
    console.log(`   新增寫入：${result.added} 筆`);
    console.log(`   薪資未變：${result.skipped} 筆`);
    console.log(`   新增醫院：${result.newHospitals} 間`);
    console.log(`${'═'.repeat(50)}\n`);

  } catch (err) {
    console.error('\n❌ Pipeline 失敗:', err.message);
    console.error(err.stack);
    process.exit(1);
  }
}

main();
