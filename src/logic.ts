import type {ArchiveBatch, BillingChoice, ExpenseKind, Payment, PaymentGroup, ReimbursementTarget, StoredData} from './types'

export const FALLBACK_GROUP_NAME = '過去の記録'
export const DEFAULT_GROUP_NAME = '日常生活'
export const UNSET_TARGET = '請求先未設定'
export const SELF_TARGET = '自分'
export const UNCLASSIFIED_GROUP_NAME = '未分類'

export const paymentTarget = (payment: Payment) =>
  payment.kind === 'personal' ? SELF_TARGET : payment.reimbursementTarget?.trim() || UNSET_TARGET

export const billingChoiceFor = (payment: Payment): BillingChoice =>
  payment.kind === 'personal'
    ? 'self'
    : payment.reimbursementTarget === '家計'
      ? 'household'
      : payment.reimbursementTarget
        ? 'other'
        : 'unset'

export const billingValues = (choice: BillingChoice, customTarget = ''): Pick<Payment, 'kind' | 'reimbursementTarget'> => {
  if (choice === 'self') return {kind: 'personal', reimbursementTarget: undefined}
  if (choice === 'household') return {kind: 'advance', reimbursementTarget: '家計'}
  if (choice === 'other') return {kind: 'advance', reimbursementTarget: customTarget.trim() || undefined}
  return {kind: 'advance', reimbursementTarget: undefined}
}

export const outstandingTotal = (items: Payment[]) =>
  items
    .filter(payment => payment.kind === 'advance' && !payment.archivedAt)
    .reduce((total, payment) => total + payment.amount, 0)

export const totalsByTarget = (items: Payment[]) => {
  const totals = new Map<string, number>()
  items
    .filter(payment => payment.kind === 'advance' && !payment.archivedAt)
    .forEach(payment => {
      const target = paymentTarget(payment)
      totals.set(target, (totals.get(target) || 0) + payment.amount)
    })
  const order = ['家計', UNSET_TARGET]
  return [...totals.entries()].sort(([a], [b]) => {
    const aIndex = order.indexOf(a)
    const bIndex = order.indexOf(b)
    if (aIndex >= 0 || bIndex >= 0) return (aIndex < 0 ? order.length : aIndex) - (bIndex < 0 ? order.length : bIndex)
    return a.localeCompare(b, 'ja')
  })
}

export const totalsByGroup = (items: Payment[], groups: PaymentGroup[]) => {
  const groupNames = new Map(groups.map(group => [group.id, group.name.trim() || UNCLASSIFIED_GROUP_NAME]))
  const totals = new Map<string, number>()
  items
    .filter(payment => payment.kind === 'advance' && !payment.archivedAt)
    .forEach(payment => {
      const name = groupNames.get(payment.groupId) || UNCLASSIFIED_GROUP_NAME
      totals.set(name, (totals.get(name) || 0) + payment.amount)
    })
  return [...totals.entries()]
    .filter(([, total]) => total > 0)
    .sort(([a], [b]) => a.localeCompare(b, 'ja'))
}

export const updateKind = (payment: Payment, kind: ExpenseKind, now: string): Payment =>
  kind === 'personal'
    ? {...payment, kind, reimbursementTarget: undefined, updatedAt: now}
    : {...payment, kind, updatedAt: now}

export const splitPaidAt = (paidAt: string) => {
  const date = new Date(paidAt)
  const pad = (value: number) => String(value).padStart(2, '0')
  return {
    paidDate: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    paidTime: `${pad(date.getHours())}:${pad(date.getMinutes())}`,
  }
}

export const combinePaidAt = (paidDate: string, paidTime: string) =>
  new Date(`${paidDate}T${paidTime}:00`).toISOString()

export const appendQuickMemo = (memo: string, item: string) => {
  const parts = memo.split('・').map(part => part.trim()).filter(Boolean)
  if (parts.includes(item)) return memo
  return memo.trim() ? `${memo.trim()}・${item}` : item
}

export const registrationGroupName = (currentGroupName: string, oneOff: boolean, oneOffGroupName: string) =>
  (oneOff ? oneOffGroupName : currentGroupName).trim() || UNCLASSIFIED_GROUP_NAME

