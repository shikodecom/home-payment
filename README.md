# 家計の支払めも

Vite + React + TypeScript のPWAです。未ログイン時は従来どおりブラウザ内へ保存し、LINEログイン後は同一オリジンのPHP APIとMySQLを使います。

## 主な機能

- 支払い記録、編集、削除、処理済みアーカイブ
- LINEログイン後の自動クラウド保存
- 「今すぐ同期」による送信待ちデータの反映とクラウドからの再取得
- 全記録のUTF-8 CSVエクスポート（Excel向けBOM付き）
- LINE公式アカウントへの友だち追加導線
- 友だち追加済みの利用者には追加ボタンを非表示
- LINEトークへ「ランチ 1200」のように送るメッセージ登録
- 印刷用一覧

## 開発

```sh
nvm use
npm ci
npm test
npm run build
npm run test:php
```

Node.jsは `.nvmrc` の24.19.0、PHPは8.2以上を使います。依存はバージョンを固定し、更新時は `package.json` と `package-lock.json` を同時に更新します。
PRとmain更新でフロント、PHP 8.2/8.3、MySQL 5.7/8.0のCIを実行します。

実API・DBの回帰テストは、初期テーブルのない専用DBを作成して実行します。`DB_NAME` の末尾が `_test` でない場合は拒否します。テストはスキーマを作成し、専用ユーザーの試験データを作って終了時に削除します。

```sh
DB_HOST=127.0.0.1 DB_PORT=3306 DB_NAME=home_payment_test \
  DB_USER=root DB_PASSWORD=your-test-password npm run test:mysql
```

同期の競合では未送信データを保持し、サーバーの内容を使うか、端末の編集を明示的に再適用するか選べます。取り消した変更は端末へバックアップし、アカウントメニューからJSONを保存できます。アーカイブ・削除など再適用できない操作は、サーバーの内容を確認して操作し直します。

フロントの公開パスは `/tools/home-payment/`、APIは `/tools/home-payment/api/` です。PHP 8.2以上、PDO MySQL、cURL、mbstring、MySQL 5.7以上を想定しています。

## データ領域

- ゲスト: `paymentApp.guest.v4`（互換維持のため従来キー `home-payment-data` にも保存）
- クラウドキャッシュ: `paymentApp.cloud.{userId}.cache.v1`
- 未送信キュー: `paymentApp.cloud.{userId}.queue.v1`

ゲストとクラウドは自動的に混在しません。初回ログイン後に利用者が明示的に選んだ場合だけ、`POST /api/import/local` でゲストデータをコピーします。

## セットアップ

- [LINE Login設定](docs/line-login-setup.md)
- [さくらインターネット設定・本番反映](docs/sakura-cloud-setup.md)
- 初期SQL: `database/migrations/001_create_cloud_storage.sql`
- 追加導入用SQL: `database/migrations/002_add_cloud_storage_to_existing_db.sql`
- iPhoneホーム画面のログイン復帰追加: `database/migrations/004_add_pwa_login_resume.sql`
- 安全な再送のための操作履歴: `database/migrations/005_add_mutation_receipts.sql`（新APIの配置前に実行）
- Issue #12の反映と受け入れ確認: [リリース確認表](docs/issue-12-release-checklist.md)
- 手動ロールバック: `database/rollback/001_remove_cloud_storage_manual.sql`

秘密情報を公開ディレクトリやGitへ置かないでください。

LINEメッセージ登録では、Messaging APIのWebhookを
`/tools/home-payment/api/webhooks/line` に設定します。サーバーの非公開設定へ
`LINE_MESSAGING_CHANNEL_SECRET` と `LINE_MESSAGING_CHANNEL_ACCESS_TOKEN` を追加してください。
