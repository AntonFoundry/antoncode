/**
 * OpenCode Zen OAuth over the device flow, adapted from the `opencode-zen-oauth`
 * package by duyban23 (MIT-licensed; see ATTRIBUTION below): no API keys to
 * manage — the operator approves once in the browser, the harness stores the
 * tokens, and refresh stays silent.
 *
 * Flow: `POST {console}/auth/device/code` (client `opencode-cli`) shows a
 * user code plus verification link; polling `POST {console}/auth/device/token`
 * yields access/refresh tokens; `GET {console}/api/orgs` lists workspaces to
 * bill against; `GET {console}/api/config` reads the workspace model catalog.
 * Token state lives in the credentials seam as one JSON blob (never logged),
 * under a configurable reference.
 *
 * ATTRIBUTION: protocol, endpoints, client id, polling semantics, and the
 * refresh-skew convention below follow `duyban23/pi-opencode-zen`
 * (`src/auth.ts`), MIT License, Copyright (c) duyban23.
 *
 * @module dsh-llm-opencode/zen-oauth
 */

/** OpenCode console root serving device auth and workspace reads. */
export const ZEN_CONSOLE_URL = 'https://opencode.ai/console'
/** OAuth client id the console issues device codes for. */
export const ZEN_OAUTH_CLIENT_ID = 'opencode-cli'
/** Versionless console UA: accepted without a pinned client version to drift. */
export const ZEN_CONSOLE_UA = 'opencode/cli'
/** Versionless console UA: accepted without a pinned client version to drift. */
export const ZEN_OAUTH_UA = 'opencode/cli'
/** Default credentials-seam reference holding the serialized OAuth state. */
export const DEFAULT_OAUTH_REF = 'OPENCODE_ZEN_OAUTH'
/** Inference gateway base serving the OAuth workspace session. */
export const DEFAULT_INFERENCE_BASE_URL = 'https://opencode.ai/inference/openai/v1'
/** Added poll delay after a `slow_down` answer. */
export const SLOW_DOWN_PENALTY_MS = 5_000
/** Refresh-skew guard: treat tokens as expired this early. */
const EXPIRY_SKEW_MS = 5 * 60_000

/** Durable OAuth state: tokens plus the billed workspace. */
export interface ZenOAuthState {
  /** Bearer access token for inference and console reads. */
  access: string
  /** Refresh token for silent renewal. */
  refresh: string
  /** Epoch milliseconds after which the access token must be refreshed. */
  expiresAt: number
  /** Workspace id billed for requests; absent until the operator picks one. */
  orgID?: string
  /** Workspace-allowed model ids snapshotted at login/refresh; absent means unfiltered. */
  allowedModels?: string[]
}

/** Smallest credential-source surface the OAuth helpers need. */
export interface OAuthCredentialSource {
  /** Resolve one reference to its stored value, if present. */
  resolve(ref: string): Promise<{ value: string } | undefined>
}

/** Smallest credential-sink surface the login flow needs. */
export interface OAuthCredentialSink {
  /** Durably store one value under a reference. */
  set(ref: string, value: string): Promise<void>
}

/** Operator interaction for the one-time login; injected so tests drive fakes. */
export interface ZenLoginInteraction {
  /** Show a line to the operator (code, link, progress). Never receives secrets. */
  notify(message: string): void
  /** Offer workspace choices; resolves the picked id, or `undefined` to keep Manual. */
  promptSelect(message: string, options: ReadonlyArray<{ id: string; label: string }>): Promise<string | undefined>
  /** Fires with the device code right after it issues, e.g. to open the link. */
  onDeviceCode?: (code: ZenDeviceCode) => void
  /** Cancellation for the approval wait. */
  signal?: AbortSignal | undefined
}

/** Device-code answer starting the approval wait. */
export interface ZenDeviceCode {
  deviceCode: string
  userCode: string
  verificationUri: string
  intervalSeconds: number
  expiresInSeconds: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function requiredString(record: Record<string, unknown>, field: string): string {
  const value = record[field]
  if (typeof value !== 'string' || value.length === 0) {
    throw new LlmOAuthError(`Zen device flow answered without ${field}`)
  }
  return value
}

/** Narrow, named errors for the login flow (never carrying token material). */
export class LlmOAuthError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'LlmOAuthError'
  }
}

/**
 * Parse durable OAuth state; `undefined` for anything absent or malformed.
 * @param raw - stored JSON credential value, or undefined when absent.
 * @returns validated access/refresh state with optional workspace metadata, or undefined for invalid input.
 */