export const migrateStoredData = (raw: unknown, now = new Date().toISOString()): StoredData => {
  const source = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  const sourcePayments = Array.isArray(source.payments) ? source.payments as Array<Partial<Payment>> : []
  const sourceGroups = Array.isArray(source.groups) ? source.groups as PaymentGroup[] : []
  const sourceArchives = Array.isArray(source.archives) ? source.archives as ArchiveBatch[] : []
  const fallbackId = 'legacy-group'
  const isNewData = sourceGroups.length === 0 && sourcePayments.length === 0
  const needsFallback = !isNewData && (sourceGroups.length === 0 || sourcePayments.some(payment => !payment.groupId))
  const groups = [...sourceGroups]
  if (needsFallback && !groups.some(group => group.id === fallbackId)) {
    groups.push({id: fallbackId, name: FALLBACK_GROUP_NAME, createdAt: now, updatedAt: now})
  }
  if (groups.length === 0) groups.push({id: fallbackId, name: isNewData ? DEFAULT_GROUP_NAME : FALLBACK_GROUP_NAME, createdAt: now, updatedAt: now})

  const archives = [...sourceArchives]
  const payments = sourcePayments.map((payment, index): Payment => {
    const id = payment.id || `legacy-payment-${index}`
    const legacySettled = payment.settlementStatus === 'settled'
    let batchId = payment.archiveBatchId
    let archivedAt = payment.archivedAt
    if (legacySettled && !batchId) {
      batchId = `legacy-archive-${id}`
      archivedAt = payment.settledAt || payment.updatedAt || now
      archives.push({
        id: batchId,
        groupId: payment.groupId || fallbackId,
        reimbursementTarget: payment.reimbursementTarget,
        paymentIds: [id],
        totalAmount: Number(payment.amount) || 0,
        archivedAt,
      })
    }
    return {
      id,
      serverId: payment.serverId,
      version: payment.version,
      groupId: payment.groupId || fallbackId,
      amount: Number(payment.amount) || 0,
      memo: payment.memo || '',
      kind: payment.kind === 'personal' ? 'personal' : 'advance',
      reimbursementTarget: payment.kind === 'personal' ? undefined : payment.reimbursementTarget,
      isOneOffGroup: payment.isOneOffGroup,
      paidAt: payment.paidAt || now,
      createdAt: payment.createdAt || now,
      updatedAt: payment.updatedAt || now,
      archiveBatchId: batchId,
      archivedAt,
    }
  })
  const requestedCurrent = typeof source.currentGroupId === 'string' ? source.currentGroupId : ''
  const currentGroupId = groups.some(group => group.id === requestedCurrent) ? requestedCurrent : groups[0].id
  const storedName = typeof source.currentGroupName === 'string' ? source.currentGroupName : ''
  const currentGroupName = storedName || groups.find(group => group.id === currentGroupId)?.name || DEFAULT_GROUP_NAME
  return {version: 4, payments, groups, archives, currentGroupId, currentGroupName}
}

export const archivePayments = (
  payments: Payment[],
  groupId: string,
  target: ReimbursementTarget | undefined,
  now: string,
  batchId: string,
) => {
  const targetKey = target?.trim() || ''
  const selected = payments.filter(payment =>
    payment.kind === 'advance' &&
    !payment.archivedAt &&
    payment.groupId === groupId &&
    (payment.reimbursementTarget?.trim() || '') === targetKey
  )
  const paymentIds = selected.map(payment => payment.id)
  const idSet = new Set(paymentIds)
  return {
    payments: payments.map(payment => idSet.has(payment.id)
      ? {...payment, archiveBatchId: batchId, archivedAt: now, updatedAt: now}
      : payment),
    archive: {
      id: batchId,
      groupId,
      reimbursementTarget: target,
      paymentIds,
      totalAmount: selected.reduce((total, payment) => total + payment.amount, 0),
      archivedAt: now,
    } satisfies ArchiveBatch,
  }
}

export const restoreArchivedPayments = (payments: Payment[], paymentIds: string[], now: string) => {
  const ids = new Set(paymentIds)
  return payments.map(payment => ids.has(payment.id)
    ? {...payment, archiveBatchId: undefined, archivedAt: undefined, updatedAt: now}
    : payment)
}

export const permanentlyDeleteArchive = (
  payments: Payment[],
  archives: ArchiveBatch[],
  archiveId: string,
  paymentIds: string[],
) => {
  const ids = new Set(paymentIds)
  return {
    payments: payments.filter(payment => !ids.has(payment.id)),
    archives: archives.filter(archive => archive.id !== archiveId),
  }
}
