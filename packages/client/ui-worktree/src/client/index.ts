/**
 * Worktree surface plugin, browser half: the composer context bar
 * (conversation.composer.dock — repository chip, workspace-mode select, base-ref
 * picker) and the session header's repo-status chip
 * (conversation.session.header.actions). Live state arrives through the
 * standard workspaces/sessions feeds; the inject faces carry the mode-write
 * verb and the status query from `ctx.workspaces`.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the ui-conversation SlotMap merge (the input.left and
// session.header.actions entries).
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { ComposerContextBar } from './ComposerContextBar.tsx'
import { RepoStatusChip } from './RepoStatusChip.tsx'
import { en, zh, type WorktreeKey } from './locales.ts'

export { RepoStatusChip } from './RepoStatusChip.tsx'
export { resolveRepo, WorktreeModeSelect } from './WorktreeModeSelect.tsx'
export type { RepoStatusActions, WorktreeBarActions, WorktreeSelectActions } from './slots.ts'
export type { WorktreeKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The worktree surface's copy. */
    worktree: WorktreeKey
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'worktree'

/** Required services: slot registration, the workspaces domain, and copy. */
export const inject = ['slots', 'workspaces', 'locale']

/**
 * Client plugin body: the two worktree entries.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-worktree: dictionaries')

  const workspaces = ctx.workspaces

  ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
    name: 'conversation.composer.dock',
    id: 'composer-context-bar',
    // Above the stats line (order 0): the bar sits directly under the card,
    // inside the composer's width column; the stats band renders below it.
    order: -10,
    locale: NS,
    inject: () => ({
      setMode: (repoPath, pref) => workspaces.setWorktreePref(repoPath, pref),
      refresh: () => {
        // A missed pull is non-fatal: the boot hook and every mutation also
        // refresh the projection.
        void workspaces.refreshWorktrees().catch(() => {})
      },
      status: (path, signal) => workspaces.worktreeStatus(path, signal),
    }),
  }, ComposerContextBar))

  ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
    name: 'conversation.session.header.actions',
    id: 'repo-status',
    // Static session context occupies the header's leading negative-order band.
    order: -20,
    locale: NS,
    inject: () => ({
      status: (path, signal) => workspaces.worktreeStatus(path, signal),
    }),
  }, RepoStatusChip))
}
