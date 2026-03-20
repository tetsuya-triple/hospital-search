/**
 * ナビイ（医療情報ネット）分娩数データ スクレイピングスクリプト
 *
 * navii_mapping.json のマッチ済み施設について、ナビイの施設詳細ページから
 * 「◆産科領域」セクションの分娩件数データを取得する。
 *
 * 使い方: node scripts/scrape_navii.cjs [--resume] [--retry-errors] [--limit N] [--delay MS]
 *   --resume: 前回の中断地点から再開（navii_deliveries.json の既取得施設をスキップ）
 *   --retry-errors: エラーになった施設のみ再取得
 *   --limit N: 最初のN施設のみ処理（テスト用）
 *   --delay MS: アクセス間隔（ミリ秒、デフォルト: 3000）
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const MAPPING_FILE = path.join(DATA_DIR, 'navii_mapping.json');
const OUTPUT_FILE = path.join(DATA_DIR, 'navii_deliveries.json');
const BASE_URL = 'https://www.iryou.teikyouseido.mhlw.go.jp/znk-web/juminkanja/S2430/initialize';
const DEFAULT_DELAY_MS = 3000;

function parseArgs() {
  const args = process.argv.slice(2);
  return {
    resume: args.includes('--resume'),
    retryErrors: args.includes('--retry-errors'),
    limit: args.includes('--limit') ? parseInt(args[args.indexOf('--limit') + 1]) : 0,
    delay: args.includes('--delay') ? parseInt(args[args.indexOf('--delay') + 1]) : DEFAULT_DELAY_MS
  };
}

function loadExistingResults() {
  if (fs.existsSync(OUTPUT_FILE)) {
    return JSON.parse(fs.readFileSync(OUTPUT_FILE, 'utf-8'));
  }
  return [];
}

function saveResults(results) {
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(results, null, 2), 'utf-8');
}

async function extractDeliveryData(page) {
  return await page.evaluate(() => {
    const result = {
      normal_deliveries: null,
      elective_cesarean: null,
      emergency_cesarean: null,
      has_obstetric_section: false
    };

    // ◆産科領域 セクションを探す
    const strongs = document.querySelectorAll('strong');
    let obstetricSection = null;
    for (const s of strongs) {
      if (s.textContent.includes('産科領域')) {
        obstetricSection = s;
        result.has_obstetric_section = true;
        break;
      }
    }

    if (!obstetricSection) return result;

    // DOM構造: <div class="ptn5DataArea"><label><strong>◆産科領域</strong></label><table>...</table></div>
    // strongの親が<label>で、テーブルはlabelの兄弟要素
    let table = null;
    const parent = obstetricSection.parentElement; // <label>
    if (parent) {
      // labelの次の兄弟要素がtable
      let sibling = parent.nextElementSibling;
      while (sibling) {
        if (sibling.tagName === 'TABLE') {
          table = sibling;
          break;
        }
        sibling = sibling.nextElementSibling;
      }
    }
    // フォールバック: strongの直接の兄弟
    if (!table) {
      let sibling = obstetricSection.nextElementSibling;
      while (sibling) {
        if (sibling.tagName === 'TABLE') {
          table = sibling;
          break;
        }
        sibling = sibling.nextElementSibling;
      }
    }

    if (!table) return result;

    extractFromTable(table, result);
    return result;

    function extractFromTable(tbl, res) {
      const rows = tbl.querySelectorAll('tr');
      for (const row of rows) {
        const cells = row.querySelectorAll('td, th');
        for (let i = 0; i < cells.length - 1; i++) {
          const label = cells[i].textContent.trim();
          const value = cells[i + 1].textContent.trim();

          if (label === '正常分娩') {
            res.normal_deliveries = parseCount(value);
          } else if (label === '選択帝王切開術') {
            res.elective_cesarean = parseCount(value);
          } else if (label === '緊急帝王切開術') {
            res.emergency_cesarean = parseCount(value);
          }
        }
      }
    }

    function parseCount(str) {
      if (!str || str === '-' || str === '－') return null;
      const num = parseInt(str.replace(/[件,，\s]/g, ''));
      return isNaN(num) ? null : num;
    }
  });
}

async function main() {
  const { resume, retryErrors, limit, delay } = parseArgs();
  const DELAY_MS = delay;
  const mapping = JSON.parse(fs.readFileSync(MAPPING_FILE, 'utf-8'));
  let results = (resume || retryErrors) ? loadExistingResults() : [];

  let facilities;
  if (retryErrors) {
    // エラー施設のIDを取得し、結果からエラー分を除去して再取得対象とする
    const errorIds = new Set(results.filter(r => r.error).map(r => r.facility_id));
    results = results.filter(r => !r.error); // エラー分を除去
    facilities = mapping.filter(f => errorIds.has(f.facility_id));
  } else {
    const processedIds = new Set(results.map(r => r.facility_id));
    facilities = mapping.filter(f => !processedIds.has(f.facility_id));
  }
  if (limit > 0) facilities = facilities.slice(0, limit);
  const processedIds = new Set(results.map(r => r.facility_id));

  console.log(`=== ナビイ分娩数スクレイピング ===`);
  console.log(`マッチ済み施設: ${mapping.length}件`);
  console.log(`取得済み: ${processedIds.size}件`);
  console.log(`今回処理対象: ${facilities.length}件`);
  console.log(`開始時刻: ${new Date().toLocaleString('ja-JP')}`);
  console.log('');

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  });
  const page = await context.newPage();
  page.setDefaultTimeout(30000);

  let successCount = 0;
  let hasDataCount = 0;
  let noDataCount = 0;
  let errorCount = 0;

  for (let i = 0; i < facilities.length; i++) {
    const f = facilities[i];
    const progress = `[${processedIds.size + i + 1}/${mapping.length}]`;

    try {
      // 施設詳細ページにアクセス
      const url = `${BASE_URL}?kikanCd=${f.kikanCd}&kikanKbn=${f.kikanKbn}&prefCd=${f.prefCd}`;
      await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });

      // 「診療内容、提供 保健・医療・介護サービス」タブをクリック
      const tabButton = page.locator('button').filter({ hasText: '診療内容、提供' });
      if (await tabButton.count() > 0) {
        await tabButton.first().click();
        await page.waitForTimeout(1000);
      } else {
        // タブが見つからない場合
        const entry = {
          facility_id: f.facility_id,
          facility_name: f.facility_name,
          navii_id: f.navii_id,
          prefCd: f.prefCd,
          kikanKbn: f.kikanKbn,
          kikanCd: f.kikanCd,
          normal_deliveries: null,
          elective_cesarean: null,
          emergency_cesarean: null,
          total_deliveries: null,
          has_obstetric_section: false,
          error: 'tab_not_found',
          scraped_at: new Date().toISOString()
        };
        results.push(entry);
        noDataCount++;
        console.log(`${progress} ${f.facility_name}: タブなし`);

        if ((processedIds.size + i + 1) % 50 === 0) saveResults(results);
        await page.waitForTimeout(DELAY_MS);
        continue;
      }

      // 分娩データ抽出
      const data = await extractDeliveryData(page);

      const total = (data.normal_deliveries || 0) + (data.elective_cesarean || 0) + (data.emergency_cesarean || 0);
      const hasAnyData = data.normal_deliveries !== null || data.elective_cesarean !== null || data.emergency_cesarean !== null;

      const entry = {
        facility_id: f.facility_id,
        facility_name: f.facility_name,
        navii_id: f.navii_id,
        prefCd: f.prefCd,
        kikanKbn: f.kikanKbn,
        kikanCd: f.kikanCd,
        normal_deliveries: data.normal_deliveries,
        elective_cesarean: data.elective_cesarean,
        emergency_cesarean: data.emergency_cesarean,
        total_deliveries: hasAnyData ? total : null,
        has_obstetric_section: data.has_obstetric_section,
        error: null,
        scraped_at: new Date().toISOString()
      };

      results.push(entry);
      successCount++;

      if (hasAnyData) {
        hasDataCount++;
        console.log(`${progress} ${f.facility_name}: 正常${data.normal_deliveries ?? '-'} / 選択帝切${data.elective_cesarean ?? '-'} / 緊急帝切${data.emergency_cesarean ?? '-'} (計${total}件)`);
      } else {
        noDataCount++;
        console.log(`${progress} ${f.facility_name}: 産科領域${data.has_obstetric_section ? 'あり' : 'なし'}・分娩数なし`);
      }

    } catch (err) {
      errorCount++;
      const entry = {
        facility_id: f.facility_id,
        facility_name: f.facility_name,
        navii_id: f.navii_id,
        prefCd: f.prefCd,
        kikanKbn: f.kikanKbn,
        kikanCd: f.kikanCd,
        normal_deliveries: null,
        elective_cesarean: null,
        emergency_cesarean: null,
        total_deliveries: null,
        has_obstetric_section: false,
        error: err.message,
        scraped_at: new Date().toISOString()
      };
      results.push(entry);
      console.log(`${progress} ${f.facility_name}: エラー - ${err.message.slice(0, 80)}`);
    }

    // 定期保存（50件ごと）
    if ((processedIds.size + i + 1) % 50 === 0) {
      saveResults(results);
      console.log(`  → ${results.length}件保存完了`);
    }

    // アクセス間隔
    await page.waitForTimeout(DELAY_MS);
  }

  await browser.close();
  saveResults(results);

  // 全結果の集計
  const allHasData = results.filter(r => r.total_deliveries !== null).length;
  const allNoData = results.filter(r => r.total_deliveries === null && !r.error).length;
  const allErrors = results.filter(r => r.error).length;

  console.log('');
  console.log('=== 完了 ===');
  console.log(`処理完了: ${facilities.length}件（今回）`);
  console.log(`全体結果: ${results.length}件`);
  console.log(`  分娩数あり: ${allHasData}件`);
  console.log(`  分娩数なし: ${allNoData}件`);
  console.log(`  エラー: ${allErrors}件`);
  console.log(`保存先: ${OUTPUT_FILE}`);
  console.log(`終了時刻: ${new Date().toLocaleString('ja-JP')}`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
