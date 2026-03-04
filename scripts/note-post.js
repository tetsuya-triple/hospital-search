/**
 * note.com 記事投稿スクリプト（Triple LLC）
 *
 * 使い方:
 *   NOTE_EMAIL=xxx NOTE_PASSWORD=xxx node scripts/note-post.js \
 *     --title "タイトル" \
 *     --body-file /path/to/body.txt \
 *     --schedule "2026-03-04T08:00"   # 省略すると即時投稿
 */

import { chromium } from 'playwright';
import { readFileSync } from 'fs';

// --- 引数パース ---
const args = process.argv.slice(2);
const get = (key) => {
  const i = args.indexOf(key);
  return i !== -1 ? args[i + 1] : null;
};

const title = get('--title');
const bodyFile = get('--body-file');
const scheduleAt = get('--schedule'); // 例: "2026-03-04T08:00"

if (!title || !bodyFile) {
  console.error('使い方: --title "タイトル" --body-file /path/to/body.txt [--schedule "YYYY-MM-DDTHH:MM"]');
  process.exit(1);
}

const body = readFileSync(bodyFile, 'utf-8');
const email = process.env.NOTE_EMAIL;
const password = process.env.NOTE_PASSWORD;

if (!email || !password) {
  console.error('環境変数 NOTE_EMAIL と NOTE_PASSWORD を設定してください。');
  process.exit(1);
}

// --- メイン処理 ---
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext();
const page = await context.newPage();

try {
  console.log('🔐 note.com にログイン中...');
  await page.goto('https://note.com/login');
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', password);
  await page.click('button[type="submit"]');
  await page.waitForURL('**/notes/**', { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(2000);
  console.log('✅ ログイン完了');

  console.log('📝 新規記事作成画面へ移動...');
  await page.goto('https://note.com/notes/new');
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(2000);

  // タイトル入力
  console.log('✏️  タイトルを入力中...');
  const titleField = page.locator('[placeholder*="タイトル"], [data-placeholder*="タイトル"]').first();
  await titleField.click();
  await titleField.fill(title);

  // 本文入力
  console.log('📄 本文を入力中...');
  const bodyField = page.locator('.ProseMirror, [contenteditable="true"]').first();
  await bodyField.click();
  await page.keyboard.type(body, { delay: 10 });

  // 投稿設定を開く
  console.log('⚙️  投稿設定を開く...');
  await page.click('button:has-text("投稿設定"), button:has-text("公開設定")');
  await page.waitForTimeout(1000);

  if (scheduleAt) {
    console.log(`⏰ 予約投稿を設定: ${scheduleAt}`);
    // 予約投稿ラジオボタンを選択
    await page.click('label:has-text("予約投稿"), input[value="reserved"]');
    await page.waitForTimeout(500);

    // 日時入力
    const [dateStr, timeStr] = scheduleAt.split('T');
    const dateInput = page.locator('input[type="date"], input[placeholder*="日付"]').first();
    const timeInput = page.locator('input[type="time"], input[placeholder*="時間"]').first();
    await dateInput.fill(dateStr);
    await timeInput.fill(timeStr);
  }

  // 投稿実行
  console.log('🚀 投稿中...');
  await page.click('button:has-text("投稿する"), button:has-text("公開する")');
  await page.waitForTimeout(3000);

  const currentUrl = page.url();
  console.log(`✅ 投稿完了: ${currentUrl}`);

} catch (err) {
  console.error('❌ エラーが発生しました:', err.message);
  // デバッグ用スクリーンショット
  await page.screenshot({ path: '/tmp/note-post-error.png' });
  console.log('スクリーンショットを保存: /tmp/note-post-error.png');
  process.exit(1);
} finally {
  await browser.close();
}
