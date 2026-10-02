// @vitest-environment jsdom
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {act} from 'react'
import {createRoot, type Root} from 'react-dom/client'
import App from './App'

let root: Root
let container: HTMLDivElement
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), {status})
const emptyState = {payments: [], archives: [], settings: {currentGroupName: '日常生活', defaultBillingTargetType: 'household'}}
const mount = async () => { await act(async () => { root.render(<App/>); await new Promise(resolve => setTimeout(resolve, 0)) }) }
const click = async (text: string) => {
  const button = [...container.querySelectorAll('button')].find(item => item.textContent === text)
  expect(button).toBeTruthy()
  await act(async () => { button!.click(); await new Promise(resolve => setTimeout(resolve, 0)) })
}
beforeEach(() => {
  localStorage.clear()
  history.replaceState(null, '', '/')
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 0 })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals() })

describe('認証と復帰待ちの画面', () => {
  it('一時的な認証障害ではゲスト操作を開始せず、再試行でクラウドへ復旧する', async () => {
    const guest = JSON.stringify({payments: [{id: 'legacy', amount: 500, memo: '保持する'}]})
    localStorage.setItem('paymentApp.guest.v4', guest)
    const fetchMock = vi.fn().mockResolvedValueOnce(json({}, 503)).mockResolvedValueOnce(json({authenticated: true, storageMode: 'cloud', user: {id: 'user', displayName: 'テスト'}, csrfToken: 'csrf'})).mockResolvedValueOnce(json(emptyState))
    vi.stubGlobal('fetch', fetchMock)
    await mount()
    expect(container.textContent).toContain('認証状態を確認できません')
    expect(container.textContent).not.toContain('LINEでログイン')
    expect(container.querySelector('form')).toBeNull()
    expect(localStorage.getItem('paymentApp.guest.v4')).toBe(guest)
    await click('再試行')
    expect(container.textContent).toContain('クラウド保存')
    expect(container.querySelector('form')).not.toBeNull()
  })

  it('OAuth取消で戻った場合は復帰待ちを解除して失敗理由と再ログインを表示する', async () => {
    localStorage.setItem('paymentApp.loginResume.v1', 'a'.repeat(43))
    history.replaceState(null, '', '/?login_error=' + encodeURIComponent('ログインを取り消しました'))
    const fetchMock = vi.fn().mockResolvedValue(json({authenticated: false, storageMode: 'local'}))
    vi.stubGlobal('fetch', fetchMock)
    await mount()
    expect(container.textContent).toContain('LINEでログイン')
    expect(container.textContent).toContain('ログインを取り消しました')
    expect(localStorage.getItem('paymentApp.loginResume.v1')).toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(location.search).toBe('')
  })

  it('正常な202待機ではトークンを保持し、利用者が待機を取り消せる', async () => {
    localStorage.setItem('paymentApp.loginResume.v1', 'b'.repeat(43))
    const fetchMock = vi.fn().mockResolvedValueOnce(json({authenticated: false, storageMode: 'local'})).mockResolvedValueOnce(json({}, 202)).mockResolvedValueOnce(json({authenticated: false, storageMode: 'local'}))
    vi.stubGlobal('fetch', fetchMock)
    await mount()
    expect(container.textContent).toContain('LINEログインの完了を待っています')
    expect(localStorage.getItem('paymentApp.loginResume.v1')).toBe('b'.repeat(43))
    await click('ログインを取り消して戻る')
    expect(container.textContent).toContain('LINEでログイン')
    expect(container.querySelector('form')).not.toBeNull()
    expect(localStorage.getItem('paymentApp.loginResume.v1')).toBeNull()
  })

  it('競合した端末データを画面に保持し、復旧操作を表示する', async () => {
    const id = '11111111-1111-4111-8111-111111111111'
    localStorage.setItem('paymentApp.cloud.user.cache.v1', JSON.stringify({version: 4, payments: [{id, groupId: 'group', amount: 500, memo: '未送信の編集', kind: 'advance', reimbursementTarget: '家計', paidAt: '2026-10-02T00:00:00Z', createdAt: '2026-10-02T00:00:00Z', updatedAt: '2026-10-02T00:00:00Z', version: 1}], groups: [{id: 'group', name: '日常生活'}], archives: [], currentGroupId: 'group', currentGroupName: '日常生活'}))
    localStorage.setItem('paymentApp.cloud.user.queue.v1', JSON.stringify([{id: crypto.randomUUID(), method: 'PATCH', path: `/payments/${id}`, paymentId: id, body: {memo: '未送信の編集', version: 1}, sent: true, failure: {status: 409, message: '別端末で変更', serverMemo: 'サーバーのメモ'}}]))
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({authenticated: true, storageMode: 'cloud', user: {id: 'user', displayName: 'テスト'}, csrfToken: 'csrf'})))
    await mount()
    expect(container.textContent).toContain('未送信の編集')
    expect(container.textContent).toContain('保存する変更の確認が必要です')
    expect(container.textContent).toContain('この端末の編集内容を保存する')
    expect(container.textContent).toContain('サーバーの内容を使う')
  })
})
