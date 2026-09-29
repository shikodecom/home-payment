<?php
declare(strict_types=1);

namespace HomePayment\Api;

use DateTimeImmutable;
use DateTimeZone;
use PDO;
use PDOException;
use RuntimeException;
use Throwable;

final class App
{
    private PDO $db;
    private array $config;
    private const MAX_BODY_BYTES = 2097152;

    public static function run(): void
    {
        try {
            $app = new self();
            $app->dispatch();
        } catch (HttpError $error) {
            self::json(['error' => $error->publicMessage], $error->status);
        } catch (Throwable $error) {
            error_log('[home-payment] ' . $error->getMessage());
            self::json(['error' => 'サーバーでエラーが発生しました'], 500);
        }
    }

    public function __construct()
    {
        $this->loadExternalEnv();
        $this->config = [
            'env' => $this->env('APP_ENV', 'production'),
            'baseUrl' => rtrim($this->env('APP_BASE_URL', ''), '/'),
            'appPath' => '/' . trim($this->env('APP_PATH', '/tools/home-payment'), '/'),
            'successUrl' => $this->env('APP_LOGIN_SUCCESS_URL', ''),
            'origin' => rtrim($this->env('APP_ALLOWED_ORIGIN', ''), '/'),
            'lineId' => $this->env('LINE_CHANNEL_ID', ''),
            'lineSecret' => $this->env('LINE_CHANNEL_SECRET', ''),
            'lineCallback' => $this->env('LINE_CALLBACK_URL', ''),
            'lineMessagingSecret' => $this->env('LINE_MESSAGING_CHANNEL_SECRET', ''),
            'lineMessagingToken' => $this->env('LINE_MESSAGING_CHANNEL_ACCESS_TOKEN', ''),
            'cookie' => $this->env('SESSION_COOKIE_NAME', 'home_payment_session'),
            'csrfCookie' => $this->env('CSRF_COOKIE_NAME', 'home_payment_csrf'),
            'cookiePath' => $this->env('SESSION_COOKIE_PATH', '/tools/home-payment/'),
            'sessionLifetime' => max(3600, (int)$this->env('SESSION_LIFETIME_SECONDS', '2592000')),
            'sessionRefreshThreshold' => max(0, (int)$this->env('SESSION_REFRESH_THRESHOLD_SECONDS', '604800')),
            'csrfSecret' => $this->env('CSRF_SECRET', ''),
            'loginLimit' => max(1, (int)$this->env('LOGIN_RATE_LIMIT_PER_15_MINUTES', '20')),
        ];
        if ($this->config['env'] === 'production' && strlen($this->config['csrfSecret']) < 32) {
            throw new HttpError(503, 'クラウド保存は現在準備中です');
        }
        $dsn = sprintf(
            'mysql:host=%s;port=%d;dbname=%s;charset=%s',
            $this->env('DB_HOST', ''),
            (int)$this->env('DB_PORT', '3306'),
            $this->env('DB_NAME', ''),
            $this->env('DB_CHARSET', 'utf8mb4')
        );
        try {
            $this->db = new PDO($dsn, $this->env('DB_USER', ''), $this->env('DB_PASSWORD', ''), [
                PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
                PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
                PDO::ATTR_EMULATE_PREPARES => false,
            ]);
        } catch (PDOException $error) {
            throw new HttpError(503, 'クラウドへ接続できません');
        }
    }

    private function dispatch(): void
    {
        $this->requireHttps();
        $method = strtoupper($_SERVER['REQUEST_METHOD'] ?? 'GET');
        $route = $this->routePath();

        if ($method === 'GET' && $route === '/auth/line/start') {
            $this->startLineLogin();
            return;
        }
        if ($method === 'GET' && $route === '/auth/line/callback') {
            $this->lineCallback();
            return;
        }
        if ($method === 'POST' && $route === '/auth/line/resume') {
            $this->resumeLineLogin();
            return;
        }
        if ($method === 'GET' && $route === '/auth/me') {
            $this->authMe();
            return;
        }
        if ($method === 'POST' && $route === '/webhooks/line') {
            $this->lineWebhook();
            return;
        }
        if ($method === 'POST' && $route === '/auth/logout') {
            $session = $this->requireUser();
            $this->requireMutationSecurity($session);
            $this->logout($session);
            return;
        }

        $session = $this->requireUser();
        if (in_array($method, ['POST', 'PUT', 'PATCH', 'DELETE'], true)) {
            $this->requireMutationSecurity($session);
        }

        if ($method === 'GET' && $route === '/state') {
            $this->getState($session['user_id']);
        } elseif ($method === 'GET' && $route === '/payments') {
            self::json(['payments' => $this->listPayments($session['user_id'])]);
        } elseif ($method === 'POST' && $route === '/payments') {
            $this->createPayment($session['user_id']);
        } elseif (preg_match('#^/payments/([0-9a-f-]{36})$#i', $route, $match)) {
            if ($method === 'PATCH') $this->updatePayment($session['user_id'], $match[1]);
            elseif ($method === 'DELETE') $this->deletePayment($session['user_id'], $match[1]);
            else throw new HttpError(405, '許可されていない操作です');
        } elseif ($method === 'GET' && $route === '/archive-batches') {
            self::json(['archives' => $this->listArchives($session['user_id'])]);
        } elseif ($method === 'POST' && $route === '/archive-batches/process') {
            $this->processArchive($session['user_id']);
        } elseif (preg_match('#^/archive-batches/([0-9a-f-]{36})/restore$#i', $route, $match) && $method === 'POST') {
            $this->restoreArchive($session['user_id'], $match[1]);
        } elseif (preg_match('#^/archive-batches/([0-9a-f-]{36})$#i', $route, $match) && $method === 'DELETE') {
            $this->deleteArchive($session['user_id'], $match[1]);
        } elseif ($route === '/settings' && $method === 'GET') {
            self::json(['settings' => $this->getSettings($session['user_id'])]);
        } elseif ($route === '/settings' && $method === 'PATCH') {
            $this->updateSettings($session['user_id']);
        } elseif ($route === '/import/local' && $method === 'POST') {
            $this->importLocal($session['user_id']);
        } else {
            throw new HttpError(404, 'APIが見つかりません');
        }
    }

    private function startLineLogin(): void
    {
        $this->requireLineConfig();
        $this->rateLimit('line-start:' . $this->clientIp(), $this->config['loginLimit'], 900);
        $state = self::randomToken(32);
        $nonce = self::randomToken(32);
        $verifier = self::randomToken(64);
        $challenge = self::base64Url(hash('sha256', $verifier, true));
        $now = self::now();
        $attemptId = self::uuid();
        $stmt = $this->db->prepare(
            'INSERT INTO auth_login_attempts
             (id,state_hash,nonce_value,code_verifier,return_url,created_at,expires_at,ip_address)
             VALUES (?,?,?,?,?,?,DATE_ADD(?, INTERVAL 10 MINUTE),?)'
        );
        $stmt->execute([
            $attemptId, hash('sha256', $state), $nonce, $verifier,
            $this->config['successUrl'], $now, $now, $this->clientIp(),
        ]);
        $resumeToken = is_string($_GET['resume_token'] ?? null) ? $_GET['resume_token'] : '';
        if (preg_match('/^[A-Za-z0-9_-]{43}$/', $resumeToken)) {
            $this->db->prepare(
                'INSERT INTO auth_login_resumes
                 (token_hash,login_attempt_id,created_at,expires_at)
                 VALUES (?,?,?,DATE_ADD(?, INTERVAL 15 MINUTE))'
            )->execute([hash('sha256', $resumeToken), $attemptId, $now, $now]);
        }
        $query = http_build_query([
            'response_type' => 'code',
            'client_id' => $this->config['lineId'],
            'redirect_uri' => $this->config['lineCallback'],
            'state' => $state,
            'scope' => 'openid profile',
            'nonce' => $nonce,
            'bot_prompt' => 'normal',
            'code_challenge' => $challenge,
            'code_challenge_method' => 'S256',
        ], '', '&', PHP_QUERY_RFC3986);
        header('Location: https://access.line.me/oauth2/v2.1/authorize?' . $query, true, 302);
    }

