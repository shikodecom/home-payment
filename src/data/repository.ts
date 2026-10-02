import {billingChoiceFor, billingValues, migrateStoredData, UNCLASSIFIED_GROUP_NAME} from '../logic'
import type {ArchiveBatch, AuthState, Payment, PaymentGroup, StoredData, SyncInfo} from '../types'

const LEGACY_KEY = 'home-payment-data'
const GUEST_KEY = 'paymentApp.guest.v4'
const API_BASE = '/tools/home-payment/api'
const IMPORTED_PREFIX = 'paymentApp.imported.'
const LOGIN_RESUME_KEY = 'paymentApp.loginResume.v1'

type CloudPayment = {
  id: string
  serverId: string
  clientId: string
  amount: number
  memo: string
  billingTargetType: 'household' | 'self' | 'other' | 'unset'
  billingTargetName?: string | null
  groupName: string
  paidAt: string
  createdAt: string
  updatedAt: string
  processedAt?: string | null
  archiveBatchId?: string | null
  version: number
  isOneOff: boolean
}

type CloudArchive = {
  id: string
  groupName: string
  billingTargetType: 'household' | 'other' | 'unset'
  billingTargetName?: string | null
  paymentIds: string[]
  totalAmount: number
  itemCount: number
  processedAt: string
  restoredAt?: string | null
}

type CloudState = {
  payments: CloudPayment[]
  archives: CloudArchive[]
  settings: {
    currentGroupName: string
    defaultBillingTargetType: 'household' | 'self' | 'other' | 'unset'
    defaultBillingTargetName?: string | null
  }
}

type QueueOperation = {
  id: string
  method: 'POST' | 'PATCH' | 'DELETE'
  path: string
  body?: Record<string, unknown>
  paymentId?: string
  paymentIds?: string[]
  sent?: boolean
  failure?: {status: number; message: string; serverMemo?: string}
  originalPayment?: Payment
}

export interface PaymentRepository {
  load(): Promise<StoredData>
  refresh(): Promise<StoredData>
  save(data: StoredData): void
  syncNow(): Promise<void>
  importGuest(data: StoredData): Promise<void>
  subscribe(listener: (info: SyncInfo) => void): () => void
  dispose(): void
  resolveConflict?(choice: 'server' | 'local'): Promise<StoredData>
  exportBackup?(): string
}

export class LocalPaymentRepository implements PaymentRepository {
  private listener?: (info: SyncInfo) => void

  async load() {
    const current = localStorage.getItem(GUEST_KEY)
    const legacy = localStorage.getItem(LEGACY_KEY)
    const data = migrateStoredData(JSON.parse(current || legacy || '{}'))
    if (!current) localStorage.setItem(GUEST_KEY, JSON.stringify(data))
    return data
  }

  save(data: StoredData) {
    localStorage.setItem(GUEST_KEY, JSON.stringify(data))
    localStorage.setItem(LEGACY_KEY, JSON.stringify(data))
    this.listener?.({state: 'synced', pendingCount: 0})
  }

  async syncNow() {}
  async refresh() {
    return this.load()
  }
  async importGuest() {}
  subscribe(listener: (info: SyncInfo) => void) {
    this.listener = listener
    listener({state: 'synced', pendingCount: 0})
    return () => { this.listener = undefined }
  }
  dispose() {}
}

export class CloudPaymentRepository implements PaymentRepository {
  private readonly cacheKey: string
  private readonly queueKey: string
  private listener?: (info: SyncInfo) => void
  private previous?: StoredData
  private syncPromise?: Promise<void>
  private disposed = false
  private revision = 0

  constructor(private userId: string, private csrfToken: string) {
    this.cacheKey = `paymentApp.cloud.${userId}.cache.v1`
    this.queueKey = `paymentApp.cloud.${userId}.queue.v1`
    window.addEventListener('online', this.online)
  }

