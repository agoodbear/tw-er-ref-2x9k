#!/usr/bin/env node
/**
 * FB 急診薪資爬取 Pipeline v3 — Scroll + Read + Expand
 *
 * 核心發現：
 * - FB m版用 virtual scroll，只有 viewport 內的貼文 visible=true
 * - div.native-text 的 textContent 是可讀中文（非亂碼）
 * - 必須「邊捲動邊讀取」，因為離開 viewport 後元素會被 recycle
 * - 「查看更多」按鈕是 <span class="f1">，必須捲到可見時才能點擊
 *
 * 流程：
 * 1. Playwright 開 m.facebook.com 社團
 * 2. 逐步捲動，每步：展開「查看更多」→ 讀取可見的貼文文字
 * 3. claude -p 解析所有貼文，提取薪資
 * 4. 比對 Supabase，寫入新資料
 *
 * Usage:
 *   node scripts/fetch-fb-salary.mjs [--days 7] [--dry-run]
 *   node scripts/fetch-fb-salary.mjs --export-cookies
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
const DEFAULT_GROUP = 'https://m.facebook.com/groups/Taiwan.ER';

const args = process.argv.slice(2);
const DAYS = parseInt(args.find((_, i, a) => a[i - 1] === '--days') || '7');
const DRY_RUN = args.includes('--dry-run');
const GROUP_URL = args.find((_, i, a) => a[i - 1] === '--group') || DEFAULT_GROUP;
const EXPORT_COOKIES = args.includes('--export-cookies');

console.log(`\n🏥 急診薪資爬取 Pipeline v3（Scroll + Read + Expand）`);
console.log(`   社團：${GROUP_URL}`);
console.log(`   期間：最近 ${DAYS} 天`);
console.log(`   模式：${DRY_RUN ? '🔍 Dry Run（不寫入）' : '✍️ 寫入 Supabase'}`);
console.log('');

if (!existsSync(RESULTS_DIR)) mkdirSync(RESULTS_DIR, { recursive: true });

function sleep(ms) { return new Promise(r => setTimeout(r, ms + randomInt(500, 1500))); }
function log(msg) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] ${msg}`);
}

// ── Cookie 管理 ──────────────────────────────────
async function exportCookiesInteractive() {
  log('🍪 互動式 Cookie 擷取...');
  const browser = await chromium.launch({
    executablePath: CHROMIUM_PATH, headless: false,
    args: ['--disable-blink-features=AutomationControlled']
  });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
    viewport: { width: 390, height: 844 }
  });
  const page = await context.newPage();
  await page.goto('https://m.facebook.com/', { waitUntil: 'networkidle' });
  console.log('\n⏳ 請在瀏覽器中登入 Facebook...\n');
  for (let i = 0; i < 120; i++) {
    await sleep(5000);
    const cookies = await context.cookies();
    if (cookies.some(c => c.name === 'c_user')) {
      log('✅ 偵測到登入！儲存 cookie...');
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
    throw new Error(`找不到 cookie (${COOKIE_FILE})。\n請先執行：node scripts/fetch-fb-salary.mjs --export-cookies`);
  }
  const raw = JSON.parse(readFileSync(COOKIE_FILE, 'utf-8'));
  const cUser = raw.find(c => c.name === 'c_user');
  if (!cUser) throw new Error('Cookie 中沒有 c_user，需要重新登入');
  log(`🍪 Cookie 載入成功（c_user: ${cUser.value.slice(0, 4)}...）`);
  return raw;
}

// ── Step 1: 邊捲動邊讀取貼文 ──────────────────────
async function fetchPostTexts() {
  log('📱 Step 1: 爬取社團貼文（邊捲動、邊展開、邊讀取）...');

  const cookies = loadCookies();

  const browser = await chromium.launch({
    executablePath: CHROMIUM_PATH, headless: false,
    args: ['--disable-blink-features=AutomationControlled']
  });

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
    viewport: { width: 390, height: 844 },
    locale: 'zh-TW', timezoneId: 'Asia/Taipei'
  });

  await context.addCookies(cookies);
  const page = await context.newPage();

  try {
    await page.goto(GROUP_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(4000);

    if (page.url().includes('/login') || page.url().includes('checkpoint')) {
      throw new Error('Cookie 已過期。請重新執行 --export-cookies');
    }
    log('   ✅ 已進入社團頁面');

    const scrollRounds = Math.min(Math.ceil(DAYS * 3), 40);
    const allTexts = new Set(); // 用 Set 去重
    const posts = [];

    for (let i = 0; i < scrollRounds; i++) {
      // Step A: 展開當前可見的「查看更多」
      await page.evaluate(() => {
        // FB m 版的「查看更多」按鈕在 span.f1 或文字包含「查看更多」的元素
        document.querySelectorAll('span.f1, a, div[role="button"]').forEach(el => {
          const t = (el.textContent || '').trim();
          if (t === '查看更多' || t === '……查看更多' || t === 'See more' || t === 'See More') {
            const rect = el.getBoundingClientRect();
            // 只點可見且在 viewport 內的
            if (rect.height > 0 && rect.top > -100 && rect.top < window.innerHeight + 100) {
              try { el.click(); } catch {}
            }
          }
        });
      });
      await sleep(600);

      // Step B: 讀取當前可見的貼文內容
      const visibleTexts = await page.evaluate(() => {
        const results = [];
        // 找所有 native-text 元素
        document.querySelectorAll('div.native-text').forEach(el => {
          const rect = el.getBoundingClientRect();
          // 只讀可見且在 viewport 附近的
          if (rect.height > 0 && rect.top > -500 && rect.top < window.innerHeight + 500) {
            const text = el.textContent || '';
            if (text.length > 30) {
              results.push(text.trim());
            }
          }
        });
        return results;
      });

      for (const text of visibleTexts) {
        if (!allTexts.has(text.slice(0, 100))) { // 用前 100 字作為 key 去重
          allTexts.add(text.slice(0, 100));
          posts.push(text);
        }
      }

      // Step C: 捲動
      await page.evaluate(() => window.scrollBy(0, 600));
      await sleep(2000);
      process.stdout.write(`\r   📜 捲動 ${i + 1}/${scrollRounds}，已收集 ${posts.length} 段文字...`);
    }
    console.log('');
    log(`   ✅ 共收集 ${posts.length} 段不重複文字`);

    await browser.close();

    // 儲存原始文字
    const rawPath = join(RESULTS_DIR, `raw-${new Date().toISOString().slice(0, 10)}.json`);
    writeFileSync(rawPath, JSON.stringify(posts, null, 2));
    log(`   💾 原始文字存於：${rawPath}`);

    return posts;

  } catch (err) {
    await browser.close();
    throw err;
  }
}

// ── Step 2: AI 解析貼文 ──────────────────────────
async function parsePostsWithAI(posts) {
  log('\n🤖 Step 2: AI 解析貼文內容...');

  if (posts.length === 0) {
    log('   ⚠️ 沒有收集到文字，跳過');
    return [];
  }

  // 先篩選可能包含薪資的貼文（減少 AI 處理量）
  const salaryKeywords = ['薪', '月薪', '時薪', '萬', '徵才', '誠徵', '招募', '保證', '稅前', '班'];
  const candidates = posts.filter(text =>
    salaryKeywords.some(kw => text.includes(kw))
  );

  log(`   📋 ${posts.length} 段文字中，${candidates.length} 段可能包含薪資`);

  if (candidates.length === 0) {
    log('   ⚠️ 沒有找到薪資相關貼文');
    return [];
  }

  const postsText = candidates.map((text, i) =>
    `--- 貼文 #${i + 1} ---\n${text}\n`
  ).join('\n');

  const prompt = `你是急診薪資資料分析助手。以下是從 Facebook「急診醫師的秘密花園」私密社團爬到的貼文文字。

請從中提取所有「急診醫師薪資 / 徵才」貼文的薪資資訊。

## 提取規則

1. 提取任何提到具體薪資數字的貼文（月薪、班薪、時薪皆可）
2. 薪資統一轉換為「月薪（萬）」填入 s10/s14/s15/s16 欄位：
   - 如果貼文直接寫月薪，直接填入（如 50.5萬 → 50.5）
   - 如果是班薪制（如每班 2.4~3.2 萬），請估算 15 班月薪：取平均班薪 × 15，填入 s15
   - 如果是時薪制（如 1667/hr），請估算：時薪 × 12hr × 15班 / 10000，填入 s15
3. 班數欄位（s10/s14/s15/s16）填的是「上 N 班的月薪總額（萬）」
4. 貼文中如果有人提到「15班稅前50萬」之類的描述（即使語氣是抱怨或討論），也要提取
5. 醫院名稱用社群常用簡稱（如「中醫北港」「員基」「台東馬偕」「輔大醫院」）
6. 地區：基隆/台北/新北/桃園/新竹/苗栗/台中/彰化/南投/雲林/嘉義/台南/高雄/屏東/宜蘭/花蓮/台東
7. 醫院層級：醫學中心/區域醫院/地區醫院/部立醫院
8. source_date 盡量從文中判斷貼文日期，無法判斷則填 ${new Date().toISOString().slice(0, 10)}
9. 非徵才文（如純討論、新聞轉貼、求助文）即使提到「薪」「萬」等字也不要提取
10. note 欄位記錄班制（如「固定班薪制，平日白/中/夜班 2.4/2.5/2.8萬」）、特殊福利等

只回覆 JSON array，不加任何說明文字：
[{"hospital":"醫院","region":"地區","level":"層級","s10":null,"s14":null,"s15":45,"s16":null,"visits":null,"note":"備註","source_date":"2026-04-11"}]

如果沒有可提取的薪資資料，回覆 []

${postsText}`;

  const tmpFile = join(tmpdir(), 'er-salary-posts.txt');
  writeFileSync(tmpFile, prompt);

  // 最多重試 3 次（API 500 error 重試通常會成功）
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      if (attempt > 1) log(`   🔄 重試第 ${attempt} 次...`);

      const result = execSync(
        `cat "${tmpFile}" | claude -p --output-format json`,
        { encoding: 'utf-8', timeout: 180000, maxBuffer: 10 * 1024 * 1024 }
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

      const parsedPath = join(RESULTS_DIR, `parsed-${new Date().toISOString().slice(0, 10)}.json`);
      writeFileSync(parsedPath, JSON.stringify(parsed, null, 2));
      log(`   💾 存於：${parsedPath}`);

      return parsed;
    } catch (err) {
      const isRetryable = err.message.includes('500') || err.message.includes('Internal') || err.message.includes('overloaded');
      if (isRetryable && attempt < 3) {
        log(`   ⚠️ API 錯誤（${attempt}/3），30 秒後重試...`);
        await new Promise(r => setTimeout(r, 30000));
        continue;
      }
      console.error(`   ❌ AI 解析失敗: ${err.message}`);
      return [];
    }
  }
  return [];
}

// ── Step 3: 寫入 Supabase ──────────────────────────
async function writeToSupabase(entries) {
  log('\n💾 Step 3: 比對 Supabase 並寫入...');

  if (entries.length === 0) {
    log('   ⚠️ 沒有新資料');
    return { added: 0, skipped: 0, newHospitals: 0 };
  }

  const headers = {
    'apikey': SB_KEY, 'Authorization': `Bearer ${SB_KEY}`,
    'Content-Type': 'application/json', 'Prefer': 'return=representation'
  };

  const [hospResp, dashResp] = await Promise.all([
    fetch(`${SB_URL}/rest/v1/hospitals?select=id,name,aliases`, { headers }),
    fetch(`${SB_URL}/rest/v1/dashboard_data?select=hospital,s10,s14,s15,s16`, { headers })
  ]);

  const hospitals = await hospResp.json();
  const currentData = await dashResp.json();
  let added = 0, skipped = 0, newHospitals = 0;

  // 常用簡稱 → 全名映射
  const aliasMap = {
    '員基': '員林基督教醫院', '員林基督教': '員林基督教醫院',
    '中醫北港': '中國醫藥大學北港附設醫院', '北港媽祖': '中國醫藥大學北港附設醫院',
    '台大雲林': '台大醫院雲林分院', '台東馬偕': '台東馬偕紀念醫院',
    '光田': '光田醫院', '署苗': '衛生福利部苗栗醫院',
    '聯醫': '台北市立聯合醫院', '高醫岡山': '高雄醫學大學附設岡山醫院',
    '彰濱秀傳': '彰濱秀傳紀念醫院', '埔基': '埔里基督教醫院',
    '輔大醫院': '輔仁大學附設醫院',
  };

  for (const entry of entries) {
    try {
      // 先查簡稱映射
      const resolvedName = aliasMap[entry.hospital] || entry.hospital;

      let hospital = hospitals.find(h => {
        const n1 = h.name.replace(/醫院/g, '');
        const n2 = resolvedName.replace(/醫院/g, '');
        const n3 = entry.hospital.replace(/醫院/g, '');
        if (h.name === resolvedName || h.name === entry.hospital) return true;
        if (n1.includes(n2) || n2.includes(n1)) return true;
        if (n1.includes(n3) || n3.includes(n1)) return true;
        if (h.aliases && h.aliases.some(a =>
          a === entry.hospital || a === resolvedName ||
          entry.hospital.includes(a) || a.includes(entry.hospital)
        )) return true;
        return false;
      });

      if (hospital) {
        const current = currentData.find(d => d.hospital === hospital.name);
        if (current) {
          const same = (
            ((!entry.s15 && !current.s15) || entry.s15 == current.s15) &&
            ((!entry.s16 && !current.s16) || entry.s16 == current.s16) &&
            ((!entry.s10 && !current.s10) || entry.s10 == current.s10)
          );
          if (same) {
            log(`   ⏭️ ${entry.hospital}: 薪資未變動，跳過`);
            skipped++;
            continue;
          }
        }
      }

      if (!hospital) {
        log(`   🆕 新醫院：${entry.hospital}（${entry.region}）`);
        newHospitals++;
        if (DRY_RUN) { log(`      [DRY RUN] 跳過`); continue; }

        const areaLookup = {
          '基隆':'北部','台北':'北部','新北':'北部','桃園':'北部','新竹':'北部','苗栗':'北部','宜蘭':'北部',
          '台中':'中部','彰化':'中部','南投':'中部','雲林':'中部',
          '嘉義':'南部','台南':'南部','高雄':'南部','屏東':'南部',
          '花蓮':'東部','台東':'東部'
        };

        const createResp = await fetch(`${SB_URL}/rest/v1/hospitals`, {
          method: 'POST', headers,
          body: JSON.stringify({
            name: entry.hospital, region: entry.region,
            area: areaLookup[entry.region] || '北部',
            level: entry.level || '地區醫院'
          })
        });
        if (!createResp.ok) { log(`      ❌ 建立失敗: ${await createResp.text()}`); continue; }
        hospital = (await createResp.json())[0];
        hospitals.push(hospital);
      }

      const report = {
        hospital_id: hospital.id, s10: entry.s10 || null, s14: entry.s14 || null,
        s15: entry.s15 || null, s16: entry.s16 || null, visits: entry.visits || null,
        note: entry.note || null,
        source_date: entry.source_date || new Date().toISOString().slice(0, 10),
        submitter_token: 'auto_pipeline'
      };

      if (DRY_RUN) {
        log(`   📋 [DRY RUN] ${entry.hospital}: s10=${report.s10 || '—'} s15=${report.s15 || '—'} s16=${report.s16 || '—'}萬`);
        added++;
        continue;
      }

      const insertResp = await fetch(`${SB_URL}/rest/v1/salary_reports`, {
        method: 'POST', headers, body: JSON.stringify(report)
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
const MAX_RETRIES = 2;       // 最多重試 2 次（含首次共 3 次）
const RETRY_DELAY = 3600000; // 1 小時 = 3,600,000 ms

async function run() {
  const posts = await fetchPostTexts();
  const entries = await parsePostsWithAI(posts);
  const result = await writeToSupabase(entries);

  const logEntry = {
    date: new Date().toISOString(),
    postsCollected: posts.length,
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
  console.log(`   收集文字：${posts.length} 段`);
  console.log(`   解析薪資：${entries.length} 筆`);
  console.log(`   新增寫入：${result.added} 筆`);
  console.log(`   薪資未變：${result.skipped} 筆`);
  console.log(`   新增醫院：${result.newHospitals} 間`);
  console.log(`${'═'.repeat(50)}\n`);
}

async function main() {
  if (EXPORT_COOKIES) { await exportCookiesInteractive(); return; }

  for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt++) {
    try {
      if (attempt > 1) {
        log(`🔄 第 ${attempt} 次嘗試（上次失敗後等了 1 小時）`);
      }
      await run();
      return; // 成功就結束
    } catch (err) {
      console.error(`\n❌ Pipeline 失敗（第 ${attempt} 次）: ${err.message}`);

      if (attempt <= MAX_RETRIES) {
        const nextTime = new Date(Date.now() + RETRY_DELAY).toLocaleTimeString('zh-TW');
        log(`⏳ 將在 1 小時後自動重試（預計 ${nextTime}）...`);
        await new Promise(r => setTimeout(r, RETRY_DELAY));
      } else {
        console.error('❌ 已達最大重試次數，放棄本次執行。');
        console.error(err.stack);
        process.exit(1);
      }
    }
  }
}

main();
