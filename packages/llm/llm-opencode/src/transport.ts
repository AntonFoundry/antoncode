/**
 * Local opencode server discovery and authentication.
 *
 * OpenCode's free tier answers only inside genuine OpenCode: direct gateway
 * calls fail `FreeTierError` no matter which client headers are stamped, so
 * this provider speaks to the user's own running server instead — `GET
 * /api/model`, `POST /api/session`, `POST /api/session/:id/prompt`, `GET
 * /api/session/:id/message` — with the same Basic credential the `opencode
 * api` CLI subcommand uses. Every fact resolves per request (never frozen at
 * load): a TUI restart moves the port, and the next call re-discovers it.
 *
 * @module dsh-llm-opencode/transport
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import { LlmError } from '@deepseek-ai/dsh-llm'

/** Environment variable naming an explicit server URL; honored before file and CLI discovery. */
export const SERVER_URL_ENV = 'OPENCODE_SERVER_URL'
/** Default credential environment variable the server itself reads. */
export const DEFAULT_PASSWORD_ENV = 'OPENCODE_SERVER_PASSWORD'
/** Basic-auth username the server expects unless configured otherwise. */
export const DEFAULT_USERNAME = 'opencode'
/** Password-file name inside the config home, as written by the opencode CLI. */
export const SERVICE_FILE = 'service.json'

/** The caller-controlled halves of server transport. */
export interface OpenCodeServerTransportConfig {
  /** Explicit server base URL; skips file and CLI discovery. */
  serverURL?: string
  /** Basic-auth username; defaults to `opencode`. */
  username?: string
  /**
   * Server registration-file path; defaults to the CLI's state-home
   * `service.json`, which carries both the live URL and its password, so
   * GUI processes without the CLI on PATH still discover the server.
   */
  serviceFile?: string
  /** Password-file path; defaults to `~/.config/opencode/service.json`. */
  passwordFile?: string
  /** Environment variable holding the password fallback. */
  passwordEnv?: string
}

/** One resolved request transport: where to send it and how to authenticate. */
export interface ServerTransport {
  /** Server base URL with no trailing slash. */
  url: string
  /** Request headers carrying the Basic credential, or `{}` when the server runs unsecured. */
  headers: Record<string, string>
}

/**
 * Injectable system boundary so unit tests resolve every discovery branch
 * without spawning processes or touching the real home directory.
 */
export interface TransportSystem {
  /** Process environment mapping. */
  env: Record<string, string | undefined>
  /** Current user's home directory. */
  home: string
  /**
   * Read the server registration file: the live URL plus its password when
   * the CLI wrote one. `undefined` when the file is missing, unreadable, or
   * carries neither fact.
   */
  readServiceFile(path: string): Promise<{ url?: string; password?: string } | undefined>
  /**
   * Read the password value from a service file; `undefined` when the file
   * is missing, unreadable, or carries no password.
   */
  readPasswordFile(path: string): Promise<string | undefined>
  /**
   * Ask the opencode CLI for its background-service URL; `undefined` when the
   * binary is absent or no server is registered.
   */
  serviceStatus(): Promise<string | undefined>
}

function defaultServiceFile(env: Record<string, string | undefined>, home: string): string {
  const state = env.XDG_STATE_HOME !== undefined && env.XDG_STATE_HOME.length > 0
    ? env.XDG_STATE_HOME
    : join(home, '.local', 'state')
  return join(state, 'opencode', SERVICE_FILE)
}

function defaultPasswordFile(home: string): string {
  return join(home, '.config', 'opencode', SERVICE_FILE)
}

function serviceFacts(raw: unknown): { url?: string; password?: string } | undefined {
  if (!isServiceRecord(raw)) return undefined
  const url = typeof raw.url === 'string' && raw.url.length > 0 ? raw.url : undefined
  const password = typeof raw.password === 'string' && raw.password.length > 0 ? raw.password : undefined
  if (url === undefined && password === undefined) return undefined
  return {
    ...url === undefined ? {} : { url },
    ...password === undefined ? {} : { password },
  }
}

function isServiceRecord(raw: unknown): raw is Record<string, unknown> {
  return typeof raw === 'object' && raw !== null
}

async function defaultReadServiceFile(path: string): Promise<{ url?: string; password?: string } | undefined> {
  try {
    return serviceFacts(JSON.parse(await readFile(path, 'utf8')) as unknown)
  } catch {
    return undefined
  }
}

async function defaultReadPasswordFile(path: string): Promise<string | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null) return undefined
    const password = (parsed as Record<string, unknown>).password
    return typeof password === 'string' && password.length > 0 ? password : undefined
  } catch {
    return undefined
  }
}

async function defaultServiceStatus(): Promise<string | undefined> {
  try {
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    const { stdout } = await promisify(execFile)('opencode', ['service', 'status'])
    const url = stdout.trim()
    return url.length > 0 ? url : undefined
  } catch {
    return undefined
  }
}

/** Production system boundary: real environment, home, service files, and CLI discovery. */
export function defaultSystem(env: Record<string, string | undefined> = process.env): TransportSystem {
  return {
    env,
    home: homedir(),
    readServiceFile: defaultReadServiceFile,
    readPasswordFile: defaultReadPasswordFile,
    serviceStatus: defaultServiceStatus,
  }
}

function basicHeader(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`
}

function noServerError(): LlmError {
  return new LlmError(
    'llm-opencode: no opencode server URL; start one with `opencode service start` (or launch the opencode TUI),'
    + ` or set an explicit serverURL (or ${SERVER_URL_ENV})`,
    'TRANSPORT',
  )
}

/**
 * Resolve one request's server transport: explicit URL first, then the
 * environment override, then the CLI's registration file (which needs no
 * binary on PATH, so GUI processes discover the server too), then live
 * `opencode service status` discovery. The password comes from the
 * registration file with the password file and the server-password
 * environment variable as fallbacks; when none exists the requests go out
 * unauthenticated, which only an unsecured server (`OPENCODE_SERVER_PASSWORD`
 * unset) accepts — its 401 otherwise surfaces as `AUTH`.
 * @param config - caller-controlled transport halves.
 * @param system - injectable discovery boundary; defaults to production.
 */
export async function resolveServerTransport(
  config: OpenCodeServerTransportConfig,
  system: TransportSystem = defaultSystem(),
): Promise<ServerTransport> {
  const serverURL = config.serverURL
  if (serverURL !== undefined && serverURL.length === 0) {
    throw new LlmError('llm-opencode: serverURL must be non-empty', 'INVALID_REQUEST')
  }
  const envURL = system.env[SERVER_URL_ENV]
  const service = await system.readServiceFile(config.serviceFile ?? defaultServiceFile(system.env, system.home))
  const discovered = serverURL ?? (envURL !== undefined && envURL.length > 0 ? envURL : undefined)
    ?? service?.url ?? await system.serviceStatus()
  if (discovered === undefined) throw noServerError()
  const url = discovered.endsWith('/') ? discovered.slice(0, -1) : discovered

  const username = config.username ?? DEFAULT_USERNAME
  if (username.length === 0) throw new LlmError('llm-opencode: username must be non-empty', 'INVALID_REQUEST')
  const password = service?.password
    ?? await system.readPasswordFile(config.passwordFile ?? defaultPasswordFile(system.home))
    ?? system.env[config.passwordEnv ?? DEFAULT_PASSWORD_ENV]
  const headers = password === undefined || password.length === 0
    ? {}
    : { authorization: basicHeader(username, password) }
  return { url, headers }
}
