#!/usr/bin/env node
/**
 * FB 急診薪資爬取 Pipeline v2 — Screenshot + AI Vision
 *
 * 策略：
 * FB 的 CSS font substitution 讓 innerText 全是亂碼，
 * 所以改用截圖 + Claude Vision 來辨識貼文內容。
 *
 * 流程：
 * 1. Playwright 開 m.facebook.com 社團，捲動+截圖（每段一張）
 * 2. claude -p (vision) 辨識每張截圖中的薪資貼文
 * 3. 合併解析結果，比對 Supabase 現有醫院，寫入新資料
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

console.log(`\n🏥 急診薪資爬取 Pipeline v2（Screenshot + Vision）`);
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
    executablePath: CHROMIUM_PATH,
    headless: false,
    args: ['--disable-blink-features=AutomationControlled']
  });

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
    viewport: { width: 390, height: 844 }
  });

  const page = await context.newPage();
  await page.goto('https://m.facebook.com/', { waitUntil: 'networkidle' });

  console.log('\n⏳ 請在瀏覽器中登入 Facebook...');
  console.log('   登入完成後會自動偵測並儲存 cookie。\n');

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
    throw new Error(
      `找不到 cookie (${COOKIE_FILE})。\n` +
      `請先執行：node scripts/fetch-fb-salary.mjs --export-cookies`
    );
  }
  const raw = JSON.parse(readFileSync(COOKIE_FILE, 'utf-8'));
  const cUser = raw.find(c => c.name === 'c_user');
  if (!cUser) throw new Error('Cookie 中沒有 c_user，需要重新登入');
  log(`🍪 Cookie 載入成功（c_user: ${cUser.value.slice(0, 4)}...）`);
  return raw;
}

// ── Step 1: 截圖社團頁面 ──────────────────────────
async function captureGroupScreenshots() {
  log('📱 Step 1: 擷取社團頁面截圖...');

  const cookies = loadCookies();

  const browser = await chromium.launch({
    executablePath: CHROMIUM_PATH,
    headless: false,
    args: ['--disable-blink-features=AutomationControlled']
  });

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
    viewport: { width: 390, height: 844 },
    locale: 'zh-TW',
    timezoneId: 'Asia/Taipei'
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

    // 策略：捲動 → 每段截一張全畫面圖
    // 估算：7 天大概需要捲 10-15 次（每次約 2-3 篇貼文）
    const scrollRounds = Math.min(Math.ceil(DAYS * 2), 25);
    const screenshots = [];
    const screenshotDir = join(RESULTS_DIR, `screenshots-${new Date().toISOString().slice(0, 10)}`);
    if (!existsSync(screenshotDir)) mkdirSync(screenshotDir, { recursive: true });

    for (let i = 0; i < scrollRounds; i++) {
      // 展開「更多」按鈕（每次捲動後都試）
      await page.evaluate(() => {
        document.querySelectorAll('a[href*="see_more"], span.see_more_link_inner').forEach(btn => {
          try { btn.click(); } catch {}
        });
      });
      await sleep(800);

      // 截圖當前畫面
      const path = join(screenshotDir, `page-${String(i).padStart(2, '0')}.png`);
      await page.screenshot({ path, fullPage: false });
      screenshots.push(path);

      // 捲動
      await page.evaluate(() => window.scrollBy(0, 750));
      await sleep(2500);
      process.stdout.write(`\r   📜 捲動+截圖 ${i + 1}/${scrollRounds}...`);
    }
    console.log('');
    log(`   ✅ 共截取 ${screenshots.length} 張截圖`);

    await browser.close();
    return screenshots;

  } catch (err) {
    await browser.close();
    throw err;
  }
}

// ── Step 2: Claude Vision 辨識薪資貼文 ──────────────
function analyzeScreenshotsWithVision(screenshots) {
  log('\n🤖 Step 2: Claude Vision 辨識截圖中的薪資資訊...');

  if (screenshots.length === 0) {
    log('   ⚠️ 沒有截圖，跳過');
    return [];
  }

  // 分批處理：每次送 3-4 張圖（避免太大）
  const batchSize = 4;
  const allEntries = [];

  for (let batchStart = 0; batchStart < screenshots.length; batchStart += batchSize) {
    const batch = screenshots.slice(batchStart, batchStart + batchSize);
    const batchNum = Math.floor(batchStart / batchSize) + 1;
    const totalBatches = Math.ceil(screenshots.length / batchSize);

    log(`   📸 處理批次 ${batchNum}/${totalBatches}（${batch.length} 張圖）...`);

    // 建構 claude -p 的指令，用圖片路徑
    const imageArgs = batch.map(p => `"${p}"`).join(' ');

    const prompt = `你是急診薪資資料分析助手。以下截圖來自 Facebook「急診醫師的秘密花園」私密社團。

請仔細閱讀每張截圖，找出任何「急診醫師薪資 / 徵才」相關的貼文。

提取規則：
1. 只提取明確提到月薪數字的貼文（不含「待遇優」、「面議」等）
2. 薪資單位為「萬」（如 50.5萬 → 50.5）
3. 班數通常是 10/14/15/16 班制
4. 醫院名稱用社群常用簡稱
5. 地區：基隆/台北/新北/桃園/新竹/苗栗/台中/彰化/南投/雲林/嘉義/台南/高雄/屏東/宜蘭/花蓮/台東
6. 醫院層級：醫學中心/區域醫院/地區醫院/部立醫院
7. source_date 填貼文日期（從貼文上方的時間判斷，如「4月11日」→ 2026-04-11）

如果截圖中沒有薪資相關貼文（只是討論、新聞、閒聊），回覆空陣列 []

只回覆 JSON，不加說明：
[{"hospital":"醫院","region":"地區","level":"層級","s10":null,"s14":null,"s15":45,"s16":null,"visits":null,"note":"備註","source_date":"2026-04-11"}]`;

    const tmpPrompt = join(tmpdir(), `er-vision-batch-${batchNum}.txt`);
    writeFileSync(tmpPrompt, prompt);

    try {
      const cmd = `cat "${tmpPrompt}" | claude -p --output-format json ${batch.map(p => `"${p}"`).join(' ')} 2>/dev/null`;
      const result = execSync(cmd, {
        encoding: 'utf-8',
        timeout: 180000,
        maxBuffer: 10 * 1024 * 1024
      });

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

      if (parsed.length > 0) {
        log(`   ✅ 批次 ${batchNum}: 提取到 ${parsed.length} 筆薪資資料`);
        allEntries.push(...parsed);
      }

    } catch (err) {
      log(`   ⚠️ 批次 ${batchNum} 解析失敗: ${err.message}`);
    }
  }

  // 去重（同醫院同日期只留一筆）
  const deduped = [];
  const seen = new Set();
  for (const e of allEntries) {
    const key = `${e.hospital}_${e.source_date}`;
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(e);
    }
  }

  log(`   ✅ 共提取 ${deduped.length} 筆不重複薪資資料`);

  const parsedPath = join(RESULTS_DIR, `parsed-${new Date().toISOString().slice(0, 10)}.json`);
  writeFileSync(parsedPath, JSON.stringify(deduped, null, 2));
  log(`   💾 存於：${parsedPath}`);

  return deduped;
}

// ── Step 3: 寫入 Supabase ──────────────────────────
async function writeToSupabase(entries) {
  log('\n💾 Step 3: 比對 Supabase 並寫入...');

  if (entries.length === 0) {
    log('   ⚠️ 沒有新資料');
    return { added: 0, skipped: 0, newHospitals: 0 };
  }

  const headers = {
    'apikey': SB_KEY,
    'Authorization': `Bearer ${SB_KEY}`,
    'Content-Type': 'application/json',
    'Prefer': 'return=representation'
  };

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
        const n1 = h.name.replace(/醫院/g, '');
        const n2 = entry.hospital.replace(/醫院/g, '');
        if (h.name === entry.hospital) return true;
        if (n1.includes(n2) || n2.includes(n1)) return true;
        if (h.aliases && h.aliases.some(a =>
          a === entry.hospital || entry.hospital.includes(a) || a.includes(entry.hospital)
        )) return true;
        return false;
      });

      // 比對薪資是否已有
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
        hospital_id: hospital.id,
        s10: entry.s10 || null, s14: entry.s14 || null,
        s15: entry.s15 || null, s16: entry.s16 || null,
        visits: entry.visits || null, note: entry.note || null,
        source_date: entry.source_date || new Date().toISOString().slice(0, 10),
        submitter_token: 'auto_pipeline'
      };

      if (DRY_RUN) {
        log(`   📋 [DRY RUN] ${entry.hospital}: s15=${report.s15 || '—'}萬`);
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
async function main() {
  if (EXPORT_COOKIES) {
    await exportCookiesInteractive();
    return;
  }

  try {
    const screenshots = await captureGroupScreenshots();
    const entries = analyzeScreenshotsWithVision(screenshots);
    const result = await writeToSupabase(entries);

    const logEntry = {
      date: new Date().toISOString(),
      screenshots: screenshots.length,
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
    console.log(`   截圖數量：${screenshots.length} 張`);
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
