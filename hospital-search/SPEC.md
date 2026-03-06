# 産婦人科検索システム 仕様書

**プロダクト名**: 産婦人科検索（出産なび（全国2,096施設）× AI検索 | Triple LLC）
**バージョン**: 2.5
**作成日**: 2026/03/04
**作成者**: Triple LLC（エーデル by Claude Code）
**顧問先**: 株式会社コミットコーポレーション

---

## 目的

コミットコーポレーションの営業・提案活動を支援するため、全国2,096件の産婦人科施設データを自然言語で検索・比較できるツールを構築する。MEO分析・競合調査・施設提案資料作成などで活用することを想定。

---

## システム概要

| 項目 | 内容 |
|------|------|
| ローカルURL | http://localhost:3456 |
| 本番URL | https://hospital-search-1517.onrender.com |
| データ件数 | 全国2,096施設（出産なびデータ） |
| AIモデル | claude-sonnet-4-6 |

---

## 技術スタック

| レイヤー | 技術 |
|----------|------|
| バックエンド | Node.js + Express |
| AI | Anthropic Claude API（claude-sonnet-4-6） |
| フロントエンド | Vanilla HTML/CSS/JS（フレームワークなし） |
| データ形式 | JSON（facilities.json / babystory.json） |
| ホスティング | Render（無料プラン） |
| バージョン管理 | GitHub |
| CI/CD | GitHub push → Render 自動デプロイ |

---

## ファイル構成

```
/Users/mikitetsuya/triple-llc/automation/hospital-search/
├── server.js              # Expressサーバー本体
├── public/
│   ├── index.html         # AI検索画面
│   └── list.html          # 施設一覧画面
└── data/
    ├── facilities.json    # 全2,096施設データ（出産なび）
    └── babystory.json     # BABYSTORY導入施設リスト（103件）
```

---

## 画面・機能仕様

### 1. AI検索画面（index.html）

- **サジェスト例文**: 「広島県で無痛分娩対応の施設は？」「神奈川県で費用が安い順に5件教えて」「東京都でNICUがある産婦人科は？」など
- **自然言語検索**: 都道府県・市区町村・施設名・機能（無痛分娩/NICU）・費用などで絞り込み
- **AI回答形式**: Claude APIが表形式でMarkdown回答を生成
- **複数ヒット時**: 施設選択UIを表示（クリックで詳細表示）
- **ヘッダー**: 施設一覧画面へのリンクボタンあり

### 2. 施設一覧画面（list.html）

- **全件表示**: 2,096件をページネーション（100件/ページ、全21ページ）
- **テキスト検索**: 施設名・住所で絞り込み
- **都道府県フィルタ**: ドロップダウンで絞り込み
- **表示カラム**: 病院名、住所、年間分娩数合計、マップ、公式サイト、出産なび、電話番号、産科病床数、NICU病床数、産科医師数
- **外部リンク**: GoogleマップURL・公式サイトを各行に表示

---

## APIエンドポイント

| メソッド | パス | 説明 |
|----------|------|------|
| POST | /api/search | 自然言語検索 → Claude AIで回答生成 |
| POST | /api/facility | 施設URLから詳細情報取得 |
| GET | /api/facilities | 全施設一覧（JSON） |
| GET | /api/babystory | BABYSTORY導入施設リスト |

---

## フィルタロジック（server.js）

AIに渡すデータを事前に絞り込むロジック：

1. **都道府県フィルタ**: 質問に都道府県名が含まれれば該当prefectureのみ
2. **市区町村フィルタ**: 市区町村名で追加絞り込み
3. **施設名フィルタ**: 法人格を除去したうえで部分一致検索
4. **機能フィルタ**: 無痛分娩・NICU有無
5. **分娩件数フィルタ**: 「〇件以上」の条件指定
6. **費用ソート**: 「安い順」「高い順」で並び替え

---

## データ仕様

### facilities.json の主要フィールド