    private function lineCallback(): void
    {
        $this->requireLineConfig();
        if (isset($_GET['error'])) {
            $this->redirectWithError('LINEログインを完了できませんでした');
        }
        $state = is_string($_GET['state'] ?? null) ? $_GET['state'] : '';
        $code = is_string($_GET['code'] ?? null) ? $_GET['code'] : '';
        if ($state === '' || $code === '') throw new HttpError(400, 'ログイン情報の確認に失敗しました');

        $this->db->beginTransaction();
        try {
            $stmt = $this->db->prepare(
                'SELECT * FROM auth_login_attempts
                 WHERE state_hash=? AND used_at IS NULL AND expires_at > UTC_TIMESTAMP(6)
                 FOR UPDATE'
            );
            $stmt->execute([hash('sha256', $state)]);
            $attempt = $stmt->fetch();
            if (!$attempt) throw new HttpError(400, 'ログイン情報の確認に失敗しました');
            $this->db->prepare('UPDATE auth_login_attempts SET used_at=UTC_TIMESTAMP(6) WHERE id=?')->execute([$attempt['id']]);

            $token = $this->lineRequest('https://api.line.me/oauth2/v2.1/token', [
                'grant_type' => 'authorization_code',
                'code' => $code,
                'redirect_uri' => $this->config['lineCallback'],
                'client_id' => $this->config['lineId'],
                'client_secret' => $this->config['lineSecret'],
                'code_verifier' => $attempt['code_verifier'],
            ]);
            if (!is_string($token['id_token'] ?? null)) throw new HttpError(401, 'ログイン情報の確認に失敗しました');
            $friendAdded = is_string($token['access_token'] ?? null)
                ? $this->lineLoginFriendStatus($token['access_token'])
                : null;
            $verified = $this->lineRequest('https://api.line.me/oauth2/v2.1/verify', [
                'id_token' => $token['id_token'],
                'client_id' => $this->config['lineId'],
                'nonce' => $attempt['nonce_value'],
            ]);
            if (($verified['iss'] ?? '') !== 'https://access.line.me' ||
                (string)($verified['aud'] ?? '') !== $this->config['lineId'] ||
                !hash_equals($attempt['nonce_value'], (string)($verified['nonce'] ?? '')) ||
                (int)($verified['exp'] ?? 0) <= time() ||
                !is_string($verified['sub'] ?? null)) {
                throw new HttpError(401, 'ログイン情報の確認に失敗しました');
            }
            $userId = $this->upsertLineUser(
                $verified['sub'],
                self::cleanText((string)($verified['name'] ?? 'LINEユーザー'), 255),
                self::cleanUrl($verified['picture'] ?? null),
                $friendAdded
            );
            $this->db->prepare(
                'UPDATE auth_login_resumes
                 SET user_id=?,completed_at=UTC_TIMESTAMP(6)
                 WHERE login_attempt_id=? AND consumed_at IS NULL'
            )->execute([$userId, $attempt['id']]);
            $this->db->commit();
            $this->issueSession($userId);
            header('Location: ' . $attempt['return_url'], true, 302);
        } catch (Throwable $error) {
            if ($this->db->inTransaction()) $this->db->rollBack();
            if ($error instanceof HttpError) throw $error;
            error_log('[home-payment line callback] ' . $error->getMessage());
            throw new HttpError(401, 'LINEログインを完了できませんでした');
        }
    }

    private function resumeLineLogin(): void
    {
        $this->requireRequestOrigin();
        $this->rateLimit('line-resume:' . $this->clientIp(), $this->config['loginLimit'] * 3, 900);
        $input = $this->jsonInput();
        $token = is_string($input['token'] ?? null) ? $input['token'] : '';
        if (!preg_match('/^[A-Za-z0-9_-]{43}$/', $token)) {
            throw new HttpError(422, 'ログイン復帰情報が正しくありません');
        }

        $this->db->beginTransaction();
        try {
            $stmt = $this->db->prepare(
                'SELECT * FROM auth_login_resumes
                 WHERE token_hash=? AND consumed_at IS NULL
                 FOR UPDATE'
            );
            $stmt->execute([hash('sha256', $token)]);
            $resume = $stmt->fetch();
            if (!$resume) throw new HttpError(401, 'ログイン復帰情報を確認できませんでした');
            if (strtotime($resume['expires_at']) <= time()) {
                throw new HttpError(410, 'ログインの有効時間が切れました');
            }
            if (!is_string($resume['user_id'] ?? null) || $resume['user_id'] === '') {
                $this->db->commit();
                self::json(['completed' => false], 202);
                return;
            }
            $this->db->prepare(
                'UPDATE auth_login_resumes SET consumed_at=UTC_TIMESTAMP(6) WHERE token_hash=?'
            )->execute([hash('sha256', $token)]);
            $this->issueSession($resume['user_id']);
            $this->db->commit();
            self::json(['completed' => true]);
        } catch (Throwable $error) {
            if ($this->db->inTransaction()) $this->db->rollBack();
            throw $error;
        }
    }

    private function upsertLineUser(string $providerUserId, string $name, ?string $picture, ?bool $friendAdded): string
    {
        $stmt = $this->db->prepare(
            "SELECT user_id FROM auth_identities WHERE provider='line' AND provider_user_id=? FOR UPDATE"
        );
        $stmt->execute([$providerUserId]);
        $existing = $stmt->fetch();
        $now = self::now();
        if ($existing) {
            $userId = $existing['user_id'];
            $this->db->prepare(
                'UPDATE users
                 SET display_name=?,profile_image_url=?,line_friend_added=COALESCE(?,line_friend_added),
                     updated_at=?,last_login_at=?
                 WHERE id=?'
            )->execute([$name, $picture, $friendAdded === null ? null : ($friendAdded ? 1 : 0), $now, $now, $userId]);
            $this->db->prepare(
                "UPDATE auth_identities SET provider_display_name=?,provider_profile_image_url=?,updated_at=?
                 WHERE provider='line' AND provider_user_id=?"
            )->execute([$name, $picture, $now, $providerUserId]);
            return $userId;
        }
        $userId = self::uuid();
        $this->db->prepare(
            'INSERT INTO users
             (id,display_name,profile_image_url,line_friend_added,created_at,updated_at,last_login_at)
             VALUES (?,?,?,?,?,?,?)'
        )->execute([
            $userId, $name, $picture, $friendAdded === null ? null : ($friendAdded ? 1 : 0),
            $now, $now, $now,
        ]);
        $this->db->prepare(
            'INSERT INTO auth_identities
             (id,user_id,provider,provider_user_id,provider_display_name,provider_profile_image_url,created_at,updated_at)
             VALUES (?,?,"line",?,?,?,?,?)'
        )->execute([self::uuid(), $userId, $providerUserId, $name, $picture, $now, $now]);
        $this->db->prepare(
            'INSERT INTO user_settings
             (user_id,current_group_name,default_billing_target_type,created_at,updated_at)
             VALUES (?,"日常生活","household",?,?)'
        )->execute([$userId, $now, $now]);
        return $userId;
    }

