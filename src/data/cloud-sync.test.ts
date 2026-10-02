import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {CloudPaymentRepository, cloudToStored} from './repository'
import {archivePayments, restoreArchivedPayments} from '../logic'
import type {StoredData, SyncInfo} from '../types'

class MemoryStorage {
  private values = new Map<string, string>()
  get length() { return this.values.size }
  key(index: number) { return [...this.values.keys()][index] ?? null }
  getItem(key: string) { return this.values.get(key) ?? null }
  setItem(key: string, value: string) { this.values.set(key, value) }
  removeItem(key: string) { this.values.delete(key) }
}
const id = '11111111-1111-4111-8111-111111111111'
const id2 = '22222222-2222-4222-8222-222222222222'
const batch = '33333333-3333-4333-8333-333333333333'
const payment = {id, clientId: id, serverId: id2, amount: 500, memo: '元のメモ', billingTargetType: 'household' as const, groupName: '日常生活', paidAt: '2026-10-02T00:00:00Z', createdAt: '2026-10-02T00:00:00Z', updatedAt: '2026-10-02T00:00:00Z', version: 1, isOneOff: false}
const state = (payments = [payment]) => ({payments, archives: [], settings: {currentGroupName: '日常生活', defaultBillingTargetType: 'household' as const}})
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {status})
const queueKey = 'paymentApp.cloud.user.queue.v1'
const cacheKey = 'paymentApp.cloud.user.cache.v1'
const queue = () => JSON.parse(localStorage.getItem(queueKey) || '[]')
const cache = (): StoredData => JSON.parse(localStorage.getItem(cacheKey) || '{}')
const repositories: CloudPaymentRepository[] = []
const repository = () => { const repo = new CloudPaymentRepository('user', 'csrf'); repositories.push(repo); return repo }
const defer = () => { let resolve!: (response: Response) => void; const promise = new Promise<Response>(r => { resolve = r }); return {promise, resolve} }

beforeEach(() => {
  vi.stubGlobal('localStorage', new MemoryStorage())
  vi.stubGlobal('window', new EventTarget())
  vi.stubGlobal('navigator', {onLine: true})
})
afterEach(() => { repositories.splice(0).forEach(repo => repo.dispose()); vi.unstubAllGlobals() })

