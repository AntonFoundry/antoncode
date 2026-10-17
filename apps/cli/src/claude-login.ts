/**
 * `dsh claude-login`: one-time Claude Code subscription login over the
 * PKCE authorization-code flow with manual code paste-back. Prints the
 * browser approval link (opening it unless disabled), reads the pasted
 * code, exchanges it for tokens, and stores the session in the credentials
 * seam — after which `claude-code` serves subscription turns without
 * further interaction, refreshing silently. Nothing secret is printed: only
 * the link and progress lines reach the console.
 *
 * @module @deepseek-ai/dsh/claude-login
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { createInterface, type Interface } from 'node:readline'
import { Context } from '@deepseek-ai/cordis'
import { LocalCredentialProvider, CREDENTIALS_FILENAME } from '@deepseek-ai/dsh-credentials-local'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import {
  DEFAULT_OAUTH_REF,
  runClaudeLogin,
} from '@deepseek-ai/dsh-llm-claude'
import { join } from 'node:path'

/** Options for {@link runClaudeLogin}; every field is optional. */
export interface ClaudeLoginOptions {
  /** Harness home holding `.credentials.yaml`; defaults to `$DSH_HOME` or `~/.dsh`. */
  dshHome?: string
  /** Credential reference holding the OAuth state; defaults to `CLAUDE_CODE_OAUTH`. */
  oauthRef?: string
  /** Console root override (tests and advanced deployments). */
  consoleBase?: string
  /** Open the approval link in the system browser; defaults to true. */
  openBrowser?: boolean
  /** readline input for the pasted code; defaults to process stdin. */
  input?: NodeJS.ReadableStream
  /** readline output for prompts; defaults to process stdout. */
  output?: NodeJS.WritableStream
  /** Cancellation for the waits. */
  signal?: AbortSignal
}

/** Open the URL with the platform opener, best-effort: failures only lose convenience. */
function openBrowserUrl(url: string): void {
  try {
    if (process.platform === 'win32') {
      spawn('cmd', ['/c', 'start', '', url], { stdio: 'ignore', detached: true }).unref()
      return
    }
    const opener = process.platform === 'darwin' ? 'open' : 'xdg-open'
    spawn(opener, [url], { stdio: 'ignore', detached: true }).unref()
  } catch {
    // The printed URL below is the real channel; opening is convenience.
  }
}

/**
 * Candidate Anton app homes in preference order. Mirrors
 * `apps/anton-bridge` without importing it (the CLI must not depend on the
 * app); the bridge remains the owner of these paths.
 */
function antonAppHomes(homeDir: string = homedir()): string[] {
  const homes = [
    join(homeDir, 'Library', 'Application Support', 'Anton', 'dsh'),
    join(homeDir, '.anton', 'dsh'),
  ]
  // Same default the Windows `Start Anton.cmd` and `dsh.cmd` use.
  if (process.platform === 'win32' && process.env.APPDATA !== undefined && process.env.APPDATA.length > 0) {
    homes.unshift(join(process.env.APPDATA, 'Anton', 'dsh'))
  }
  return homes
}

/**
 * When the session was stored somewhere the Anton app does not read, name
 * the exact re-run that logs the app in. Pure over an existence probe so
 * tests drive fakes; `undefined` means the app already reads this home.
 * @param targetHome - the home the session was just stored in.
 * @param exists - filesystem presence probe for candidate app homes.
 * @param appHomes - candidate homes, defaulting to the bridge-owned list.
 */
export function appHomeHint(
  targetHome: string,
  exists: (path: string) => boolean = existsSync,
  appHomes: readonly string[] = antonAppHomes(),
): string | undefined {
  // Already an app home: nothing to suggest. Otherwise point at the
  // preferred home the app would read — and stay silent when no app home
  // exists on this machine (a pure CLI login needs no second home).
  if (appHomes.includes(targetHome)) return undefined
  const readable = appHomes.find(candidate => exists(candidate))
  if (readable === undefined) return undefined
  return `The Anton app reads a different home (${readable}); to log the app in, re-run with --home "${readable}".`
}

/**
 * Run the browser-approval login against the credentials seam and exit-coded
 * outcome. Boots only the file credentials provider (no profile), so login
 * works before any composition exists.
 * @returns process exit code: 0 stored, 1 failed or cancelled.
 */
export async function runClaudeLoginCli(options: ClaudeLoginOptions = {}): Promise<number> {
  const home = resolveDshHome(options.dshHome)
  const ref = credentialRef(options.oauthRef ?? DEFAULT_OAUTH_REF)
  const ctx = new Context()
  try {
    await ctx.plugin(LocalCredentialProvider, {
      path: join(home, CREDENTIALS_FILENAME),
      dshHome: home,
      watch: false,
    })
    const credentials = ctx.get('credentials')
    if (credentials === undefined) {
      console.error('claude-login: credentials service unavailable')
      return 1
    }
    const input = options.input ?? process.stdin as NodeJS.ReadableStream
    const output = options.output ?? process.stdout as NodeJS.WritableStream
    let opened = false
    const state = await runClaudeLogin(
      {
        notify: (message: string) => {
          console.log(message)
        },
        promptLine: async (message: string): Promise<string> => {
          const terminal: Interface = createInterface({ input, output })
          try {
            return await new Promise<string>((resolve, reject) => {
              if (options.signal?.aborted === true) {
                reject(options.signal.reason ?? new Error('cancelled'))
                return
              }
              terminal.question(message, resolve)
              options.signal?.addEventListener('abort', () => {
                terminal.close()
                reject(options.signal?.reason ?? new Error('cancelled'))
              }, { once: true })
            })
          } finally {
            terminal.close()
          }
        },
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        onApproveLink: (url: string) => {
          if (!opened && options.openBrowser !== false) {
            opened = true
            openBrowserUrl(url)
          }
        },
      },
      {
        ...(options.consoleBase === undefined ? {} : { consoleBase: options.consoleBase }),
      },
    )
    await credentials.set(ref, JSON.stringify(state))
    console.log(
      `Claude subscription login stored in ${join(home, CREDENTIALS_FILENAME)} (ref ${String(ref)}).`
      + ' The claude-code route serves subscription turns from the next request.',
    )
    const hint = appHomeHint(home)
    if (hint !== undefined) console.log(hint)
    return 0
  } catch (error: unknown) {
    console.error(`claude-login: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  } finally {
    await ctx.fiber.dispose()
  }
}
