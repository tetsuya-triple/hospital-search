/**
 * 出産なび 病院検索サーバー（Triple LLC）
 * 使い方: ANTHROPIC_API_KEY=xxx node hospital-search/server.js
 */

import express from 'express';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import Anthropic from '@anthropic-ai/sdk';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3456;

// --- データ読み込み ---
const DATA_PATH = resolve(__dirname, 'data/facilities.json');
let facilities = [];
try {
  facilities = JSON.parse(readFileSync(DATA_PATH, 'utf-8'));
  console.log(`✅ ${facilities.length}件の施設データを読み込みました`);
} catch (e) {
  const { readdirSync } = await import('fs');
  const salesDir = resolve(__dirname, '../../../triple-llc/sales');
  const files = readdirSync(salesDir).filter(f => f.startsWith('birth-navi') && f.endsWith('.json')).sort().reverse();
  if (files.length > 0) {
    facilities = JSON.parse(readFileSync(resolve(salesDir, files[0]), 'utf-8'));
    console.log(`✅ ${facilities.length}件の施設データを読み込みました（${files[0]}）`);
  } else {
    console.error('❌ 施設データが見つかりません');
  }
}

// 都道府県名 → prefecture_id マッピング
const PREFECTURE_MAP = {
  '北海道':1,'青森':2,'岩手':3,'宮城':4,'秋田':5,'山形':6,'福島':7,
  '茨城':8,'栃木':9,'群馬':10,'埼玉':11,'千葉':12,'東京':13,'神奈川':14,
  '新潟':15,'富山':16,'石川':17,'福井':18,'山梨':19,'長野':20,'岐阜':21,'静岡':22,'愛知':23,
  '三重':24,'滋賀':25,'京都':26,'大阪':27,'兵庫':28,'奈良':29,'和歌山':30,
  '鳥取':31,'島根':32,'岡山':33,'広島':34,'山口':35,
  '徳島':36,'香川':37,'愛媛':38,'高知':39,
  '福岡':40,'佐賀':41,'長崎':42,'熊本':43,'大分':44,'宮崎':45,'鹿児島':46,'沖縄':47,
};

const LEGAL_PREFIX = /^(医療法人|社会医療法人|学校法人|財団法人|社会福祉法人|宗教法人|特定医療法人|一般財団法人|公益財団法人)\s*/;
const GENERIC_START = /^(産婦人科|産科婦人科|産科・婦人科|婦人科・産科|婦人科)/;

/**
 * 施設名フィルタ
 * @returns {{ facilities: Array, nameMatch: boolean }}
 */
function filterFacilities(question) {
  let filtered = [...facilities];

  // 都道府県フィルタ
  for (const [name, id] of Object.entries(PREFECTURE_MAP)) {
    if (question.includes(name)) {
      filtered = filtered.filter(f => String(f.prefecture_id) === String(id));
      break;
    }
  }

  // 市区町村フィルタ
  const cityMatch = question.match(/([^\s都道府県]{2,8}[市区町村])/);
  if (cityMatch) {
    const city = cityMatch[1];
    const cityFiltered = filtered.filter(f => f.municipality?.includes(city) || f.address?.includes(city));
    if (cityFiltered.length > 0) filtered = cityFiltered;
  }

  // 施設名フィルタ
  const q = question.trim();
  const nameFiltered = filtered.filter(f => {
    if (!f.name) return false;
    const cleanName = f.name.replace(LEGAL_PREFIX, '').trim();
    if (cleanName.length < 3) return false;
    // 完全名（法人格除去後）が質問に含まれる
    if (question.includes(cleanName)) return true;
    // 汎用語で始まらない施設のみ、先頭4文字で部分一致
    if (!GENERIC_START.test(cleanName) && question.includes(cleanName.slice(0, 4))) return true;
    // 施設名（フルまたは法人格除去後）が質問テキストを含む（グループ検索用、5文字以上）
    if (q.length >= 5 && (f.name.includes(q) || cleanName.includes(q))) return true;
    return false;
  });

  if (nameFiltered.length > 0) {
    return { facilities: nameFiltered.slice(0, 20), nameMatch: true };
  }

  // 機能フィルタ
  if (question.includes('無痛分娩')) {
    filtered = filtered.filter(f => f.painless_delivery === true);
  }
  if (question.includes('NICU')) {
    filtered = filtered.filter(f => Number(f.nicu_beds) > 0);
  }

  // 分娩件数フィルタ
  const countMatch = question.match(/(\d+)件以上/);
  if (countMatch) {
    const minCount = parseInt(countMatch[1]);
    filtered = filtered.filter(f => {
      if (!f.vaginal_deliveries) return false;
      const m = f.vaginal_deliveries.match(/(\d+)/);
      return m && parseInt(m[1]) >= minCount;
    });
  }

  // 費用フィルタ
  if (question.includes('安い') || question.includes('費用が低い')) {
    filtered = filtered
      .filter(f => f.cost_total_avg)
      .sort((a, b) => Number(a.cost_total_avg) - Number(b.cost_total_avg));
  } else if (question.includes('高い')) {
    filtered = filtered
      .filter(f => f.cost_total_avg)
      .sort((a, b) => Number(b.cost_total_avg) - Number(a.cost_total_avg));
  }

  return { facilities: filtered.slice(0, 50), nameMatch: false };
}

