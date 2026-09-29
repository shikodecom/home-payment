<?php
declare(strict_types=1);

require_once __DIR__ . '/../src/App.php';

use HomePayment\Api\App;

final class SessionTestPDO extends PDO
{
    public ?array $row = null;
    public array $queries = [];

    public function __construct() {}

    public function prepare(string $query, array $options = []): PDOStatement|false
    {
        $this->queries[] = $query;
        return new SessionTestStatement($this);
    }
}

final class SessionTestStatement extends PDOStatement
{
    public function __construct(private SessionTestPDO $database) {}

    public function execute(?array $params = null): bool { return true; }
    public function fetch(int $mode = PDO::FETCH_DEFAULT, int $cursorOrientation = PDO::FETCH_ORI_NEXT, int $cursorOffset = 0): mixed
    {
        return $this->database->row ?: false;
    }
}

function sessionApp(SessionTestPDO $database): App
{
    $reflection = new ReflectionClass(App::class);
    $app = $reflection->newInstanceWithoutConstructor();
    $reflection->getProperty('db')->setValue($app, $database);
    $reflection->getProperty('config')->setValue($app, [
        'cookie' => 'home_payment_session',
        'csrfCookie' => 'home_payment_csrf',
        'cookiePath' => '/tools/home-payment/',
        'sessionLifetime' => 2592000,
        'sessionRefreshThreshold' => 604800,
        'csrfSecret' => str_repeat('s', 32),
        'env' => 'production',
    ]);
    return $app;
}

function check(bool $condition, string $message): void
{
    if (!$condition) throw new RuntimeException($message);
}

$method = new ReflectionMethod(App::class, 'currentSession');
$_COOKIE = ['home_payment_session' => 'test-session', 'home_payment_csrf' => 'test-csrf'];
$base = [
    'id' => 'session-1',
    'csrf_token_hash' => hash_hmac('sha256', 'test-csrf', str_repeat('s', 32)),
    'revoked_at' => null,
];

$database = new SessionTestPDO();
$database->row = $base + ['expires_at' => gmdate('Y-m-d H:i:s', time() + 8 * 86400)];
$method->invoke(sessionApp($database));
check(count(array_filter($database->queries, fn($query) => str_contains($query, 'expires_at=DATE_ADD'))) === 0, 'Session with more than seven days remaining was extended');
check(count(array_filter($database->queries, fn($query) => str_contains($query, 'last_used_at=UTC_TIMESTAMP(6)'))) === 1, 'Last use was not updated');

$database = new SessionTestPDO();
$database->row = $base + ['expires_at' => gmdate('Y-m-d H:i:s', time() + 6 * 86400)];
$session = $method->invoke(sessionApp($database));
check(count(array_filter($database->queries, fn($query) => str_contains($query, 'expires_at=DATE_ADD'))) === 1, 'Session within seven days was not extended');
check(strtotime($session['expires_at'] . ' UTC') > time() + 29 * 86400, 'Returned session expiry was not refreshed');

foreach (['expired' => $base + ['expires_at' => gmdate('Y-m-d H:i:s', time() - 60)],
          'revoked' => array_replace($base, ['expires_at' => gmdate('Y-m-d H:i:s', time() + 3600), 'revoked_at' => gmdate('Y-m-d H:i:s')])] as $reason => $row) {
    $database = new SessionTestPDO();
    $database->row = $row;
    check($method->invoke(sessionApp($database), false) === null, $reason . ' session was accepted');
    check(count($database->queries) === 1, $reason . ' session was updated');
}

echo "Session rolling expiry tests passed\n";