  async load() {
    const cached = this.cached()
    if (cached) this.previous = structuredClone(cached)
    await this.syncNow()
    if (this.queue().length) {
      if (!cached) throw new Error('未送信データが残っています。端末のバックアップを確認してください')
      return this.cached() || cached
    }
    try {
      return await this.fetchCloudState()
    } catch {
      const data = this.cached()
      if (!data) throw new Error('クラウドへ接続できません')
      this.previous = structuredClone(data)
      this.emit('failed', 'クラウドへ接続できません。端末内のキャッシュを表示しています')
      return data
    }
  }

  async refresh() {
    await this.syncNow()
    if (this.queue().length) throw new Error('同期待ちのデータをクラウドへ保存できませんでした')
    return this.fetchCloudState()
  }

  save(input: StoredData) {
    // React may still hold a version from before our own successful request.
    const versions = new Map(this.previous?.payments.map(payment => [payment.id, payment.version]))
    const data = {...input, payments: input.payments.map(payment => ({...payment, version: versions.get(payment.id) ?? payment.version}))}
    this.revision++
    localStorage.setItem(this.cacheKey, JSON.stringify(data))
    if (this.previous) this.enqueueDiff(this.previous, data)
    this.previous = structuredClone(data)
    void this.syncNow()
  }

  async importGuest(data: StoredData) {
    await this.request('/import/local', {
      method: 'POST',
      body: JSON.stringify({
        importSourceId: guestImportSourceId(),
        payments: data.payments,
        archives: data.archives,
        groups: data.groups,
        settings: {currentGroupName: data.currentGroupName},
      }),
    })
    localStorage.setItem(IMPORTED_PREFIX + this.userId, 'true')
  }

  subscribe(listener: (info: SyncInfo) => void) {
    this.listener = listener
    this.emit(this.queue().length ? 'pending' : 'synced')
    return () => { this.listener = undefined }
  }

  dispose() {
    window.removeEventListener('online', this.online)
    this.listener = undefined
    this.disposed = true
  }

  async syncNow() {
    if (this.syncPromise) return this.syncPromise
    if (this.disposed || !navigator.onLine) {
      if (this.queue().length) this.emit('pending')
      return
    }
    this.syncPromise = this.drainQueue()
    try { await this.syncPromise } finally { this.syncPromise = undefined }
  }

  private async drainQueue() {
    while (!this.disposed && this.queue().length) {
      let operation = this.queue()[0]
      if (operation.failure) { this.emit('failed', operation.failure.message); return }
      this.emit('syncing')
      try {
        // Persist before dispatch. Once sent, an operation is immutable even if
        // its response is lost or the app restarts while it is in flight.
        operation = {...operation, sent: true}
        this.setQueue(this.queue().map(item => item.id === operation.id ? operation : item))
        const result = await this.request(operation.path, {
          method: operation.method,
          headers: {'X-Operation-Id': operation.id},
          body: operation.body ? JSON.stringify(operation.body) : undefined,
        }) as {payment?: CloudPayment; payments?: CloudPayment[]; archive?: CloudArchive}
        this.acceptResult(operation, result)
      } catch (error) {
        const status = error instanceof ApiError ? error.status : 0
        const message = status === 401 ? 'セッションの有効期限が切れました。もう一度LINEでログインしてください'
          : [400, 404, 409, 422].includes(status) ? (error instanceof Error ? error.message : '変更を確認してください')
          : '同期できません。データは端末内に残っています'
        if ([400, 404, 409, 422].includes(status)) {
          const server = error instanceof ApiError ? (error.data as {payment?: CloudPayment}).payment : undefined
          this.setQueue(this.queue().map(item => item.id === operation.id ? {...item, failure: {status, message, serverMemo: server?.memo}} : item))
        }
        this.emit('failed', message)
        return
      }
    }
    if (!this.queue().length) this.emit('synced')
  }

