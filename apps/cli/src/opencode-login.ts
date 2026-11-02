/**
 * `dsh opencode-login`: one-time OpenCode Zen workspace login over the
 * device flow. Prints the user code plus verification link (opening the
 * browser unless disabled), polls until the browser approval lands, resolves
 * the billed workspace, and stores the token state in the credentials seam
 * — after which `opencode-free` serves workspace-identity turns without
 * further interaction, refreshing silently. Nothing secret is printed: only
 * the code, the link, and progress lines reach the console.
 *
 * @module @deepseek-ai/dsh/opencode-login
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
  runZenLogin,
  type ZenOrg,
} from '@deepseek-ai/dsh-llm-opencode'
import { join } from 'node:path'

/** Options for {@link runOpencodeLogin}; every field is optional. */
export interface OpencodeLoginOptions {
  /** Harness home holding `.credentials.yaml`; defaults to `$DSH_HOME` or `~/.dsh`. */
  dshHome?: string
  /** Credential reference holding the OAuth state; defaults to `OPENCODE_ZEN_OAUTH`. */
  oauthRef?: string
  /** Console root override (tests and advanced deployments). */
  consoleBase?: string
  /** Open the verification link in the system browser; defaults to true. */
  openBrowser?: boolean
  /** Workspace id or name to bill against; prompts when omitted and ambiguous. */
  org?: string
  /** readline input for the workspace prompt; defaults to process stdin. */
  input?: NodeJS.ReadableStream
  /** readline output for the workspace prompt; defaults to process stdout. */
  output?: NodeJS.WritableStream
  /** Cancellation for the approval wait. */
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

async function promptOrg(
  orgs: ZenOrg[],
  selected: string | undefined,
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
  signal: AbortSignal | undefined,
): Promise<string | undefined> {
  const byId = new Map(orgs.map(org => [org.id, org] as const))
  const byName = new Map(orgs.map(org => [org.name, org] as const))
  if (selected !== undefined) {
    const match = byId.get(selected) ?? byName.get(selected)
    if (match === undefined) {
      throw new Error(
        `no workspace matches "${selected}" (available: ${orgs.map(org => org.name).join(', ')})`,
      )
    }
    return match.id
  }
  if (orgs.length === 1) {
    const [only] = orgs
    if (only !== undefined) return only.id
  }
  if (!isAttended(input)) {
    throw new Error(
      `multiple workspaces available (${orgs.map(org => org.name).join(', ')}); re-run with --org <name-or-id>`,
    )
  }
  const terminal: Interface = createInterface({ input, output })
  try {
    for (;;) {
      terminal.write('Select the workspace OpenCode requests bill against:\n')
      orgs.forEach((org, index) => { terminal.write(`  ${String(index + 1)}. ${org.name}\n`) })
      const answer: string = await new Promise((resolve, reject) => {
        if (signal?.aborted === true) {
          reject(signal.reason ?? new Error('cancelled'))
          return
        }
        terminal.question('Choice (number, or empty to skip): ', resolve)
        signal?.addEventListener('abort', () => {
          terminal.close()
          reject(signal.reason ?? new Error('cancelled'))
        }, { once: true })
      })
      const trimmed = answer.trim()
      if (trimmed === '') return undefined
      const picked = Number.parseInt(trimmed, 10)
      if (Number.isInteger(picked) && picked >= 1 && picked <= orgs.length) {
        const chosen = orgs[picked - 1]
        if (chosen !== undefined) return chosen.id
      }
      terminal.write('Not a listed number — try again.\n')
    }
  } finally {
    terminal.close()
  }
}

function isAttended(input: NodeJS.ReadableStream): boolean {
  return input === process.stdin ? process.stdin.isTTY === true : true
}

/**
 * Candidate Anton app homes in preference order: the packaged app's
 * `ANTON_DSH_HOME` default first, then the checkout-development default,
 * then the Windows launcher home. Mirrors `apps/anton-bridge` without
 * importing it (the CLI must not depend on the app); the bridge remains the
 * owner of these paths.
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
 * Run the device-flow login against the credentials seam and exit-coded
 * outcome. Boots only the file credentials provider (no profile), so login
 * works before any composition exists.
 * @returns process exit code: 0 stored, 1 failed or cancelled.
 */
export async function runOpencodeLogin(options: OpencodeLoginOptions = {}): Promise<number> {
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
      console.error('opencode-login: credentials service unavailable')
      return 1
    }
    let opened = false
    const maybeOpen = (url: string): void => {
      if (opened || options.openBrowser === false) return
      opened = true
      openBrowserUrl(url)
    }
    const state = await runZenLogin(
      {
        notify: (message: string) => {
          console.log(message)
        },
        onDeviceCode: (code) => {
          maybeOpen(code.verificationUri)
        },
        promptSelect: async (_message, choices) => promptOrg(
          choices.map(choice => ({ id: choice.id, name: choice.label })),
          options.org,
          options.input ?? process.stdin as NodeJS.ReadableStream,
          options.output ?? process.stdout as NodeJS.WritableStream,
          options.signal,
        ),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      },
      {
        ...(options.consoleBase === undefined ? {} : { consoleBase: options.consoleBase }),
      },
    )
    await credentials.set(ref, JSON.stringify(state))
    console.log(
      `OpenCode Zen workspace login stored in ${join(home, CREDENTIALS_FILENAME)} (ref ${String(ref)})`
      + `${state.orgID !== undefined ? ` (workspace ${state.orgID})` : ''}`
      + `${state.allowedModels !== undefined ? ` — ${String(state.allowedModels.length)} workspace models` : ''}.`
      + ' The opencode-free route serves workspace turns from the next request.',
    )
    const hint = appHomeHint(home)
    if (hint !== undefined) console.log(hint)
    return 0
  } catch (error: unknown) {
    console.error(`opencode-login: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  } finally {
    await ctx.fiber.dispose()
  }
}