/** Claude APIで回答を生成 */
async function generateAnswer(question, targetFacilities) {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const dataStr = targetFacilities.map(f => JSON.stringify({
    名前: f.name,
    住所: f.address,
    市区町村: f.municipality,
    電話: f.phone,
    産科医師数: f.obstetricians,
    助産師数: f.midwives,
    産科病床数: f.maternity_beds,
    NICU病床数: f.nicu_beds,
    年間経腟分娩: f.vaginal_deliveries,
    年間帝王切開: f.cesarean_deliveries,
    総費用平均: f.cost_total_avg ? `${Number(f.cost_total_avg).toLocaleString()}円` : null,
    総費用中央値: f.cost_total_median ? `${Number(f.cost_total_median).toLocaleString()}円` : null,
    無痛分娩: f.painless_delivery,
    ウェブサイト: f.website,
    出産なびURL: f.url,
    GoogleマップURL: f.google_maps_url,
  })).join('\n');

  const message = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 2048,
    messages: [{
      role: 'user',
      content: `あなたは産婦人科施設の情報アシスタントです。以下の施設データをもとに、質問に答えてください。

【質問】
${question}

【施設データ（${targetFacilities.length}件）】
${dataStr}

回答は日本語で以下のルールに従ってください。
- 施設情報（名称・住所・電話・スタッフ数・分娩数・費用など）は**必ず1つの表**にまとめること（セクションごとに表を分けない）
- 表のヘッダー行は「| 項目 | 内容 |」のみ。セパレーター行（|---|---|）は絶対に出力しないこと
- 表の最終2行に「出産なびURL | （URLの値）」「GoogleマップURL | （URLの値）」を必ず含めること
- 表を最初に出力し、補足コメントは表の後に記載すること。見出しと表の間に空行を入れないこと
- 複数施設の場合は施設ごとに見出し（## 施設名）を付けて直後に表を置くこと（見出しと表の間に空行不要）`,
    }],
  });

  return message.content[0].text;
}

// --- Express アプリ ---
const app = express();
app.use(express.json());
app.use(express.static(resolve(__dirname, 'public')));

app.post('/api/search', async (req, res) => {
  const { question } = req.body;
  if (!question?.trim()) {
    return res.status(400).json({ error: '質問を入力してください' });
  }

  try {
    const { facilities: matched, nameMatch } = filterFacilities(question);

    if (matched.length === 0) {
      return res.json({ answer: '条件に合う施設が見つかりませんでした。別のキーワードで試してみてください。', count: 0 });
    }

    // 名前で複数ヒット → 選択UIを返す
    if (nameMatch && matched.length > 1) {
      return res.json({
        type: 'selection',
        facilities: matched.map(f => ({
          name: f.name,
          address: f.address || '',
          url: f.url,
        })),
      });
    }

    const answer = await generateAnswer(question, matched);
    res.json({ answer, count: matched.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '検索中にエラーが発生しました: ' + err.message });
  }
});

// 施設URLから直接詳細取得
app.post('/api/facility', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URLが必要です' });

  const facility = facilities.find(f => f.url === url);
  if (!facility) return res.status(404).json({ error: '施設が見つかりませんでした' });

  try {
    const answer = await generateAnswer(facility.name, [facility]);
    res.json({ answer, count: 1 });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '検索中にエラーが発生しました: ' + err.message });
  }
});

// BABYSTORY導入施設API（data/babystory.json に施設URLの配列を保存）
app.get('/api/babystory', (req, res) => {
  try {
    const list = JSON.parse(readFileSync(resolve(__dirname, 'data/babystory.json'), 'utf-8'));
    res.json(list);
  } catch {
    res.json([]);
  }
});

// 全施設一覧API
app.get('/api/facilities', (req, res) => {
  res.json(facilities.map(f => ({
    id: f.id,
    name: f.name,
    address: f.address,
    municipality: f.municipality,
    prefecture_id: f.prefecture_id,
    phone: f.phone,
    website: f.website,
    url: f.url,
    google_maps_url: f.google_maps_url,
    obstetricians: f.obstetricians,
    pediatricians: f.pediatricians,
    midwives: f.midwives,
    advanced_midwives: f.advanced_midwives,
    nurses: f.nurses,
    maternity_beds: f.maternity_beds,
    nicu_beds: f.nicu_beds,
    vaginal_deliveries: f.vaginal_deliveries,
    cesarean_deliveries: f.cesarean_deliveries,
    cost_total_avg: f.cost_total_avg,
    cost_total_median: f.cost_total_median,
    cost_delivery_avg: f.cost_delivery_avg,
    cost_delivery_median: f.cost_delivery_median,
    painless_delivery: f.painless_delivery,
    rooming_in: f.rooming_in,
    midwife_clinic: f.midwife_clinic,
  })));
});

app.listen(PORT, () => {
  console.log(`\n🏥 出産なび検索サーバー起動`);
  console.log(`👉 http://localhost:${PORT}`);
  console.log(`📊 対象施設数: ${facilities.length}件\n`);
});
