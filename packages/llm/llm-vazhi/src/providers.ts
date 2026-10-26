/**
 * The Vazhi upstream table and failure policy, ported from vazhi
 * (https://github.com/itsgg/vazhi, MIT, (c) itsgg).
 *
 * Base URLs live here and nowhere else. A downloaded pool document can only
 * name a model that its provider's own admission rule accepts, so a tampered
 * pool can neither move a prompt to another endpoint nor admit a paid model.
 * The cooldown table is provider wording, not deployment preference: it stays
 * a fixed external spec rather than configuration.
 *
 * @module @deepseek-ai/dsh-llm-vazhi/providers
 */

const SECOND = 1_000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE

/** One upstream the pool can route to. */
export interface UpstreamSpec {
  /** OpenAI-compatible base; `/chat/completions` is appended. */
  readonly base: string
  /** The provider rejects any Authorization header, so no key is resolved. */
  readonly anonymous?: true
  /** Credential reference naming this upstream's free key. */
  readonly env?: string
  /** Fixed headers the provider needs beside the bearer token. */
  readonly headers?: Readonly<Record<string, string>>
  /** Whether this upstream's free tier admits the model id. */
  readonly free: (model: string) => boolean
}

/** Every upstream the pool may name, keyed by the pool's provider segment. */
export const PROVIDERS: Readonly<Record<string, UpstreamSpec>> = {
  kilo: {
    base: 'https://api.kilo.ai/api/gateway',
    anonymous: true,
    free: model => model.endsWith(':free') || model.endsWith('/free'),
  },
  ovh: {
    base: 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1',
    anonymous: true,
    free: () => true,
  },
  llm7: {
    base: 'https://api.llm7.io/v1',
    anonymous: true,
    free: () => true,
  },
  nvidia: {
    base: 'https://integrate.api.nvidia.com/v1',
    env: 'NVIDIA_API_KEY',
    // Ask NVIDIA to give up after 5 s instead of holding a request for an hour.
    headers: { 'NVCF-POLL-SECONDS': '5' },
    free: () => true,
  },
  google: {
    base: 'https://generativelanguage.googleapis.com/v1beta/openai',
    env: 'GEMINI_API_KEY',
    free: model => /^gemini-\d+(\.\d+)?-flash(-lite)?$/.test(model),
  },
  openrouter: {
    base: 'https://openrouter.ai/api/v1',
    env: 'OPENROUTER_API_KEY',
    free: model => model.endsWith(':free') || model === 'openrouter/free',
  },
  'ollama-cloud': {
    base: 'https://ollama.com/v1',
    env: 'OLLAMA_API_KEY',
    free: model => ['nemotron-3-ultra', 'gpt-oss:120b', 'gemma4:31b'].includes(model),
  },
  'zai-free': {
    base: 'https://api.z.ai/api/paas/v4',
    env: 'ZAI_API_KEY',
    free: model => ['glm-4.7-flash', 'glm-4.5-flash'].includes(model),
  },
}

/**
 * Split a pool model key into its upstream provider and the id that provider
 * receives on the wire.
 * @param key - `provider/model` as stored in the pool.
 * @returns the provider segment and everything after the first slash.
 */
export function splitModelKey(key: string): [provider: string, model: string] {
  const slash = key.indexOf('/')
  if (slash <= 0 || slash === key.length - 1) {
    throw new Error(`llm-vazhi: "${key}" is not a provider/model key`)
  }
  return [key.slice(0, slash), key.slice(slash + 1)]
}

/**
 * Whether a provider's free tier admits one model id.
 * @param provider - upstream key.
 * @param model - wire model id within that upstream.
 * @returns true when the provider's admission rule accepts the id.
 */
export function allowedInPool(provider: string, model: string): boolean {
  return PROVIDERS[provider]?.free(model) === true
}

/** One resolved upstream attempt: where a request goes and how it authenticates. */
export interface VazhiEndpoint {
  /** OpenAI-compatible base; the transport appends `/chat/completions`. */
  readonly baseURL: string
  /** Wire model id this upstream receives. */
  readonly model: string
  /** Headers the attempt sends, including the bearer token for a keyed upstream. */
  readonly headers: Readonly<Record<string, string>>
  /** The bearer token, or undefined for an anonymous upstream. */
  readonly apiKey?: string
}

/**
 * Resolve where one pool model is reached.
 * @param key - `provider/model` pool entry.
 * @param apiKey - resolved key for a keyed upstream; ignored for an anonymous one.
 * @returns the attempt facts, or undefined for an unknown provider or a keyed
 * upstream with no key.
 */
export function endpointFor(key: string, apiKey: string | undefined): VazhiEndpoint | undefined {
  const [provider, model] = splitModelKey(key)
  const spec = PROVIDERS[provider]
  if (spec === undefined) return undefined
  if (spec.anonymous === true) return { baseURL: spec.base, model, headers: {} }
  if (apiKey === undefined) return undefined
  return { baseURL: spec.base, model, headers: spec.headers ?? {}, apiKey }
}

/**
 * The credential reference a keyed upstream resolves, or undefined when it is anonymous.
 * @param provider - upstream key from a pool model.
 * @returns the environment-style reference naming that upstream's free key.
 */
export function credentialRefOf(provider: string): string | undefined {
  return PROVIDERS[provider]?.env
}

/** One classified failure: the cooldown it starts and how far it may grow. */
export interface FailureClass {
  /** Stable kind used by the shared-limit rule and the stored reason. */
  readonly kind: string
  /** First-failure cooldown. */
  readonly baseMs: number
  /** Consecutive-failure ceiling. */
  readonly maxMs: number
}

