# LINE Login v2.1 設定手順

## LINE Developers

1. [LINE Developersコンソール](https://developers.line.biz/console/)へログインします。
2. このサービス専用のプロバイダーを作成します。
3. 同じプロバイダー内に「LINEログイン」チャネルを作成します。種類はWebアプリです。
4. チャネル名、説明、アイコン、連絡先などを設定します。
5. Web appのCallback URLへ次を登録します。

   `https://www.shikode.com/tools/home-payment/api/auth/line/callback`

6. 開発用APIを用意する場合は、そのHTTPS Callback URLも追加します。LINEへ登録するURLと `.env` の `LINE_CALLBACK_URL` は完全一致させます。
7. Basic settingsでChannel IDとChannel secretを確認し、サーバー側の環境設定だけへ保存します。
8. 開発中はテスターを登録します。本番利用前にチャネルの公開状態と利用規約・プライバシーポリシー設定を確認します。

要求スコープは `openid profile` だけです。メールアドレスは要求しません。Channel secret、認可コード、アクセストークン、IDトークンはブラウザへ保存しません。

## Messaging API

LINE公式アカウントとMessaging APIチャネルは、LINE Loginと同じLINE Developersプロバイダーへ連携します。
Webhook URLには次を設定し、「Webhookの利用」を有効にします。

`https://www.shikode.com/tools/home-payment/api/webhooks/line`

同じプロバイダー配下のため、`auth_identities.provider = line` と
`provider_user_id` を使ってLINE Login済みの利用者を照合します。LINEトークへ
「ランチ 1200」のように文字と1つの金額を送ると、文字をメモ、数字を金額として
登録します。同じWebhookイベントが再送されても、決定的な支払いIDにより二重登録しません。

LINEログイン時には `GET https://api.line.me/friendship/v1/status` で友だち状態を確認し、
友だち追加済みならアプリ内の追加ボタンを表示しません。Webhookの `follow` / `unfollow`
イベントでも保存状態を更新します。

## サーバー環境変数

`.env.example` を参照し、少なくとも次を設定します。

- `LINE_CHANNEL_ID`
- `LINE_CHANNEL_SECRET`
- `LINE_CALLBACK_URL`
- `LINE_MESSAGING_CHANNEL_SECRET`
- `LINE_MESSAGING_CHANNEL_ACCESS_TOKEN`
- `APP_LOGIN_SUCCESS_URL=https://www.shikode.com/tools/home-payment/`

ログインはAuthorization Code Flow、OpenID Connect、state、nonce、PKCE（S256）を使用します。IDトークンはサーバーからLINE公式の検証エンドポイントへ送り、issuer、audience、有効期限、nonceも確認します。
