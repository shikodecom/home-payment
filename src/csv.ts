import type {StoredData} from './types'
import {paymentTarget, UNCLASSIFIED_GROUP_NAME} from './logic'

const spreadsheetSafe = (value: string) =>
  /^[\t\r\n ]*[=+\-@]/.test(value) ? `'${value}` : value

const cell = (value: string | number | undefined) => {
  const safe = spreadsheetSafe(value == null ? '' : String(value))
  return `"${safe.replaceAll('"', '""')}"`
}

export function paymentCsv(data: StoredData) {
  const groupNames = new Map(data.groups.map(group => [group.id, group.name]))
  const header = [
    '支払日時',
    'まとまり',
    '内容・メモ',
    '金額（円）',
    '区分',
    '請求先',
    '状態',
    '処理日時',
    '登録日時',
    '更新日時',
  ]
  const rows = [...data.payments]
    .sort((a, b) => b.paidAt.localeCompare(a.paidAt))
    .map(payment => [
      payment.paidAt,
      groupNames.get(payment.groupId) || UNCLASSIFIED_GROUP_NAME,
      payment.memo,
      payment.amount,
      payment.kind === 'personal' ? '自分の支払い' : '立替',
      paymentTarget(payment),
      payment.archivedAt ? '処理済み' : payment.kind === 'personal' ? '記録済み' : '未対応',
      payment.archivedAt,
      payment.createdAt,
      payment.updatedAt,
    ])

  return `\uFEFF${[header, ...rows].map(row => row.map(cell).join(',')).join('\r\n')}\r\n`
}

export function paymentCsvFileName(now = new Date()) {
  const date = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ].join('-')
  return `home-payment-${date}.csv`
}
