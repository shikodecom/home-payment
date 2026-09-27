import {beforeEach, describe, expect, it, vi} from 'vitest'
import {cloudToStored, LocalPaymentRepository, loginUrl, resumePendingLogin} from './repository'
import {migrateStoredData} from '../logic'

class MemoryStorage {
  private values = new Map<string, string>()
  getItem(key: string) { return this.values.get(key) ?? null }
  setItem(key: string, value: string) { this.values.set(key, value) }
  removeItem(key: string) { this.values.delete(key) }
  clear() { this.values.clear() }
}

beforeEach(() => {
  Object.defineProperty(globalThis, 'localStorage', {value: new MemoryStorage(), configurable: true})
  vi.restoreAllMocks()
})

describe('保存先の分離', () => {
  it('従来キーをゲスト領域へ安全に移行する', async () => {
    localStorage.setItem('home-payment-data', JSON.stringify({
      payments: [{id: 'legacy-1', amount: 500, memo: '自販機', paidAt: '2026-07-25T01:00:00.000Z'}],
    }))
    const data = await new LocalPaymentRepository().load()
    expect(data.payments).toHaveLength(1)
    expect(JSON.parse(localStorage.getItem('paymentApp.guest.v4') || '{}').payments).toHaveLength(1)
  })

  it('クラウド応答を既存画面モデルへ変換し、サーバー版番号を保持する', () => {
    const data = cloudToStored({
      payments: [{
        id: 'client-id', serverId: 'server-id', clientId: 'client-id', amount: 2200, memo: '交通費',
        billingTargetType: 'other', billingTargetName: '会社', groupName: '初島',
        paidAt: '2026-07-25T01:00:00.000Z', createdAt: '2026-07-25T01:00:00.000Z',
        updatedAt: '2026-07-25T01:00:00.000Z', version: 3, isOneOff: false,
      }],
      archives: [],
      settings: {currentGroupName: '初島', defaultBillingTargetType: 'household'},
    })
    expect(data.payments[0]).toMatchObject({id: 'client-id', serverId: 'server-id', version: 3, reimbursementTarget: '会社'})
    expect(migrateStoredData(data).payments[0].version).toBe(3)
  })
})

describe('iPhoneホーム画面のログイン復帰', () => {
  it('ログイン開始時に推測困難な復帰キーを端末へ保存する', () => {
    const url = new URL(loginUrl(), 'https://www.shikode.com')
    const token = url.searchParams.get('resume_token')
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(localStorage.getItem('paymentApp.loginResume.v1')).toBe(token)
  })

  it('LINE認証完了後に復帰キーを一度だけ交換する', async () => {
    localStorage.setItem('paymentApp.loginResume.v1', 'a'.repeat(43))
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({completed: true}),
      {status: 200, headers: {'Content-Type': 'application/json'}},
    ))
    vi.stubGlobal('fetch', fetchMock)

    await expect(resumePendingLogin()).resolves.toBe(true)
    expect(localStorage.getItem('paymentApp.loginResume.v1')).toBeNull()
    expect(fetchMock).toHaveBeenCalledWith(
      '/tools/home-payment/api/auth/line/resume',
      expect.objectContaining({method: 'POST', credentials: 'same-origin'}),
    )
  })

  it('LINE認証が未完了なら復帰キーを保持する', async () => {
    localStorage.setItem('paymentApp.loginResume.v1', 'b'.repeat(43))
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', {status: 202})))

    await expect(resumePendingLogin()).resolves.toBe(false)
    expect(localStorage.getItem('paymentApp.loginResume.v1')).toBe('b'.repeat(43))
  })
})
