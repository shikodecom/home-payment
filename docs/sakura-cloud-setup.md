# さくらインターネット MySQL・API設定

## 必要条件

- PHP 8.2以上
- PDO MySQL、cURL、mbstring
- MySQL 5.7以上または8.x
- HTTPS
- Apache `mod_rewrite` と `.htaccess`

確認済みの本番PHPは8.3.31で、PDO MySQLを利用できます。公開URLは `https://www.shikode.com/tools/home-payment/`、APIは同一オリジンの `https://www.shikode.com/tools/home-payment/api/` です。

## MySQL

1. さくらのコントロールパネルでデータベースと専用ユーザーを作ります。
2. DBのバックアップを取得します。
3. `database/migrations/001_create_cloud_storage.sql` を一度だけ実行します。既存テーブルは削除しません。
   既存環境へ友だち状態の保存欄だけを追加する場合は
   `database/migrations/003_add_line_friend_status.sql` を実行します。
4. `SHOW TABLES` と `SHOW CREATE TABLE payments` で、外部キー・UNIQUE・INDEXを確認します。

`002_add_cloud_storage_to_existing_db.sql` はMySQL CLIから初期SQLを読み込む入口です。phpMyAdmin相当の画面では `001_create_cloud_storage.sql` 本体を実行してください。ロールバックはデータ消失を伴うため自動化していません。必要時のみ `database/rollback/001_remove_cloud_storage_manual.sql` を確認し、バックアップ後に手動実行します。

## 秘密設定

Web公開ディレクトリの外、例として `/home/f-taniguchi/private/home-payment.env` に `.env.example` と同じ形式で値を置きます。権限は所有者だけが読める状態にしてください。ランダムな `CSRF_SECRET` は32文字以上にします。

APIの実行環境へ次を渡します。

`APP_CONFIG_PATH=/home/f-taniguchi/private/home-payment.env`

さくら側の環境変数設定、または公開ディレクトリの `.htaccess` に `SetEnv APP_CONFIG_PATH ...` を設定します。秘密値そのものは `.htaccess` やソースへ書きません。

Issue #1 のログイン継続性修正を本番へ反映する際は、非公開の `home-payment.env` にある既存のセッション設定を次の値へ**置き換えます**。特に、現在 `SESSION_COOKIE_NAME=payment_session` がある場合は旧値を残さないでください。

```ini
SESSION_COOKIE_NAME=home_payment_session
CSRF_COOKIE_NAME=home_payment_csrf
SESSION_COOKIE_PATH=/tools/home-payment/
SESSION_LIFETIME_SECONDS=2592000
SESSION_REFRESH_THRESHOLD_SECONDS=604800
```

PHPはすでに実行環境へ渡されている同名の環境変数を `home-payment.env` より優先します。さくら側の環境変数や `.htaccess` に旧 `SESSION_COOKIE_NAME` などを設定している場合も、同じ値へ更新してください。旧名のままPathだけ変更すると、同名でPathが異なるCookieが共存する可能性があります。設定変更と新しいAPIの配置は同じ本番反映作業で行い、完了後に一度LINEで再ログインします。

## 本番反映

1. ローカルで `npm ci && npm test && npm run build` を実行します。
2. `dist/` の内容を `/home/f-taniguchi/www/shikode/www/tools/home-payment/` へ配置します。
3. 上記のセッション設定を非公開の `home-payment.env` と、同名の設定がある実行環境へ反映します。
4. `api/` を同ディレクトリの `api/` へ配置します。PHPソースと `api/.htaccess` は必要ですが、`.env.example` や実際の秘密設定は公開しません。
5. MySQLマイグレーションを実行します。
   既存環境を更新する場合は `database/migrations/004_add_pwa_login_resume.sql` も実行します。
6. `APP_CONFIG_PATH` を設定します。
7. `/api/auth/me` が未ログイン応答を返すことを確認します。
8. LINE DevelopersのCallback URLを登録して、ログイン、支払いCRUD、処理、復元、完全削除、ログアウトを確認します。
9. iPhoneではSafariとホーム画面アイコンの両方からLINEログインし、ホーム画面へ戻った後もクラウド保存表示になることを確認します。

デプロイ時は既存のゲスト用localStorageを削除しません。Service Worker更新後に古い画面が残る場合は、再読み込みして新しいアセットへ切り替えます。

## 必須環境変数

`APP_ENV`, `APP_BASE_URL`, `APP_PATH`, `APP_LOGIN_SUCCESS_URL`, `APP_ALLOWED_ORIGIN`, `LINE_CHANNEL_ID`, `LINE_CHANNEL_SECRET`, `LINE_CALLBACK_URL`, `LINE_MESSAGING_CHANNEL_SECRET`, `LINE_MESSAGING_CHANNEL_ACCESS_TOKEN`, `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`, `DB_CHARSET`, `SESSION_COOKIE_NAME`, `CSRF_COOKIE_NAME`, `SESSION_COOKIE_PATH`, `SESSION_LIFETIME_SECONDS`, `SESSION_REFRESH_THRESHOLD_SECONDS`, `CSRF_SECRET`
