/**
 * SPEC.md → Google Docs 自動同期スクリプト
 * GitHub Actions から呼び出す
 *
 * 必要な環境変数:
 *   GOOGLE_CREDENTIALS : application_default_credentials の JSON 文字列
 *   GOOGLE_DOC_ID      : 同期先 Google ドキュメントの ID
 */

import { google } from 'googleapis';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function syncSpecToGoogleDocs() {
  const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);
  const docId = process.env.GOOGLE_DOC_ID;

  if (!credentials || !docId) {
    throw new Error('GOOGLE_CREDENTIALS または GOOGLE_DOC_ID が未設定じゃ');
  }

  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/documents'],
  });

  const docs = google.docs({ version: 'v1', auth });

  // SPEC.md を読み込む
  const specContent = readFileSync(join(__dirname, '..', 'SPEC.md'), 'utf-8');

  // 現在のドキュメント末尾インデックスを取得
  const doc = await docs.documents.get({ documentId: docId });
  const lastElement = doc.data.body.content.at(-1);
  const endIndex = lastElement.endIndex - 1;

  const requests = [];

  // 既存コンテンツを全削除
  if (endIndex > 1) {
    requests.push({
      deleteContentRange: {
        range: { startIndex: 1, endIndex },
      },
    });
  }

  // SPEC.md の内容を挿入
  requests.push({
    insertText: {
      location: { index: 1 },
      text: specContent,
    },
  });

  await docs.documents.batchUpdate({
    documentId: docId,
    requestBody: { requests },
  });

  console.log('✅ SPEC.md を Google Docs に同期完了');
}

syncSpecToGoogleDocs().catch((err) => {
  console.error('❌ 同期失敗:', err.message);
  process.exit(1);
});