    private function issueSession(string $userId): void
    {
        $old = $this->currentSession(false, false);
        if ($old) $this->db->prepare('UPDATE user_sessions SET revoked_at=UTC_TIMESTAMP(6) WHERE id=?')->execute([$old['id']]);
        $token = self::randomToken(48);
        $csrf = self::randomToken(32);
        $now = self::now();
        $stmt = $this->db->prepare(
            'INSERT INTO user_sessions
             (id,user_id,token_hash,csrf_token_hash,created_at,expires_at,last_used_at,user_agent,ip_address)
             VALUES (?,?,?,?,?,DATE_ADD(?, INTERVAL ? SECOND),?,?,?)'
        );
        $stmt->execute([
            self::uuid(), $userId, hash('sha256', $token), $this->csrfHash($csrf),
            $now, $now, $this->config['sessionLifetime'], $now,
            substr((string)($_SERVER['HTTP_USER_AGENT'] ?? ''), 0, 512), $this->clientIp(),
        ]);
        $this->setCookie($this->config['cookie'], $token, true, $this->config['sessionLifetime']);
        $this->setCookie($this->config['csrfCookie'], $csrf, false, $this->config['sessionLifetime']);
    }

    private function authMe(): void
    {
        $session = $this->currentSession(false);
        if (!$session) {
            self::json(['authenticated' => false, 'storageMode' => 'local']);
            return;
        }
        $csrf = (string)($_COOKIE[$this->config['csrfCookie']] ?? '');
        if ($csrf === '' || !hash_equals($session['csrf_token_hash'], $this->csrfHash($csrf))) {
            $csrf = self::randomToken(32);
            $this->db->prepare('UPDATE user_sessions SET csrf_token_hash=? WHERE id=?')->execute([$this->csrfHash($csrf), $session['id']]);
            $this->setCookie($this->config['csrfCookie'], $csrf, false, max(60, (new DateTimeImmutable($session['expires_at'], new DateTimeZone('UTC')))->getTimestamp() - time()));
        }
        if ($session['line_friend_added'] === null && is_string($session['provider_user_id'] ?? null)) {
            $friendAdded = $this->lineMessagingFriendStatus($session['provider_user_id']);
            if ($friendAdded !== null) {
                $this->db->prepare('UPDATE users SET line_friend_added=?,updated_at=UTC_TIMESTAMP(6) WHERE id=?')
                    ->execute([$friendAdded ? 1 : 0, $session['user_id']]);
                $session['line_friend_added'] = $friendAdded ? 1 : 0;
            }
        }
        self::json([
            'authenticated' => true,
            'user' => [
                'id' => $session['user_id'],
                'displayName' => $session['display_name'],
                'profileImageUrl' => $session['profile_image_url'],
                'lineFriendAdded' => $session['line_friend_added'] === null
                    ? null
                    : (bool)$session['line_friend_added'],
            ],
            'csrfToken' => $csrf,
            'storageMode' => 'cloud',
        ]);
    }

    private function logout(array $session): void
    {
        $this->db->prepare('UPDATE user_sessions SET revoked_at=UTC_TIMESTAMP(6) WHERE id=?')->execute([$session['id']]);
        $this->setCookie($this->config['cookie'], '', true, -3600);
        $this->setCookie($this->config['csrfCookie'], '', false, -3600);
        self::json(['ok' => true, 'storageMode' => 'local']);
    }

    private function lineWebhook(): void
    {
        $this->requireLineMessagingConfig();
        $length = (int)($_SERVER['CONTENT_LENGTH'] ?? 0);
        if ($length > self::MAX_BODY_BYTES) throw new HttpError(413, '送信データが大きすぎます');
        $raw = file_get_contents('php://input', false, null, 0, self::MAX_BODY_BYTES + 1);
        if ($raw === false || strlen($raw) > self::MAX_BODY_BYTES) {
            throw new HttpError(413, '送信データが大きすぎます');
        }
        $signature = (string)($_SERVER['HTTP_X_LINE_SIGNATURE'] ?? '');
        $expected = base64_encode(hash_hmac('sha256', $raw, $this->config['lineMessagingSecret'], true));
        if ($signature === '' || !hash_equals($expected, $signature)) {
            throw new HttpError(401, '署名を確認できませんでした');
        }
        $payload = json_decode($raw, true);
        if (!is_array($payload) || !is_array($payload['events'] ?? null) || count($payload['events']) > 100) {
            throw new HttpError(400, '送信データが正しくありません');
        }
        foreach ($payload['events'] as $event) {
            if (!is_array($event)) continue;
            $this->handleLineEvent($event);
        }
        self::json(['ok' => true]);
    }

