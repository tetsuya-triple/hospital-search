/**
 * 出産なび 全国施設データ スクレイパー（Triple LLC）
 *
 * 使い方:
 *   node scripts/birth-navi-scrape.js
 *
 * 出力:
 *   /triple-llc/sales/birth-navi-YYYY-MM-DD.csv
 *   /triple-llc/sales/birth-navi-YYYY-MM-DD.json
 */

import { writeFileSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = resolve(__dirname, '../../sales');
const BASE_URL = 'https://birth-navi.mhlw.go.jp';
const RATE_LIMIT_MS = 1200;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const today = new Date().toISOString().slice(0, 10);

/** turbo-stream（React Router v7）形式をオブジェクトに変換 */
function parseTurboStream(html) {
  const startMarker = 'streamController.enqueue(';
  const idx = html.indexOf(startMarker);
  if (idx === -1) return null;

  const afterParen = html.slice(idx + startMarker.length);
  const closingPattern = '\\n");';
  const closingIdx = afterParen.indexOf(closingPattern);
  if (closingIdx === -1) return null;

  // JS文字列リテラルをJSON.parseでデコード
  const strLiteral = afterParen.slice(0, closingIdx + closingPattern.length - ');'.length);
  let jsonArrayStr;
  try {
    jsonArrayStr = JSON.parse(strLiteral);
  } catch {
    return null;
  }

  let store;
  try {
    store = JSON.parse(jsonArrayStr);
  } catch {
    return null;
  }

  // store参照を再帰的に解決
  function resolveValue(val) {
    if (val === null || val === undefined) return val;
    if (typeof val !== 'object') return val;
    if (Array.isArray(val)) {
      return val.map((item) =>
        typeof item === 'number' ? resolveValue(store[item]) : resolveValue(item)
      );
    }
    const result = {};
    for (const [k, v] of Object.entries(val)) {
      if (!k.startsWith('_')) continue;
      const keyIdx = parseInt(k.slice(1));
      const keyName = store[keyIdx];
      if (typeof keyName !== 'string') continue;
      const rawVal = typeof v === 'number' ? store[v] : v;
      result[keyName] = resolveValue(rawVal);
    }
    return result;
  }

  const root = resolveValue(store[0]);
  return root?.loaderData?.['routes/FacilityDetail']?.facility ?? null;
}

/** 施設データをフラットなCSV行用オブジェクトに変換 */
function flattenFacility(f, id) {
  if (!f) return null;
  return {
    id,
    name: f.name ?? '',
    address: f.address ?? '',
    phone: f.phoneNumber ?? '',
    website: f.externalSites?.[0]?.url ?? '',
    facility_type: f.type ?? '',
    prefecture_id: f.municipality?.prefectureId ?? '',
    municipality: f.municipality?.name ?? '',
    // 病床・スタッフ
    maternity_beds: f.equipment?.maternityBedCount ?? '',
    nicu_beds: f.equipment?.nicuBedCount ?? '',
    obstetricians: f.professionalStaff?.obstetricianCount ?? '',
    pediatricians: f.professionalStaff?.pediatricianCount ?? '',
    midwives: f.professionalStaff?.midwifeCount ?? '',
    advanced_midwives: f.professionalStaff?.advancedMidwifeCount ?? '',
    nurses: f.professionalStaff?.nurseCount ?? '',
    // 分娩件数
    vaginal_deliveries: f.delivery?.vaginalDeliveryCountText ?? '',
    cesarean_deliveries: f.delivery?.cesareanDeliveryCountText ?? '',
    // 費用（円）
    cost_total_avg: f.deliveryCost?.totalCostAverage ?? '',
    cost_total_median: f.deliveryCost?.totalCostMedian ?? '',
    cost_delivery_avg: f.deliveryCost?.deliveryCostAverage ?? '',
    cost_delivery_median: f.deliveryCost?.deliveryCostMedian ?? '',
    // サービス
    painless_delivery: f.painlessDelivery?.painlessDeliveryPolicy !== undefined ? true : false,
    rooming_in: f.delivery?.canMotherChildRoomingIn ?? '',
    midwife_clinic: f.midwiferyCareService?.canOutpatient ?? '',
    // メタ
    last_modified: f.lastModifiedAt ?? '',
    url: `${BASE_URL}/facilities/${id}`,
  };
}

/** sitemap.xml から全施設IDを取得 */
async function fetchFacilityIds() {
  console.log('📋 sitemapから施設IDを取得中...');
  const res = await fetch(`${BASE_URL}/sitemap.xml`);
  const xml = await res.text();
  const matches = [...xml.matchAll(/<loc>.*?\/facilities\/(\d+)<\/loc>/g)];
  const ids = matches.map((m) => m[1]);
  console.log(`✅ ${ids.length}件の施設IDを取得`);
  return ids;
}

/** 1施設のデータを取得 */
async function fetchFacility(id) {
  const res = await fetch(`${BASE_URL}/facilities/${id}`, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TripleLLC-Research/1.0)' },
  });
  if (!res.ok) return res.status === 404 ? null : (() => { throw new Error(`HTTP ${res.status}`); })();
  const html = await res.text();
  const facility = parseTurboStream(html);
  return flattenFacility(facility, id);
}

/** JSON → CSV変換 */
function toCSV(records) {
  if (records.length === 0) return '';
  const headers = Object.keys(records[0]);
  const esc = (v) => {
    const s = v == null ? '' : String(v);
    return s.includes(',') || s.includes('"') || s.includes('\n')
      ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [headers.join(','), ...records.map((r) => headers.map((h) => esc(r[h])).join(','))].join('\n');
}

// --- メイン ---
console.log('🏥 出産なび スクレイパー 起動（Triple LLC）');
console.log('━'.repeat(50));
mkdirSync(OUTPUT_DIR, { recursive: true });

const ids = await fetchFacilityIds();
const results = [];
const errors = [];

for (let i = 0; i < ids.length; i++) {
  const id = ids[i];
  const progress = `[${i + 1}/${ids.length}]`;
  try {
    const data = await fetchFacility(id);
    if (data) {
      results.push(data);
      console.log(`${progress} ✅ ${data.name} (${data.municipality})`);
    } else {
      console.log(`${progress} ⏭  ID ${id} スキップ（404）`);
    }
  } catch (err) {
    console.error(`${progress} ❌ ID ${id}: ${err.message}`);
    errors.push({ id, error: err.message });
  }
  if (i < ids.length - 1) await sleep(RATE_LIMIT_MS);
}

const jsonPath = `${OUTPUT_DIR}/birth-navi-${today}.json`;
const csvPath  = `${OUTPUT_DIR}/birth-navi-${today}.csv`;
writeFileSync(jsonPath, JSON.stringify(results, null, 2), 'utf-8');
writeFileSync(csvPath,  toCSV(results), 'utf-8');

console.log('\n' + '━'.repeat(50));
console.log(`✅ 取得成功: ${results.length}件`);
console.log(`❌ エラー:   ${errors.length}件`);
console.log(`📄 JSON: ${jsonPath}`);
console.log(`📊 CSV:  ${csvPath}`);
