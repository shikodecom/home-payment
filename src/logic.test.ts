import {describe, expect, it} from 'vitest'
import {
  appendQuickMemo,
  archivePayments,
  billingChoiceFor,
  billingValues,
  combinePaidAt,
  migrateStoredData,
  outstandingTotal,
  permanentlyDeleteArchive,
  registrationGroupName,
  restoreArchivedPayments,
  splitPaidAt,
  totalsByTarget,
  totalsByGroup,
  updateKind,
} from './logic'
import type {Payment} from './types'

const base: Payment = {
  id: '1',
  groupId: 'group',
  amount: 1200,
  memo: '',
  kind: 'advance',
  reimbursementTarget: '家計',
  paidAt: '2026-01-01',
  createdAt: 'x',
  updatedAt: 'x',
}

describe('payment logic', () => {
  it('未対応の立替だけを合計し、請求先別にも集計する', () => {
    const items = [
      base,
      {...base, id: '2', amount: 800, reimbursementTarget: '会社'},
      {...base, id: '3', amount: 500, kind: 'personal', reimbursementTarget: undefined},
      {...base, id: '4', amount: 300, archivedAt: 'now'},
      {...base, id: '5', amount: 200, reimbursementTarget: undefined},
    ] satisfies Payment[]
    expect(outstandingTotal(items)).toBe(2200)
    expect(totalsByTarget(items)).toEqual([['家計', 1200], ['請求先未設定', 200], ['会社', 800]])
  })

  it('上部内訳は請求先をまたいでまとまり別に集計し、自分とアーカイブを除外する', () => {
    const groups = [
      {id: 'group', name: '初島', createdAt: 'x', updatedAt: 'x'},
      {id: 'other', name: '', createdAt: 'x', updatedAt: 'x'},
    ]
    const items = [
      base,
      {...base, id: '2', amount: 800, reimbursementTarget: '会社'},
      {...base, id: '3', amount: 500, kind: 'personal'},
      {...base, id: '4', amount: 300, archivedAt: 'now'},
      {...base, id: '5', groupId: 'other', amount: 200},
    ] satisfies Payment[]
    expect(totalsByGroup(items, groups)).toEqual([['初島', 2000], ['未分類', 200]])
    expect(totalsByGroup(items, groups).reduce((sum, [, total]) => sum + total, 0)).toBe(outstandingTotal(items))
  })

  it('自分の支払いへ変えると請求先を外す', () => {
    expect(updateKind(base, 'personal', 'now').reimbursementTarget).toBeUndefined()
  })

  it('ローカル日時を結合して再分解できる', () => {
    const iso = combinePaidAt('2026-07-12', '14:35')
    expect(splitPaidAt(iso)).toEqual({paidDate: '2026-07-12', paidTime: '14:35'})
  })

  it('クイック入力を区切り付きで追加し、重複させない', () => {
    expect(appendQuickMemo('', '食事代')).toBe('食事代')
    expect(appendQuickMemo('食事代', '交通費')).toBe('食事代・交通費')
    expect(appendQuickMemo('食事代・福田パン', '食事代')).toBe('食事代・福田パン')
  })

  it('v2データを過去の記録へ移し、旧対応状態をアーカイブする', () => {
    const migrated = migrateStoredData({
      version: 2,
      payments: [{...base, groupId: undefined, settlementStatus: 'settled'}],
    }, 'now')
    expect(migrated.version).toBe(4)
    expect(migrated.groups[0].name).toBe('過去の記録')
    expect(migrated.payments[0].archivedAt).toBe('x')
    expect(migrated.archives).toHaveLength(1)
  })

  it('既存の現在のまとまりをv4の直接入力値として引き継ぐ', () => {
    const migrated = migrateStoredData({
      version: 3,
      payments: [base],
      groups: [{id: 'group', name: '初島', createdAt: 'x', updatedAt: 'x'}],
      archives: [],
      currentGroupId: 'group',
    }, 'now')
    expect(migrated.currentGroupName).toBe('初島')
    expect(migrated.currentGroupId).toBe('group')
  })

  it('既存の区分と請求先を新しい請求先UIへ互換変換する', () => {
    expect(billingChoiceFor(base)).toBe('household')
    expect(billingChoiceFor({...base, reimbursementTarget: '会社'})).toBe('other')
    expect(billingChoiceFor({...base, kind: 'personal', reimbursementTarget: undefined})).toBe('self')
    expect(billingChoiceFor({...base, reimbursementTarget: undefined})).toBe('unset')
    expect(billingValues('self')).toEqual({kind: 'personal', reimbursementTarget: undefined})
    expect(billingValues('other', '会社')).toEqual({kind: 'advance', reimbursementTarget: '会社'})
  })

  it('まとまりと請求先が一致する未対応記録だけをまとめてアーカイブする', () => {
    const result = archivePayments([
      base,
      {...base, id: '2', reimbursementTarget: '会社'},
      {...base, id: '3', kind: 'personal'},
    ], 'group', '家計', 'now', 'batch')
    expect(result.archive.paymentIds).toEqual(['1'])
    expect(result.payments[0].archivedAt).toBe('now')
    expect(result.payments[1].archivedAt).toBeUndefined()
  })

  it('カットイン登録後も現在のまとまりを変えず、次の通常登録で元へ戻る', () => {
    const current = 'ブルーベリー狩り'
    expect(registrationGroupName(current, false, '')).toBe('ブルーベリー狩り')
    expect(registrationGroupName(current, true, '新幹線予約')).toBe('新幹線予約')
    expect(registrationGroupName(current, false, '')).toBe('ブルーベリー狩り')
  })

  it('対応処理で合計から外れ、復元すると未対応合計へ戻る', () => {
    const archived = archivePayments([base, {...base, id: '2', reimbursementTarget: '会社'}], 'group', '家計', 'now', 'batch')
    expect(outstandingTotal(archived.payments)).toBe(1200)
    const restored = restoreArchivedPayments(archived.payments, archived.archive.paymentIds, 'later')
    expect(outstandingTotal(restored)).toBe(2400)
    expect(restored[0].archiveBatchId).toBeUndefined()
  })

  it('アーカイブの完全削除は対象の支払いと履歴だけを削除する', () => {
    const payments = [base, {...base, id: '2', reimbursementTarget: '会社'}]
    const archives = [
      {id: 'batch', groupId: 'group', reimbursementTarget: '家計', paymentIds: ['1'], totalAmount: 1200, archivedAt: 'now'},
      {id: 'other-batch', groupId: 'group', reimbursementTarget: '会社', paymentIds: ['2'], totalAmount: 1200, archivedAt: 'now'},
    ]
    const deleted = permanentlyDeleteArchive(payments, archives, 'batch', ['1'])
    expect(deleted.payments.map(payment => payment.id)).toEqual(['2'])
    expect(deleted.archives.map(archive => archive.id)).toEqual(['other-batch'])
    expect(outstandingTotal(deleted.payments)).toBe(1200)
  })
})
