export type ExpenseKind = 'personal' | 'advance'
export type ReimbursementTarget = '家計' | '会社' | '親' | string

export interface PaymentGroup {
  id: string
  name: string
  createdAt: string
  updatedAt: string
}

export interface Payment {
  id: string
  groupId: string
  amount: number
  memo: string
  kind: ExpenseKind
  reimbursementTarget?: ReimbursementTarget
  isOneOffGroup?: boolean
  paidAt: string
  createdAt: string
  updatedAt: string
  archiveBatchId?: string
  archivedAt?: string
  /** v2以前のデータを読み込むためにだけ残す */
  method?: 'cashless' | 'cash'
  settlementStatus?: 'open' | 'settled'
  settledAt?: string
  serverId?: string
  version?: number
}

export interface ArchiveBatch {
  id: string
  groupId: string
  reimbursementTarget?: ReimbursementTarget
  paymentIds: string[]
  totalAmount: number
  archivedAt: string
  restoredAt?: string
}

export interface StoredData {
  version: 4
  payments: Payment[]
  groups: PaymentGroup[]
  archives: ArchiveBatch[]
  currentGroupId: string
  currentGroupName: string
}

export type BillingChoice = 'household' | 'self' | 'other' | 'unset'
export type StorageMode = 'local' | 'cloud'
export type SyncState = 'synced' | 'syncing' | 'pending' | 'failed'
export type AuthStatus = 'checking' | 'authenticated' | 'unauthenticated' | 'unavailable'

export interface AuthUser {
  id: string
  displayName: string
  profileImageUrl?: string
  lineFriendAdded?: boolean | null
}

export interface AuthState {
  status: AuthStatus
  authenticated: boolean
  storageMode: StorageMode
  pendingResume?: boolean
  user?: AuthUser
  csrfToken?: string
}

export interface SyncInfo {
  state: SyncState
  pendingCount: number
  message?: string
}
