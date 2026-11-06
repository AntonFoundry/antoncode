/** Independent login-shell terminals used by the window-manager buffer. */
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'

interface GuiSession {
  readonly pty: import('node-pty').IPty
  buffer: string
  base: number
  exited: boolean
}

/** Limits and shell choice for window-manager terminals. */
export interface GuiTerminalConfig {
  readonly shell?: string
  readonly bufferLimit?: number
}

/** Remote owner for independent window-manager terminal buffers. */
export class GuiTerminalController extends TypertRemoteService {
  static inject = ['typert']
  static Config: z<GuiTerminalConfig> = z.object({
    shell: z.string().default('/bin/bash'),
    bufferLimit: z.natural().min(1024).default(400_000),
  })

  private readonly sessions = new Map<string, GuiSession>()
  private readonly shell: string
  private readonly bufferLimit: number

  /** @param ctx - Host context. @param config - login shell and retained output limit. */
  constructor(ctx: Context, config: GuiTerminalConfig = {}) {
    super(ctx, 'guiTerminalController', { namespace: 'guiTerminal' })
    const resolved = GuiTerminalController.Config(config)
    this.shell = resolved.shell ?? '/bin/bash'
    this.bufferLimit = resolved.bufferLimit ?? 400_000
    ctx.effect(() => () => {
      for (const session of this.sessions.values()) session.pty.kill()
      this.sessions.clear()
    }, 'gui-terminal.processes')
  }

  /**
   * Start an independent login shell, falling back to the process directory or home when needed.
   * @param request - initial grid size and optional existing working directory.
   * @returns allocated terminal identity; output remains buffered until disposal or controller unload.
   */
  @Remote
  async spawn(request: { cols: number; rows: number; cwd?: string }): Promise<{ sessionId: string }> {
    const { spawn } = await import('node-pty')
    const cwd = request.cwd !== undefined && existsSync(request.cwd) ? request.cwd
      : existsSync(process.cwd()) ? process.cwd() : homedir()
    const id = randomUUID()
    const pty = spawn(this.shell, ['-l'], {
      name: 'xterm-256color', cols: request.cols, rows: request.rows, cwd,
      env: { ...process.env, TERM: 'xterm-256color' } as Record<string, string>,
    })
    const session: GuiSession = { pty, buffer: '', base: 0, exited: false }
    pty.onData((data) => {
      session.buffer += data
      const overflow = session.buffer.length - this.bufferLimit
      if (overflow > 0) {
        session.buffer = session.buffer.slice(overflow)
        session.base += overflow
      }
    })
    pty.onExit(() => { session.exited = true })
    this.sessions.set(id, session)
    return { sessionId: id }
  }

  /**
   * Read retained output, skipping any prefix already evicted by the buffer limit.
   * Throws when the terminal is unknown or disposed.
   * @param request - terminal identity and consumed character cursor.
   * @returns retained output tail, next cursor, and whether the PTY exit callback has run.
   */
  @Remote
  read(request: { sessionId: string; since: number }): { data: string; next: number; exited: boolean } {
    const session = this.expect(request.sessionId)
    const since = Math.max(request.since, session.base)
    const data = session.buffer.slice(since - session.base)
    return { data, next: since + data.length, exited: session.exited }
  }

  /**
   * Write raw input to a known terminal; throws when the terminal is unknown or disposed.
   * @param request - terminal identity and raw input.
   * @returns receipt that the PTY write call returned, not that the shell consumed the input.
   */
  @Remote
  input(request: { sessionId: string; data: string }): { wrote: true } {
    this.expect(request.sessionId).pty.write(request.data)
    return { wrote: true }
  }

  /**
   * Resize a known terminal; throws when the terminal is unknown or disposed.
   * @param request - terminal identity and new grid dimensions.
   * @returns receipt that the PTY resize call returned.
   */
  @Remote
  resize(request: { sessionId: string; cols: number; rows: number }): { resized: true } {
    this.expect(request.sessionId).pty.resize(request.cols, request.rows)
    return { resized: true }
  }

  /**
   * Forget a terminal and request its PTY termination; unknown identities are a no-op.
   * @param request - terminal identity.
   * @returns disposal receipt without waiting for child exit.
   */
  @Remote
  dispose(request: { sessionId: string }): { disposed: true } {
    const session = this.sessions.get(request.sessionId)
    if (session !== undefined) {
      this.sessions.delete(request.sessionId)
      session.pty.kill()
    }
    return { disposed: true }
  }

  private expect(id: string): GuiSession {
    const session = this.sessions.get(id)
    if (session === undefined) throw new Error(`terminal ${id} does not exist`)
    return session
  }
}
