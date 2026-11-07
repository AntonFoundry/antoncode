// @vitest-environment jsdom
/** Session move dialogs retain identity and visible failures independently of row menus. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { WorkspaceId, WorkspaceSnapshot } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { GlobalStandardProps } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-resources/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { allowAllAccess, bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { en as commonEn } from '@deepseek-ai/dsh-client-locale/src/locales/en.ts'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import type {
  SessionMenuItemProps, SessionMoveDialogInjected, SessionMoveTarget,
} from '../src/client/contract/slots.ts'
import { MoveSessionMenuItem, SessionMoveDialog } from '../src/client/session-actions/MoveSession.tsx'
import { en, zh } from '../src/client/locales.ts'

afterEach(cleanup)
const sessionId = 'original-session' as SessionId
const wid = (id: string) => id as WorkspaceId
const t = makeTranslate(en, commonEn)
const tZh = makeTranslate(zh, commonZh)
const workspace = (id: string, member: boolean, title = id, path = `/projects/${id}`) => ({
  workspaceId: wid(id), title, path, sessionIds: member ? [sessionId] : [],
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
})
const snapshot: WorkspaceSnapshot = {
  items: [workspace('source', true), workspace('target', false)],
  worktrees: { byRepo: {}, prefs: {}, namesByWorkspaceId: {} },
  archivedSessionIds: [], pinnedSessionIds: [], phase: 'ready', state: 'idle', error: null,
}
const hook = <T,>(value: T) => <S,>(selector: (value: T) => S): S => selector(value)
const standard: GlobalStandardProps = {
  useSessions: hook({ ids: [sessionId], byId: {}, phase: 'ready', projectionsBySession: {} }),
  useSessionStatus: hook(new Map()), useSessionRetainInfo: () => undefined,
  usePanelInfo: hook({ activePanelId: null }),
  useResource: () => ({ status: 'none', value: undefined, failure: undefined, reload: () => {} }),
  useWorkspaces: hook(snapshot), ...allowAllAccess,
}
const menu = (): SessionMenuItemProps => ({
  ...standard, sessionId, displayTitle: 'Keep this session', t,
  useMenuOpenState: () => [true, vi.fn()], useShortcuts: hook([]),
})

function dialog(moveSession: SessionMoveDialogInjected['moveSession'] = vi.fn(async () => {}),
  options: Partial<GlobalStandardProps> = {}, translate = t) {
  const request = createSnapshotStore<SessionMoveTarget | null>(null)
  const settleSessionMove = vi.fn(() => { request.set(null) })
  render(<SessionMoveDialog {...standard} {...options} t={translate}
    useMoveRequest={bindSnapshotSelector(request)} settleSessionMove={settleSessionMove} moveSession={moveSession} />)
  const ask = (id = sessionId): void => {
    act(() => { request.set({ sessionId: id, displayTitle: 'Keep this session' }) })
  }
  const choose = (): void => { fireEvent.click(screen.getByRole('button', { name: translate('move.destination') })) }
  return { ask, choose, request, settleSessionMove, moveSession }
}

describe('Session move', () => {
  it('closes the menu before requesting the persistent dialog for its original row identity', () => {
    const close = vi.fn()
    const requestSessionMove = vi.fn()
    const props = menu()
    render(<MoveSessionMenuItem {...props} useMenuOpenState={() => [true, close]} requestSessionMove={requestSessionMove} />)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Move session…' }))
    expect(close).toHaveBeenCalledExactlyOnceWith(false)
    expect(requestSessionMove).toHaveBeenCalledExactlyOnceWith(sessionId, 'Keep this session')
    expect(close.mock.invocationCallOrder[0]).toBeLessThan(requestSessionMove.mock.invocationCallOrder[0]!)
  })

  it('does not render a move action without Session access', () => {
    const access = vi.fn(() => false)
    render(<MoveSessionMenuItem {...menu()} useSessionAccess={access} requestSessionMove={vi.fn()} />)
    expect(screen.queryByRole('menuitem')).toBeNull()
    expect(access).toHaveBeenCalledWith(sessionId, 'workspace/moveSession')
  })

  it.each([t, tZh])('moves the same ID to an existing Workspace and blocks dismissal until acceptance', async (translate) => {
    const pending = Promise.withResolvers<undefined>()
    const moveSession = vi.fn(() => pending.promise)
    const surface = dialog(moveSession, {}, translate)
    expect(screen.queryByRole('dialog')).toBeNull()
    surface.ask()
    expect(screen.getByRole('dialog', { name: translate('move.session.title') }).textContent).toContain('Keep this session')
    surface.choose()
    expect(screen.getByRole<HTMLButtonElement>('menuitem', { name: 'source' }).disabled).toBe(true)
    fireEvent.click(screen.getByRole('menuitem', { name: 'target' }))
    expect(moveSession).toHaveBeenCalledExactlyOnceWith(sessionId, wid('target'))
    expect(screen.getByRole('status').textContent).toBe(translate('move.pending'))
    expect(screen.queryByRole('menuitem')).toBeNull()
    fireEvent.keyDown(document, { key: 'Escape' })
    fireEvent.click(screen.getByRole('button', { name: translate('cancel') }))
    expect(surface.settleSessionMove).not.toHaveBeenCalled()
    await act(async () => { pending.resolve(undefined) })
    expect(surface.settleSessionMove).toHaveBeenCalledOnce()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('moves to Ungrouped using null and offers Workspaces for a synthetic Ungrouped source', async () => {
    const ungrouped = { ...snapshot, items: [workspace('target', false)] }
    const surface = dialog(undefined, { useWorkspaces: hook(ungrouped) })
    surface.ask()
    surface.choose()
    expect(screen.getByRole<HTMLButtonElement>('menuitem', { name: 'Ungrouped' }).disabled).toBe(true)
    fireEvent.click(screen.getByRole('menuitem', { name: 'target' }))
    await waitFor(() => { expect(surface.settleSessionMove).toHaveBeenCalledOnce() })
    expect(surface.moveSession).toHaveBeenCalledWith(sessionId, wid('target'))
    cleanup()
    const grouped = dialog()
    grouped.ask()
    grouped.choose()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Ungrouped' }))
    await waitFor(() => { expect(grouped.settleSessionMove).toHaveBeenCalledOnce() })
    expect(grouped.moveSession).toHaveBeenCalledExactlyOnceWith(sessionId, null)
  })

  it('shows only admitted destination Workspaces without requiring global access', () => {
    const useWorkspaceAccess = vi.fn((id: WorkspaceId) => id !== wid('target'))
    const surface = dialog(undefined, { useWorkspaceAccess, useRemoteAccess: () => false })
    surface.ask()
    surface.choose()
    expect(screen.queryByRole('menuitem', { name: 'target' })).toBeNull()
    expect(screen.getByRole('menuitem', { name: 'Ungrouped' })).toBeTruthy()
    expect(useWorkspaceAccess).toHaveBeenCalledWith(wid('target'), 'workspace/moveSession')
  })

  it('keeps a localized alert visible after menu unmount on failure and permits a later checked retry', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const moveSession = vi.fn<SessionMoveDialogInjected['moveSession']>()
      .mockRejectedValueOnce(new Error('internal carrier detail')).mockResolvedValueOnce(undefined)
    const surface = dialog(moveSession)
    surface.ask()
    surface.choose()
    fireEvent.click(screen.getByRole('menuitem', { name: 'target' }))
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe(t('move.failed')) })
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(screen.queryByRole('menuitem')).toBeNull()
    expect(surface.settleSessionMove).not.toHaveBeenCalled()
    surface.choose()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Ungrouped' }))
    await waitFor(() => { expect(surface.settleSessionMove).toHaveBeenCalledOnce() })
    expect(moveSession).toHaveBeenLastCalledWith(sessionId, null)
  })

  it('cancels without a mutation and starts a separate request with fresh local state', () => {
    const surface = dialog()
    surface.ask()
    surface.choose()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('menuitem')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(surface.settleSessionMove).toHaveBeenCalledOnce()
    expect(surface.moveSession).not.toHaveBeenCalled()
    surface.ask('different-session' as SessionId)
    expect(screen.queryByRole('menuitem')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(surface.settleSessionMove).toHaveBeenCalledTimes(2)
  })

  it('waits for the Workspace baseline and reacts to revoked Session access', () => {
    const workspaces = createSnapshotStore<WorkspaceSnapshot>({ ...snapshot, phase: 'pending' })
    const access = createSnapshotStore(true)
    const surface = dialog(undefined, {
      useWorkspaces: bindSnapshotSelector(workspaces),
      useSessionAccess: () => bindSnapshotSelector(access)(value => value),
    })
    surface.ask()
    expect(screen.getByRole('status').textContent).toBe(t('picker.loading'))
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Choose destination' }).disabled).toBe(true)
    act(() => { workspaces.set(snapshot) })
    surface.choose()
    expect(screen.getByRole('menuitem', { name: 'target' })).toBeTruthy()
    act(() => { access.set(false) })
    expect(screen.queryByRole('menuitem')).toBeNull()
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Choose destination' }).disabled).toBe(true)
  })

  it('disambiguates same-title Workspaces by trailing path and shows their complete paths', () => {
    const surface = dialog(undefined, { useWorkspaces: hook({ ...snapshot, items: [
      workspace('one', false, 'same', '/one/project'), workspace('two', false, 'same', '/two/project'),
    ] }) })
    surface.ask()
    surface.choose()
    expect(screen.getByRole('menuitem', { name: 'same one/project' }).textContent).toContain('one/project')
    expect(screen.getByTitle('/two/project')).toBeTruthy()
  })
})
