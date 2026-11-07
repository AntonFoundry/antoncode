/** Session move requests outlive the row menu; the overlay owns pending and failure state. */
import { useMemo, useState } from 'react'
import {
  Button, IconFolderCloseRegular, Menu, MenuItemButton, Modal,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import { workspaceDisplayTitle } from '@deepseek-ai/dsh-api-workspace-controller/default-workspace'
import type {
  MoveSessionInjected, SessionMenuItemProps, SessionMoveDialogProps, SessionMoveTarget,
} from '../contract/slots.ts'
import { distinguishingPathSuffixes } from '../path-suffix.ts'
import css from '../WorkspacePicker.module.css'

/**
 * Raise the move dialog without opening or replacing the Session.
 * @param props - row identity, access Hook, locale, and request callback.
 * @returns a menu action when Session move access is granted.
 */
export function MoveSessionMenuItem({
  sessionId, displayTitle, useMenuOpenState, useSessionAccess, requestSessionMove, t,
}: SessionMenuItemProps<MoveSessionInjected>) {
  const [, setMenuOpen] = useMenuOpenState()
  const allowed = useSessionAccess(sessionId, 'workspace/moveSession')
  if (!allowed) return null
  return (
    <MenuItemButton icon={<IconFolderCloseRegular />} onSelect={() => {
      setMenuOpen(false)
      requestSessionMove(sessionId, displayTitle)
    }}>
      {t('menu.moveSession')}
    </MenuItemButton>
  )
}

/**
 * Keep the requested Session's picker and any failure visible after its menu unmounts.
 * @param props - framework Hooks, pending request, mutation callback, and locale.
 * @returns the requested dialog, or nothing.
 */
export function SessionMoveDialog(props: SessionMoveDialogProps) {
  const request = props.useMoveRequest(value => value)
  if (request === null) return null
  return <MoveForm key={request.sessionId} {...props} request={request} />
}

/** Each Session request owns one pending operation; cancelling never issues a mutation. */
function MoveForm({
  request, useWorkspaces, useSessionAccess, useWorkspaceAccess, moveSession, settleSessionMove, t,
}: SessionMoveDialogProps & { request: SessionMoveTarget }) {
  const [picking, setPicking] = useState(false)
  const [moving, setMoving] = useState(false)
  const [failed, setFailed] = useState(false)
  const snapshot = useWorkspaces(value => value)
  const allowed = useSessionAccess(request.sessionId, 'workspace/moveSession')
  const current = snapshot.items.find(workspace => workspace.sessionIds.includes(request.sessionId))?.workspaceId ?? null
  const defaultTitle = t('workspace.defaultName')
  const listed = useMemo(() => {
    const rows = snapshot.items.map(workspace => ({
      id: workspace.workspaceId,
      title: workspaceDisplayTitle(workspace.title, defaultTitle),
      path: workspace.path,
    }))
    const suffixes = distinguishingPathSuffixes(rows)
    return rows.map(row => ({ ...row, suffix: suffixes.get(row.id) }))
  }, [snapshot.items, defaultTitle])
  const close = (): void => {
    if (!moving) settleSessionMove()
  }
  const move = (workspaceId: WorkspaceId | null): void => {
    if (moving || !allowed || current === workspaceId) return
    setPicking(false)
    setMoving(true)
    setFailed(false)
    moveSession(request.sessionId, workspaceId).then(() => {
      settleSessionMove()
    }).catch((reason: unknown) => {
      // The Host remains authoritative; keep the request visible without claiming rollback.
      console.warn('session move rejected:', reason)
      setMoving(false)
      setFailed(true)
    })
  }
  return (
    <Modal open title={t('move.session.title')} closeLabel={t('close')} onClose={close}
      footer={<Button variant="outline" disabled={moving} onClick={close}>{t('cancel')}</Button>}>
      <p>{t('move.session.description', { title: request.displayTitle })}</p>
      <Menu open={picking && !moving && allowed && snapshot.phase === 'ready'}
        anchor={<Button variant="outline" disabled={moving || !allowed || snapshot.phase !== 'ready'}
          onClick={() => { setPicking(value => !value) }}>{t('move.destination')}</Button>}
        onSelect={() => {}} onClose={() => { setPicking(false) }} portal>
        {listed.map(workspace => (
          <WorkspaceDestination key={workspace.id} workspace={workspace} current={current}
            useWorkspaceAccess={useWorkspaceAccess} onMove={move} />
        ))}
        <MenuItemButton disabled={current === null} onSelect={() => { move(null) }}>
          {t('group.ungrouped')}
        </MenuItemButton>
      </Menu>
      {moving && <div role="status" className={css.menuStatus}>{t('move.pending')}</div>}
      {snapshot.phase === 'pending' && <div role="status" className={css.menuStatus}>{t('picker.loading')}</div>}
      {failed && <div role="alert" className={css.modalError}>{t('move.failed')}</div>}
    </Modal>
  )
}

/** A destination owns its access subscription so a changing roster never changes another component's Hook order. */
function WorkspaceDestination({ workspace, current, useWorkspaceAccess, onMove }: {
  workspace: { id: WorkspaceId; title: string; path: string; suffix: string | undefined }
  current: WorkspaceId | null
  useWorkspaceAccess: SessionMoveDialogProps['useWorkspaceAccess']
  onMove: (workspaceId: WorkspaceId) => void
}) {
  const allowed = useWorkspaceAccess(workspace.id, 'workspace/moveSession')
  if (!allowed) return null
  return (
    <MenuItemButton icon={<IconFolderCloseRegular size={16} />} disabled={current === workspace.id}
      onSelect={() => { onMove(workspace.id) }}>
      <span className={css.disambiguated} title={workspace.path}>
        <span className={css.title}>{workspace.title}</span>
        {workspace.suffix !== undefined && <> <span className={css.pathSuffix}>{workspace.suffix}</span></>}
      </span>
    </MenuItemButton>
  )
}