  private acceptResult(operation: QueueOperation, result: {payment?: CloudPayment; payments?: CloudPayment[]; archive?: CloudArchive}) {
    const payments = result.payment ? [result.payment] : result.payments || []
    const versions = new Map(payments.map(payment => [payment.clientId, payment]))
    const next = this.queue().filter(item => item.id !== operation.id).map(item => {
      if (item.sent) return item
      const body = {...item.body}
      if (item.paymentId && versions.has(item.paymentId)) body.version = Math.max(Number(body.version) || 0, versions.get(item.paymentId)!.version)
      if (Array.isArray(body.payments)) body.payments = body.payments.map((payment: {clientId: string; version?: number}) => ({...payment, version: versions.has(payment.clientId) ? Math.max(payment.version || 0, versions.get(payment.clientId)!.version) : payment.version}))
      return {...item, body: item.body ? body : undefined}
    })
    const cached = this.cached()
    if (cached) {
      cached.payments = cached.payments.map(payment => {
        const accepted = versions.get(payment.id)
        if (!accepted) return payment
        return {...payment, version: Math.max(payment.version || 0, accepted.version), serverId: accepted.serverId,
          archivedAt: payment.archiveBatchId && payment.archiveBatchId === accepted.archiveBatchId ? accepted.processedAt || undefined : payment.archivedAt}
      })
      if (result.archive) {
        const archive = result.archive
        cached.archives = cached.archives.map(item => item.id === archive.id ? {...item, paymentIds: archive.paymentIds, totalAmount: archive.totalAmount, archivedAt: archive.processedAt} : item)
      }
      this.previous = structuredClone(cached)
      localStorage.setItem(this.cacheKey, JSON.stringify(cached))
    }
    this.setQueue(next)
  }

  async resolveConflict(choice: 'server' | 'local') {
    await this.syncNow()
    const queue = this.queue()
    const blocked = queue[0]
    if (!blocked?.failure) throw new Error('解決する同期エラーはありません')
    const remote = cloudToStored(await this.request('/state') as CloudState)
    if (JSON.stringify(this.queue()) !== JSON.stringify(queue)) throw new Error('別の画面で変更されています。確認し直してください')
    const local = this.cached()
    if (!local) throw new Error('端末のデータが見つかりません')
    localStorage.setItem(`${this.cacheKey}.backup.${crypto.randomUUID()}`, JSON.stringify({data: local, queue, savedAt: new Date().toISOString()}))
    if (choice === 'local') {
      if (blocked.method !== 'PATCH' || !blocked.paymentId || blocked.failure.status !== 409) throw new Error('この操作は取り消して、対象を確認し直してください')
      const payment = remote.payments.find(item => item.id === blocked.paymentId)
      if (!payment || payment.archivedAt) throw new Error('支払いが削除または処理済みに変更されています。サーバーの内容を使ってください')
      queue[0] = {...blocked, id: crypto.randomUUID(), body: {...blocked.body, version: payment.version}, sent: false, failure: undefined}
      this.setQueue(queue)
    } else {
      // Cancel dependent operations too; preserve independent edits and replay
      // their optimistic display over the freshly read server state.
      const affected = new Set(this.operationPaymentIds(blocked))
      const removed = new Set([blocked.id])
      for (const item of queue) {
        if (removed.has(item.id) || this.operationPaymentIds(item).some(id => affected.has(id))) {
          removed.add(item.id)
          this.operationPaymentIds(item).forEach(id => affected.add(id))
        }
      }
      const remaining = queue.filter(item => !removed.has(item.id))
      const merged = this.overlayPending(remote, local, remaining)
      localStorage.setItem(this.cacheKey, JSON.stringify(merged))
      this.previous = structuredClone(merged)
      this.revision++
      this.setQueue(remaining)
    }
    await this.syncNow()
    return this.queue().length ? this.cached()! : this.fetchCloudState()
  }

  private operationPaymentIds(operation: QueueOperation) {
    return operation.paymentId ? [operation.paymentId] : operation.paymentIds || []
  }

