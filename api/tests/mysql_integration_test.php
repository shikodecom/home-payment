<?php
declare(strict_types=1);

// Only a disposable database ending in _test may be used by this runner.
$name = getenv('DB_NAME') ?: '';
if (!str_ends_with($name, '_test')) throw new RuntimeException('Set DB_NAME to a disposable database ending in _test');
$db = new PDO(sprintf('mysql:host=%s;port=%s;dbname=%s;charset=utf8mb4', getenv('DB_HOST') ?: '127.0.0.1', getenv('DB_PORT') ?: '3306', $name), getenv('DB_USER') ?: 'root', getenv('DB_PASSWORD') ?: '', [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC, PDO::ATTR_EMULATE_PREPARES => false]);
$migrations = __DIR__ . '/../../database/migrations/';
if (!$db->query("SHOW TABLES LIKE 'users'")->fetch()) $db->exec(file_get_contents($migrations . '001_create_cloud_storage.sql'));
$db->exec(file_get_contents($migrations . '005_add_mutation_receipts.sql'));

function uuid(): string { $h = bin2hex(random_bytes(16)); return substr($h, 0, 8) . '-' . substr($h, 8, 4) . '-4' . substr($h, 13, 3) . '-8' . substr($h, 17, 3) . '-' . substr($h, 20); }
function check(bool $condition, string $message): void { if (!$condition) throw new RuntimeException($message); }
function equal(mixed $actual, mixed $expected, string $message): void { check($actual === $expected, $message . ': ' . json_encode(['actual' => $actual, 'expected' => $expected], JSON_UNESCAPED_UNICODE)); }

$user = uuid();
$otherUser = uuid();
$session = bin2hex(random_bytes(32));
$csrf = bin2hex(random_bytes(32));
$secret = str_repeat('integration-test-', 3);
foreach ([$user, $otherUser] as $id) $db->prepare('INSERT INTO users (id,display_name,created_at,updated_at,last_login_at) VALUES (?,"test",UTC_TIMESTAMP(6),UTC_TIMESTAMP(6),UTC_TIMESTAMP(6))')->execute([$id]);
$db->prepare('INSERT INTO user_sessions (id,user_id,token_hash,csrf_token_hash,created_at,expires_at,last_used_at) VALUES (?,?,?,?,UTC_TIMESTAMP(6),DATE_ADD(UTC_TIMESTAMP(6), INTERVAL 30 DAY),UTC_TIMESTAMP(6))')->execute([uuid(), $user, hash('sha256', $session), hash_hmac('sha256', $csrf, $secret)]);
$socket = stream_socket_server('tcp://127.0.0.1:0', $errno, $error);
if (!$socket) throw new RuntimeException($error);
$port = (int)substr(strrchr(stream_socket_get_name($socket, false), ':'), 1);
fclose($socket);
$origin = 'http://127.0.0.1:' . $port;
$log = tempnam(sys_get_temp_dir(), 'home-payment-api-test-');
$env = array_merge(getenv(), ['DB_HOST' => getenv('DB_HOST') ?: '127.0.0.1', 'DB_PORT' => getenv('DB_PORT') ?: '3306', 'DB_USER' => getenv('DB_USER') ?: 'root', 'DB_NAME' => $name, 'APP_ENV' => 'test', 'APP_CONFIG_PATH' => '', 'APP_ALLOWED_ORIGIN' => $origin, 'APP_PATH' => '/tools/home-payment', 'CSRF_SECRET' => $secret, 'SESSION_COOKIE_NAME' => 'home_payment_session', 'CSRF_COOKIE_NAME' => 'home_payment_csrf', 'SESSION_COOKIE_PATH' => '/tools/home-payment/']);
$server = proc_open([PHP_BINARY, '-S', '127.0.0.1:' . $port, __DIR__ . '/integration_router.php'], [0 => ['file', '/dev/null', 'r'], 1 => ['file', $log, 'a'], 2 => ['file', $log, 'a']], $pipes, null, $env);
if (!is_resource($server)) throw new RuntimeException('Could not start test API');
$servers = [$server];

