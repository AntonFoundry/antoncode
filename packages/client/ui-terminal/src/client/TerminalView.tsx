/**
 * The terminal view: one xterm.js instance bound to one interactive PTY
 * session (the `term` RPC domain). Owns the session lifecycle — spawns on
 * first render, polls the output tail on a 60ms cadence, writes keystrokes
 * straight through, resizes the pseudoterminal on container resize, and
 * disposes the session when the buffer closes. Terminal colors follow the
 * loaded theme palette.
 */
import { useEffect, useRef } from 'react'
// Static imports: the client module table answers only platform specifiers —
// a dynamic import() here would emit sibling chunks the loader cannot resolve.
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import type { BroadcastState } from './broadcast.js'
import css from './TerminalView.module.css'

/** Term faces injected by the plugin's apply (over the `term` RPC domain). */
export interface TerminalViewProps {
  /** Spawn a login shell at the given size; resolves the session id. */
  spawn(cols: number, rows: number): Promise<{ sessionId: string }>
  /** Read the output tail past the client's cursor. */
  read(sessionId: string, since: number): Promise<{ data: string; next: number; exited: boolean }>
  /** Write raw keystrokes to the shell. */
  input(sessionId: string, data: string): Promise<unknown>
  /** Resize the pseudoterminal. */
  resize(sessionId: string, cols: number, rows: number): Promise<unknown>
  /** Kill the session. */
  dispose(sessionId: string): Promise<unknown>
  /** The loaded theme's alias tokens (bg/fg/cursor colors for xterm). */
  themeTokens(): Record<string, string>
  /** The buffer's PTY session id; a missing id spawns a fresh session. */
  sessionId?: string | undefined
  /** Broadcast-store read hook (bound from the hooks compartment). */
  useBroadcast: SnapshotSelectorHook<BroadcastState>
  /** Broadcast-store write face (the single instance's bound actions). */
  broadcastActions: {
    setBroadcast(on: boolean): void
    join(sessionId: string): void
    leave(sessionId: string): void
  }
}

/**
 * Render the terminal surface for one PTY session.
 * @param props - term faces and the session binding.
 * @returns the terminal element tree.
 */
