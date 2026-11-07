/** Validated Host route-recovery configuration; no policy is inferred from model names. */
import { z } from 'zod'

const routeSchema = z.object({ provider: z.string().min(1), model: z.string().min(1) }).strict()
const schema = z.object({
  enabled: z.boolean().default(false),
  chains: z.array(z.object({
    primary: routeSchema,
    fallbacks: z.array(routeSchema).min(1).max(32),
  }).strict()).max(64).default([]),
  cooldownMs: z.number().int().positive().max(2_147_483_647).default(300_000),
  sameRouteRetries: z.number().int().min(0).max(10).default(1),
  retryDelayMs: z.number().int().min(1).max(60_000).default(500),
  maxAttempts: z.number().int().min(1).max(64).default(8),
  maxElapsedMs: z.number().int().min(1).max(2_147_483_647).default(120_000),
  contextHeadroomTokens: z.number().int().min(0).max(1_000_000).default(8192),
}).strict()

/** Optional failover policy; omission preserves the provider's existing retry behavior. */
export interface FailoverConfig {
  /** Enable automatic route recovery; omission is false. */
  enabled?: boolean
  /** Exact ordered alternatives per primary; enabled policies require at least one chain. */
  chains?: Array<{
    /** Primary route whose failures activate these ordered alternatives. */
    primary: {
      /** Registered provider ID. */
      provider: string
      /** Exact model ID within the provider. */
      model: string
    }
    /** Ordered alternatives; each chain requires one through 32 distinct routes. */
    fallbacks: Array<{
      /** Registered provider ID. */
      provider: string
      /** Exact model ID within the provider. */
      model: string
    }>
  }>
  /** Session-local fallback duration in milliseconds; default 300000. */
  cooldownMs?: number
  /** Same-route transient retries before switching; default 1, maximum 10. */
  sameRouteRetries?: number
  /** Minimum same-route retry delay in milliseconds; default 500. */
  retryDelayMs?: number
  /** Maximum failed requests and rejected candidates per step; default 8, maximum 64. */
  maxAttempts?: number
  /** Recovery budget through target admission, preparation and streaming in milliseconds; default 120000. */
  maxElapsedMs?: number
  /** Additional conservative request-capacity reserve; default 8192 tokens. */
  contextHeadroomTokens?: number
}
/** Complete validated limits and ordered exact routes for one plugin activation. */
export type ResolvedFailoverConfig = z.output<typeof schema>
/** Exact provider/model pair; reasoning effort resolves anew on a different route. */
export type FailoverRoute = z.infer<typeof routeSchema>

/**
 * Validate policy limits, duplicate primary routes and cyclic candidate chains.
 * @param input - optional Host policy configuration.
 * @returns complete detached settings, disabled when omitted.
 */
export function resolveFailoverConfig(input: FailoverConfig | undefined): ResolvedFailoverConfig {
  const config = schema.parse(input ?? {})
  const primaries = new Set<string>()
  for (const chain of config.chains) {
    const primary = routeKey(chain.primary)
    if (primaries.has(primary)) throw new Error(`llm-retry: duplicate failover primary ${primary}`)
    primaries.add(primary)
    const routes = new Set([primary])
    for (const candidate of chain.fallbacks) {
      const key = routeKey(candidate)
      if (routes.has(key)) throw new Error(`llm-retry: duplicate or cyclic failover route ${key}`)
      routes.add(key)
    }
  }
  if (config.enabled && config.chains.length === 0) {
    throw new Error('llm-retry: enabled failover requires at least one ordered route chain')
  }
  return config
}

/**
 * Encode one exact route without confusing slash-bearing provider or model IDs.
 * @param route - provider/model pair.
 * @returns a collision-free key for comparisons and durable policy state.
 */
export function routeKey(route: FailoverRoute): string {
  return JSON.stringify([route.provider, route.model])
}