  exportBackup() {
    const backups: unknown[] = []
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index)
      if (key?.startsWith(`${this.cacheKey}.backup.`)) backups.push(JSON.parse(localStorage.getItem(key)!))
    }
    return JSON.stringify({data: this.cached(), operations: this.queue(), backups}, null, 2)
  }

  private overlayPending(remote: StoredData, local: StoredData, queue: QueueOperation[]): StoredData {
    const dirty = new Set(queue.flatMap(item => this.operationPaymentIds(item)))
    const archiveIds = new Set(queue.map(item => item.body?.clientBatchId || item.path.match(/^\/archive-batches\/([0-9a-f-]{36})/)?.[1]).filter(Boolean))
    const groups = new Map([...remote.groups, ...local.groups.map(group => ({...group, id: cloudGroupId(group.name)}))].map(group => [group.id, group]))
    const localGroups = new Map(local.groups.map(group => [group.id, cloudGroupId(group.name)]))
    const remotePayments = new Map(remote.payments.map(payment => [payment.id, payment]))
    return {...remote, groups: [...groups.values()],
      currentGroupName: queue.some(item => item.path === '/settings') ? local.currentGroupName : remote.currentGroupName,
      payments: [...remote.payments.filter(item => !dirty.has(item.id)), ...local.payments.filter(item => dirty.has(item.id)).map(item => {
        const pendingArchive = queue.some(operation => operation.path.startsWith('/archive-batches/') && this.operationPaymentIds(operation).includes(item.id))
        const stored = remotePayments.get(item.id)
        return {...item, groupId: localGroups.get(item.groupId) || item.groupId,
          archivedAt: pendingArchive ? item.archivedAt : stored?.archivedAt,
          archiveBatchId: pendingArchive ? item.archiveBatchId : stored?.archiveBatchId}
      })],
      archives: [...remote.archives.filter(item => !archiveIds.has(item.id)), ...local.archives.filter(item => archiveIds.has(item.id)).map(item => ({...item, groupId: localGroups.get(item.groupId) || item.groupId}))],
    }
  }

  private cached(): StoredData | null {
    const value = localStorage.getItem(this.cacheKey)
    return value ? migrateStoredData(JSON.parse(value)) : null
  }

  private enqueueDiff(before: StoredData, after: StoredData) {
    const beforePayments = new Map(before.payments.map(payment => [payment.id, payment]))
    const afterPayments = new Map(after.payments.map(payment => [payment.id, payment]))
    const beforeArchives = new Map(before.archives.map(archive => [archive.id, archive]))
    const afterArchives = new Map(after.archives.map(archive => [archive.id, archive]))
    const groups = new Map(after.groups.map(group => [group.id, group.name]))

    const addedArchives = after.archives.filter(archive => !beforeArchives.has(archive.id) && !archive.restoredAt)
    const restoredArchives = after.archives.filter(archive => {
      const old = beforeArchives.get(archive.id)
      return Boolean(archive.restoredAt && old && !old.restoredAt)
    })
    const deletedArchives = before.archives.filter(archive => !afterArchives.has(archive.id) && !archive.restoredAt)
    const archivePaymentIds = new Set([
      ...addedArchives.flatMap(archive => archive.paymentIds),
      ...restoredArchives.flatMap(archive => archive.paymentIds),
      ...deletedArchives.flatMap(archive => archive.paymentIds),
    ])

    for (const payment of after.payments) {
      const old = beforePayments.get(payment.id)
      if (!old) {
        this.pushOperation({method: 'POST', path: '/payments', body: paymentBody(payment, groups), paymentId: payment.id})
      } else if (!archivePaymentIds.has(payment.id) && editableSignature(old, before.groups) !== editableSignature(payment, after.groups)) {
        this.pushOperation({
          method: 'PATCH',
          path: `/payments/${payment.id}`,
          body: {...paymentBody(payment, groups), version: old.version},
          paymentId: payment.id,
          originalPayment: old,
        })
      }
    }
    for (const payment of before.payments) {
      if (!afterPayments.has(payment.id) && !archivePaymentIds.has(payment.id)) {
        this.pushOperation({method: 'DELETE', path: `/payments/${payment.id}`, paymentId: payment.id, body: {version: payment.version}, originalPayment: payment})
      }
    }
    for (const archive of addedArchives) {
      const payment = afterPayments.get(archive.paymentIds[0])
      if (!payment) continue
      const choice = billingChoiceFor(payment)
      this.pushOperation({
        method: 'POST',
        path: '/archive-batches/process',
        paymentIds: archive.paymentIds,
        body: {
          clientBatchId: archive.id,
          payments: archive.paymentIds.map(id => ({clientId: id, version: beforePayments.get(id)?.version})),
          groupName: groups.get(archive.groupId) || UNCLASSIFIED_GROUP_NAME,
          billingTargetType: choice === 'other' ? 'other' : choice === 'unset' ? 'unset' : 'household',
          billingTargetName: choice === 'other' ? payment.reimbursementTarget : null,
        },
      })
    }
    restoredArchives.forEach(archive => this.pushOperation({method: 'POST', path: `/archive-batches/${archive.id}/restore`, paymentIds: archive.paymentIds}))
    deletedArchives.forEach(archive => this.pushOperation({method: 'DELETE', path: `/archive-batches/${archive.id}`, paymentIds: archive.paymentIds}))

    if (before.currentGroupName !== after.currentGroupName) {
      this.pushOperation({
        method: 'PATCH',
        path: '/settings',
        body: {currentGroupName: after.currentGroupName, defaultBillingTargetType: 'household'},
      })
    }
  }

  private pushOperation(operation: Omit<QueueOperation, 'id'>) {
    const queue = this.queue()
    if (operation.paymentId) {
      const pendingCreate = queue.find(item => item.paymentId === operation.paymentId && item.method === 'POST' && item.path === '/payments' && !item.sent && !queue.some(dependent => dependent.paymentIds?.includes(operation.paymentId!)))
      if (pendingCreate && operation.method === 'PATCH') {
        pendingCreate.body = operation.body
        this.setQueue(queue)
        return
      }
      if (pendingCreate && operation.method === 'DELETE') {
        this.setQueue(queue.filter(item => item.id !== pendingCreate.id))
        return
      }
    }
    queue.push({id: crypto.randomUUID(), sent: false, ...operation})
    this.setQueue(queue)
  }

  private queue(): QueueOperation[] {
    const queue = JSON.parse(localStorage.getItem(this.queueKey) || '[]') as QueueOperation[]
    if (!Array.isArray(queue)) throw new Error('未送信データを読み込めません。端末のバックアップを確認してください')
    // Old queues did not record whether a request had already left the device.
    // Treat them as potentially sent rather than merging away a later edit.
    return queue.map(operation => ({...operation, sent: operation.sent ?? true}))
  }
  private setQueue(queue: QueueOperation[]) {
    localStorage.setItem(this.queueKey, JSON.stringify(queue))
    this.emit(queue.length ? 'pending' : 'synced')
  }
  private removeOperation(id: string) {
    this.setQueue(this.queue().filter(operation => operation.id !== id))
  }
  private emit(state: SyncInfo['state'], message?: string) {
    const blocked = this.queue()[0]
    this.listener?.({state: blocked?.failure ? 'failed' : state, pendingCount: this.queue().length, message: message || blocked?.failure?.message,
      blocked: blocked?.failure ? {operationId: blocked.id, ...blocked.failure, canReapply: blocked.method === 'PATCH' && Boolean(blocked.paymentId) && blocked.failure.status === 409, localMemo: typeof blocked.body?.memo === 'string' ? blocked.body.memo : undefined} : undefined})
  }
  private online = () => { void this.syncNow() }

  private async fetchCloudState() {
    const revision = this.revision
    const initialCache = localStorage.getItem(this.cacheKey)
    const response = await this.request('/state')
    if (this.queue().length || revision !== this.revision || initialCache !== localStorage.getItem(this.cacheKey)) {
      const cached = this.cached()
      if (cached) { this.previous = structuredClone(cached); return cached }
      throw new Error('同期待ちのデータが残っています')
    }
    const data = cloudToStored(response as CloudState)
    this.previous = structuredClone(data)
    localStorage.setItem(this.cacheKey, JSON.stringify(data))
    return data
  }

  private async request(path: string, init: RequestInit = {}) {
    const response = await fetch(API_BASE + path, {
      credentials: 'same-origin',
      ...init,
      headers: {
        ...(init.body ? {'Content-Type': 'application/json'} : {}),
        ...(init.method && init.method !== 'GET' ? {'X-CSRF-Token': this.csrfToken} : {}),
        ...init.headers,
      },
    })
    const json = await response.json().catch(() => ({}))
    if (!response.ok) throw new ApiError(response.status, json.error || 'クラウドへ接続できません', json)
    return json
  }
}

