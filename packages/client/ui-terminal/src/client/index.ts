/**
 * Browser half of the terminal plugin: registers the WM's terminal-view slot
 * with an xterm.js component bound to one interactive PTY session.
 * @module @deepseek-ai/dsh-client-ui-terminal/client
 */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { IApiClient } from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import { createBroadcastStore } from './broadcast.js'
import { TerminalView } from './TerminalView.js'

export const inject = ['slots', 'connection', 'theme']

/**
 * Register the terminal-view occupant. The WM's `term` command spawns a
 * session and opens a terminal buffer; this component attaches to the
 * buffer's session id and owns the xterm lifecycle for it.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
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

  ctx.slots.inject('terminal.view', () => ctx.slots.register({
    name: 'terminal.view',
    inject: () => {
      // The connection inject is the wire handle; its api face is the typed
      // IApiClient (the model-selection service uses the same cast). The
      // theme face is cast for the same reason — the Context merges live in
      // packages this plugin type-references, but the aggregate client build
      // resolves them through the built declarations where the augmentation
      // order differs.
      const api = (ctx.get('connection') as unknown as { api: IApiClient }).api
      const theme = (ctx as unknown as { theme: { getTheme(): { active: { tokens: Record<string, string> } } } }).theme
      return {
        spawn: (cols: number, rows: number) => api.term.spawn({ cols, rows }).then(r => r.result.ok ? { sessionId: r.result.value.sessionId } : { sessionId: '' }),
        read: (sessionId: string, since: number) => api.term.read({ sessionId, since }).then(r => r.result.ok ? r.result.value : { data: '', next: since, exited: true }),
        input: (sessionId: string, data: string) => api.term.input({ sessionId, data }).then(() => undefined),
        resize: (sessionId: string, cols: number, rows: number) => api.term.resize({ sessionId, cols, rows }).then(() => undefined),
        dispose: (sessionId: string) => api.term.dispose({ sessionId }).then(() => undefined),
        themeTokens: () => theme.getTheme().active.tokens,
        broadcastActions: broadcast.actions,
        hooks: { broadcast },
      }
    },
  }, TerminalView))
}