    private function handleLineEvent(array $event): void
    {
        $eventType = (string)($event['type'] ?? '');
        $providerUserId = is_string($event['source']['userId'] ?? null) ? $event['source']['userId'] : '';
        if ($providerUserId === '') return;
        if ($eventType === 'follow' || $eventType === 'unfollow') {
            $this->updateLineFriendStatus($providerUserId, $eventType === 'follow');
            return;
        }
        if ($eventType !== 'message') return;
        $replyToken = is_string($event['replyToken'] ?? null) ? $event['replyToken'] : '';
        $message = is_array($event['message'] ?? null) ? $event['message'] : [];
        if (($message['type'] ?? '') !== 'text') {
            $this->safeLineReply($replyToken, "文字と金額を送ってください。\n例：ランチ 1200");
            return;
        }

        $stmt = $this->db->prepare(
            "SELECT user_id FROM auth_identities WHERE provider='line' AND provider_user_id=?"
        );
        $stmt->execute([$providerUserId]);
        $userId = $stmt->fetchColumn();
        if (!is_string($userId) || $userId === '') {
            $url = $this->config['successUrl'];
            $this->safeLineReply(
                $replyToken,
                "最初に「家計の支払めも」でLINEログインしてください。\nログイン後は、同じトークへ「ランチ 1200」のように送ると登録できます。" .
                ($url !== '' ? "\n" . $url : '')
            );
            return;
        }

        $parsed = LinePaymentMessageParser::parse((string)($message['text'] ?? ''));
        if ($parsed === null) {
            $this->safeLineReply(
                $replyToken,
                "登録できませんでした。文字をメモ、1つの数字を金額として送ってください。\n例：ランチ 1200"
            );
            return;
        }
        $settings = $this->getSettings($userId);
        $eventKey = (string)($event['webhookEventId'] ?? $message['id'] ?? hash('sha256', json_encode($event)));
        $clientId = self::uuidFromString('line-message:' . $providerUserId . ':' . $eventKey);
        $now = self::now();
        $paidAt = $this->lineEventDate($event['timestamp'] ?? null);
        $stmt = $this->db->prepare(
            'INSERT IGNORE INTO payments
             (id,user_id,client_id,amount,memo,billing_target_type,billing_target_name,group_name,
              paid_at,created_at,updated_at,version,is_one_off)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,0)'
        );
        $stmt->execute([
            self::uuid(), $userId, $clientId, $parsed['amount'], $parsed['memo'],
            $settings['defaultBillingTargetType'], $settings['defaultBillingTargetName'],
            $settings['currentGroupName'], $paidAt, $now, $now, 1,
        ]);
        $created = $stmt->rowCount() === 1;
        $memoLabel = $parsed['memo'] !== '' ? $parsed['memo'] : '（メモなし）';
        $prefix = $created ? '登録しました。' : 'このメッセージは登録済みです。';
        $this->safeLineReply(
            $replyToken,
            $prefix . "\nメモ：" . $memoLabel .
            "\n金額：¥" . number_format($parsed['amount']) .
            "\nまとまり：" . $settings['currentGroupName']
        );
    }

    private function lineEventDate(mixed $timestamp): string
    {
        $milliseconds = filter_var($timestamp, FILTER_VALIDATE_INT);
        if ($milliseconds === false || $milliseconds <= 0) return self::now();
        $seconds = intdiv((int)$milliseconds, 1000);
        return (new DateTimeImmutable('@' . $seconds))
            ->setTimezone(new DateTimeZone('UTC'))
            ->format('Y-m-d H:i:s.u');
    }

    private function updateLineFriendStatus(string $providerUserId, bool $friendAdded): void
    {
        $stmt = $this->db->prepare(
            "UPDATE users u
             JOIN auth_identities i ON i.user_id=u.id
             SET u.line_friend_added=?,u.updated_at=UTC_TIMESTAMP(6)
             WHERE i.provider='line' AND i.provider_user_id=?"
        );
        $stmt->execute([$friendAdded ? 1 : 0, $providerUserId]);
    }

    private function safeLineReply(string $replyToken, string $text): void
    {
        if ($replyToken === '') return;
        try {
            $curl = curl_init('https://api.line.me/v2/bot/message/reply');
            curl_setopt_array($curl, [
                CURLOPT_POST => true,
                CURLOPT_POSTFIELDS => json_encode([
                    'replyToken' => $replyToken,
                    'messages' => [['type' => 'text', 'text' => self::cleanText($text, 5000)]],
                ], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES),
                CURLOPT_HTTPHEADER => [
                    'Authorization: Bearer ' . $this->config['lineMessagingToken'],
                    'Content-Type: application/json',
                ],
                CURLOPT_RETURNTRANSFER => true,
                CURLOPT_TIMEOUT => 10,
                CURLOPT_SSL_VERIFYPEER => true,
            ]);
            $body = curl_exec($curl);
            $status = (int)curl_getinfo($curl, CURLINFO_RESPONSE_CODE);
            if ($body === false || $status < 200 || $status >= 300) {
                error_log('[home-payment line reply] LINE API returned status ' . $status);
            }
        } catch (Throwable $error) {
            error_log('[home-payment line reply] ' . $error->getMessage());
        }
    }

    private function currentSession(bool $required = true, bool $refresh = true): ?array
    {
        $token = (string)($_COOKIE[$this->config['cookie']] ?? '');
        if ($token === '') {
            error_log('[home-payment auth] session_cookie_missing');
            if ($required) throw new HttpError(401, 'セッションの有効期限が切れました');
            return null;
        }
        try {
            $stmt = $this->db->prepare(
                "SELECT s.*,u.display_name,u.profile_image_url,u.line_friend_added,i.provider_user_id
                 FROM user_sessions s
                 JOIN users u ON u.id=s.user_id
                 LEFT JOIN auth_identities i ON i.user_id=u.id AND i.provider='line'
                 WHERE s.token_hash=?"
            );
            $stmt->execute([hash('sha256', $token)]);
            $session = $stmt->fetch();
        } catch (PDOException $error) {
            error_log('[home-payment auth] auth_db_error');
            throw $error;
        }
        $reason = !$session ? 'session_not_found'
            : ($session['revoked_at'] !== null ? 'session_revoked'
                : ((new DateTimeImmutable($session['expires_at'], new DateTimeZone('UTC')))->getTimestamp() <= time() ? 'session_expired' : null));
        if ($reason !== null) error_log('[home-payment auth] ' . $reason);
        if ($reason !== null) {
            if ($required) throw new HttpError(401, 'セッションの有効期限が切れました');
            return null;
        }
        if ($refresh) {
            try {
                if ((new DateTimeImmutable($session['expires_at'], new DateTimeZone('UTC')))->getTimestamp() - time() < $this->config['sessionRefreshThreshold']) {
                    $this->db->prepare('UPDATE user_sessions SET last_used_at=UTC_TIMESTAMP(6), expires_at=DATE_ADD(UTC_TIMESTAMP(6), INTERVAL ? SECOND) WHERE id=?')
                        ->execute([$this->config['sessionLifetime'], $session['id']]);
                    $session['expires_at'] = gmdate('Y-m-d H:i:s', time() + $this->config['sessionLifetime']);
                    $this->setCookie($this->config['cookie'], $token, true, $this->config['sessionLifetime']);
                    $csrf = (string)($_COOKIE[$this->config['csrfCookie']] ?? '');
                    if ($csrf !== '' && hash_equals($session['csrf_token_hash'], $this->csrfHash($csrf))) {
                        $this->setCookie($this->config['csrfCookie'], $csrf, false, $this->config['sessionLifetime']);
                    }
                } else {
                    $this->db->prepare('UPDATE user_sessions SET last_used_at=UTC_TIMESTAMP(6) WHERE id=?')->execute([$session['id']]);
                }
            } catch (PDOException $error) {
                error_log('[home-payment auth] auth_db_error');
                throw $error;
            }
        }
        return $session;
    }

    private function requireUser(): array
    {
        return $this->currentSession(true);
    }

    private function requireMutationSecurity(array $session): void
    {
        $this->requireRequestOrigin();
        $header = (string)($_SERVER['HTTP_X_CSRF_TOKEN'] ?? '');
        $cookie = (string)($_COOKIE[$this->config['csrfCookie']] ?? '');
        if ($header === '' || $cookie === '' || !hash_equals($cookie, $header) ||
            !hash_equals($session['csrf_token_hash'], $this->csrfHash($header))) {
            throw new HttpError(403, '操作を確認できませんでした');
        }
    }

    private function requireRequestOrigin(): void
    {
        $origin = rtrim((string)($_SERVER['HTTP_ORIGIN'] ?? ''), '/');
        if ($this->config['origin'] === '' || !hash_equals($this->config['origin'], $origin)) {
            throw new HttpError(403, '不正な送信元です');
        }
    }

    private function getState(string $userId): void
    {
        self::json([
            'payments' => $this->listPayments($userId),
            'archives' => $this->listArchives($userId),
            'settings' => $this->getSettings($userId),
        ]);
    }

    private function listPayments(string $userId): array
    {
        $stmt = $this->db->prepare('SELECT * FROM payments WHERE user_id=? AND deleted_at IS NULL ORDER BY paid_at DESC');
        $stmt->execute([$userId]);
        return array_map(fn(array $row) => $this->paymentJson($row), $stmt->fetchAll());
    }

    private function createPayment(string $userId): void
    {
        $input = $this->jsonInput();
        $payment = $this->validatePayment($input, false);
        $id = self::uuid();
        $now = self::now();
        try {
            $stmt = $this->db->prepare(
                'INSERT INTO payments
                 (id,user_id,client_id,amount,memo,billing_target_type,billing_target_name,group_name,
                  paid_at,created_at,updated_at,version,is_one_off)
                 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)'
            );
            $stmt->execute([
                $id, $userId, $payment['clientId'], $payment['amount'], $payment['memo'],
                $payment['billingTargetType'], $payment['billingTargetName'], $payment['groupName'],
                $payment['paidAt'], $now, $now, 1, $payment['isOneOff'] ? 1 : 0,
            ]);
        } catch (PDOException $error) {
            if ($error->getCode() !== '23000') throw $error;
        }
        $row = $this->findPayment($userId, $payment['clientId']);
        self::json(['payment' => $this->paymentJson($row)], 201);
    }

    private function updatePayment(string $userId, string $id): void
    {
        $input = $this->jsonInput();
        $payment = $this->validatePayment($input, true);
        $version = filter_var($input['version'] ?? null, FILTER_VALIDATE_INT);
        if (!$version || $version < 1) throw new HttpError(422, '更新情報が不足しています');
        $stmt = $this->db->prepare(
            'UPDATE payments SET amount=?,memo=?,billing_target_type=?,billing_target_name=?,group_name=?,
             paid_at=?,updated_at=UTC_TIMESTAMP(6),version=version+1,is_one_off=?
             WHERE user_id=? AND (id=? OR client_id=?) AND deleted_at IS NULL AND version=?'
        );
        $stmt->execute([
            $payment['amount'], $payment['memo'], $payment['billingTargetType'],
            $payment['billingTargetName'], $payment['groupName'], $payment['paidAt'],
            $payment['isOneOff'] ? 1 : 0, $userId, $id, $id, $version,
        ]);
        if ($stmt->rowCount() !== 1) {
            $latest = $this->findPayment($userId, $id, false);
            if (!$latest) throw new HttpError(404, '支払い記録が見つかりません');
            self::json(['error' => '別の端末で更新されています', 'payment' => $this->paymentJson($latest)], 409);
        }
        self::json(['payment' => $this->paymentJson($this->findPayment($userId, $id))]);
    }

    private function deletePayment(string $userId, string $id): void
    {
        $stmt = $this->db->prepare(
            'UPDATE payments SET deleted_at=UTC_TIMESTAMP(6),updated_at=UTC_TIMESTAMP(6),version=version+1
             WHERE user_id=? AND (id=? OR client_id=?) AND deleted_at IS NULL'
        );
        $stmt->execute([$userId, $id, $id]);
        if ($stmt->rowCount() !== 1) {
            $alreadyDeleted = $this->db->prepare(
                'SELECT 1 FROM payments WHERE user_id=? AND (id=? OR client_id=?) AND deleted_at IS NOT NULL'
            );
            $alreadyDeleted->execute([$userId, $id, $id]);
            if (!$alreadyDeleted->fetchColumn()) throw new HttpError(404, '支払い記録が見つかりません');
        }
        self::json(['ok' => true]);
    }

    private function processArchive(string $userId): void
    {
        $input = $this->jsonInput();
        $requestedBatchId = (string)($input['clientBatchId'] ?? '');
        if ($requestedBatchId !== '' && !self::validUuid($requestedBatchId)) throw new HttpError(422, '処理IDが正しくありません');
        $group = self::cleanText((string)($input['groupName'] ?? ''), 255);
        [$type, $name] = $this->validateBilling($input['billingTargetType'] ?? '', $input['billingTargetName'] ?? null);
        if ($type === 'self') throw new HttpError(422, '自分の支払いは処理対象にできません');
        if ($group === '') throw new HttpError(422, 'まとまりが必要です');
        $this->db->beginTransaction();
        try {
            $batchId = $requestedBatchId !== '' ? $requestedBatchId : self::uuid();
            if ($requestedBatchId !== '') {
                $existing = $this->db->prepare('SELECT id FROM archive_batches WHERE id=? AND user_id=?');
                $existing->execute([$batchId, $userId]);
                if ($existing->fetch()) {
                    $this->db->rollBack();
                    self::json(['archive' => $this->archiveById($userId, $batchId)]);
                }
            }
            $condition = $name === null ? 'billing_target_name IS NULL' : 'billing_target_name=?';
            $params = [$userId, $group, $type];
            if ($name !== null) $params[] = $name;
            $stmt = $this->db->prepare(
                "SELECT id,amount FROM payments
                 WHERE user_id=? AND group_name=? AND billing_target_type=? AND {$condition}
                 AND processed_at IS NULL AND deleted_at IS NULL FOR UPDATE"
            );
            $stmt->execute($params);
            $rows = $stmt->fetchAll();
            if (!$rows) throw new HttpError(404, '処理する支払いが見つかりません');
            $total = array_sum(array_map(fn(array $row) => (int)$row['amount'], $rows));
            $now = self::now();
            $this->db->prepare(
                'INSERT INTO archive_batches
                 (id,user_id,group_name,billing_target_type,billing_target_name,total_amount,item_count,processed_at,created_at)
                 VALUES (?,?,?,?,?,?,?,?,?)'
            )->execute([$batchId, $userId, $group, $type, $name, $total, count($rows), $now, $now]);
            $update = $this->db->prepare('UPDATE payments SET processed_at=?,archive_batch_id=?,updated_at=? WHERE id=? AND user_id=?');
            $link = $this->db->prepare('INSERT INTO archive_batch_payments (archive_batch_id,payment_id,user_id) VALUES (?,?,?)');
            foreach ($rows as $row) {
                $update->execute([$now, $batchId, $now, $row['id'], $userId]);
                $link->execute([$batchId, $row['id'], $userId]);
            }
            $this->db->commit();
            self::json(['archive' => $this->archiveById($userId, $batchId)], 201);
        } catch (Throwable $error) {
            if ($this->db->inTransaction()) $this->db->rollBack();
            throw $error;
        }
    }

    private function restoreArchive(string $userId, string $batchId): void
    {
        $this->db->beginTransaction();
        try {
            $batch = $this->lockArchive($userId, $batchId);
            if ($batch['restored_at'] !== null) throw new HttpError(409, 'すでに未処理へ戻されています');
            $stmt = $this->db->prepare(
                'UPDATE payments p JOIN archive_batch_payments ap ON ap.payment_id=p.id
                 SET p.processed_at=NULL,p.archive_batch_id=NULL,p.updated_at=UTC_TIMESTAMP(6)
                 WHERE ap.archive_batch_id=? AND ap.user_id=? AND p.user_id=?'
            );
            $stmt->execute([$batchId, $userId, $userId]);
            $this->db->prepare('UPDATE archive_batches SET restored_at=UTC_TIMESTAMP(6) WHERE id=? AND user_id=?')->execute([$batchId, $userId]);
            $this->db->commit();
            self::json(['ok' => true]);
        } catch (Throwable $error) {
            if ($this->db->inTransaction()) $this->db->rollBack();
            throw $error;
        }
    }

    private function deleteArchive(string $userId, string $batchId): void
    {
        $this->db->beginTransaction();
        try {
            $this->lockArchive($userId, $batchId);
            $stmt = $this->db->prepare(
                'DELETE p FROM payments p JOIN archive_batch_payments ap ON ap.payment_id=p.id
                 WHERE ap.archive_batch_id=? AND ap.user_id=? AND p.user_id=?'
            );
            $stmt->execute([$batchId, $userId, $userId]);
            $this->db->prepare('DELETE FROM archive_batches WHERE id=? AND user_id=?')->execute([$batchId, $userId]);
            $this->db->commit();
            self::json(['ok' => true]);
        } catch (Throwable $error) {
            if ($this->db->inTransaction()) $this->db->rollBack();
            throw $error;
        }
    }

    private function listArchives(string $userId): array
    {
        $stmt = $this->db->prepare(
            'SELECT b.*,GROUP_CONCAT(p.client_id ORDER BY p.paid_at SEPARATOR ",") AS payment_ids
             FROM archive_batches b
             LEFT JOIN archive_batch_payments ap ON ap.archive_batch_id=b.id AND ap.user_id=b.user_id
             LEFT JOIN payments p ON p.id=ap.payment_id AND p.user_id=b.user_id
             WHERE b.user_id=? GROUP BY b.id ORDER BY b.processed_at DESC'
        );
        $stmt->execute([$userId]);
        return array_map(fn(array $row) => $this->archiveJson($row), $stmt->fetchAll());
    }

    private function getSettings(string $userId): array
    {
        $stmt = $this->db->prepare('SELECT * FROM user_settings WHERE user_id=?');
        $stmt->execute([$userId]);
        $row = $stmt->fetch();
        if (!$row) {
            $now = self::now();
            $this->db->prepare(
                'INSERT INTO user_settings (user_id,current_group_name,default_billing_target_type,created_at,updated_at)
                 VALUES (?,"日常生活","household",?,?)'
            )->execute([$userId, $now, $now]);
            return ['currentGroupName' => '日常生活', 'defaultBillingTargetType' => 'household', 'defaultBillingTargetName' => null];
        }
        return [
            'currentGroupName' => $row['current_group_name'],
            'defaultBillingTargetType' => $row['default_billing_target_type'],
            'defaultBillingTargetName' => $row['default_billing_target_name'],
        ];
    }

    private function updateSettings(string $userId): void
    {
        $input = $this->jsonInput();
        $group = self::cleanText((string)($input['currentGroupName'] ?? '日常生活'), 255);
        [$type, $name] = $this->validateBilling(
            $input['defaultBillingTargetType'] ?? 'household',
            $input['defaultBillingTargetName'] ?? null
        );
        $stmt = $this->db->prepare(
            'INSERT INTO user_settings
             (user_id,current_group_name,default_billing_target_type,default_billing_target_name,created_at,updated_at)
             VALUES (?,?,?,?,UTC_TIMESTAMP(6),UTC_TIMESTAMP(6))
             ON DUPLICATE KEY UPDATE current_group_name=VALUES(current_group_name),
             default_billing_target_type=VALUES(default_billing_target_type),
             default_billing_target_name=VALUES(default_billing_target_name),updated_at=UTC_TIMESTAMP(6)'
        );
        $stmt->execute([$userId, $group ?: '未分類', $type, $name]);
        self::json(['settings' => $this->getSettings($userId)]);
    }

    private function importLocal(string $userId): void
    {
        $input = $this->jsonInput();
        $payments = is_array($input['payments'] ?? null) ? $input['payments'] : [];
        $archives = is_array($input['archives'] ?? null) ? $input['archives'] : [];
        $groups = is_array($input['groups'] ?? null) ? $input['groups'] : [];
        if (count($payments) > 500 || count($archives) > 100) throw new HttpError(413, 'コピーできる件数の上限を超えています');
        $groupNames = [];
        foreach ($groups as $group) {
            if (is_array($group) && isset($group['id'])) $groupNames[(string)$group['id']] = self::cleanText((string)($group['name'] ?? '未分類'), 255);
        }
        $this->db->beginTransaction();
        try {
            foreach ($payments as $item) {
                if (!is_array($item)) throw new HttpError(422, 'コピーするデータが正しくありません');
                $clientId = self::validUuid((string)($item['id'] ?? '')) ? (string)$item['id'] : self::uuid();
                $kind = ($item['kind'] ?? 'advance') === 'personal' ? 'personal' : 'advance';
                $target = $kind === 'personal' ? ['self', null] : $this->legacyBilling($item['reimbursementTarget'] ?? null);
                $group = $groupNames[(string)($item['groupId'] ?? '')] ?? '未分類';
                $amount = filter_var($item['amount'] ?? null, FILTER_VALIDATE_INT);
                if ($amount === false || $amount <= 0) throw new HttpError(422, 'コピーする金額が正しくありません');
                $now = self::now();
                $stmt = $this->db->prepare(
                    'INSERT IGNORE INTO payments
                     (id,user_id,client_id,amount,memo,billing_target_type,billing_target_name,group_name,
                      paid_at,created_at,updated_at,processed_at,version,is_one_off)
                     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1,?)'
                );
                $stmt->execute([
                    self::uuid(), $userId, $clientId, $amount,
                    self::cleanText((string)($item['memo'] ?? ''), 2000),
                    $target[0], $target[1], $group, $this->mysqlDate((string)($item['paidAt'] ?? '')),
                    $this->mysqlDate((string)($item['createdAt'] ?? $now)), $now,
                    isset($item['archivedAt']) ? $this->mysqlDate((string)$item['archivedAt']) : null,
                    !empty($item['isOneOffGroup']) ? 1 : 0,
                ]);
            }
            foreach ($archives as $archive) {
                if (!is_array($archive)) continue;
                $sourceId = (string)($archive['id'] ?? '');
                $batchId = self::validUuid($sourceId) ? $sourceId : self::uuid();
                $paymentIds = array_values(array_filter($archive['paymentIds'] ?? [], fn($id) => is_string($id) && self::validUuid($id)));
                if (!$paymentIds) continue;
                $existing = $this->db->prepare('SELECT id FROM archive_batches WHERE id=? AND user_id=?');
                $existing->execute([$batchId, $userId]);
                if ($existing->fetch()) continue;
                $target = $this->legacyBilling($archive['reimbursementTarget'] ?? null);
                $group = $groupNames[(string)($archive['groupId'] ?? '')] ?? '未分類';
                $placeholders = implode(',', array_fill(0, count($paymentIds), '?'));
                $stmt = $this->db->prepare(
                    "SELECT id,amount FROM payments WHERE user_id=? AND client_id IN ({$placeholders}) FOR UPDATE"
                );
                $stmt->execute(array_merge([$userId], $paymentIds));
                $rows = $stmt->fetchAll();
                if (!$rows) continue;
                $processed = $this->mysqlDate((string)($archive['archivedAt'] ?? self::now()));
                $total = array_sum(array_map(fn($row) => (int)$row['amount'], $rows));
                $this->db->prepare(
                    'INSERT INTO archive_batches
                     (id,user_id,group_name,billing_target_type,billing_target_name,total_amount,item_count,processed_at,created_at,restored_at)
                     VALUES (?,?,?,?,?,?,?,?,?,?)'
                )->execute([
                    $batchId, $userId, $group, $target[0] === 'self' ? 'unset' : $target[0], $target[1],
                    $total, count($rows), $processed, $processed,
                    isset($archive['restoredAt']) ? $this->mysqlDate((string)$archive['restoredAt']) : null,
                ]);
                foreach ($rows as $row) {
                    $this->db->prepare('INSERT INTO archive_batch_payments (archive_batch_id,payment_id,user_id) VALUES (?,?,?)')
                        ->execute([$batchId, $row['id'], $userId]);
                    $this->db->prepare('UPDATE payments SET archive_batch_id=?,processed_at=? WHERE id=? AND user_id=?')
                        ->execute([$batchId, $processed, $row['id'], $userId]);
                }
            }
            $settings = is_array($input['settings'] ?? null) ? $input['settings'] : [];
            if (isset($settings['currentGroupName'])) {
                $this->db->prepare('UPDATE user_settings SET current_group_name=?,updated_at=UTC_TIMESTAMP(6) WHERE user_id=?')
                    ->execute([self::cleanText((string)$settings['currentGroupName'], 255), $userId]);
            }
            $this->db->commit();
            self::json(['ok' => true, 'importedPayments' => count($payments)]);
        } catch (Throwable $error) {
            if ($this->db->inTransaction()) $this->db->rollBack();
            throw $error;
        }
    }

    private function validatePayment(array $input, bool $update): array
    {
        $clientId = (string)($input['clientId'] ?? $input['id'] ?? '');
        if (!$update && !self::validUuid($clientId)) throw new HttpError(422, '支払いIDが正しくありません');
        $amount = filter_var($input['amount'] ?? null, FILTER_VALIDATE_INT);
        if ($amount === false || $amount <= 0 || $amount > 999999999999) throw new HttpError(422, '金額が正しくありません');
        [$type, $name] = $this->validateBilling($input['billingTargetType'] ?? '', $input['billingTargetName'] ?? null);
        $group = self::cleanText((string)($input['groupName'] ?? ''), 255);
        if ($group === '') $group = '未分類';
        return [
            'clientId' => $clientId,
            'amount' => $amount,
            'memo' => self::cleanText((string)($input['memo'] ?? ''), 2000),
            'billingTargetType' => $type,
            'billingTargetName' => $name,
            'groupName' => $group,
            'paidAt' => $this->mysqlDate((string)($input['paidAt'] ?? '')),
            'isOneOff' => !empty($input['isOneOff']),
        ];
    }

    private function validateBilling(mixed $type, mixed $name): array
    {
        $type = (string)$type;
        if (!in_array($type, ['household', 'self', 'other', 'unset'], true)) throw new HttpError(422, '請求先が正しくありません');
        if ($type === 'other') {
            $name = self::cleanText((string)$name, 255);
            if ($name === '') throw new HttpError(422, '請求先の名前が必要です');
            return [$type, $name];
        }
        return [$type, null];
    }

    private function legacyBilling(mixed $target): array
    {
        $target = self::cleanText((string)($target ?? ''), 255);
        if ($target === '') return ['unset', null];
        if ($target === '家計') return ['household', null];
        return ['other', $target];
    }

    private function paymentJson(array $row): array
    {
        return [
            'id' => $row['client_id'],
            'serverId' => $row['id'],
            'clientId' => $row['client_id'],
            'amount' => (int)$row['amount'],
            'memo' => $row['memo'],
            'billingTargetType' => $row['billing_target_type'],
            'billingTargetName' => $row['billing_target_name'],
            'groupName' => $row['group_name'],
            'paidAt' => $this->isoDate($row['paid_at']),
            'createdAt' => $this->isoDate($row['created_at']),
            'updatedAt' => $this->isoDate($row['updated_at']),
            'processedAt' => $row['processed_at'] ? $this->isoDate($row['processed_at']) : null,
            'archiveBatchId' => $row['archive_batch_id'],
            'version' => (int)$row['version'],
            'isOneOff' => (bool)$row['is_one_off'],
        ];
    }

    private function archiveJson(array $row): array
    {
        return [
            'id' => $row['id'],
            'groupName' => $row['group_name'],
            'billingTargetType' => $row['billing_target_type'],
            'billingTargetName' => $row['billing_target_name'],
            'paymentIds' => $row['payment_ids'] ? explode(',', $row['payment_ids']) : [],
            'totalAmount' => (int)$row['total_amount'],
            'itemCount' => (int)$row['item_count'],
            'processedAt' => $this->isoDate($row['processed_at']),
            'restoredAt' => $row['restored_at'] ? $this->isoDate($row['restored_at']) : null,
        ];
    }

    private function findPayment(string $userId, string $id, bool $required = true): ?array
    {
        $stmt = $this->db->prepare('SELECT * FROM payments WHERE user_id=? AND (id=? OR client_id=?) AND deleted_at IS NULL');
        $stmt->execute([$userId, $id, $id]);
        $row = $stmt->fetch() ?: null;
        if ($required && !$row) throw new HttpError(404, '支払い記録が見つかりません');
        return $row;
    }

    private function lockArchive(string $userId, string $id): array
    {
        $stmt = $this->db->prepare('SELECT * FROM archive_batches WHERE id=? AND user_id=? FOR UPDATE');
        $stmt->execute([$id, $userId]);
        $row = $stmt->fetch();
        if (!$row) throw new HttpError(404, 'アーカイブが見つかりません');
        return $row;
    }

    private function archiveById(string $userId, string $id): array
    {
        $stmt = $this->db->prepare(
            'SELECT b.*,GROUP_CONCAT(p.client_id ORDER BY p.paid_at SEPARATOR ",") AS payment_ids
             FROM archive_batches b
             LEFT JOIN archive_batch_payments ap ON ap.archive_batch_id=b.id
             LEFT JOIN payments p ON p.id=ap.payment_id
             WHERE b.id=? AND b.user_id=? GROUP BY b.id'
        );
        $stmt->execute([$id, $userId]);
        return $this->archiveJson($stmt->fetch());
    }

    private function lineRequest(string $url, array $fields): array
    {
        $curl = curl_init($url);
        curl_setopt_array($curl, [
            CURLOPT_POST => true,
            CURLOPT_POSTFIELDS => http_build_query($fields, '', '&', PHP_QUERY_RFC3986),
            CURLOPT_HTTPHEADER => ['Content-Type: application/x-www-form-urlencoded'],
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT => 15,
            CURLOPT_SSL_VERIFYPEER => true,
        ]);
        $body = curl_exec($curl);
        $status = (int)curl_getinfo($curl, CURLINFO_RESPONSE_CODE);
        if ($body === false || $status < 200 || $status >= 300) {
            throw new HttpError(401, 'ログイン情報の確認に失敗しました');
        }
        $json = json_decode($body, true);
        if (!is_array($json)) throw new HttpError(401, 'ログイン情報の確認に失敗しました');
        return $json;
    }

    private function lineLoginFriendStatus(string $accessToken): ?bool
    {
        $result = $this->lineGetJson(
            'https://api.line.me/friendship/v1/status',
            $accessToken,
            [200]
        );
        return is_bool($result['friendFlag'] ?? null) ? $result['friendFlag'] : null;
    }

    private function lineMessagingFriendStatus(string $providerUserId): ?bool
    {
        if ($this->config['lineMessagingToken'] === '') return null;
        $result = $this->lineGetJson(
            'https://api.line.me/v2/bot/profile/' . rawurlencode($providerUserId),
            $this->config['lineMessagingToken'],
            [200, 404]
        );
        if (($result['_status'] ?? null) === 404) return false;
        return ($result['_status'] ?? null) === 200 ? true : null;
    }

    private function lineGetJson(string $url, string $accessToken, array $acceptedStatuses): array
    {
        try {
            $curl = curl_init($url);
            curl_setopt_array($curl, [
                CURLOPT_HTTPHEADER => ['Authorization: Bearer ' . $accessToken],
                CURLOPT_RETURNTRANSFER => true,
                CURLOPT_TIMEOUT => 10,
                CURLOPT_SSL_VERIFYPEER => true,
            ]);
            $body = curl_exec($curl);
            $status = (int)curl_getinfo($curl, CURLINFO_RESPONSE_CODE);
            if ($body === false || !in_array($status, $acceptedStatuses, true)) return [];
            $json = json_decode($body, true);
            if (!is_array($json)) $json = [];
            $json['_status'] = $status;
            return $json;
        } catch (Throwable $error) {
            error_log('[home-payment line status] ' . $error->getMessage());
            return [];
        }
    }

    private function rateLimit(string $key, int $limit, int $windowSeconds): void
    {
        $hash = hash('sha256', $key);
        $this->db->beginTransaction();
        try {
            $stmt = $this->db->prepare('SELECT * FROM api_rate_limits WHERE rate_key=? FOR UPDATE');
            $stmt->execute([$hash]);
            $row = $stmt->fetch();
            if (!$row || strtotime($row['expires_at']) <= time()) {
                $now = self::now(false);
                $this->db->prepare(
                    'INSERT INTO api_rate_limits (rate_key,window_started_at,request_count,expires_at)
                     VALUES (?,?,1,DATE_ADD(?,INTERVAL ? SECOND))
                     ON DUPLICATE KEY UPDATE window_started_at=VALUES(window_started_at),request_count=1,expires_at=VALUES(expires_at)'
                )->execute([$hash, $now, $now, $windowSeconds]);
            } else {
                if ((int)$row['request_count'] >= $limit) throw new HttpError(429, 'しばらく待ってからもう一度お試しください');
                $this->db->prepare('UPDATE api_rate_limits SET request_count=request_count+1 WHERE rate_key=?')->execute([$hash]);
            }
            $this->db->commit();
        } catch (Throwable $error) {
            if ($this->db->inTransaction()) $this->db->rollBack();
            throw $error;
        }
    }

    private function requireLineConfig(): void
    {
        foreach (['lineId', 'lineSecret', 'lineCallback', 'successUrl'] as $key) {
            if ($this->config[$key] === '') throw new HttpError(503, 'LINEログインは現在準備中です');
        }
    }

    private function requireLineMessagingConfig(): void
    {
        if ($this->config['lineMessagingSecret'] === '' || $this->config['lineMessagingToken'] === '') {
            throw new HttpError(503, 'LINEメッセージ登録は現在準備中です');
        }
    }

    private function requireHttps(): void
    {
        if ($this->config['env'] !== 'production') return;
        $https = ($_SERVER['HTTPS'] ?? '') === 'on' || strtolower((string)($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '')) === 'https';
        if (!$https) throw new HttpError(400, 'HTTPSでアクセスしてください');
    }

    private function jsonInput(): array
    {
        $length = (int)($_SERVER['CONTENT_LENGTH'] ?? 0);
        if ($length > self::MAX_BODY_BYTES) throw new HttpError(413, '送信データが大きすぎます');
        $raw = file_get_contents('php://input', false, null, 0, self::MAX_BODY_BYTES + 1);
        if ($raw === false || strlen($raw) > self::MAX_BODY_BYTES) throw new HttpError(413, '送信データが大きすぎます');
        $value = json_decode($raw, true);
        if (!is_array($value)) throw new HttpError(400, '送信データが正しくありません');
        return $value;
    }

    private function routePath(): string
    {
        $path = parse_url((string)($_SERVER['REQUEST_URI'] ?? ''), PHP_URL_PATH) ?: '';
        $marker = rtrim($this->config['appPath'], '/') . '/api';
        if (!str_starts_with($path, $marker)) throw new HttpError(404, 'APIが見つかりません');
        $route = substr($path, strlen($marker));
        return '/' . ltrim($route, '/');
    }

    private function loadExternalEnv(): void
    {
        $path = getenv('APP_CONFIG_PATH');
        if (!$path || !is_file($path) || !is_readable($path)) return;
        foreach (file($path, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) ?: [] as $line) {
            $line = trim($line);
            if ($line === '' || str_starts_with($line, '#') || !str_contains($line, '=')) continue;
            [$key, $value] = explode('=', $line, 2);
            $key = trim($key);
            if (getenv($key) === false) putenv($key . '=' . trim($value, " \t\n\r\0\x0B\"'"));
        }
    }

    private function env(string $key, string $default): string
    {
        $value = getenv($key);
        return $value === false ? $default : (string)$value;
    }

    private function csrfHash(string $token): string
    {
        return hash_hmac('sha256', $token, $this->config['csrfSecret']);
    }

    private function setCookie(string $name, string $value, bool $httpOnly, int $maxAge): void
    {
        setcookie($name, $value, [
            'expires' => time() + $maxAge,
            'path' => $this->config['cookiePath'],
            'secure' => $this->config['env'] === 'production',
            'httponly' => $httpOnly,
            'samesite' => 'Lax',
        ]);
    }

    private function redirectWithError(string $message): never
    {
        $url = $this->config['successUrl'] . '?login_error=' . rawurlencode($message);
        header('Location: ' . $url, true, 302);
        exit;
    }

    private function clientIp(): string
    {
        return substr((string)($_SERVER['REMOTE_ADDR'] ?? ''), 0, 45);
    }

    private function mysqlDate(string $value): string
    {
        try {
            return (new DateTimeImmutable($value))->setTimezone(new DateTimeZone('UTC'))->format('Y-m-d H:i:s.u');
        } catch (Throwable) {
            throw new HttpError(422, '日時が正しくありません');
        }
    }

    private function isoDate(string $value): string
    {
        return (new DateTimeImmutable($value, new DateTimeZone('UTC')))->format('Y-m-d\TH:i:s.v\Z');
    }

    private static function cleanText(string $value, int $max): string
    {
        $value = trim(str_replace("\0", '', $value));
        return mb_substr($value, 0, $max, 'UTF-8');
    }

    private static function cleanUrl(mixed $value): ?string
    {
        if (!is_string($value) || !filter_var($value, FILTER_VALIDATE_URL) || !str_starts_with($value, 'https://')) return null;
        return substr($value, 0, 2048);
    }

    private static function validUuid(string $value): bool
    {
        return (bool)preg_match('/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i', $value);
    }

    private static function uuid(): string
    {
        $bytes = random_bytes(16);
        $bytes[6] = chr((ord($bytes[6]) & 0x0f) | 0x40);
        $bytes[8] = chr((ord($bytes[8]) & 0x3f) | 0x80);
        return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($bytes), 4));
    }

    private static function uuidFromString(string $value): string
    {
        $bytes = substr(hash('sha256', $value, true), 0, 16);
        $bytes[6] = chr((ord($bytes[6]) & 0x0f) | 0x50);
        $bytes[8] = chr((ord($bytes[8]) & 0x3f) | 0x80);
        return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($bytes), 4));
    }

    private static function randomToken(int $bytes): string
    {
        return self::base64Url(random_bytes($bytes));
    }

    private static function base64Url(string $value): string
    {
        return rtrim(strtr(base64_encode($value), '+/', '-_'), '=');
    }

    private static function now(bool $microseconds = true): string
    {
        return (new DateTimeImmutable('now', new DateTimeZone('UTC')))->format($microseconds ? 'Y-m-d H:i:s.u' : 'Y-m-d H:i:s');
    }

    private static function json(array $body, int $status = 200): never
    {
        http_response_code($status);
        header('Content-Type: application/json; charset=utf-8');
        header('Cache-Control: no-store');
        echo json_encode($body, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
        exit;
    }
}

