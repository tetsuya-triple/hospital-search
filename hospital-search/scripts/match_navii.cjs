#!/usr/bin/env node
/**
 * ナビイ施設IDマッチングスクリプト
 *
 * ナビイ（医療情報ネット）のオープンデータCSVと facilities.json をマッチングし、
 * 各施設のナビイ施設IDとURLを生成して navii_mapping.json に保存する。
 *
 * Usage: node scripts/match_navii.js [--csv-path /path/to/csv]
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const FACILITIES_PATH = path.join(DATA_DIR, 'facilities.json');
const OUTPUT_PATH = path.join(DATA_DIR, 'navii_mapping.json');

// Default CSV path
const CSV_PATH = process.argv.includes('--csv-path')
  ? process.argv[process.argv.indexOf('--csv-path') + 1]
  : '/tmp/01-1_hospital_facility_info_20251201.csv';

// --- CSV Parser ---
function parseCsvLine(line) {
  const cols = [];
  let inQuote = false, col = '';
  for (const ch of line) {
    if (ch === '"') { inQuote = !inQuote; }
    else if (ch === ',' && !inQuote) { cols.push(col); col = ''; }
    else col += ch;
  }
  cols.push(col);
  return cols;
}

// --- Name Normalization ---
const LEGAL_ENTITIES = [
  '独立行政法人国立病院機構', '独立行政法人', '国立大学法人', '公立大学法人',
  '地方独立行政法人', '社会医療法人', '医療法人社団', '医療法人財団',
  '特定医療法人', '医療法人', '社会福祉法人', '一般社団法人', '一般財団法人',
  '公益社団法人', '公益財団法人', '学校法人', '宗教法人', '日本赤十字社',
  '国立研究開発法人', '国家公務員共済組合連合会', '地方公務員共済組合',
  '全国社会保険協会連合会', '厚生農業協同組合連合会', '恩賜財団', 'ＪＡ', 'JA',
];

function normalizeName(name) {
  let n = name;
  for (const le of LEGAL_ENTITIES) {
    n = n.replace(new RegExp(le, 'g'), '');
  }
  return n
    .replace(/[（(][^）)]*[）)]/g, '')
    .replace(/[\s　]+/g, '')
    .trim();
}

// Normalize address for comparison
function normalizeAddress(addr) {
  return addr
    .replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/[Ａ-Ｚａ-ｚ]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/丁目/g, '-')
    .replace(/番地?/g, '-')
    .replace(/号/g, '')
    .replace(/[-ー－]+/g, '-')
    .replace(/-$/, '')
    .replace(/[\s　]+/g, '')
    .trim();
}

// Extract core address (prefecture + city + first few blocks) for partial matching
function extractAddressCore(addr) {
  const norm = normalizeAddress(addr);
  // Get up to the first number part
  const match = norm.match(/^(.+?[区市町村])(.+?)(?:\d|$)/);
  if (match) return match[1] + match[2].substring(0, Math.min(match[2].length, 6));
  return norm.substring(0, 20);
}

// Build navii URL from ID components
function buildNaviiUrl(prefCd, kikanKbn, kikanCd) {
  return `https://www.iryou.teikyouseido.mhlw.go.jp/znk-web/juminkanja/S2300/initialize?kikanCd=${kikanCd}&prefCd=${prefCd}&kikanKbn=${kikanKbn}`;
}

// --- Main ---
function main() {
  console.log('=== ナビイ施設IDマッチング ===');

  // Load facilities
  const facilities = JSON.parse(fs.readFileSync(FACILITIES_PATH, 'utf8'));
  console.log(`facilities.json: ${facilities.length}施設`);

  // Load CSV
  if (!fs.existsSync(CSV_PATH)) {
    console.error(`CSVファイルが見つかりません: ${CSV_PATH}`);
    process.exit(1);
  }
  const csvText = fs.readFileSync(CSV_PATH, 'utf8');
  const csvLines = csvText.split(/\r?\n/);
  console.log(`CSV: ${csvLines.length - 1}行`);

  // Parse CSV rows
  const csvRows = [];
  for (let i = 1; i < csvLines.length; i++) {
    if (!csvLines[i].trim()) continue;
    const cols = parseCsvLine(csvLines[i]);
    const id = cols[0];
    if (id.length < 8) continue;
    const name = cols[1];
    const shortName = cols[3] || '';
    const address = cols[9] || '';
    const prefCd = id.substring(0, 2);
    const kikanKbn = id.substring(2, 3);
    const kikanCd = id.substring(3);
    csvRows.push({
      id, name, shortName, address, prefCd, kikanKbn, kikanCd,
      normName: normalizeName(name),
      normShort: normalizeName(shortName),
      normAddr: normalizeAddress(address),
      addrCore: extractAddressCore(address),
    });
  }

  // Group by prefecture
  const csvByPref = {};
  for (const row of csvRows) {
    if (!csvByPref[row.prefCd]) csvByPref[row.prefCd] = [];
    csvByPref[row.prefCd].push(row);
  }

  // Matching
  const mapping = [];
  let matchCount = 0;
  let unmatchCount = 0;
  const unmatchedFacilities = [];

  for (const f of facilities) {
    const prefCd = String(f.prefecture_id).padStart(2, '0');
    const normName = normalizeName(f.name);
    const normAddr = normalizeAddress(f.address || '');
    const candidates = csvByPref[prefCd] || [];

    let match = null;
    let matchMethod = '';

    // Strategy 1: Exact normalized name match
    match = candidates.find(c => c.normName === normName);
    if (match) matchMethod = 'exact_name';

    // Strategy 2: CSV shortName matches facility name
    if (!match) {
      match = candidates.find(c => c.normShort && c.normShort === normName);
      if (match) matchMethod = 'short_name';
    }

    // Strategy 3: Substring match (longer than 4 chars)
    if (!match) {
      match = candidates.find(c => {
        if (c.normShort && c.normShort.length > 4) {
          return normName.includes(c.normShort) || c.normShort.includes(normName);
        }
        return false;
      });
      if (match) matchMethod = 'short_substring';
    }

    // Strategy 4: Full name substring match
    if (!match) {
      match = candidates.find(c => {
        return (c.normName.includes(normName) && normName.length > 4) ||
               (normName.includes(c.normName) && c.normName.length > 4);
      });
      if (match) matchMethod = 'name_substring';
    }

    // Strategy 5: Address match + partial name overlap
    if (!match && normAddr.length > 10) {
      const addrMatches = candidates.filter(c => {
        // Exact address or close address match
        return c.normAddr === normAddr ||
               (c.normAddr.length > 15 && normAddr.length > 15 &&
                c.normAddr.substring(0, 15) === normAddr.substring(0, 15));
      });
      if (addrMatches.length === 1) {
        match = addrMatches[0];
        matchMethod = 'address';
      } else if (addrMatches.length > 1) {
        // Multiple address matches: pick the one with the most name overlap
        const scored = addrMatches.map(c => {
          let score = 0;
          for (let len = 2; len <= Math.min(normName.length, c.normName.length); len++) {
            for (let start = 0; start <= normName.length - len; start++) {
              if (c.normName.includes(normName.substring(start, start + len))) {
                score = Math.max(score, len);
              }
            }
          }
          return { csv: c, score };
        });
        scored.sort((a, b) => b.score - a.score);
        if (scored[0].score >= 3) {
          match = scored[0].csv;
          matchMethod = 'address+name_overlap';
        }
      }
    }

    if (match) {
      matchCount++;
      mapping.push({
        facility_id: f.id,
        facility_name: f.name,
        navii_id: match.id,
        navii_name: match.name,
        navii_short_name: match.shortName,
        prefCd: match.prefCd,
        kikanKbn: match.kikanKbn,
        kikanCd: match.kikanCd,
        navii_url: buildNaviiUrl(match.prefCd, match.kikanKbn, match.kikanCd),
        match_method: matchMethod,
      });
    } else {
      unmatchCount++;
      unmatchedFacilities.push({
        facility_id: f.id,
        name: f.name,
        address: f.address,
        prefecture_id: f.prefecture_id,
        facility_type: f.facility_type,
      });
    }
  }

  // Stats
  const methodStats = {};
  for (const m of mapping) {
    methodStats[m.match_method] = (methodStats[m.match_method] || 0) + 1;
  }

  console.log(`\n=== マッチング結果 ===`);
  console.log(`マッチ: ${matchCount} / ${facilities.length} (${(matchCount / facilities.length * 100).toFixed(1)}%)`);
  console.log(`アンマッチ: ${unmatchCount}`);
  console.log(`\nマッチ方法別:`);
  for (const [method, count] of Object.entries(methodStats).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${method}: ${count}`);
  }

  // Type-based stats
  const typeStats = { matched: {}, unmatched: {} };
  for (const m of mapping) {
    const f = facilities.find(x => x.id === m.facility_id);
    typeStats.matched[f.facility_type] = (typeStats.matched[f.facility_type] || 0) + 1;
  }
  for (const u of unmatchedFacilities) {
    typeStats.unmatched[u.facility_type] = (typeStats.unmatched[u.facility_type] || 0) + 1;
  }
  console.log(`\n施設タイプ別マッチ:`, typeStats.matched);
  console.log(`施設タイプ別アンマッチ:`, typeStats.unmatched);

  // Save mapping
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(mapping, null, 2), 'utf8');
  console.log(`\n保存: ${OUTPUT_PATH}`);

  // Save unmatched for reference
  const unmatchedPath = path.join(DATA_DIR, 'navii_unmatched.json');
  fs.writeFileSync(unmatchedPath, JSON.stringify(unmatchedFacilities, null, 2), 'utf8');
  console.log(`アンマッチ一覧: ${unmatchedPath}`);
}

main();