export async function fetchAuth(): Promise<AuthState> {
  try {
    const response = await fetch(API_BASE + '/auth/me', {credentials: 'same-origin', cache: 'no-store'})
    if (!response.ok) return {status: 'unavailable', authenticated: false, storageMode: 'local'}
    const result = await response.json() as AuthState
    if (result.authenticated === true && result.user?.id && result.csrfToken) {
      return {...result, status: 'authenticated'}
    }
    if (result.authenticated === false) {
      return {status: 'unauthenticated', authenticated: false, storageMode: 'local'}
    }
  } catch {
    // A temporary network failure must not select the guest repository.
  }
  return {status: 'unavailable', authenticated: false, storageMode: 'local'}
}

export async function resumePendingLogin(): Promise<'completed' | 'pending' | 'invalid' | 'unavailable' | 'none'> {
  const token = localStorage.getItem(LOGIN_RESUME_KEY)
  if (!token) return 'none'
  try {
    const response = await fetch(API_BASE + '/auth/line/resume', {
      method: 'POST',
      credentials: 'same-origin',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({token}),
    })
    if (response.status === 200) {
      localStorage.removeItem(LOGIN_RESUME_KEY)
      return 'completed'
    }
    if (response.status === 202) return 'pending'
    if ([400, 401, 410, 422].includes(response.status)) {
      localStorage.removeItem(LOGIN_RESUME_KEY)
      return 'invalid'
    }
  } catch {
    // Keep the one-time token so a later online resume can complete the login.
  }
  return 'unavailable'
}