type KindRule = readonly [kind: string, pattern: RegExp, baseMs: number, maxMs: number]

/** A hang, which NVIDIA reports early as a 504 instead of a timeout. */
const SLOW: KindRule = ['slow', /timed? ?out|timeout|ETIMEDOUT/i, 15 * MINUTE, 2 * HOUR]

/**
 * Kinds tried in order; the first match wins, and an unmatched text is the
 * `other` class. Base doubles with each consecutive failure, up to the maximum.
 */
const KINDS: readonly KindRule[] = [
  ['auth', /\b401\b|unauthori[sz]ed|invalid.{0,20}(api.?key|token|credential)|api.?key.{0,20}(not valid|invalid)|incorrect api key|missing api key|authentication/i, 6 * HOUR, 6 * HOUR],
  ['denied', /\b403\b|forbidden|permission|not allowed|not available in your/i, HOUR, 6 * HOUR],
  ['minute', /per.?min|\brpm\b|\btpm\b/i, MINUTE, 30 * MINUTE],
  ['hourly', /per.?hour|hourly|req\/hr|\brph\b/i, 15 * MINUTE, HOUR],
  ['daily', /per.?day|daily|\brpd\b|\btpd\b|weekly|monthly|session limit/i, HOUR, 6 * HOUR],
  ['quota', /quota|exhausted|insufficient|billing|credit|usage limit|balance|payment required|\b402\b/i, HOUR, 6 * HOUR],
  ['gone', /\b404\b|\b410\b|not.?found|does not exist|unavailable_model|no longer|deprecated|decommissioned/i, HOUR, 6 * HOUR],
  SLOW,
  ['rate', /\b429\b|rate.?limit|too many requests|concurrent|throttl|overloaded|capacity/i, 30 * SECOND, 30 * MINUTE],
  ['client', /\b(400|413|422)\b|bad request|invalid request|unprocessable|thought.?signature/i, 5 * MINUTE, 5 * MINUTE],
]

/** Kinds whose cooldown also cools the whole upstream when a shared-limit provider reports them. */
export const SHARED_KINDS: ReadonlySet<string> = new Set(['minute', 'hourly', 'daily', 'quota', 'rate'])

/**
 * Classify one failure from the text a provider or transport reported.
 * @param text - error code and message.
 * @param provider - upstream key, when known; NVIDIA reports a hang as a 504.
 * @returns the matching failure class.
 */
export function classify(text: string, provider?: string): FailureClass {
  if (provider === 'nvidia' && /^\s*504\b/.test(text)) {
    return { kind: SLOW[0], baseMs: SLOW[2], maxMs: SLOW[3] }
  }
  let match: FailureClass = { kind: 'other', baseMs: MINUTE, maxMs: 30 * MINUTE }
  for (const [kind, pattern, baseMs, maxMs] of KINDS) {
    if (!pattern.test(text)) continue
    match = { kind, baseMs, maxMs }
    break
  }
  return match
}

const UNITS = 'milliseconds?|ms|seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h'

function toMs(value: string | undefined, unit: string | undefined): number {
  const normalized = (unit ?? 's').toLowerCase()
  const scale = normalized === 'ms' || normalized.startsWith('milli')
    ? 1
    : normalized.startsWith('h')
      ? HOUR
      : normalized.startsWith('m') ? MINUTE : SECOND
  return Number(value) * scale
}

/** One stated component of a `try again in` delay. */
function timeOf(value: string | undefined, scale: number): number {
  return value === undefined ? 0 : Number(value) * scale * SECOND
}

/**
 * The delay a provider asked for, from the wordings it uses. A bare number is
 * seconds, matching the `Retry-After` header convention.
 * @param text - provider error text or a header value.
 * @returns the requested delay in milliseconds, or undefined when none is stated.
 */
export function parseRetryAfter(text: string): number | undefined {
  for (const pattern of [
    new RegExp(`retry[-_ ]?after["':\\s]*(\\d+(?:\\.\\d+)?)\\s*(${UNITS})?\\b`, 'i'),
    new RegExp(`retry in\\s+(\\d+(?:\\.\\d+)?)\\s*(${UNITS})?\\b`, 'i'),
    /retryDelay["':\s]*"?(\d+(?:\.\d+)?)(s)\b/i,
  ]) {
    const stated = pattern.exec(text)
    if (stated !== null) return toMs(stated[1], stated[2])
  }
  const compact = /try again in\s+(?:(\d+)h)?\s*(?:(\d+)m(?!s))?\s*(?:(\d+(?:\.\d+)?)s)?/i.exec(text)
  if (compact !== null) {
    const [hours, minutes, seconds]: ReadonlyArray<string | undefined> = compact.slice(1)
    if (hours !== undefined || minutes !== undefined || seconds !== undefined) {
      return timeOf(hours, 3_600) + timeOf(minutes, 60) + timeOf(seconds, 1)
    }
  }
  const worded = new RegExp(`try again in\\s+(\\d+(?:\\.\\d+)?)\\s*(${UNITS})\\b`, 'i').exec(text)
  return worded === null ? undefined : toMs(worded[1], worded[2])
}

/**
 * Render a cooldown for a user-facing message.
 * @param ms - duration in milliseconds.
 * @returns the rounded duration in seconds, minutes, or hours.
 */
export function formatDuration(ms: number): string {
  if (ms < MINUTE) return `${Math.ceil(ms / SECOND)}s`
  if (ms < HOUR) return `${Math.ceil(ms / MINUTE)}m`
  return `${(ms / HOUR).toFixed(1)}h`
}
