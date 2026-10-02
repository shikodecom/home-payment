import {FormEvent, useEffect, useMemo, useRef, useState} from 'react'
import {
  appendQuickMemo,
  archivePayments,
  billingChoiceFor,
  billingValues,
  combinePaidAt,
  migrateStoredData,
  outstandingTotal,
  paymentTarget,
  permanentlyDeleteArchive,
  registrationGroupName,
  restoreArchivedPayments,
  SELF_TARGET,
  splitPaidAt,
  totalsByGroup,
  UNCLASSIFIED_GROUP_NAME,
  UNSET_TARGET,
} from './logic'
import type {ArchiveBatch, AuthState, BillingChoice, Payment, PaymentGroup, StoredData, SyncInfo} from './types'
import {
  CloudPaymentRepository,
  cancelPendingLogin,
  fetchAuthWithResume,
  guestImportWasHandled,
  loadGuestData,
  LocalPaymentRepository,
  loginUrl,
  logout,
  markGuestImportHandled,
} from './data/repository'
import type {PaymentRepository} from './data/repository'
import {paymentCsv, paymentCsvFileName} from './csv'

const quickMemos = ['交通費', '食事代', 'お土産', '入場料', '風呂', '自販機']
const lineOfficialAccountUrl = 'https://lin.ee/uKE3v95'
const yen = new Intl.NumberFormat('ja-JP', {style: 'currency', currency: 'JPY', maximumFractionDigits: 0})
const dateText = (iso: string) => new Intl.DateTimeFormat('ja-JP', {year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'}).format(new Date(iso))
const monthText = (iso: string) => new Intl.DateTimeFormat('ja-JP', {year: 'numeric', month: 'long'}).format(new Date(iso))
const dayText = (iso: string) => new Intl.DateTimeFormat('ja-JP', {year: 'numeric', month: 'long', day: 'numeric'}).format(new Date(iso))
const timeText = (iso: string) => new Intl.DateTimeFormat('ja-JP', {hour: '2-digit', minute: '2-digit'}).format(new Date(iso))
const makeId = () => crypto.randomUUID()

type Draft = {
  amount: string
  memo: string
  billingChoice: BillingChoice
  customTarget: string
  paidDate: string
  paidTime: string
  oneOff: boolean
  oneOffGroupName: string
}
const blankDraft = (): Draft => ({
  amount: '',
  memo: '',
  billingChoice: 'household',
  customTarget: '',
  ...splitPaidAt(new Date().toISOString()),
  oneOff: false,
  oneOffGroupName: '',
})

const resolveGroup = (name: string, groups: PaymentGroup[], now: string) => {
  const resolvedName = name.trim() || UNCLASSIFIED_GROUP_NAME
  const existing = groups.find(group => group.name === resolvedName)
  if (existing) return {group: existing, groups}
  const group: PaymentGroup = {id: makeId(), name: resolvedName, createdAt: now, updatedAt: now}
  return {group, groups: [...groups, group]}
}

export default function App() {
  const [data, setData] = useState<StoredData>(() => migrateStoredData({}))
  const [auth, setAuth] = useState<AuthState>({status: 'checking', authenticated: false, storageMode: 'local'})
  const [authRetry, setAuthRetry] = useState(0)
  const [syncInfo, setSyncInfo] = useState<SyncInfo>({state: 'synced', pendingCount: 0})
  const [importGuest, setImportGuest] = useState<StoredData | null>(null)
  const [accountOpen, setAccountOpen] = useState(false)
  const [manualSyncing, setManualSyncing] = useState(false)
  const [resolvingSync, setResolvingSync] = useState(false)
  const [draft, setDraft] = useState<Draft>(blankDraft)
  const [editing, setEditing] = useState<string | null>(null)
  const [editDraft, setEditDraft] = useState<Draft | null>(null)
  const [editGroupName, setEditGroupName] = useState('')
  const [targetFilter, setTargetFilter] = useState('all')
  const [notice, setNotice] = useState('')
  const [inlineMemos, setInlineMemos] = useState<Record<string, string>>({})
  const [view, setView] = useState<'records' | 'archive'>('records')
  const [handling, setHandling] = useState<{groupId: string; target?: string; payments: Payment[]} | null>(null)
  const [deleting, setDeleting] = useState<ArchiveBatch | null>(null)
  const amountRef = useRef<HTMLInputElement>(null)
  const memoRef = useRef<HTMLInputElement>(null)
  const repositoryRef = useRef<PaymentRepository | null>(null)
  const storageReadyRef = useRef(false)
  const unsubscribeRef = useRef<(() => void) | null>(null)

  useEffect(() => {
    let active = true
    const initialize = async () => {
      storageReadyRef.current = false
      setAuth({status: 'checking', authenticated: false, storageMode: 'local'})
      const nextAuth = await fetchAuthWithResume()
      if (!active) return
      if (nextAuth.status === 'unavailable' || nextAuth.pendingResume) {
        setAuth(nextAuth)
        return
      }
      const repository: PaymentRepository = nextAuth.authenticated && nextAuth.user && nextAuth.csrfToken
        ? new CloudPaymentRepository(nextAuth.user.id, nextAuth.csrfToken)
        : new LocalPaymentRepository()
      try {
        unsubscribeRef.current?.()
        repositoryRef.current?.dispose()
        repositoryRef.current = repository
        unsubscribeRef.current = repository.subscribe(info => active && setSyncInfo(info))
        const loaded = await repository.load()
        if (!active) return
        setData(loaded)
        setAuth(nextAuth)
        storageReadyRef.current = true
        if (nextAuth.authenticated && nextAuth.user && !guestImportWasHandled(nextAuth.user.id)) {
          const guest = await loadGuestData()
          if (guest.payments.length) setImportGuest(guest)
        }
      } catch (error) {
        if (active) {
          setAuth({status: 'unavailable', authenticated: false, storageMode: 'local'})
          setNotice(error instanceof Error ? error.message : 'クラウドへ接続できません')
        }
      }
      const loginError = new URLSearchParams(location.search).get('login_error')
      if (loginError) {
        setNotice(loginError)
        history.replaceState(null, '', location.pathname)
      }
    }
    void initialize()
    return () => {
      active = false
      unsubscribeRef.current?.()
      repositoryRef.current?.dispose()
    }
  }, [authRetry])
  useEffect(() => {
    const retry = () => {
      if (document.visibilityState === 'visible' && (auth.status === 'unavailable' || auth.pendingResume)) {
        setAuthRetry(value => value + 1)
      }
    }
    document.addEventListener('visibilitychange', retry)
    window.addEventListener('pageshow', retry)
    window.addEventListener('online', retry)
    return () => {
      document.removeEventListener('visibilitychange', retry)
      window.removeEventListener('pageshow', retry)
      window.removeEventListener('online', retry)
    }
  }, [auth.status, auth.pendingResume])
  useEffect(() => {
    if (storageReadyRef.current) repositoryRef.current?.save(data)
  }, [data])
  useEffect(() => amountRef.current?.focus(), [])
  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(() => setNotice(''), 2600)
    return () => clearTimeout(timer)
  }, [notice])

  const groupsById = useMemo(() => new Map(data.groups.map(group => [group.id, group])), [data.groups])
  const activePayments = data.payments.filter(payment => !payment.archivedAt)
  const outstanding = outstandingTotal(data.payments)
  const groupTotals = totalsByGroup(data.payments, data.groups)
  const filterTargets = useMemo(() => {
    const targets = new Set(activePayments.map(paymentTarget))
    const order = ['家計', SELF_TARGET, UNSET_TARGET]
    return [...targets].sort((a, b) => {
      const ai = order.indexOf(a)
      const bi = order.indexOf(b)
      if (ai >= 0 || bi >= 0) return (ai < 0 ? order.length : ai) - (bi < 0 ? order.length : bi)
      return a.localeCompare(b, 'ja')
    })
  }, [activePayments])
  const filtered = useMemo(() => activePayments
    .filter(payment => targetFilter === 'all' || paymentTarget(payment) === targetFilter)
    .sort((a, b) => new Date(b.paidAt).getTime() - new Date(a.paidAt).getTime()), [activePayments, targetFilter])

  const pendingSets = useMemo(() => {
    const map = new Map<string, {groupId: string; target?: string; payments: Payment[]}>()
    data.payments.filter(payment => payment.kind === 'advance' && !payment.archivedAt).forEach(payment => {
      const target = payment.reimbursementTarget?.trim() || ''
      const key = `${payment.groupId}\u0000${target}`
      const item = map.get(key) || {groupId: payment.groupId, target: target || undefined, payments: []}
      item.payments.push(payment)
      map.set(key, item)
    })
    return [...map.values()].sort((a, b) => {
      const groupCompare = (groupsById.get(a.groupId)?.name || '').localeCompare(groupsById.get(b.groupId)?.name || '', 'ja')
      return groupCompare || (a.target || UNSET_TARGET).localeCompare(b.target || UNSET_TARGET, 'ja')
    })
  }, [data.payments, groupsById])

  const archivesByMonth = useMemo(() => {
    const map = new Map<string, ArchiveBatch[]>()
    data.archives.filter(archive => !archive.restoredAt).sort((a, b) => b.archivedAt.localeCompare(a.archivedAt)).forEach(archive => {
      const month = monthText(archive.archivedAt)
      map.set(month, [...(map.get(month) || []), archive])
    })
    return [...map.entries()]
  }, [data.archives])

  const field = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft(current => ({...current, [key]: value}))
  const changeMemo = (value: string) => {
    const quickOnly = quickMemos.includes(draft.memo)
    const addedDirectly = value.startsWith(draft.memo) && value.length > draft.memo.length
    const addition = value.slice(draft.memo.length)
    field('memo', quickOnly && addedDirectly && !addition.startsWith('・') ? `${draft.memo}・${addition}` : value)
  }

  const submit = (event: FormEvent) => {
    event.preventDefault()
    const amount = Number(draft.amount)
    if (!Number.isInteger(amount) || amount <= 0) {
      setNotice('1円以上の金額を入力してください')
      amountRef.current?.focus()
      return
    }
    if (draft.billingChoice === 'other' && !draft.customTarget.trim()) {
      setNotice('請求先の名前を入力してください')
      return
    }
    if (draft.oneOff && !draft.oneOffGroupName.trim()) {
      setNotice('今回だけのまとまりを入力してください')
      return
    }
    const now = new Date().toISOString()
    const resolved = resolveGroup(registrationGroupName(data.currentGroupName, draft.oneOff, draft.oneOffGroupName), data.groups, now)
    const billing = billingValues(draft.billingChoice, draft.customTarget)
    const item: Payment = {
      id: makeId(),
      groupId: resolved.group.id,
      amount,
      memo: draft.memo.trim(),
      ...billing,
      isOneOffGroup: draft.oneOff,
      paidAt: combinePaidAt(draft.paidDate, draft.paidTime),
      createdAt: now,
      updatedAt: now,
    }
    setData(current => ({
      ...current,
      groups: resolved.groups,
      currentGroupId: draft.oneOff ? current.currentGroupId : resolved.group.id,
      payments: [item, ...current.payments],
    }))
    setDraft(blankDraft())
    setNotice('記録しました')
    requestAnimationFrame(() => amountRef.current?.focus())
  }

  const beginEdit = (payment: Payment) => {
    const choice = billingChoiceFor(payment)
    setEditing(payment.id)
    setEditGroupName(groupsById.get(payment.groupId)?.name || UNCLASSIFIED_GROUP_NAME)
    setEditDraft({
      amount: String(payment.amount),
      memo: payment.memo,
      billingChoice: choice,
      customTarget: choice === 'other' ? payment.reimbursementTarget || '' : '',
      ...splitPaidAt(payment.paidAt),
      oneOff: Boolean(payment.isOneOffGroup),
      oneOffGroupName: '',
    })
  }

  const saveEdit = (id: string) => {
    if (!editDraft) return
    const amount = Number(editDraft.amount)
    if (!Number.isInteger(amount) || amount <= 0) {
      setNotice('1円以上の金額を入力してください')
      return
    }
    if (editDraft.billingChoice === 'other' && !editDraft.customTarget.trim()) {
      setNotice('請求先の名前を入力してください')
      return
    }
    const now = new Date().toISOString()
    setData(current => {
      const resolved = resolveGroup(editGroupName, current.groups, now)
      return {
        ...current,
        groups: resolved.groups,
        payments: current.payments.map(payment => payment.id === id ? {
          ...payment,
          groupId: resolved.group.id,
          amount,
          memo: editDraft.memo.trim(),
          ...billingValues(editDraft.billingChoice, editDraft.customTarget),
          paidAt: combinePaidAt(editDraft.paidDate, editDraft.paidTime),
          updatedAt: now,
        } : payment),
      }
    })
    setEditing(null)
    setEditDraft(null)
    setNotice('変更を保存しました')
  }

  const saveInlineMemo = (id: string) => {
    const memo = (inlineMemos[id] || '').trim()
    if (!memo) {
      setNotice('内容を入力してください')
      return
    }
    const now = new Date().toISOString()
    setData(current => ({...current, payments: current.payments.map(payment => payment.id === id ? {...payment, memo, updatedAt: now} : payment)}))
    setInlineMemos(values => ({...values, [id]: ''}))
    setNotice('内容を保存しました')
  }

  const remove = (id: string) => {
    if (!window.confirm('この記録を削除しますか？')) return
    setData(current => ({...current, payments: current.payments.filter(payment => payment.id !== id)}))
    setNotice('削除しました')
  }

  const markHandled = (groupId: string, target: string | undefined, payments: Payment[]) => {
    setHandling({groupId, target, payments})
  }

  const confirmHandled = () => {
    if (!handling) return
    const now = new Date().toISOString()
    const result = archivePayments(data.payments, handling.groupId, handling.target, now, makeId())
    setData(current => ({...current, payments: result.payments, archives: [...current.archives, result.archive]}))
    setHandling(null)
    setNotice('処理済みにしてアーカイブしました')
  }

  const restoreArchive = (archive: ArchiveBatch) => {
    const groupName = groupsById.get(archive.groupId)?.name || UNCLASSIFIED_GROUP_NAME
    if (!window.confirm(`${groupName}の記録を未処理に戻しますか？`)) return
    const now = new Date().toISOString()
    setData(current => ({
      ...current,
      payments: restoreArchivedPayments(current.payments, archive.paymentIds, now),
      archives: current.archives.map(item => item.id === archive.id ? {...item, restoredAt: now} : item),
    }))
    setNotice('未処理に戻しました')
  }

  const confirmDeleteArchive = () => {
    if (!deleting) return
    setData(current => {
      const deleted = permanentlyDeleteArchive(current.payments, current.archives, deleting.id, deleting.paymentIds)
      return {...current, ...deleted}
    })
    setDeleting(null)
    setNotice('アーカイブを完全に削除しました')
  }

  const logoutToGuest = async () => {
    if (!auth.csrfToken) return
    try {
      await logout(auth.csrfToken)
      storageReadyRef.current = false
      unsubscribeRef.current?.()
      repositoryRef.current?.dispose()
      const repository = new LocalPaymentRepository()
      repositoryRef.current = repository
      unsubscribeRef.current = repository.subscribe(setSyncInfo)
      const guest = await repository.load()
      setData(guest)
      setAuth({status: 'unauthenticated', authenticated: false, storageMode: 'local'})
      storageReadyRef.current = true
      setAccountOpen(false)
      setNotice('この端末への保存に戻りました')
    } catch {
      setNotice('ログアウトできませんでした')
    }
  }

  const copyGuestToCloud = async () => {
    if (!importGuest || !auth.user) return
    try {
      await repositoryRef.current?.importGuest(importGuest)
      setImportGuest(null)
      const loaded = await repositoryRef.current?.load()
      if (loaded) setData(loaded)
      setNotice('端末のデータをクラウドへコピーしました')
    } catch {
      setNotice('クラウドへのコピーに失敗しました。データは端末内に残っています')
    }
  }

  const syncFromCloud = async () => {
    if (!auth.authenticated || manualSyncing) return
    setManualSyncing(true)
    try {
      const loaded = await repositoryRef.current?.refresh()
      if (loaded) setData(loaded)
      setNotice('クラウドと同期しました')
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '同期できませんでした')
    } finally {
      setManualSyncing(false)
    }
  }

  const resolveSync = async (choice: 'server' | 'local') => {
    const message = choice === 'server'
      ? '競合した変更と、それに続く関連する変更を取り消して、サーバーの内容を使いますか？取り消す変更はこの端末にバックアップします。'
      : '別の端末の変更を、この端末の編集内容で上書きしますか？'
    if (!window.confirm(message)) return
    setResolvingSync(true)
    try {
      const loaded = await repositoryRef.current?.resolveConflict?.(choice)
      if (loaded) setData(loaded)
      setNotice(choice === 'server' ? 'サーバーの内容を使いました。関連のない変更は引き続き同期します' : 'この端末の編集内容で保存を再試行しました')
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '変更の確認に失敗しました')
    } finally { setResolvingSync(false) }
  }

  const exportCsv = () => {
    const blob = new Blob([paymentCsv(data)], {type: 'text/csv;charset=utf-8'})
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = paymentCsvFileName()
    document.body.appendChild(link)
    link.click()
    link.remove()
    window.setTimeout(() => URL.revokeObjectURL(url), 1000)
    setNotice(`${data.payments.length}件をCSVに保存しました`)
  }

  const exportBackup = () => {
    const backup = repositoryRef.current?.exportBackup?.()
    if (!backup) return
    const url = URL.createObjectURL(new Blob([backup], {type: 'application/json'}))
    const link = document.createElement('a')
    link.href = url
    link.download = `payment-backup-${new Date().toISOString().slice(0, 10)}.json`
    link.click()
    window.setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  const billingFields = (value: Draft, change: (next: Partial<Draft>) => void, allowUnset = false) => (
    <fieldset className="billing-fields">
      <legend>請求先</legend>
      <div className="billing-options">
        {([['household', '家計'], ['self', '自分'], ['other', 'その他']] as const).map(([choice, label]) =>
          <button type="button" className={value.billingChoice === choice ? 'selected' : ''} key={choice} onClick={() => change({billingChoice: choice, customTarget: choice === 'other' ? value.customTarget : ''})}>{label}</button>)}
        {allowUnset && value.billingChoice === 'unset' && <button type="button" className="selected">未設定</button>}
      </div>
      {value.billingChoice === 'other' && <label>請求先の名前<input value={value.customTarget} onChange={event => change({customTarget: event.target.value})} placeholder="会社、親など"/></label>}
    </fieldset>
  )

  const printTotal = filtered.reduce((total, payment) => total + payment.amount, 0)
  if (resolvingSync) return <main><section className="panel" role="status"><h2>変更を確認しています…</h2><p>この端末のデータを保持して同期しています。</p></section></main>
  if (auth.status === 'checking' || auth.status === 'unavailable' || auth.pendingResume) {
    return <main><header className="hero"><div><p className="eyebrow">PAYMENT NOTE</p><h1>家計の支払めも</h1></div></header>
      <section className="panel auth-message" role="status">
        <h2>{auth.status === 'checking' ? 'ログイン状態を確認中…' : auth.pendingResume ? 'LINEログインの完了を待っています' : '認証状態を確認できません'}</h2>
        {auth.status !== 'checking' && <><p>{notice || '通信を確認して再試行してください。'}</p><button className="primary" onClick={() => setAuthRetry(value => value + 1)}>再試行</button>
          {auth.pendingResume && <button onClick={() => { cancelPendingLogin(); setAuthRetry(value => value + 1) }}>ログインを取り消して戻る</button>}</>}
      </section></main>
  }
  return <>
    <main>
      <header className="hero">
        <div><p className="eyebrow">PAYMENT NOTE</p><h1>家計の支払めも</h1><p className="tagline">払ったときに、すぐ残す。</p></div>
        <div className="hero-mark" aria-hidden="true">✓</div>
      </header>
      <section className="storage-bar no-print">
        {auth.authenticated && auth.user ? <>
          <button className="account-button" onClick={() => setAccountOpen(value => !value)}>
            {auth.user.profileImageUrl ? <img src={auth.user.profileImageUrl} alt=""/> : <span className="profile-placeholder" aria-hidden="true">✓</span>}
            <span><small>クラウド保存</small><b>{auth.user.displayName}</b></span>
          </button>
          <span className={`sync-status ${syncInfo.state}`}>
            {syncInfo.state === 'synced' ? 'クラウド保存済み' :
              syncInfo.state === 'syncing' ? '同期中' :
                syncInfo.pendingCount ? `${syncInfo.pendingCount}件同期待ち` : '同期できません'}
          </span>
          <button className="sync-button" disabled={manualSyncing || syncInfo.state === 'syncing'} onClick={() => void syncFromCloud()}>
            {manualSyncing ? '同期中…' : '今すぐ同期'}
          </button>
          {accountOpen && <div className="account-menu">
            <b>{auth.user.displayName}</b>
            <p>{syncInfo.message || (syncInfo.pendingCount ? `${syncInfo.pendingCount}件のデータが同期待ちです` : 'クラウドへ保存されています')}</p>
            <button onClick={exportBackup}>端末データのバックアップを保存</button>
            {syncInfo.state === 'failed' && !syncInfo.blocked && <button onClick={() => setAuthRetry(value => value + 1)}>ログイン状態を確認し直す</button>}
            <button className="logout-button" onClick={() => void logoutToGuest()}>ログアウト</button>
          </div>}
        </> : <>
          <div><small>ゲストモード</small><b>この端末に保存中</b></div>
          <a className="line-login-button" href="/tools/home-payment/api/auth/line/start"
            onClick={event => {
              event.preventDefault()
              location.assign(loginUrl())
            }}>LINEでログイン</a>
        </>}
      </section>
      {syncInfo.blocked && <section className="panel no-print" role="alert">
        <h2>保存する変更の確認が必要です</h2>
        <p>{syncInfo.blocked.message} この端末の未送信データは保持しています。</p>
        {syncInfo.blocked.localMemo !== undefined && <p>この端末のメモ：{syncInfo.blocked.localMemo || '（なし）'}</p>}
        {syncInfo.blocked.serverMemo !== undefined && <p>サーバーのメモ：{syncInfo.blocked.serverMemo || '（なし）'}</p>}
        <button onClick={() => void resolveSync('server')}>競合した変更を取り消してサーバーの内容を使う</button>
        {syncInfo.blocked.canReapply && <button onClick={() => void resolveSync('local')}>この端末の編集内容を保存する</button>}
      </section>}
      {auth.user?.lineFriendAdded !== true &&
        <a className="line-friend-card no-print" href={lineOfficialAccountUrl} target="_blank" rel="noopener noreferrer">
          <span><small>LINE公式アカウント</small><b>旅と思考のデザイン</b></span>
          <strong>友だち追加</strong>
        </a>}

      <section className="balance" aria-live="polite">
        <div><span>立替中</span><strong>{yen.format(outstanding)}</strong></div>
        {groupTotals.length ? <><p>あとで処理する支払いの合計です</p><ul>{groupTotals.map(([group, total]) => <li key={group}><span>{group}</span><b>{yen.format(total)}</b></li>)}</ul></> : <p>あとで処理する支払いはありません</p>}
      </section>

      {view === 'records' ? <>
        <section className="panel entry">
          <div className="section-heading"><span>01</span><div><h2>支払いを記録</h2><p>金額と内容ですぐ記録できます</p></div></div>
          <form onSubmit={submit}>
            <label className="amount-field">金額（必須）
              <span className="amount-input"><input ref={amountRef} inputMode="numeric" pattern="[0-9]*" autoComplete="off" value={draft.amount} onChange={event => field('amount', event.target.value)} placeholder="0"/><b>円</b></span>
              <small>半角数字で入力</small>
            </label>
            <label>内容・メモ <em>あとから入力できます</em>
              <input ref={memoRef} value={draft.memo} onChange={event => changeMemo(event.target.value)} placeholder="例：食事代・マクドナルド"/>
            </label>
            <div className="quick-memos" aria-label="内容のクイック入力">
              {quickMemos.map(item => <button type="button" key={item} onClick={() => {
                field('memo', appendQuickMemo(draft.memo, item))
                requestAnimationFrame(() => {
                  memoRef.current?.focus()
                  const length = memoRef.current?.value.length || 0
                  memoRef.current?.setSelectionRange(length, length)
                })
              }}>{item}</button>)}
            </div>

            <button className="primary" type="submit">この支払いを記録する</button>
            <section className="other-settings" aria-labelledby="options-title">
              <h3 id="options-title">オプション</h3>
              <div className="settings-content">
                {billingFields(draft, next => setDraft(current => ({...current, ...next})))}
                <div className="date-time-fields">
                  <label>支払日<span className="date-time-input"><input type="date" value={draft.paidDate} onChange={event => field('paidDate', event.target.value)} required/></span></label>
                  <label>支払時刻<span className="date-time-input"><input type="time" value={draft.paidTime} onChange={event => field('paidTime', event.target.value)} required/></span></label>
                </div>
                <label>現在のまとまり<input value={data.currentGroupName} onChange={event => setData(current => ({...current, currentGroupName: event.target.value}))} placeholder={UNCLASSIFIED_GROUP_NAME}/></label>
                <label className="one-off-toggle"><input type="checkbox" checked={draft.oneOff} onChange={event => field('oneOff', event.target.checked)}/><span>この支払いだけ別のまとまりにする</span></label>
                {draft.oneOff && <div className="one-off-fields">
                  <label>今回だけのまとまり<input value={draft.oneOffGroupName} onChange={event => field('oneOffGroupName', event.target.value)} placeholder="例：新幹線予約"/></label>
                  <small>登録後も現在のまとまりは「{data.currentGroupName || UNCLASSIFIED_GROUP_NAME}」のままです。</small>
                </div>}
              </div>
            </section>
          </form>
        </section>

        <section className="filters no-print">
          <div className="section-heading"><span>02</span><div><h2>絞り込み</h2><p>{filtered.length}件を表示中</p></div></div>
          <label>請求先<select value={targetFilter} onChange={event => setTargetFilter(event.target.value)}><option value="all">すべて</option>{filterTargets.map(target => <option value={target} key={target}>{target}</option>)}</select></label>
          {targetFilter !== 'all' && <button className="text-button" onClick={() => setTargetFilter('all')}>条件をリセット</button>}
        </section>

        <section className="records">
          <div className="section-heading"><span>03</span><div><h2>支払記録</h2><p>未対応と自分の支払いを時系列で表示</p></div></div>
          {filtered.length === 0 ? <div className="empty"><b>表示する記録はありません。</b><p>{activePayments.length ? '絞り込み条件を変えてみてください。' : '支払った金額を記録してみましょう。'}</p></div> : <div className="timeline">{filtered.map((payment, index) => {
            const groupName = groupsById.get(payment.groupId)?.name || UNCLASSIFIED_GROUP_NAME
            const previous = filtered[index - 1]
            const showGroupHeading = !payment.isOneOffGroup && (!previous || previous.groupId !== payment.groupId || previous.isOneOffGroup)
            return <div className="timeline-item" key={payment.id}>
              {payment.isOneOffGroup ? <h3 className="cut-in-label">別件：{groupName}</h3> : showGroupHeading && <h3 className="timeline-group">{groupName}</h3>}
              <article className={`record ${payment.isOneOffGroup ? 'cut-in' : ''}`}>
                {editing === payment.id && editDraft ? <div className="edit-form">
                  <h3>「{payment.memo || '内容未入力'}」を編集</h3>
                  <label>金額<input inputMode="numeric" value={editDraft.amount} onChange={event => setEditDraft({...editDraft, amount: event.target.value})}/></label>
                  <label>内容・メモ<input autoFocus value={editDraft.memo} onChange={event => setEditDraft({...editDraft, memo: event.target.value})}/></label>
                  {billingFields(editDraft, next => setEditDraft(current => current ? {...current, ...next} : current), true)}
                  <label>まとまり<input value={editGroupName} onChange={event => setEditGroupName(event.target.value)} placeholder={UNCLASSIFIED_GROUP_NAME}/></label>
                  <div className="date-time-fields"><label>支払日<span className="date-time-input"><input type="date" value={editDraft.paidDate} onChange={event => setEditDraft({...editDraft, paidDate: event.target.value})}/></span></label><label>支払時刻<span className="date-time-input"><input type="time" value={editDraft.paidTime} onChange={event => setEditDraft({...editDraft, paidTime: event.target.value})}/></span></label></div>
                  <div className="edit-actions"><button className="primary small" onClick={() => saveEdit(payment.id)}>保存</button><button className="secondary" onClick={() => {setEditing(null); setEditDraft(null)}}>キャンセル</button></div>
                </div> : <>
                  <div className="record-top"><div><time>{timeText(payment.paidAt)} <span>{dayText(payment.paidAt)}</span></time>{payment.memo ? <h3>{payment.memo}</h3> : <div className="inline-memo"><h3 className="missing">内容未入力</h3><form onSubmit={event => {event.preventDefault(); saveInlineMemo(payment.id)}}><input aria-label="内容・メモ" value={inlineMemos[payment.id] || ''} onChange={event => setInlineMemos(values => ({...values, [payment.id]: event.target.value}))} placeholder="例：交通費"/><button type="submit">保存</button></form></div>}</div><strong>{yen.format(payment.amount)}</strong></div>
                  <div className="badges">{payment.kind === 'personal' ? <span>自分の支払い</span> : <><span>未対応</span><span className={payment.reimbursementTarget ? 'target' : 'target unset'}>請求先：{payment.reimbursementTarget || '未設定'}</span></>}</div>
                  <div className="record-actions no-print"><button className="secondary" onClick={() => beginEdit(payment)}>編集</button><button className="delete" onClick={() => remove(payment.id)}>削除</button></div>
                </>}
              </article>
            </div>
          })}</div>}
        </section>

        <section className="pending panel">
          <div className="section-heading"><span>04</span><div><h2>処理する立替</h2><p>転記や申請が終わったものを、まとまり・請求先ごとに片づけます</p></div></div>
          {pendingSets.length === 0 ? <div className="compact-empty">対応が必要な立替はありません。</div> : <div className="pending-list">{pendingSets.map(set => {
            const total = set.payments.reduce((sum, payment) => sum + payment.amount, 0)
            const targetName = set.target || UNSET_TARGET
            return <article className="pending-card" key={`${set.groupId}-${targetName}`}>
              <p className="group-name">{groupsById.get(set.groupId)?.name || UNCLASSIFIED_GROUP_NAME}</p>
              <h3>{targetName}への請求</h3>
              <p className="pending-summary"><b>{set.payments.length}件</b><strong>{yen.format(total)}</strong></p>
              <ul>{set.payments.sort((a, b) => a.paidAt.localeCompare(b.paidAt)).map(payment => <li key={payment.id}><span>{payment.memo || '内容未入力'}</span><b>{yen.format(payment.amount)}</b></li>)}</ul>
              <button className="handle-button" onClick={() => markHandled(set.groupId, set.target, set.payments)}>処理を終える</button>
            </article>
          })}</div>}
        </section>
      </> : <section className="archive-view">
        <div className="section-heading"><span>A</span><div><h2>アーカイブ</h2><p>処理済みの記録</p></div></div>
        {archivesByMonth.length === 0 ? <div className="empty"><b>アーカイブはまだありません。</b><p>処理済みにした記録がここに表示されます。</p></div> : archivesByMonth.map(([month, archives]) => <section className="archive-month" key={month}><h3>{month}</h3><div className="archive-list">{archives.map(archive => {
          const payments = archive.paymentIds.map(id => data.payments.find(payment => payment.id === id)).filter((payment): payment is Payment => Boolean(payment))
          return <article className="archive-card" key={archive.id}>
            <h4>{groupsById.get(archive.groupId)?.name || UNCLASSIFIED_GROUP_NAME} × {archive.reimbursementTarget || UNSET_TARGET}</h4>
            <p><b>{archive.paymentIds.length}件　{yen.format(archive.totalAmount)}</b></p>
            <p>{dayText(archive.archivedAt)}に処理済み</p>
            <details><summary>記録を見る</summary><ul>{payments.map(payment => <li key={payment.id}><span>{payment.memo || '内容未入力'}</span><b>{yen.format(payment.amount)}</b></li>)}</ul></details>
            <div className="archive-actions"><button className="restore-button" onClick={() => restoreArchive(archive)}>未処理に戻す</button><button className="archive-delete-button" onClick={() => setDeleting(archive)}>削除</button></div>
          </article>
        })}</div></section>)}
      </section>}
      <nav className="view-tabs bottom-tabs no-print" aria-label="表示切り替え">
        <button className={view === 'records' ? 'active' : ''} onClick={() => setView('records')}>未対応・支払記録</button>
        <button className={view === 'archive' ? 'active' : ''} onClick={() => setView('archive')}>アーカイブを見る</button>
      </nav>
      <div className="output-actions no-print">
        <button className="csv-button" onClick={exportCsv}>全記録をCSVで保存</button>
        <button className="print-button" onClick={() => window.print()}>現在の一覧を印刷する</button>
      </div>
    </main>

    <section className="print-sheet">
      <header><h1>家計の支払めも</h1><p>印刷日時：{dateText(new Date().toISOString())}</p><div><span>対象件数 <b>{filtered.length}件</b></span><span>合計金額 <b>{yen.format(printTotal)}</b></span><span>立替中 <b>{yen.format(outstanding)}</b></span></div></header>
      <table><thead><tr><th>日時</th><th>まとまり</th><th>内容</th><th>金額</th><th>状態</th><th>請求先</th></tr></thead><tbody>{filtered.map(payment => <tr key={payment.id}><td>{dateText(payment.paidAt)}</td><td>{groupsById.get(payment.groupId)?.name}</td><td>{payment.memo || '内容未入力'}</td><td>{yen.format(payment.amount)}</td><td>{payment.kind === 'advance' ? '未対応' : '自分の支払い'}</td><td>{payment.kind === 'advance' ? payment.reimbursementTarget || '未設定' : '自分'}</td></tr>)}</tbody></table>
    </section>
    {handling && <div className="dialog-backdrop" role="presentation" onMouseDown={event => {if (event.target === event.currentTarget) setHandling(null)}}>
      <section className="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="confirm-title">
        <h2 id="confirm-title">{groupsById.get(handling.groupId)?.name || UNCLASSIFIED_GROUP_NAME}の{handling.target || UNSET_TARGET}分</h2>
        <p><b>{handling.payments.length}件</b><strong>合計{yen.format(handling.payments.reduce((sum, payment) => sum + payment.amount, 0))}</strong></p>
        <p>{handling.target || UNSET_TARGET}への転記などの処理は終わりましたか？</p>
        <div><button className="secondary" onClick={() => setHandling(null)}>キャンセル</button><button className="primary small" autoFocus onClick={confirmHandled}>処理を終える</button></div>
      </section>
    </div>}
    {deleting && <div className="dialog-backdrop" role="presentation" onMouseDown={event => {if (event.target === event.currentTarget) setDeleting(null)}}>
      <section className="confirm-dialog danger-dialog" role="alertdialog" aria-modal="true" aria-labelledby="delete-title">
        <h2 id="delete-title">{groupsById.get(deleting.groupId)?.name || UNCLASSIFIED_GROUP_NAME}の{deleting.reimbursementTarget || UNSET_TARGET}分を削除しますか？</h2>
        <p><b>{deleting.paymentIds.length}件</b><strong>合計{yen.format(deleting.totalAmount)}</strong></p>
        <p>削除すると元に戻せません。</p>
        <div><button className="secondary" onClick={() => setDeleting(null)}>キャンセル</button><button className="danger-button" autoFocus onClick={confirmDeleteArchive}>完全に削除する</button></div>
      </section>
    </div>}
    {importGuest && auth.user && <div className="dialog-backdrop" role="presentation">
      <section className="confirm-dialog import-dialog" role="dialog" aria-modal="true" aria-labelledby="import-title">
        <h2 id="import-title">この端末に支払い記録があります</h2>
        <p><b>支払い記録：{importGuest.payments.length}件</b><strong>立替中：{yen.format(outstandingTotal(importGuest.payments))}</strong></p>
        <p>ゲストデータをクラウドへコピーしますか？ コピー後も端末内のデータは削除されません。</p>
        <div className="import-actions">
          <button className="secondary" onClick={() => {
            markGuestImportHandled(auth.user!.id)
            setImportGuest(null)
          }}>コピーせず始める</button>
          <button className="secondary" onClick={() => setImportGuest(null)}>あとで</button>
          <button className="primary small" autoFocus onClick={() => void copyGuestToCloud()}>クラウドへコピー</button>
        </div>
      </section>
    </div>}
    {notice && <div className="toast" role="status">{notice}</div>}
  </>
}
