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
npm ci
npm test
npm run build
```

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
- 手動ロールバック: `database/rollback/001_remove_cloud_storage_manual.sql`

秘密情報を公開ディレクトリやGitへ置かないでください。

LINEメッセージ登録では、Messaging APIのWebhookを
`/tools/home-payment/api/webhooks/line` に設定します。サーバーの非公開設定へ
`LINE_MESSAGING_CHANNEL_SECRET` と `LINE_MESSAGING_CHANNEL_ACCESS_TOKEN` を追加してください。
