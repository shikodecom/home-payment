<?php
declare(strict_types=1);

$source = file_get_contents(__DIR__ . '/../src/App.php');
if ($source === false) {
    fwrite(STDERR, "API source could not be read\n");
    exit(1);
}

$requirements = [
    "'state' => \$state" => 'OAuth state',
    "'nonce' => \$nonce" => 'OIDC nonce',
    "'code_challenge_method' => 'S256'" => 'PKCE S256',
    "'bot_prompt' => 'normal'" => 'LINE Official Account add-friend prompt',
    'https://api.line.me/friendship/v1/status' => 'LINE friendship status API',
    "'lineFriendAdded'" => 'friendship status response',
    'HTTP_X_LINE_SIGNATURE' => 'LINE webhook signature header',
    "hash_hmac('sha256', \$raw, \$this->config['lineMessagingSecret'], true)" => 'LINE webhook signature verification',
    "'Authorization: Bearer ' . \$this->config['lineMessagingToken']" => 'LINE Messaging API authentication',
    "uuidFromString('line-message:'" => 'idempotent LINE message registration',
    "'code_verifier' => \$attempt['code_verifier']" => 'PKCE verifier exchange',
    'https://api.line.me/oauth2/v2.1/verify' => 'official ID token verification',
    "'httponly' => \$httpOnly" => 'HttpOnly session cookie',
    "'samesite' => 'Lax'" => 'SameSite cookie',
    "'/auth/line/resume'" => 'PWA login resume endpoint',
    "hash('sha256', \$resumeToken)" => 'hashed PWA login resume token',
    'consumed_at IS NULL' => 'one-time PWA login resume token',
    '$this->requireRequestOrigin()' => 'same-origin PWA login resume',
    'HTTP_X_CSRF_TOKEN' => 'CSRF header',
    'HTTP_ORIGIN' => 'Origin validation',
    'user_id=?' => 'user-scoped queries',
    'deleted_at IS NOT NULL' => 'idempotent payment deletion',
    'PDO::ATTR_EMULATE_PREPARES => false' => 'native prepared statements',
    "'sessionRefreshThreshold'" => 'rolling session threshold',
    "expires_at=DATE_ADD(UTC_TIMESTAMP(6), INTERVAL ? SECOND)" => 'rolling session expiry',
    "'path' => \$this->config['cookiePath']" => 'application cookie path',
    "\$this->config['csrfCookie']" => 'configurable CSRF cookie',
    'session_cookie_missing' => 'missing session diagnostic',
    'session_not_found' => 'unknown session diagnostic',
    'session_expired' => 'expired session diagnostic',
    'session_revoked' => 'revoked session diagnostic',
    'auth_db_error' => 'session database diagnostic',
];

$failed = [];
foreach ($requirements as $needle => $label) {
    if (!str_contains($source, $needle)) $failed[] = $label;
}
if ($failed) {
    fwrite(STDERR, 'Missing controls: ' . implode(', ', $failed) . PHP_EOL);
    exit(1);
}
echo "API security controls present\n";