export function parseOAuthState(raw: string | undefined): ZenOAuthState | undefined {
  if (raw === undefined || raw.length === 0) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(raw) as unknown
  } catch {
    return undefined
  }
  if (!isRecord(parsed)) return undefined
  if (typeof parsed.access !== 'string' || parsed.access.length === 0) return undefined
  if (typeof parsed.refresh !== 'string' || parsed.refresh.length === 0) return undefined
  if (typeof parsed.expiresAt !== 'number' || !Number.isFinite(parsed.expiresAt)) return undefined
  const state: ZenOAuthState = {
    access: parsed.access,
    refresh: parsed.refresh,
    expiresAt: parsed.expiresAt,
  }
  if (typeof parsed.orgID === 'string' && parsed.orgID.length > 0) state.orgID = parsed.orgID
  if (Array.isArray(parsed.allowedModels)
    && parsed.allowedModels.every((entry): entry is string => typeof entry === 'string')) {
    state.allowedModels = [...parsed.allowedModels]
  }
  return state
}

/**
 * Whether the access token is still usable (with refresh skew applied).
 * @param state - parsed OAuth state with an absolute expiry timestamp.
 * @param now - comparison time in milliseconds; omission uses the current clock.
 * @returns whether expiry remains beyond the refresh skew.
 */
export function isAccessValid(state: ZenOAuthState, now: number = Date.now()): boolean {
  return state.expiresAt - EXPIRY_SKEW_MS > now
}

/** Narrowing-safe abort check (a direct `?.aborted === true` comparison mis-narrows across the poll loop). */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted ?? false
}

async function postConsole(path: string, body: unknown, init?: {
  token?: string
  orgID?: string
  signal?: AbortSignal | undefined
  consoleBase?: string | undefined
}): Promise<unknown> {
  const base = init?.consoleBase ?? ZEN_CONSOLE_URL
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'user-agent': ZEN_CONSOLE_UA,
      ...(init?.token === undefined ? {} : { authorization: `Bearer ${init.token}` }),
    },
    body: JSON.stringify(body),
    ...(init?.signal === undefined ? {} : { signal: init.signal }),
  })
  if (!response.ok) {
    throw new LlmOAuthError(`Zen console answered ${path} with HTTP ${response.status}`)
  }
  return response.json() as Promise<unknown>
}

async function getConsole(path: string, init: {
  token: string
  orgID?: string
  signal?: AbortSignal | undefined
  consoleBase?: string | undefined
}): Promise<unknown> {
  const base = init.consoleBase ?? ZEN_CONSOLE_URL
  const response = await fetch(`${base}${path}`, {
    headers: {
      authorization: `Bearer ${init.token}`,
      // Console reads take the workspace in `x-org-id`; inference takes
      // `x-opencode-org-id` — the two surfaces name it differently.
      ...(init.orgID === undefined ? {} : { 'x-org-id': init.orgID }),
      'user-agent': ZEN_CONSOLE_UA,
    },
    ...(init.signal === undefined ? {} : { signal: init.signal }),
  })
  if (response.status === 401) {
    throw new LlmOAuthError(`Zen console rejected the token at ${path}; log in again`)
  }
  if (!response.ok) {
    throw new LlmOAuthError(`Zen console answered ${path} with HTTP ${response.status}`)
  }
  return response.json() as Promise<unknown>
}

/**
 * Start the device flow: returns the code the operator approves in the browser.
 * @param options - optional cancellation, console endpoint, and client overrides; omission uses provider defaults.
 * @returns the private device credential plus operator approval link, code, and polling timings.
 */
export async function requestDeviceCode(options?: {
  signal?: AbortSignal | undefined
  consoleBase?: string | undefined
  clientId?: string
}): Promise<ZenDeviceCode> {
  const payload = await postConsole('/auth/device/code', {
    client_id: options?.clientId ?? ZEN_OAUTH_CLIENT_ID,
  }, { signal: options?.signal, consoleBase: options?.consoleBase })
  if (!isRecord(payload)) throw new LlmOAuthError('Zen device flow answered without a code payload')
  const verification = payload.verification_uri_complete ?? payload.verification_uri
  if (typeof verification !== 'string' || verification.length === 0) {
    throw new LlmOAuthError('Zen device flow answered without a verification link')
  }
  return {
    deviceCode: requiredString(payload, 'device_code'),
    userCode: requiredString(payload, 'user_code'),
    verificationUri: new URL(verification, `${options?.consoleBase ?? ZEN_CONSOLE_URL}/`).href,
    intervalSeconds: typeof payload.interval === 'number' && payload.interval > 0 ? payload.interval : 5,
    expiresInSeconds: typeof payload.expires_in === 'number' && payload.expires_in > 0 ? payload.expires_in : 600,
  }
}

