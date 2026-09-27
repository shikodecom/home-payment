<?php
declare(strict_types=1);

require_once __DIR__ . '/../src/App.php';

use HomePayment\Api\LinePaymentMessageParser;

$cases = [
    ['ランチ 1200', ['memo' => 'ランチ', 'amount' => 1200]],
    ['1,280円 タクシー', ['memo' => 'タクシー', 'amount' => 1280]],
    ['コーヒー　３５０', ['memo' => 'コーヒー', 'amount' => 350]],
    ['¥500 おやつ', ['memo' => 'おやつ', 'amount' => 500]],
    ['2500', ['memo' => '', 'amount' => 2500]],
    ['ランチ', null],
    ['ランチ 1200 交通費 500', null],
    ['無料 0', null],
];

foreach ($cases as [$input, $expected]) {
    $actual = LinePaymentMessageParser::parse($input);
    if ($actual !== $expected) {
        fwrite(STDERR, sprintf(
            "Parser mismatch for %s\nExpected: %s\nActual: %s\n",
            $input,
            var_export($expected, true),
            var_export($actual, true)
        ));
        exit(1);
    }
}

echo "LINE message parser tests passed\n";