export function TerminalView(props: TerminalViewProps) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const facesRef = useRef(props)
  facesRef.current = props
  // Broadcast share: subscribed for the overlay render, mirrored into a ref
  // for the term.onData callback (hooks cannot run inside event callbacks).
  const broadcast = props.useBroadcast(s => s)
  const broadcastRef = useRef({ on: broadcast.broadcast, sessions: broadcast.sessions })
  broadcastRef.current = { on: broadcast.broadcast, sessions: broadcast.sessions }
  const toggleBroadcast = (): void => { props.broadcastActions.setBroadcast(!broadcastRef.current.on) }

  useEffect(() => {
    const host = hostRef.current
    if (host === null) return

    let disposed = false
    let since = 0
    let poll: number | undefined
    let liveSession = props.sessionId

    void (async () => {
      const faces = facesRef.current
      const tokens = faces.themeTokens()

      const term = new Terminal({
        cursorBlink: true,
        fontSize: 13,
        // The Nerd Fonts installed on this machine carry lsd's icon glyphs;
        // Apple Color Emoji renders emoji; the system mono is the fallback.
        fontFamily: '\u0027FiraCode Nerd Font Mono\u0027, \u0027FiraCode Nerd Font\u0027, \u0027Hack Nerd Font Mono\u0027, \u0027Apple Color Emoji\u0027, ui-monospace, SFMono-Regular, Menlo, monospace',
        convertEol: false,
        theme: {
          background: tokens['--dsw-alias-bg-base'] ?? '#16181d',
          foreground: tokens['--dsw-alias-label-primary'] ?? '#d7dae0',
          cursor: tokens['--dsw-alias-brand-primary'] ?? '#4d78cc',
        },
      })
      const fit = new FitAddon()
      term.loadAddon(fit)
      term.open(host)
      try { fit.fit() } catch { /* zero-size container before layout settles */ }

      // Debug capture (termdebug): record every write, fit, and resize with
      // timestamps so a startup garble can be attributed to its emitter.
      const dbg = new URLSearchParams(window.location.search).has('termdebug')
      const trace: string[] = []
      if (dbg) {
        (window as unknown as { __termTrace: string[] }).__termTrace = trace
        const origWrite = term.write.bind(term)
        term.write = ((data: string) => { trace.push(`write:${JSON.stringify(data.slice(0, 80))}`); return origWrite(data) }) as typeof term.write
      }
      const mark = (what: string): void => {
        if (dbg) trace.push(`${what}: cols=${term.cols} rows=${term.rows}`)
      }
      mark('created')

      // Let web fonts finish, then wait for the pane grid to reach a stable,
      // usable size BEFORE the shell spawns. A freshly split pane settles
      // over several frames; spawning into a transient narrow grid makes bash
      // wrap its multi-line prompt into soup, and every later layout settle
      // then fires a SIGWINCH prompt-redraw over that soup — the interleaved
      // chevron garble at the top of the scrollback.
      try { await document.fonts.ready } catch { /* font API unavailable */ }
      const stableGrid = async (): Promise<void> => {
        for (let attempt = 0; attempt < 60; attempt += 1) {
          try { fit.fit() } catch { /* zero-size container still settling */ }
          const cols = term.cols
          const rows = term.rows
          mark('settle-fit')
          await new Promise(resolve => setTimeout(resolve, 120))
          if (disposed) return
          try { fit.fit() } catch { /* as above */ }
          if (term.cols >= 20 && term.cols === cols && term.rows === rows) return
        }
      }
      await stableGrid()
      mark('pre-spawn')
      if (disposed) return

      if (liveSession === undefined) {
        const spawned = await faces.spawn(term.cols, term.rows)
        mark('spawned')
        if (disposed) { void facesRef.current.dispose(spawned.sessionId); return }
        liveSession = spawned.sessionId
      }

      // Resize the PTY only when the grid actually changed: every SIGWINCH
      // makes bash's readline redraw its prompt, and a multi-line prompt
      // redraws in place garbling the top of the scrollback. The mount-time
      // observation fires with unchanged dimensions — it must be a no-op.
      let liveCols = term.cols
      let liveRows = term.rows
      const pushResize = (): void => {
        if (liveSession === undefined) return
        if (term.cols === liveCols && term.rows === liveRows) return
        liveCols = term.cols
        liveRows = term.rows
        void facesRef.current.resize(liveSession, term.cols, term.rows)
      }
      term.onData((data) => {
        if (liveSession === undefined) return
        if (broadcastRef.current.on) {
          // Multi-cursor: echo the keystrokes into every joined terminal.
          for (const sid of broadcastRef.current.sessions) {
            void facesRef.current.input(sid, data)
          }
          return
        }
        void facesRef.current.input(liveSession, data)
      })
      term.onResize(pushResize)
      facesRef.current.broadcastActions.join(liveSession)

      const ro = new ResizeObserver(() => {
        try {
          fit.fit()
          mark('ro-fit')
          pushResize()
        } catch { /* the session may already be gone */ }
      })
      ro.observe(host)

      let exitWritten = false
      // Single-flight: a read that outlives its tick must not overlap the
      // next one — two in-flight reads share the same cursor and both write
      // the same tail, double-printing the prompt (the startup chevron
      // overprint). The next tick re-checks after the cursor advances.
      let reading = false
      poll = window.setInterval(() => {
        if (disposed || exitWritten || reading || liveSession === undefined) return
        reading = true
        void facesRef.current.read(liveSession, since).then((result) => {
          reading = false
          if (disposed || exitWritten) return
          if (result.data.length > 0) {
            term.write(result.data)
            since = result.next
          }
          if (result.exited) {
            // Write the notice once and stop the poll — the session is dead,
            // so every later read would just re-report the exit.
            exitWritten = true
            if (poll !== undefined) window.clearInterval(poll)
            term.write('\r\n\x1b[90m[process exited — close the window or C-x t for a new shell]\x1b[0m')
          }
        }, () => { reading = false })
      }, 60)
    })()

    return () => {
      disposed = true
      if (poll !== undefined) window.clearInterval(poll)
      facesRef.current.broadcastActions.leave(props.sessionId ?? liveSession ?? '')
      void facesRef.current.dispose(props.sessionId ?? '')
      host.innerHTML = ''
    }
    // One lifecycle per buffer session identity.
  }, [props.sessionId])

  return (
    <div ref={hostRef} className={css.host} data-terminal-view data-broadcast={broadcast.broadcast || undefined}>
      <button
        type="button"
        className={css.broadcastToggle}
        data-active={broadcast.broadcast || undefined}
        aria-label="Broadcast keystrokes to all terminals"
        title={broadcast.broadcast ? 'Multi-cursor ON — keystrokes go to every terminal' : 'Multi-cursor OFF'}
        onClick={toggleBroadcast}
      >
        <svg width={12} height={12} viewBox="0 0 16 16" fill="none" aria-hidden>
          <rect x="5" y="2" width="9" height="9" rx="1.5" stroke="currentColor" strokeWidth="1.4" />
          <path d="M11 14H3.5A1.5 1.5 0 0 1 2 12.5V5" stroke="currentColor" strokeWidth="1.4" />
        </svg>
      </button>
    </div>
  )
}