export function cancelPendingLogin() {
  localStorage.removeItem(LOGIN_RESUME_KEY)
}

export async function fetchAuthWithResume(): Promise<AuthState> {
  if (typeof location !== 'undefined' && new URLSearchParams(location.search).has('login_error')) cancelPendingLogin()
  const auth = await fetchAuth()
  if (auth.status === 'authenticated') {
    localStorage.removeItem(LOGIN_RESUME_KEY)
    return auth
  }
  if (auth.status === 'unavailable') return auth
  const resume = await resumePendingLogin()
  if (resume === 'completed') return fetchAuth()
  if (resume === 'pending') return {...auth, pendingResume: true}
  if (resume === 'unavailable') return {status: 'unavailable', authenticated: false, storageMode: 'local'}
  return auth
}

export async function logout(csrfToken: string) {
  const response = await fetch(API_BASE + '/auth/logout', {
    method: 'POST',
    credentials: 'same-origin',
    headers: {'X-CSRF-Token': csrfToken, 'Content-Type': 'application/json'},
    body: '{}',
  })
  if (!response.ok) throw new Error('ログアウトできませんでした')
}

export function loginUrl() {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  const token = btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '')
  localStorage.setItem(LOGIN_RESUME_KEY, token)
  return API_BASE + '/auth/line/start?resume_token=' + encodeURIComponent(token)
}

