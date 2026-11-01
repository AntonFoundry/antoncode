/**
 * Interactive Antigravity OAuth login: run a local callback server on port
 * 51121, open the Google authorization page, exchange the returned code, and
 * append the account to the shared accounts file. This gives the harness a
 * self-sufficient login path — the same file the opencode Antigravity plugin
 * reads — so one login serves both.
 *
 * @module @deepseek-ai/dsh-llm-antigravity/login
 */

import { createServer } from 'node:http'
import { authorizeAntigravity, exchangeAntigravity, readAccounts, writeAccounts } from './auth.ts'
import type { AntigravityAccount } from './auth.ts'

export interface LoginOptions {
  /** Accounts file to append to; empty means the shared default. */
  accountsPath?: string
  /** Open the authorization URL in the system browser (default true). */
  openBrowser?: boolean
}

/**
 * Run the interactive login flow; resolves after the account is stored.
 * @returns the stored account (email, packed refresh credential, project).
 */
export async function runLogin(options: LoginOptions = {}): Promise<AntigravityAccount> {
  const { url } = authorizeAntigravity()
  if (options.openBrowser === false) {
    console.log(`Open this URL to authorize Antigravity:\n${url}`)
  } else {
    const opener = process.platform === 'darwin' ? 'open' : 'xdg-open'
    const { spawn } = await import('node:child_process')
    spawn(opener, [url], { stdio: 'ignore', detached: true }).unref()
  }

  const callback = new Promise<{ code: string; state: string }>((resolve, reject) => {
    const server = createServer((request, response) => {
      const requestUrl = new URL(request.url ?? '/', 'http://localhost')
      if (requestUrl.pathname !== '/oauth-callback') {
        response.writeHead(404).end()
        return
      }
      const code = requestUrl.searchParams.get('code')
      const state = requestUrl.searchParams.get('state')
      const error = requestUrl.searchParams.get('error')
      if (error !== null) {
        response.writeHead(200, { 'content-type': 'text/plain' }).end(`Authorization failed: ${error}`)
        server.close()
        reject(new Error(`Antigravity login rejected: ${error}`))
        return
      }
      if (code === null || state === null) {
        response.writeHead(400).end('missing code/state')
        return
      }
      response.writeHead(200, { 'content-type': 'text/plain' }).end('Antigravity login complete. You can close this tab.')
      server.close()
      resolve({ code, state })
    })
    server.on('error', reject)
    server.listen(51121, 'localhost')
  })

  const { code, state } = await callback
  const auth = await exchangeAntigravity(code, state)
  if (auth.refresh === undefined) {
    throw new Error('Antigravity login returned no refresh credential')
  }
  const account: AntigravityAccount = {
    ...auth.email === undefined ? {} : { email: auth.email },
    refreshToken: auth.refresh,
    ...auth.projectId === undefined ? {} : { projectId: auth.projectId },
  }
  // Idempotent by email: replace an existing account, otherwise append.
  const existing = readAccounts(options.accountsPath)
  const next = auth.email === undefined
    ? [...existing, account]
    : [...existing.filter(entry => entry.email !== auth.email), account]
  writeAccounts(options.accountsPath, next)
  return account
}
