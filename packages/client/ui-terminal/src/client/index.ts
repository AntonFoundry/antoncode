/**
 * Browser half of the terminal plugin: registers the WM's terminal-view slot
 * with an xterm.js component bound to one interactive PTY session.
 * @module @deepseek-ai/dsh-client-ui-terminal/client
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
// Type-only: the ui-theme Context merge carrying the `font/change` event.
import type {} from '@deepseek-ai/dsh-client-ui-theme/client'
import { createBroadcastStore } from './broadcast.js'
import { createTermFontStore } from './term-font.js'
import { TerminalView } from './TerminalView.js'

export const inject = ['slots', 'remote', 'remote.guiTerminal', 'theme']

/**
 * Register the terminal-view occupant. The WM's `term` command spawns a
 * session and opens a terminal buffer; this component attaches to the
 * buffer's session id and owns the xterm lifecycle for it.
 * @param ctx - client root context.
 */
export function apply(ctx: Context): void {
  // The broadcast store: one instance, created here and shared two ways —
  // the hooks compartment (views subscribe via useBroadcast) and the inject
  // face (the write actions). M-x multi-cursor raises the toggle event from
  // the WM; this listener flips the same single instance.
  const broadcast = createBroadcastStore().create()
  ctx.effect(() => {
    const onToggle = (): void => { broadcast.actions.setBroadcast(!broadcast.getSnapshot().broadcast) }
    window.addEventListener('ui-terminal:toggle-broadcast', onToggle)
    return () => { window.removeEventListener('ui-terminal:toggle-broadcast', onToggle) }
  }, 'ui-terminal: multi-cursor toggle event')

  // Live font selection: mirror the ui-theme `font/change` event into the
  // term-font store (hooks compartment) so mounted views re-fit their xterm.
  const termFont = createTermFontStore().create()
  ctx.on('font/change', (snapshot) => {
    termFont.actions.sync(snapshot.termSize, snapshot.monoFont)
  })

  ctx.slots.inject('terminal.view', () => ctx.slots.register({
    name: 'terminal.view',
    inject: (owner?: { sessionId?: string; workspacePath?: string; onSessionCreated?: (sessionId: string) => void }) => {
      const api = ctx.remote.guiTerminal
      const unwrap = async <T>(result: Promise<{ ok: true; value: T } | { ok: false; error: { message: string } }>): Promise<T> => {
        const response = await result
        if (!response.ok) throw new Error(response.error.message)
        return response.value
      }
      return {
        spawn: (cols: number, rows: number, cwd?: string) => unwrap(api.spawn({ cols, rows, ...cwd !== undefined ? { cwd } : {} })),
        read: (sessionId: string, since: number) => unwrap(api.read({ sessionId, since })),
        input: (sessionId: string, data: string) => unwrap(api.input({ sessionId, data })),
        resize: (sessionId: string, cols: number, rows: number) => unwrap(api.resize({ sessionId, cols, rows })),
        dispose: (sessionId: string) => unwrap(api.dispose({ sessionId })),
        themeTokens: () => ctx.theme.getTheme().active.tokens,
        sessionId: owner?.sessionId,
        workspacePath: owner?.workspacePath,
        onSessionCreated: owner?.onSessionCreated,
        broadcastActions: broadcast.actions,
        hooks: { broadcast, termFont },
      }
    },
  }, TerminalView))
}
