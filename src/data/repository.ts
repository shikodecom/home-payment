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
}

export interface PaymentRepository {
  load(): Promise<StoredData>
  refresh(): Promise<StoredData>
  save(data: StoredData): void
  syncNow(): Promise<void>
  importGuest(data: StoredData): Promise<void>
  subscribe(listener: (info: SyncInfo) => void): () => void
  dispose(): void
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
  private syncing = false
  private versions = new Map<string, number>()

  constructor(private userId: string, private csrfToken: string) {
    this.cacheKey = `paymentApp.cloud.${userId}.cache.v1`
    this.queueKey = `paymentApp.cloud.${userId}.queue.v1`
    window.addEventListener('online', this.online)
  }

  async load() {
    try {
      await this.syncNow()
      return await this.fetchCloudState()
    } catch {
      const cached = localStorage.getItem(this.cacheKey)
      if (!cached) throw new Error('クラウドへ接続できません')
      const data = migrateStoredData(JSON.parse(cached))
      this.previous = data
      this.emit('failed', 'クラウドへ接続できません。端末内のキャッシュを表示しています')
      return data
    }
  }

  async refresh() {
    await this.syncNow()
    if (this.queue().length) {
      throw new Error('同期待ちのデータをクラウドへ保存できませんでした')
    }
    return this.fetchCloudState()
  }

  save(data: StoredData) {
    localStorage.setItem(this.cacheKey, JSON.stringify(data))
    if (!this.previous) {
      this.previous = data
      return
    }
    this.enqueueDiff(this.previous, data)
    this.previous = structuredClone(data)
    void this.syncNow()
  }

  async importGuest(data: StoredData) {
    await this.request('/import/local', {
      method: 'POST',
      body: JSON.stringify({
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
  }

  async syncNow() {
    if (this.syncing || !navigator.onLine) {
      if (this.queue().length) this.emit('pending')
      return
    }
    this.syncing = true
    try {
      while (this.queue().length) {
        const operation = this.queue()[0]
        this.emit('syncing')
        try {
          const body = {...operation.body}
          if (operation.method === 'PATCH' && operation.paymentId) {
            body.version = this.versions.get(operation.paymentId) ?? body.version
          }
          const result = await this.request(operation.path, {
            method: operation.method,
            body: operation.body ? JSON.stringify(body) : undefined,
          }) as {payment?: CloudPayment}
          if (result.payment) this.versions.set(result.payment.clientId, result.payment.version)
          this.removeOperation(operation.id)
        } catch (error) {
          const message = error instanceof ApiError && error.status === 409
            ? '別の端末で更新されています。再読み込みしてください'
            : error instanceof ApiError && error.status === 401
              ? 'セッションの有効期限が切れました。もう一度LINEでログインしてください'
              : '同期できません。データは端末内に残っています'
          this.emit('failed', message)
          break
        }
      }
      if (!this.queue().length) this.emit('synced')
    } finally {
      this.syncing = false
    }
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
          body: {...paymentBody(payment, groups), version: old.version || this.versions.get(payment.id)},
          paymentId: payment.id,
        })
      }
    }
    for (const payment of before.payments) {
      if (!afterPayments.has(payment.id) && !archivePaymentIds.has(payment.id)) {
        this.pushOperation({method: 'DELETE', path: `/payments/${payment.id}`, paymentId: payment.id})
      }
    }
    for (const archive of addedArchives) {
      const payment = afterPayments.get(archive.paymentIds[0])
      if (!payment) continue
      const choice = billingChoiceFor(payment)
      this.pushOperation({
        method: 'POST',
        path: '/archive-batches/process',
        body: {
          clientBatchId: archive.id,
          groupName: groups.get(archive.groupId) || UNCLASSIFIED_GROUP_NAME,
          billingTargetType: choice === 'other' ? 'other' : choice === 'unset' ? 'unset' : 'household',
          billingTargetName: choice === 'other' ? payment.reimbursementTarget : null,
        },
      })
    }
    restoredArchives.forEach(archive => this.pushOperation({method: 'POST', path: `/archive-batches/${archive.id}/restore`}))
    deletedArchives.forEach(archive => this.pushOperation({method: 'DELETE', path: `/archive-batches/${archive.id}`}))

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
      const pendingCreate = queue.find(item => item.paymentId === operation.paymentId && item.method === 'POST' && item.path === '/payments')
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
    queue.push({id: crypto.randomUUID(), ...operation})
    this.setQueue(queue)
  }

  private queue(): QueueOperation[] {
    try { return JSON.parse(localStorage.getItem(this.queueKey) || '[]') as QueueOperation[] } catch { return [] }
  }
  private setQueue(queue: QueueOperation[]) {
    localStorage.setItem(this.queueKey, JSON.stringify(queue))
    this.emit(queue.length ? 'pending' : 'synced')
  }
  private removeOperation(id: string) {
    this.setQueue(this.queue().filter(operation => operation.id !== id))
  }
  private emit(state: SyncInfo['state'], message?: string) {
    this.listener?.({state, pendingCount: this.queue().length, message})
  }
  private online = () => { void this.syncNow() }

  private async fetchCloudState() {
    const response = await this.request('/state')
    const data = cloudToStored(response as CloudState)
    this.previous = structuredClone(data)
    this.versions.clear()
    data.payments.forEach(payment => payment.version && this.versions.set(payment.id, payment.version))
    localStorage.setItem(this.cacheKey, JSON.stringify(data))
    return data
  }

  private async request(path: string, init: RequestInit = {}) {
    const response = await fetch(API_BASE + path, {
      credentials: 'same-origin',
      headers: {
        ...(init.body ? {'Content-Type': 'application/json'} : {}),
        ...(init.method && init.method !== 'GET' ? {'X-CSRF-Token': this.csrfToken} : {}),
      },
      ...init,
    })
    const json = await response.json().catch(() => ({}))
    if (!response.ok) throw new ApiError(response.status, json.error || 'クラウドへ接続できません', json)
    return json
  }
}

export async function fetchAuth(): Promise<AuthState> {
  try {
    const response = await fetch(API_BASE + '/auth/me', {credentials: 'same-origin', cache: 'no-store'})
    if (!response.ok) return {authenticated: false, storageMode: 'local'}
    return await response.json() as AuthState
  } catch {
    return {authenticated: false, storageMode: 'local'}
  }
}

export async function resumePendingLogin(): Promise<boolean> {
  const token = localStorage.getItem(LOGIN_RESUME_KEY)
  if (!token) return false
  try {
    const response = await fetch(API_BASE + '/auth/line/resume', {
      method: 'POST',
      credentials: 'same-origin',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({token}),
    })
    if (response.status === 200) {
      localStorage.removeItem(LOGIN_RESUME_KEY)
      return true
    }
    if ([400, 401, 410, 422].includes(response.status)) {
      localStorage.removeItem(LOGIN_RESUME_KEY)
    }
  } catch {
    // Keep the one-time token so a later online resume can complete the login.
  }
  return false
}

export async function fetchAuthWithResume(): Promise<AuthState> {
  const auth = await fetchAuth()
  if (auth.authenticated) {
    localStorage.removeItem(LOGIN_RESUME_KEY)
    return auth
  }
  return await resumePendingLogin() ? fetchAuth() : auth
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