| フィールド | 内容 |
|------------|------|
| name | 施設名 |
| address | 住所 |
| municipality | 市区町村 |
| prefecture_id | 都道府県ID（1〜47） |
| phone | 電話番号 |
| website | 公式サイトURL |
| url | 出産なびURL |
| google_maps_url | GoogleマップURL |
| obstetricians | 産科医師数 |
| midwives | 助産師数 |
| maternity_beds | 産科病床数 |
| nicu_beds | NICU病床数 |
| vaginal_deliveries | 年間経腟分娩件数（範囲） |
| cesarean_deliveries | 年間帝王切開件数（範囲） |
| cost_total_avg | 総費用平均（円） |
| cost_total_median | 総費用中央値（円） |
| painless_delivery | 無痛分娩対応（boolean） |
| rooming_in | 母子同室（boolean） |
| midwife_clinic | 助産院（boolean） |

### babystory.json

BABYSTORY（株式会社コミットコーポレーションの製品）を導入済みの施設URL配列。
照合結果: 103件登録（8件は出産なびとの名称不一致で保留）

---

## インフラ・デプロイ

### ローカル起動

```bash
cd /Users/mikitetsuya/triple-llc/automation && source .env && node hospital-search/server.js
```

その後 http://localhost:3456 をブラウザで開く。

### 本番（Render）

- **サービスURL**: https://hospital-search-1517.onrender.com
- **プラン**: 無料（初回アクセス時に起動まで30〜60秒かかる）
- **自動デプロイ**: GitHubにpushするたびに最新版が自動デプロイ
- **ダッシュボード**: https://dashboard.render.com（トリプル合同会社のGoogleアカウントでログイン）
- **Render APIキー**: `rnd_mfYCwIXoeHdbFHq8yUlYU6Mfh8kc`（※取り扱い注意）

### 環境変数（.env）

| 変数名 | 内容 |
|--------|------|
| ANTHROPIC_API_KEY | Claude API認証キー |
| PORT | サーバーポート（デフォルト: 3456） |

---

## 構築経緯

2026/03/04に以下の順序で構築：

1. ローカルでの静的HTML版（list.html）を原型として開発開始
2. Node.js + ExpressサーバーとClaude API統合
3. AI検索機能（自然言語 → フィルタ → Claude回答）実装
4. フィルタロジック（都道府県・市区町村・施設名・機能・費用）を段階的に改良
5. BABYSTORYデータ（babystory.json）との照合機能追加（103件登録）
6. xcode-select → Homebrew → gh CLI のインストールを経てGitHub連携確立
7. Render APIを使ってhospital-search-1517としてデプロイ完了
8. 合計15回以上の修正・改良を経てv2.5に到達

---

## 今後の改良記録

> ここに改良履歴を追記していくのじゃ。

| 日付 | バージョン | 内容 | 担当 |
|------|-----------|------|------|
| 2026/03/04 | v2.5 | 初版リリース・Renderデプロイ完了 | エーデル |
| 2026/03/05 | v2.5.1 | RenderにANTHROPIC_API_KEY未設定→Render API経由で修正 | エーデル |
| 2026/03/05 | v2.5.2 | 出産なびリンクの403エラー対応：直リンク→URLコピーボタン方式に変更・出典表記を追加 | エーデル |
| 2026/03/06 | v2.5.3 | ヘッダー直下に「出典：厚生労働省 出産なび」バナーを両画面（AI検索・施設一覧）に設置 | エーデル |
| 2026/03/06 | v2.5.4 | 出産なびURL項目を全面削除（AI検索・施設一覧）。直リンク403問題により使い勝手が悪いため廃止 | エーデル |
| 2026/03/07 | v2.5.5 | スマホ最適化（PCはそのまま）。`@media (max-width: 768px)` 追加。施設一覧は7列を非表示・ドロップダウン幅調整・右グループ折り返し | エーデル |

---

## 自動同期設定

| 項目 | 内容 |
|------|------|
| 同期先 | [産婦人科検索システム仕様書（Google Docs）](https://docs.google.com/document/d/1KFDXrN9O2SZ5g276DK17S-nEisTPmR7vURHpFmfbthU/edit) |
| トリガー | `hospital-search/SPEC.md` を main ブランチに push したとき |
| 仕組み | GitHub Actions → googleapis → Google Docs API |
| ワークフロー | `.github/workflows/sync-spec-gdocs.yml` |
| 構築日 | 2026/03/06 |

---

*このファイルはエーデル（Claude Code）が管理・更新します。改良を加えたら「今後の改良記録」テーブルに追記してください。*