function request(string $method, string $path, ?array $body = null, ?string $operation = null, bool $security = true): array
{
    global $origin, $session, $csrf;
    $curl = curl_init($origin . '/tools/home-payment/api' . $path);
    $headers = ['Content-Type: application/json', 'Origin: ' . $origin];
    if ($security) $headers[] = 'X-CSRF-Token: ' . $csrf;
    if ($operation !== null) $headers[] = 'X-Operation-Id: ' . $operation;
    curl_setopt_array($curl, [CURLOPT_CUSTOMREQUEST => $method, CURLOPT_HTTPHEADER => $headers, CURLOPT_COOKIE => 'home_payment_session=' . $session . '; home_payment_csrf=' . $csrf, CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 10]);
    if ($body !== null) curl_setopt($curl, CURLOPT_POSTFIELDS, json_encode($body, JSON_UNESCAPED_UNICODE));
    $raw = curl_exec($curl);
    $status = curl_getinfo($curl, CURLINFO_RESPONSE_CODE);
    if ($raw === false) throw new RuntimeException(curl_error($curl));
    return [$status, json_decode($raw, true, 512, JSON_THROW_ON_ERROR)];
}
function paymentInput(string $memo = 'テスト'): array { return ['clientId' => uuid(), 'amount' => 500, 'memo' => $memo, 'billingTargetType' => 'household', 'billingTargetName' => null, 'groupName' => '日常生活', 'paidAt' => '2026-10-02T00:00:00Z']; }
function createPayment(array $input): array { [$status, $result] = request('POST', '/payments', $input, uuid()); equal($status, 201, 'create'); return $result['payment']; }
function process(array $payments, ?string $batch = null): array {
    $body = ['clientBatchId' => $batch ?: uuid(), 'groupName' => '日常生活', 'billingTargetType' => 'household', 'payments' => array_map(fn($p) => ['clientId' => $p['clientId'], 'version' => $p['version']], $payments)];
    [$status, $result] = request('POST', '/archive-batches/process', $body, uuid()); equal($status, 201, 'archive'); return $result;
}

function parallelRequests(array $requests): array
{
    global $origin, $session, $csrf;
    $multi = curl_multi_init();
    $handles = [];
    foreach ($requests as [$base, $method, $path, $body, $operation]) {
        $curl = curl_init($base . '/tools/home-payment/api' . $path);
        curl_setopt_array($curl, [CURLOPT_CUSTOMREQUEST => $method, CURLOPT_HTTPHEADER => ['Content-Type: application/json', 'Origin: ' . $origin, 'X-CSRF-Token: ' . $csrf, 'X-Operation-Id: ' . $operation], CURLOPT_COOKIE => 'home_payment_session=' . $session . '; home_payment_csrf=' . $csrf, CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 10]);
        if ($body !== null) curl_setopt($curl, CURLOPT_POSTFIELDS, json_encode($body, JSON_UNESCAPED_UNICODE));
        curl_multi_add_handle($multi, $curl);
        $handles[] = $curl;
    }
    do {
        $result = curl_multi_exec($multi, $running);
        if ($running) curl_multi_select($multi, 0.1);
    } while ($running && $result === CURLM_OK);
    $results = [];
    foreach ($handles as $curl) {
        $results[] = [curl_getinfo($curl, CURLINFO_RESPONSE_CODE), json_decode(curl_multi_getcontent($curl), true, 512, JSON_THROW_ON_ERROR)];
        curl_multi_remove_handle($multi, $curl);
    }
    curl_multi_close($multi);
    return $results;
}

