/**
 * Local opencode server discovery and authentication.
 *
 * Direct gateway calls for OpenCode's free tier returned `FreeTierError`, so
 * this provider speaks to the user's own running server instead — `GET
 * /api/model`, `POST /api/session`, `POST /api/session/:id/generate` — with
 * the same Basic credential the `opencode api` CLI subcommand uses. Every
 * request re-discovers the URL and starts the background service when absent.
 *
 * @module dsh-llm-opencode/transport
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import { LlmError } from '@deepseek-ai/dsh-llm'

/** Environment variable naming an explicit server URL; honored before file and CLI discovery. */
export const SERVER_URL_ENV = 'OPENCODE_SERVER_URL'
/** Optional executable path when a GUI process cannot resolve `opencode` on PATH. */
export const EXECUTABLE_ENV = 'OPENCODE_EXECUTABLE'
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
  /** Start the OpenCode background service when discovery finds none. */
  autoStart?: boolean
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
  /** Start the background service and return its URL; undefined when it cannot start. */
  serviceStart(): Promise<string | undefined>
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

async function serviceCommand(action: 'status' | 'start'): Promise<string | undefined> {
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const executable = process.env[EXECUTABLE_ENV]
  const candidates = executable === undefined || executable.length === 0
    ? ['opencode', join(homedir(), '.opencode', 'bin', 'opencode'), '/opt/homebrew/bin/opencode', '/usr/local/bin/opencode']
    : [executable]
  for (const candidate of new Set(candidates)) {
    try {
      const { stdout } = await promisify(execFile)(candidate, ['service', action])
      const url = stdout.trim()
      if (url.length > 0) return url
    } catch {
      // A missing executable or unavailable service leaves other installed
      // locations eligible for discovery.
    }
  }
  return undefined
}

async function defaultServiceStatus(): Promise<string | undefined> {
  return serviceCommand('status')
}

async function defaultServiceStart(): Promise<string | undefined> {
  return serviceCommand('start')
}

/**
 * Production system boundary: real environment, home, service files, and CLI discovery.
 * @param env - environment used for discovery; omission captures process.env.
 * @returns production file, home-directory, and CLI discovery operations.
 */
export function defaultSystem(env: Record<string, string | undefined> = process.env): TransportSystem {
  return {
    env,
    home: homedir(),
    readServiceFile: defaultReadServiceFile,
    readPasswordFile: defaultReadPasswordFile,
    serviceStatus: defaultServiceStatus,
    serviceStart: defaultServiceStart,
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
 * Resolve one request's server transport: explicit URL, environment override,
 * registration file, live CLI status, then optional CLI start. The file lets
 * GUI processes discover a running service without the CLI on PATH. The password comes from the
 * registration file with the password file and the server-password
 * environment variable as fallbacks; when none exists the requests go out
 * unauthenticated, which only an unsecured server (`OPENCODE_SERVER_PASSWORD`
 * unset) accepts — its 401 otherwise surfaces as `AUTH`.
 * @param config - caller-controlled transport halves.
 * @param system - injectable discovery boundary; defaults to production.
 * @returns discovered server URL and authentication headers.
 * @throws LlmError when the URL is invalid or no server can be found or started.
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
  const servicePath = config.serviceFile ?? defaultServiceFile(system.env, system.home)
  let service = await system.readServiceFile(servicePath)
  let discovered = serverURL ?? (envURL !== undefined && envURL.length > 0 ? envURL : undefined)
    ?? service?.url ?? await system.serviceStatus()
  if (discovered === undefined) {
    if (config.autoStart !== false) {
      discovered = await system.serviceStart()
      if (discovered !== undefined) service = await system.readServiceFile(servicePath)
    }
  }
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