final class HttpError extends RuntimeException
{
    public function __construct(public int $status, public string $publicMessage)
    {
        parent::__construct($publicMessage);
    }
}

final class LinePaymentMessageParser
{
    public static function parse(string $text): ?array
    {
        $text = mb_convert_kana($text, 'n', 'UTF-8');
        $text = str_replace(['，', '￥'], [',', '¥'], $text);
        $pattern = '/(?<![0-9])(?:¥\\s*)?([0-9]{1,3}(?:,[0-9]{3})+|[0-9]+)(?:\\s*円)?(?![0-9])/u';
        $count = preg_match_all($pattern, $text, $matches);
        if ($count !== 1) return null;
        $digits = str_replace(',', '', (string)$matches[1][0]);
        if ($digits === '' || !ctype_digit($digits)) return null;
        $amount = (int)$digits;
        if ($amount <= 0 || $amount > 999999999999) return null;
        $memo = preg_replace($pattern, ' ', $text, 1);
        if (!is_string($memo)) return null;
        $memo = preg_replace('/\\s+/u', ' ', $memo);
        if (!is_string($memo)) return null;
        $memo = preg_replace('/\\A[-:：,、\\s]+|[-:：,、\\s]+\\z/u', '', $memo);
        if (!is_string($memo)) return null;
        return [
            'memo' => mb_substr($memo, 0, 2000, 'UTF-8'),
            'amount' => $amount,
        ];
    }
}