try {
    for ($attempt = 0; $attempt < 50; $attempt++) {
        $ready = @fsockopen('127.0.0.1', $port);
        if ($ready) { fclose($ready); break; }
        usleep(100000);
    }
    // Authentication and idempotency apply before returning a stored response.
    $input = paymentInput();
    $operation = uuid();
    [$status, $created] = request('POST', '/payments', $input, $operation);
    equal($status, 201, 'create with operation');
    equal(request('POST', '/payments', $input, $operation)[1], $created, 'lost create response replay');
    equal(request('POST', '/payments', array_replace($input, ['amount' => 900]), $operation)[0], 409, 'changed operation content');
    equal(request('POST', '/payments', $input, $operation, false)[0], 403, 'replay still checks CSRF');
    equal(request('POST', '/payments', array_replace($input, ['memo' => str_repeat('x', 2097153)]), uuid())[0], 413, 'receipt hashing respects body size limit');
    $patchId = uuid();
    $patch = $input + ['version' => 1];
    $patch['memo'] = '編集';
    $path = '/payments/' . $input['clientId'];
    [$status, $edited] = request('PATCH', $path, $patch, $patchId);
    equal($status, 200, 'patch');
    equal($edited['payment']['version'], 2, 'version advanced');
    equal(request('PATCH', $path, $patch, $patchId)[1], $edited, 'lost PATCH response replay');
    equal(request('PATCH', $path, $patch, uuid())[0], 409, 'stale version conflict');
    equal((int)$db->query("SELECT version FROM payments WHERE client_id='{$input['clientId']}'")->fetchColumn(), 2, 'replay did not update twice');

    // Another device / LINE can add a record while a stale client confirms a batch.
    $selected = createPayment(paymentInput('確認済み'));
    $unseen = createPayment(paymentInput('別端末で追加'));
    $archived = process([$selected]);
    equal($archived['archive']['paymentIds'], [$selected['clientId']], 'only selected IDs archived');
    equal($archived['archive']['itemCount'], 1, 'archive count');
    equal($archived['archive']['totalAmount'], 500, 'archive total');
    check($db->query("SELECT processed_at FROM payments WHERE client_id='{$unseen['clientId']}'")->fetchColumn() === null, 'unseen remains unprocessed');
    equal(request('POST', '/archive-batches/process', ['clientBatchId' => uuid(), 'groupName' => '日常生活', 'billingTargetType' => 'household'], uuid())[0], 422, 'legacy broad archive request rejected');
    equal(request('POST', '/archive-batches/process', ['clientBatchId' => uuid(), 'groupName' => '日常生活', 'billingTargetType' => 'household', 'payments' => [['clientId' => $selected['clientId'], 'version' => 1]]], uuid())[0], 409, 'already processed target conflicts');
    $foreign = uuid();
    $db->prepare('INSERT INTO payments (id,user_id,client_id,amount,memo,billing_target_type,group_name,paid_at,created_at,updated_at) VALUES (?,?,?,100,"foreign","household","日常生活",UTC_TIMESTAMP(6),UTC_TIMESTAMP(6),UTC_TIMESTAMP(6))')->execute([uuid(), $otherUser, $foreign]);
    equal(request('POST', '/archive-batches/process', ['clientBatchId' => uuid(), 'groupName' => '日常生活', 'billingTargetType' => 'household', 'payments' => [['clientId' => $foreign, 'version' => 1]]], uuid())[0], 409, 'foreign target rejected');

    // Stale deletion of history must not delete the current record or a newer batch.
    $oldBatch = $archived['archive']['id'];
    $restoreId = uuid();
    [$status, $restored] = request('POST', '/archive-batches/' . $oldBatch . '/restore', null, $restoreId);
    equal($status, 200, 'restore');
    equal(request('POST', '/archive-batches/' . $oldBatch . '/restore', null, $restoreId)[1], $restored, 'lost restore response replay');
    equal(request('DELETE', '/archive-batches/' . $oldBatch, null, uuid())[0], 409, 'stale delete after restore');
    $newBatch = process($restored['payments']);
    equal(request('DELETE', '/archive-batches/' . $oldBatch, null, uuid())[0], 409, 'stale delete after reprocess');
    equal($db->query("SELECT archive_batch_id FROM payments WHERE client_id='{$selected['clientId']}'")->fetchColumn(), $newBatch['archive']['id'], 'new batch membership preserved');
    $deleteId = uuid();
    equal(request('DELETE', '/archive-batches/' . $newBatch['archive']['id'], null, $deleteId)[0], 200, 'active batch delete');
    equal(request('DELETE', '/archive-batches/' . $newBatch['archive']['id'], null, $deleteId)[0], 200, 'lost delete response replay');

    // Two API processes exercise real overlapping InnoDB transactions.
    $socket = stream_socket_server('tcp://127.0.0.1:0');
    $secondPort = (int)substr(strrchr(stream_socket_get_name($socket, false), ':'), 1);
    fclose($socket);
    $secondOrigin = 'http://127.0.0.1:' . $secondPort;
    $secondServer = proc_open([PHP_BINARY, '-S', '127.0.0.1:' . $secondPort, __DIR__ . '/integration_router.php'], [0 => ['file', '/dev/null', 'r'], 1 => ['file', $log, 'a'], 2 => ['file', $log, 'a']], $pipes, null, $env);
    check(is_resource($secondServer), 'second API started');
    $servers[] = $secondServer;
    for ($attempt = 0; $attempt < 50; $attempt++) {
        $ready = @fsockopen('127.0.0.1', $secondPort);
        if ($ready) { fclose($ready); break; }
        usleep(100000);
    }
    $concurrentInput = paymentInput('同じ操作');
    $concurrentId = uuid();
    $same = parallelRequests([[$origin, 'POST', '/payments', $concurrentInput, $concurrentId], [$secondOrigin, 'POST', '/payments', $concurrentInput, $concurrentId]]);
    equal($same[0][0], 201, 'first concurrent receipt'); equal($same[1], $same[0], 'concurrent replay has identical result');
    $racePayment = createPayment(paymentInput('処理の競合'));
    $raceBody = ['clientBatchId' => uuid(), 'groupName' => '日常生活', 'billingTargetType' => 'household', 'payments' => [['clientId' => $racePayment['clientId'], 'version' => 1]]];
    $otherBody = array_replace($raceBody, ['clientBatchId' => uuid()]);
    $raceIds = [uuid(), uuid()];
    $race = parallelRequests([[$origin, 'POST', '/archive-batches/process', $raceBody, $raceIds[0]], [$secondOrigin, 'POST', '/archive-batches/process', $otherBody, $raceIds[1]]]);
    equal(count(array_filter($race, fn($r) => $r[0] === 201)), 1, 'only one process wins');
    $loser = $race[0][0] === 201 ? 1 : 0;
    check(in_array($race[$loser][0], [409, 503], true), 'loser is conflict or retryable deadlock');
    equal(request('POST', '/archive-batches/process', $loser === 0 ? $raceBody : $otherBody, $raceIds[$loser])[0], 409, 'loser retry reports changed target');
    $raceArchive = $race[1 - $loser][1]['archive'];
    $restoreDelete = parallelRequests([[$origin, 'POST', '/archive-batches/' . $raceArchive['id'] . '/restore', null, uuid()], [$secondOrigin, 'DELETE', '/archive-batches/' . $raceArchive['id'], null, uuid()]]);
    equal(count(array_filter($restoreDelete, fn($r) => $r[0] === 200)), 1, 'restore and delete cannot both succeed');
    if ($restoreDelete[0][0] === 200) {
        equal($restoreDelete[1][0], 409, 'delete rejects restored history');
        equal($db->query("SELECT processed_at FROM payments WHERE client_id='{$racePayment['clientId']}'")->fetchColumn(), null, 'restored record remains unprocessed');
    } else {
        equal($restoreDelete[0][0], 404, 'restore cannot access deleted batch');
        equal((int)$db->query("SELECT COUNT(*) FROM payments WHERE client_id='{$racePayment['clientId']}'")->fetchColumn(), 0, 'delete winner removed active record');
    }

    // No GROUP_CONCAT truncation at 29, 100 or 500 members.
    foreach ([29, 100, 500] as $count) {
        $members = [];
        for ($i = 0; $i < $count; $i++) $members[] = createPayment(paymentInput('多件数'));
        $result = process($members);
        equal(count($result['archive']['paymentIds']), $count, 'single batch complete at ' . $count);
        [$status, $all] = request('GET', '/archive-batches');
        $listed = array_values(array_filter($all['archives'], fn($a) => $a['id'] === $result['archive']['id']))[0];
        equal($listed['paymentIds'], $result['archive']['paymentIds'], 'list and detail IDs agree');
        [$stateStatus, $cloudState] = request('GET', '/state');
        equal($stateStatus, 200, 'consistent state read');
        $stateArchive = array_values(array_filter($cloudState['archives'], fn($a) => $a['id'] === $listed['id']))[0];
        equal($stateArchive['paymentIds'], $listed['paymentIds'], 'state membership agrees');
        equal(count(array_filter($cloudState['payments'], fn($p) => $p['archiveBatchId'] === $listed['id'])), $count, 'state payments agree with archive membership');
        foreach ($listed['paymentIds'] as $id) equal(strlen($id), 36, 'complete UUID');
        [$status, $restoredMany] = request('POST', '/archive-batches/' . $result['archive']['id'] . '/restore', null, uuid());
        equal($status, 200, 'restore all members');
        equal(count($restoredMany['payments']), $count, 'restore count');
    }

    // Guest legacy IDs and restored history share a stable mapping on replay.
    $guest = ['importSourceId' => uuid(), 'groups' => [['id' => 'g', 'name' => '日常生活']], 'payments' => [
        ['id' => 'legacy-open', 'groupId' => 'g', 'amount' => 200, 'memo' => '復元済み', 'kind' => 'advance', 'reimbursementTarget' => '家計', 'paidAt' => '2026-10-02T00:00:00Z'],
        ['id' => 'legacy-settled', 'groupId' => 'g', 'amount' => 300, 'memo' => '処理済み', 'kind' => 'advance', 'reimbursementTarget' => '家計', 'paidAt' => '2026-10-02T00:00:00Z', 'archiveBatchId' => 'legacy-active', 'archivedAt' => '2026-10-02T01:00:00Z'],
    ], 'archives' => [
        ['id' => 'legacy-restored', 'groupId' => 'g', 'paymentIds' => ['legacy-open'], 'reimbursementTarget' => '家計', 'totalAmount' => 200, 'archivedAt' => '2026-10-02T01:00:00Z', 'restoredAt' => '2026-10-02T02:00:00Z'],
        ['id' => 'legacy-active', 'groupId' => 'g', 'paymentIds' => ['legacy-settled'], 'reimbursementTarget' => '家計', 'totalAmount' => 300, 'archivedAt' => '2026-10-02T01:00:00Z'],
    ]];
    $importId = uuid();
    [$status, $imported] = request('POST', '/import/local', $guest, $importId);
    equal($status, 200, 'legacy import'); equal($imported['importedPayments'], 2, 'new import count');
    equal(request('POST', '/import/local', $guest, $importId)[1], $imported, 'lost import response replay');
    equal(request('POST', '/import/local', $guest, uuid())[1]['importedPayments'], 0, 'new operation still deduplicates guest IDs');
    $guestRows = $db->query("SELECT * FROM payments WHERE user_id='{$user}' AND memo IN ('復元済み','処理済み') ORDER BY amount")->fetchAll();
    equal(count($guestRows), 2, 'legacy payments not duplicated');
    equal($guestRows[0]['processed_at'], null, 'restored import remains active');
    equal($guestRows[0]['archive_batch_id'], null, 'restored import has no active batch');
    check($guestRows[1]['processed_at'] !== null, 'settled import remains archived');
    $activeBatch = $guestRows[1]['archive_batch_id'];
    equal(request('POST', '/archive-batches/' . $activeBatch . '/restore', null, uuid())[0], 200, 'restore imported batch');
    request('POST', '/import/local', $guest, uuid());
    equal($db->query("SELECT processed_at FROM payments WHERE id='{$guestRows[1]['id']}'")->fetchColumn(), null, 'repeat import preserves subsequent restore');
    echo "MySQL API integration tests passed (idempotency, conflicts, archive scope/history, 29/100/500 members, legacy import)\n";
} catch (Throwable $error) {
    fwrite(STDERR, substr(file_get_contents($log), -5000));
    throw $error;
} finally {
    foreach ($servers as $process) { proc_terminate($process); proc_close($process); }
    $db->prepare('DELETE FROM users WHERE id IN (?,?)')->execute([$user, $otherUser]);
    if (is_file($log)) unlink($log);
}