function credentialFrom(token: Record<string, unknown>): { access: string; refresh: string; expiresAt: number } {
  const access = requiredString(token, 'access_token')
  const refresh = requiredString(token, 'refresh_token')
  const lifetime = typeof token.expires_in === 'number' && token.expires_in > 0 ? token.expires_in : 3600
  return { access, refresh, expiresAt: Date.now() + lifetime * 1000 - EXPIRY_SKEW_MS }
}

/**
 * Poll the device token endpoint until approval, denial, or expiry.
 * @param code - allocated device code with polling interval and expiry lifetime.
 * @param options - optional cancellation, console/client overrides, and wait implementation; omission uses provider defaults and timer
 *   waits.
 * @returns granted credentials and skew-adjusted expiry; denial, expiry, and cancellation reject.
 */
export async function pollDeviceToken(code: ZenDeviceCode, options?: {
  signal?: AbortSignal | undefined
  consoleBase?: string | undefined
  clientId?: string
  sleep?: (ms: number) => Promise<void>
}): Promise<{ access: string; refresh: string; expiresAt: number }> {
  const sleep = options?.sleep ?? (async (ms: number) => {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, ms)
      options?.signal?.addEventListener('abort', () => {
        clearTimeout(timer)
        const reason: unknown = options.signal?.reason
        reject(reason instanceof Error ? reason : new Error('aborted'))
      }, { once: true })
    })
  })
  let intervalMs = code.intervalSeconds * 1000
  const deadline = Date.now() + code.expiresInSeconds * 1000
  for (;;) {
    if (Date.now() >= deadline) throw new LlmOAuthError('Zen device code expired before approval')
    await sleep(intervalMs)
    if (isAborted(options?.signal)) {
      throw new LlmOAuthError('Zen login cancelled while waiting for approval')
    }
    let answer: unknown
    try {
      answer = await postConsole('/auth/device/token', {
        client_id: options?.clientId ?? ZEN_OAUTH_CLIENT_ID,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: code.deviceCode,
      }, { signal: options?.signal, consoleBase: options?.consoleBase })
    } catch (error: unknown) {
      // A dropped poll is not a denial: keep waiting within the deadline.
      if (isAborted(options?.signal)) throw error
      continue
    }
    if (!isRecord(answer)) continue
    if (typeof answer.access_token === 'string') return credentialFrom(answer)
    if (answer.error === 'authorization_pending') continue
    if (answer.error === 'slow_down') {
      intervalMs += SLOW_DOWN_PENALTY_MS
      continue
    }
    throw new LlmOAuthError(
      `Zen login failed: ${typeof answer.error === 'string' ? answer.error : 'unknown'}`
      + (typeof answer.error_description === 'string' ? ` (${answer.error_description})` : ''),
    )
  }
}

/** Workspaces the token may bill against. */
export interface ZenOrg {
  id: string
  name: string
}

/**
 * List billable workspaces for an access token.
 * @param access - account access token used to list workspaces.
 * @param options - optional cancellation and console endpoint; omission uses the provider endpoint.
 * @returns workspace ids and labels, or an empty list when the response contains no workspace array.
 */
export async function fetchOrgs(access: string, options?: {
  signal?: AbortSignal | undefined
  consoleBase?: string | undefined
}): Promise<ZenOrg[]> {
  const payload = await getConsole('/api/orgs', { token: access, ...options })
  const entries = Array.isArray(payload) ? payload : isRecord(payload) && Array.isArray(payload.orgs) ? payload.orgs : []
  return entries
    .filter((entry): entry is Record<string, unknown> => isRecord(entry) && typeof entry.id === 'string')
    .map(entry => ({ id: entry.id as string, name: typeof entry.name === 'string' ? entry.name : entry.id as string }))
}

/**
 * Renew an access token from its refresh token, keeping the workspace.
 * @param state - stored refresh state and optional billed workspace/model metadata.
 * @param options - optional cancellation, console endpoint, and client overrides; omission uses provider defaults.
 * @returns renewed credentials with workspace retained; failed model refresh retains the old allowed-model list when present.
 */
export async function refreshAccessToken(state: ZenOAuthState, options?: {
  signal?: AbortSignal | undefined
  consoleBase?: string | undefined
  clientId?: string
}): Promise<ZenOAuthState> {
  let payload: unknown
  try {
    payload = await postConsole('/auth/device/token', {
      client_id: options?.clientId ?? ZEN_OAUTH_CLIENT_ID,
      grant_type: 'refresh_token',
      refresh_token: state.refresh,
    }, { signal: options?.signal, consoleBase: options?.consoleBase })
  } catch (error: unknown) {
    throw new LlmOAuthError('Zen token refresh failed', { cause: error })
  }
  if (!isRecord(payload) || typeof payload.access_token !== 'string') {
    const reason = isRecord(payload) && typeof payload.error === 'string' ? payload.error : 'unknown'
    throw new LlmOAuthError(`Zen token refresh failed: ${reason}`)
  }
  const renewed = credentialFrom(payload)
  const next: ZenOAuthState = {
    ...renewed,
    ...(state.orgID === undefined ? {} : { orgID: state.orgID }),
  }
  if (next.orgID !== undefined) {
    try {
      const allowed = await fetchAllowedModels(next.access, next.orgID, options)
      next.allowedModels = allowed
    } catch {
      if (state.allowedModels !== undefined) next.allowedModels = [...state.allowedModels]
    }
  }
  return next
}