export function guestImportWasHandled(userId: string) {
  return localStorage.getItem(IMPORTED_PREFIX + userId) !== null
}

export function markGuestImportHandled(userId: string) {
  localStorage.setItem(IMPORTED_PREFIX + userId, 'skipped')
}

function guestImportSourceId() {
  const key = 'paymentApp.guest.importSource.v1'
  let id = localStorage.getItem(key)
  if (!id) { id = crypto.randomUUID(); localStorage.setItem(key, id) }
  return id
}

export async function loadGuestData() {
  return new LocalPaymentRepository().load()
}

function paymentBody(payment: Payment, groups: Map<string, string>) {
  const choice = billingChoiceFor(payment)
  const values = billingValues(choice, payment.reimbursementTarget)
  return {
    clientId: payment.id,
    amount: payment.amount,
    memo: payment.memo,
    billingTargetType: choice,
    billingTargetName: choice === 'other' ? values.reimbursementTarget : null,
    groupName: groups.get(payment.groupId) || UNCLASSIFIED_GROUP_NAME,
    paidAt: payment.paidAt,
    isOneOff: Boolean(payment.isOneOffGroup),
  }
}

function editableSignature(payment: Payment, groups: PaymentGroup[]) {
  const names = new Map(groups.map(group => [group.id, group.name]))
  return JSON.stringify(paymentBody(payment, names))
}

export function cloudToStored(state: CloudState): StoredData {
  const groupNames = [...new Set([
    ...state.payments.map(payment => payment.groupName || UNCLASSIFIED_GROUP_NAME),
    ...state.archives.map(archive => archive.groupName || UNCLASSIFIED_GROUP_NAME),
    state.settings.currentGroupName || '日常生活',
  ])]
  const groups = groupNames.map(name => ({
    id: cloudGroupId(name),
    name,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }))
  const groupId = new Map(groups.map(group => [group.name, group.id]))
  const payments: Payment[] = state.payments.map(payment => {
    const billing = payment.billingTargetType === 'self'
      ? billingValues('self')
      : payment.billingTargetType === 'household'
        ? billingValues('household')
        : payment.billingTargetType === 'other'
          ? billingValues('other', payment.billingTargetName || '')
          : billingValues('unset')
    return {
      id: payment.clientId,
      serverId: payment.serverId,
      version: payment.version,
      groupId: groupId.get(payment.groupName) || cloudGroupId(UNCLASSIFIED_GROUP_NAME),
      amount: payment.amount,
      memo: payment.memo,
      ...billing,
      isOneOffGroup: payment.isOneOff,
      paidAt: payment.paidAt,
      createdAt: payment.createdAt,
      updatedAt: payment.updatedAt,
      archiveBatchId: payment.archiveBatchId || undefined,
      archivedAt: payment.processedAt || undefined,
    }
  })
  const archives: ArchiveBatch[] = state.archives.map(archive => ({
    id: archive.id,
    groupId: groupId.get(archive.groupName) || cloudGroupId(UNCLASSIFIED_GROUP_NAME),
    reimbursementTarget: archive.billingTargetType === 'household' ? '家計' : archive.billingTargetName || undefined,
    paymentIds: archive.paymentIds,
    totalAmount: archive.totalAmount,
    archivedAt: archive.processedAt,
    restoredAt: archive.restoredAt || undefined,
  }))
  const currentGroupId = groupId.get(state.settings.currentGroupName) || groups[0].id
  return {version: 4, payments, groups, archives, currentGroupId, currentGroupName: state.settings.currentGroupName}
}

function cloudGroupId(name: string) {
  let hash = 2166136261
  for (let index = 0; index < name.length; index++) {
    hash ^= name.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return `cloud-group-${(hash >>> 0).toString(16)}`
}

class ApiError extends Error {
  constructor(public status: number, message: string, public data: unknown) { super(message) }
}