describe('クラウドの未送信データ保護', () => {
  it.each(['edit', 'delete'])('POST送信中の%sを後続の操作として送信する', async action => {
    const pending = defer()
    const fetchMock = vi.fn().mockResolvedValueOnce(json(state([]))).mockReturnValueOnce(pending.promise).mockResolvedValueOnce(json({payment: {...payment, memo: '編集済み', version: 2}}))
    vi.stubGlobal('fetch', fetchMock)
    const repo = repository()
    const initial = await repo.load()
    const added = {...initial, payments: cloudToStored(state()).payments.map(item => ({...item, version: undefined}))}
    repo.save(added)
    repo.save({...added, payments: action === 'edit' ? added.payments.map(item => ({...item, memo: '編集済み'})) : []})
    expect(queue()).toHaveLength(2)
    pending.resolve(json({payment}))
    await repo.syncNow()
    expect(fetchMock.mock.calls[2][1]).toMatchObject({method: action === 'edit' ? 'PATCH' : 'DELETE'})
    expect(JSON.parse(fetchMock.mock.calls[2][1].body)).toMatchObject({version: 1})
    expect(queue()).toHaveLength(0)
    expect(cache().payments).toHaveLength(action === 'edit' ? 1 : 0)
  })

  it('未送信POSTは編集を統合し、削除時は通信しない', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(state([])))
    vi.stubGlobal('fetch', fetchMock)
    const repo = repository()
    const initial = await repo.load()
    ;(navigator as {onLine: boolean}).onLine = false
    const added = {...initial, payments: cloudToStored(state()).payments}
    repo.save(added)
    repo.save({...added, payments: added.payments.map(item => ({...item, memo: '編集済み'}))})
    expect(queue()).toHaveLength(1)
    expect(queue()[0].body.memo).toBe('編集済み')
    repo.save(initial)
    ;(navigator as {onLine: boolean}).onLine = true
    await repo.syncNow()
    expect(queue()).toHaveLength(0)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('応答を失ったPOSTは内容と操作IDを固定し、再起動後の編集を後続で送る', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(json(state([]))).mockRejectedValueOnce(new Error('lost')))
    const repo = repository()
    const initial = await repo.load()
    const added = {...initial, payments: cloudToStored(state()).payments}
    repo.save(added)
    await repo.syncNow()
    const operation = queue()[0]
    repo.dispose()
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
    const restarted = repository()
    const loaded = await restarted.load()
    ;(navigator as {onLine: boolean}).onLine = false
    restarted.save({...loaded, payments: loaded.payments.map(item => ({...item, memo: '次の編集'}))})
    expect(queue()).toHaveLength(2)
    expect(queue()[0]).toEqual(operation)
    const retry = vi.fn().mockResolvedValueOnce(json({payment})).mockResolvedValueOnce(json({payment: {...payment, memo: '次の編集', version: 2}}))
    vi.stubGlobal('fetch', retry)
    ;(navigator as {onLine: boolean}).onLine = true
    await restarted.syncNow()
    expect(retry.mock.calls[0][1].headers['X-Operation-Id']).toBe(operation.id)
    expect(JSON.parse(retry.mock.calls[0][1].body).memo).toBe('元のメモ')
    expect(JSON.parse(retry.mock.calls[1][1].body)).toMatchObject({memo: '次の編集', version: 1})
  })

  it('409後の再起動でもキャッシュを保持し、新版への自動上書きをしない', async () => {
    const local = cloudToStored(state())
    local.payments[0].memo = '未送信の編集'
    localStorage.setItem(cacheKey, JSON.stringify(local))
    localStorage.setItem(queueKey, JSON.stringify([{id: crypto.randomUUID(), method: 'PATCH', path: `/payments/${id}`, paymentId: id, body: {version: 1, memo: '未送信の編集'}}]))
    const fetchMock = vi.fn().mockResolvedValue(json({error: '別端末で変更', payment: {...payment, memo: '別端末', version: 2}}, 409))
    vi.stubGlobal('fetch', fetchMock)
    const repo = repository()
    let info!: SyncInfo
    repo.subscribe(value => { info = value })
    expect((await repo.load()).payments[0].memo).toBe('未送信の編集')
    expect(info.blocked).toMatchObject({status: 409, canReapply: true, serverMemo: '別端末'})
    await expect(repo.refresh()).rejects.toThrow('同期待ち')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    repo.dispose()
    expect((await repository().load()).payments[0].memo).toBe('未送信の編集')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('競合した変更だけを取り消し、関連のない後続の編集を送る', async () => {
    const second = {...payment, id: id2, clientId: id2, memo: '別の支払い'}
    const remote = state([{...payment, memo: 'サーバー', version: 2}, second])
    const local = cloudToStored(remote)
    local.payments[0].memo = '競合した編集'
    local.payments[1].memo = '独立した編集'
    localStorage.setItem(cacheKey, JSON.stringify(local))
    localStorage.setItem(queueKey, JSON.stringify([
      {id: crypto.randomUUID(), method: 'PATCH', path: `/payments/${id}`, paymentId: id, body: {version: 1, memo: '競合した編集'}, failure: {status: 409, message: '競合'}},
      {id: crypto.randomUUID(), method: 'PATCH', path: `/payments/${id2}`, paymentId: id2, body: {version: 1, memo: '独立した編集'}},
    ]))
    const fetchMock = vi.fn().mockResolvedValueOnce(json(remote)).mockResolvedValueOnce(json({payment: {...second, memo: '独立した編集', version: 2}})).mockResolvedValueOnce(json(state([remote.payments[0], {...second, memo: '独立した編集', version: 2}])))
    vi.stubGlobal('fetch', fetchMock)
    const loaded = await repository().resolveConflict('server')
    expect(fetchMock.mock.calls[1][0]).toContain(id2)
    expect(loaded.payments.map(item => item.memo)).toEqual(['サーバー', '独立した編集'])
    expect(JSON.parse(repository().exportBackup()).backups).toHaveLength(1)
  })

  it('明示的な再適用だけが最新versionを使う', async () => {
    const local = cloudToStored(state())
    local.payments[0].memo = '端末の編集'
    localStorage.setItem(cacheKey, JSON.stringify(local))
    const oldId = crypto.randomUUID()
    localStorage.setItem(queueKey, JSON.stringify([{id: oldId, method: 'PATCH', path: `/payments/${id}`, paymentId: id, body: {version: 1, memo: '端末の編集'}, sent: true, failure: {status: 409, message: '競合'}}]))
    const fetchMock = vi.fn().mockResolvedValueOnce(json(state([{...payment, memo: '別端末', version: 2}]))).mockResolvedValueOnce(json({payment: {...payment, memo: '端末の編集', version: 3}})).mockResolvedValueOnce(json(state([{...payment, memo: '端末の編集', version: 3}])))
    vi.stubGlobal('fetch', fetchMock)
    await repository().resolveConflict('local')
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toMatchObject({version: 2, memo: '端末の編集'})
    expect(fetchMock.mock.calls[1][1].headers['X-Operation-Id']).not.toBe(oldId)
  })

  it('state取得中の編集を古い応答で上書きしない', async () => {
    const pending = defer()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(json(state())).mockReturnValueOnce(pending.promise))
    const repo = repository()
    const loaded = await repo.load()
    const refresh = repo.refresh()
    await Promise.resolve()
    await Promise.resolve()
    ;(navigator as {onLine: boolean}).onLine = false
    repo.save({...loaded, payments: loaded.payments.map(item => ({...item, memo: '取得中の編集'}))})
    pending.resolve(json(state()))
    expect((await refresh).payments[0].memo).toBe('取得中の編集')
    expect(cache().payments[0].memo).toBe('取得中の編集')
  })

  it('処理と復元後の版番号を後続編集へ引き継ぐ', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(json(state()))
      .mockResolvedValueOnce(json({payments: [{...payment, version: 2, archiveBatchId: batch, processedAt: '2026-10-02T01:00:00Z'}]}))
      .mockResolvedValueOnce(json({payments: [{...payment, version: 3}]}))
      .mockResolvedValueOnce(json({payment: {...payment, memo: '復元後の編集', version: 4}}))
    vi.stubGlobal('fetch', fetchMock)
    const repo = repository()
    const loaded = await repo.load()
    ;(navigator as {onLine: boolean}).onLine = false
    const processed = archivePayments(loaded.payments, loaded.payments[0].groupId, '家計', '2026-10-02T01:00:00Z', batch)
    const archived = {...loaded, payments: processed.payments, archives: [processed.archive]}
    repo.save(archived)
    const restored = {...archived, payments: restoreArchivedPayments(archived.payments, [id], '2026-10-02T02:00:00Z'), archives: [{...processed.archive, restoredAt: '2026-10-02T02:00:00Z'}]}
    repo.save(restored)
    repo.save({...restored, payments: restored.payments.map(item => ({...item, memo: '復元後の編集'}))})
    ;(navigator as {onLine: boolean}).onLine = true
    await repo.syncNow()
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).payments).toEqual([{clientId: id, version: 1}])
    expect(JSON.parse(fetchMock.mock.calls[3][1].body).version).toBe(3)
    expect(queue()).toHaveLength(0)
  })

  it('競合した処理を取り消すと、独立した編集が同期待ちでも未処理表示へ戻る', async () => {
    const second = {...payment, id: id2, clientId: id2}
    const remote = cloudToStored(state([payment, second]))
    const processed = archivePayments(remote.payments, remote.payments[0].groupId, '家計', '2026-10-02T01:00:00Z', batch)
    const local = {...remote, payments: processed.payments.map(item => ({...item, memo: '独立した編集'})), archives: [processed.archive]}
    localStorage.setItem(cacheKey, JSON.stringify(local))
    localStorage.setItem(queueKey, JSON.stringify([
      {id: crypto.randomUUID(), method: 'PATCH', path: `/payments/${id}`, paymentId: id, body: {version: 1}, failure: {status: 409, message: '競合'}},
      {id: crypto.randomUUID(), method: 'PATCH', path: `/payments/${id2}`, paymentId: id2, body: {version: 1, memo: '独立した編集'}},
      {id: crypto.randomUUID(), method: 'POST', path: '/archive-batches/process', paymentIds: [id, id2], body: {clientBatchId: batch}},
    ]))
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(json(state([payment, second]))).mockRejectedValueOnce(new Error('offline')))
    const loaded = await repository().resolveConflict('server')
    expect(loaded.payments.find(item => item.id === id2)).toMatchObject({memo: '独立した編集', archivedAt: undefined, archiveBatchId: undefined})
    expect(loaded.archives).toHaveLength(0)
    expect(queue()).toHaveLength(1)
  })

  it('古いキューは送信済みの可能性を保ち、オフライン編集を後続へ残す', async () => {
    const local = cloudToStored(state())
    localStorage.setItem(cacheKey, JSON.stringify(local))
    localStorage.setItem(queueKey, JSON.stringify([{id: crypto.randomUUID(), method: 'POST', path: '/payments', paymentId: id, body: {clientId: id, memo: '元のメモ'}}]))
    ;(navigator as {onLine: boolean}).onLine = false
    const repo = repository()
    const loaded = await repo.load()
    repo.save({...loaded, payments: loaded.payments.map(item => ({...item, memo: '変更'}))})
    expect(queue()).toHaveLength(2)
    expect(queue()[0].body.memo).toBe('元のメモ')
    expect(queue()[1].body.memo).toBe('変更')
  })

  it('オフラインで追加・処理・復元した後の編集は、処理時点の金額を変えない', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(json(state([])))
      .mockResolvedValueOnce(json({payment}))
      .mockResolvedValueOnce(json({payments: [{...payment, version: 2}]}))
      .mockResolvedValueOnce(json({payments: [{...payment, version: 3}]}))
      .mockResolvedValueOnce(json({payment: {...payment, amount: 900, version: 4}}))
    vi.stubGlobal('fetch', fetchMock)
    const repo = repository()
    const empty = await repo.load()
    ;(navigator as {onLine: boolean}).onLine = false
    const added = {...empty, payments: cloudToStored(state()).payments.map(item => ({...item, version: undefined}))}
    repo.save(added)
    const result = archivePayments(added.payments, added.payments[0].groupId, '家計', '2026-10-02T01:00:00Z', batch)
    const archived = {...added, payments: result.payments, archives: [result.archive]}
    repo.save(archived)
    const restored = {...archived, payments: restoreArchivedPayments(archived.payments, [id], '2026-10-02T02:00:00Z'), archives: [{...result.archive, restoredAt: '2026-10-02T02:00:00Z'}]}
    repo.save(restored)
    repo.save({...restored, payments: restored.payments.map(item => ({...item, amount: 900}))})
    expect(queue()).toHaveLength(4)
    ;(navigator as {onLine: boolean}).onLine = true
    await repo.syncNow()
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).amount).toBe(500)
    expect(JSON.parse(fetchMock.mock.calls[4][1].body)).toMatchObject({amount: 900, version: 3})
  })
})