/**
 * Model ids the workspace allows: not disabled, honoring whitelist/blacklist,
 * skipping console smoke-test and non-chat entries. Mirrors the workspace
 * catalog semantics (opencode itself drops deprecated entries here).
 * @param access - account access token used for console configuration.
 * @param orgID - billed workspace whose model policy is queried.
 * @param options - optional cancellation and console endpoint; omission uses the provider endpoint.
 * @returns deduplicated admitted model ids, or an empty list when no provider model entries qualify.
 */
export async function fetchAllowedModels(access: string, orgID: string, options?: {
  signal?: AbortSignal | undefined
  consoleBase?: string | undefined
}): Promise<string[]> {
  const payload = await getConsole('/api/config', { token: access, orgID, ...options })
  const providers = isRecord(payload) && isRecord(payload.config) && isRecord(payload.config.provider)
    ? payload.config.provider
    : {}
  const ids: string[] = []
  const seen = new Set<string>()
  for (const block of Object.values(providers)) {
    if (!isRecord(block) || !isRecord(block.models)) continue
    const whitelist = Array.isArray(block.whitelist)
      ? new Set(block.whitelist.filter((entry): entry is string => typeof entry === 'string'))
      : undefined
    const blacklist = new Set(
      (Array.isArray(block.blacklist) ? block.blacklist : []).filter((entry): entry is string => typeof entry === 'string'),
    )
    for (const [id, model] of Object.entries(block.models)) {
      if (!isRecord(model)) continue
      if (/^test(?:[-_.]|$)/i.test(id) || /^jev(?:[-_.]|$)/i.test(id)) continue
      if (model.disabled === true || model.status === 'deprecated') continue
      if (whitelist !== undefined && !whitelist.has(id)) continue
      if (blacklist.has(id)) continue
      if (seen.has(id)) continue
      seen.add(id)
      ids.push(id)
    }
  }
  return ids
}

/**
 * Run the one-time interactive login: show the code and link, wait for the
 * browser approval, resolve the workspace, and return the state to store.
 * The caller persists the result (credentials seam) and reports progress;
 * this function never prints or logs token material.
 * @param interaction - operator progress, workspace selection, and optional cancellation callbacks.
 * @param options - optional console/client overrides and polling wait implementation; omission uses provider defaults.
 * @returns credentials for the caller to persist, with a workspace and allowed-model snapshot when resolved.
 */
export async function runZenLogin(interaction: ZenLoginInteraction, options?: {
  consoleBase?: string
  clientId?: string
  sleep?: (ms: number) => Promise<void>
}): Promise<ZenOAuthState> {
  const code = await requestDeviceCode({ signal: interaction.signal, ...options })
  interaction.onDeviceCode?.(code)
  interaction.notify(`OpenCode Zen login: open ${code.verificationUri} and enter code ${code.userCode}`)
  interaction.notify('Leave "All workspaces" selected on the page — you will pick the workspace here after approving.')
  const tokens = await pollDeviceToken(code, { signal: interaction.signal, ...options })
  const state: ZenOAuthState = { ...tokens }
  interaction.notify('Approved. Loading workspaces…')
  const orgs = await fetchOrgs(state.access, { signal: interaction.signal, ...options })
  if (orgs.length === 1) {
    const [only] = orgs
    if (only !== undefined) state.orgID = only.id
  } else if (orgs.length > 1) {
    const picked = await interaction.promptSelect(
      'Select the workspace OpenCode requests bill against',
      orgs.map(org => ({ id: org.id, label: org.name })),
    )
    if (picked !== undefined) state.orgID = picked
  }
  if (state.orgID !== undefined) {
    try {
      state.allowedModels = await fetchAllowedModels(state.access, state.orgID, {
        signal: interaction.signal,
        ...options,
      })
    } catch {
      // Catalog fetch failed — login still works; discovery retries later.
    }
    interaction.notify(
      `Workspace ready${state.allowedModels !== undefined ? `. Models available: ${state.allowedModels.join(', ') || 'workspace defaults'}` : ''}.`,
    )
  }
  return state
}
