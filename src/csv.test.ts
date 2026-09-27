import {describe, expect, it} from 'vitest'
import {paymentCsv, paymentCsvFileName} from './csv'
import type {StoredData} from './types'

const data: StoredData = {
  version: 4,
  currentGroupId: 'group',
  currentGroupName: '日常生活',
  groups: [{id: 'group', name: '日常生活', createdAt: 'x', updatedAt: 'x'}],
  archives: [],
  payments: [{
    id: 'payment',
    groupId: 'group',
    amount: 1500,
    memo: '=SUM(1,1)',
    kind: 'advance',
    reimbursementTarget: '家計',
    paidAt: '2026-07-25T07:11:00.000Z',
    createdAt: '2026-07-25T07:11:00.000Z',
    updatedAt: '2026-07-25T07:11:00.000Z',
  }],
}

describe('CSV export', () => {
  it('Excel向けBOMと日本語見出しを付け、数式として解釈される入力を無害化する', () => {
    const csv = paymentCsv(data)
    expect(csv.startsWith('\uFEFF')).toBe(true)
    expect(csv).toContain('"支払日時","まとまり","内容・メモ","金額（円）"')
    expect(csv).toContain(`"'=SUM(1,1)"`)
    expect(csv).toContain('"1500"')
  })

  it('日付入りのファイル名を返す', () => {
    expect(paymentCsvFileName(new Date(2026, 6, 25))).toBe('home-payment-2026-07-25.csv')
  })
})
