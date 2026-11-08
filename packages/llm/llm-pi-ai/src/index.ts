/**
 * Generic pi-ai-backed LLM adapter plugin. One plugin instance owns a dict of
 * provider routes; a route naming an installed pi-ai provider inherits that
 * provider's endpoint, protocol, and model catalog as defaults, and a route
 * pi-ai does not ship is declared outright. Profile facts resolve per request
 * over the optional `llm-pi-ai` user-settings section and the optional
 * credential seam, so a changed key, endpoint, model, or knob reaches the next
 * request without a restart; a changed *route set* (or a route's
 * registration-captured retry policy) re-registers the same adapter instance
 * in place.
 *
 * ```yaml
 * - id: llm
 *   name: '@deepseek-ai/dsh-llm-pi-ai'
 *   config:
 *     providers:
 *       # Catalog route: everything but the credential comes from pi-ai.
 *       openai:
 *         apiKeyEnv: OPENAI_API_KEY
 *         retryPolicy:
 *           mode: normal
 *           maxRetries: 2
 *       # Catalog route with the catalog narrowed and one capacity corrected.
 *       anthropic:
 *         apiKeyEnv: ANTHROPIC_API_KEY
 *         models:
 *           - id: claude-sonnet-4-5
 *             contextWindow: 200000
 *       # Hand-declared route: pi-ai ships nothing under this key.
 *       acme-gateway:
 *         displayName: Acme Gateway
 *         apiKeyEnv: ACME_GATEWAY_API_KEY
 *         api: openai-completions
 *         baseURL: https://gateway.acme.example/v1
 *         # Reasoning dialect for a URL pi-ai cannot recognize.
 *         compat:
 *           thinkingFormat: deepseek
 *         models:
 *           - id: acme-large
 *             name: Acme Large
 *             contextWindow: 65536
 *             maxTokens: 4096
 *           - id: acme-think
 *             name: Acme Think
 *             contextWindow: 262144
 *             maxTokens: 32768
 *             # key = selectable level, value = wire spelling; only off may
 *             # leave the value empty (supported, send nothing).
 *             reasoningEfforts:
 *               off:
 *               high: high
 *               max: ultra
 * ```
 *
 * @module @deepseek-ai/dsh-llm-pi-ai
 */
import type {} from '@deepseek-ai/dsh-settings'

import type {} from '@deepseek-ai/cordis-plugin-loader'

import type { Context } from '@deepseek-ai/cordis'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { assertUsableApiKey, LlmError, resolveImageAttachmentAccess } from '@deepseek-ai/dsh-llm'
import type { AdapterRegistrationHandle, DirectoryRegistrationHandle, LlmConfigurableProvider } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-fs'
import { deepEqualJson } from '@deepseek-ai/dsh-util-values'
import { PiAiAdapter } from './adapter.ts'
import { authContextFrom, credentialStoreFrom } from './auth.ts'
import { catalogProvider, catalogProviderIds } from './catalog.ts'
import type { PiAiLiveModel, PiAiReasoningEfforts } from './catalog.ts'
import { assertServiceable, Config, DEFAULT_MODELS_DEV_REFRESH_MS, resolveProfiles } from './config.ts'
import type { ResolvedPiAiProviderProfile } from './config.ts'
import { discoverModels } from './discovery.ts'
import type { StoredModelDiscoveryProfile } from './discovery.ts'
import { registerPiAiFlows } from './login.ts'
import { fetchModelsDevDocument, parseModelsDevLiveModels, ZAI_REASONING_EFFORTS } from './models-dev.ts'
import { fetchNvidiaLlmModels, mergeNvidiaLlmModels } from './nvidia-models.ts'
import { providerDefaultsOf } from './provider-data.ts'

/**
 * The routes whose live model list refreshes from models.dev at startup,
 * mapped to their models.dev provider ids. Routes absent from this map never
 * fetch: the installed catalog is their whole model surface.
 */
const MODELS_DEV_ROUTE_PROVIDERS: Readonly<Record<string, {
  /** The models.dev provider entry the route reads. */
  id: string
  /** The effort map a reasoning-capable discovered model adopts; omitted = stay neutral. */
  efforts?: PiAiReasoningEfforts
}>> = {
  zai: { id: 'zai-coding-plan', efforts: ZAI_REASONING_EFFORTS },
  moonshotai: { id: 'moonshotai' },
  deepseek: { id: 'deepseek' },
  nvidia: { id: 'nvidia' },
}

export { PiAiAdapter } from './adapter.ts'
export type { PiAiAdapterOptions } from './adapter.ts'
export { Config } from './config.ts'
// A sibling plugin building its own profile literal defaults the image budgets
// to the same values this plugin's schema does, so the two cannot drift.
export {
  DEFAULT_MAX_REQUEST_IMAGE_BYTES,
  DEFAULT_REQUEST_IMAGE_MAX_BYTES,
  DEFAULT_REQUEST_IMAGE_PIXEL_BUDGET,
} from './config.ts'
export type {
  Options,
  PiAiCompatProfile,
  PiAiModality,
  PiAiModelOverride,
  PiAiModelProfile,
  PiAiProviderProfile,
  PiAiReasoningEfforts,
  PiAiThinkingFormat,
  ResolvedPiAiProviderProfile,
} from './config.ts'
export { recordKeyFor } from './auth.ts'
export { supportedProtocols } from './provider.ts'
// A sibling plugin that serves its own routes through a pi-ai collection needs
// the same four pieces this plugin uses to build one: the provider factory, the
// installed-catalog lookup, and the two auth injectables. Re-exported rather
// than reimplemented so both build identical collections.
export { buildProvider } from './provider.ts'
export type { ProviderSpec } from './provider.ts'
export { catalogModels, catalogProvider } from './catalog.ts'
export { authContextFrom, credentialStoreFrom } from './auth.ts'

export const name = 'llm-pi-ai'
export const inject = ['llm']

const NS = 'llm-pi-ai'

/**
 * The registry captures these per route; a change here must re-register.
 * Sorted by provider so a settings document that merely reorders its keys is
 * not mistaken for a route change.
 */
function registrationFacts(profiles: ReadonlyMap<string, ResolvedPiAiProviderProfile>): unknown {
  return [...profiles.entries()]
    // `displayName` rides along because the registry hands it to every selector
    // through `providerInfo()`: a rename that did not re-register would leave
    // the old label showing until some unrelated fact happened to change.
    .map(([provider, profile]) => ({
      provider,
      displayName: profile.displayName,
      retryPolicy: profile.retryPolicy,
    }))
    .sort((left, right) => left.provider.localeCompare(right.provider))
}

/**
 * The configurable-provider directory: every installed catalog route, plus
 * every route the current profiles declare. A hand-declared route has no
 * catalog entry, so without this union it would have no settings address and
 * configuration surfaces could neither show nor edit it. A catalog route also
 * carries its catalog endpoint and native authentication, which a settings
 * editor shows while the profile leaves the endpoint or the credential
 * reference unset.
 * @param profiles - the currently resolved provider profiles.
 * @returns the directory entries in catalog order, declared routes last.
 */
function directoryEntries(
  profiles: ReadonlyMap<string, ResolvedPiAiProviderProfile>,
  settingsNs: string,
  reservedProviders: ReadonlySet<string>,
): LlmConfigurableProvider[] {
  const entries = new Map<string, LlmConfigurableProvider>()
  const declare = (provider: string, displayName: string, error?: string): void => {
    const installed = catalogProvider(provider)
    entries.set(provider, {
      provider,
      displayName: provider === 'anthropic' && displayName === provider ? 'Anthropic' : displayName,
      settingsNs,
      settingsPath: ['providers', provider],
      // Membership of the installed catalog, not of the settings document:
      // narrowing a shipped provider's models stores a profile too, and that
      // route is still one pi-ai knows.
      declared: installed === undefined,
      ...installed === undefined ? {} : providerDefaultsOf(installed),
      ...error === undefined ? {} : { error },
    })
  }
  for (const provider of catalogProviderIds()) {
    if (!reservedProviders.has(provider)) declare(provider, provider)
  }
  for (const [provider, profile] of profiles) {
    if (!reservedProviders.has(provider)) declare(provider, profile.displayName, profile.catalogError)
  }
  return [...entries.values()]
}

/** Register one generic pi-ai adapter for all configured provider routes. */
export function apply(ctx: Context, config: Config): void {
  ctx.inject(['settings'], (child) => { child.effect(() => child.settings.configure({ auto: false }, ctx.fiber)) })
  const settingsNs = ctx.fiber.entry?.options.id ?? NS
  // Native protocol adapters may reserve the familiar route names they own.
  // Keep this static composition fact outside the live settings section: a
  // user cannot accidentally make one route belong to two adapter families.
  const reservedProviders = new Set(config.reservedProviders ?? [])
  let lastRaw: ReturnType<Config['providers']['get']> | undefined
  let memoized: ReadonlyMap<string, ResolvedPiAiProviderProfile> | undefined
  const liveModels = new Map<string, readonly PiAiLiveModel[]>()
  const refreshedRoutes = new Set<string>()
  const refreshInFlight = new Map<string, Promise<void>>()
  let modelsDevDocument: Promise<unknown> | undefined
  /**
   * The resolved profiles for the current configuration, memoized by the raw
   * snapshot's identity — which is also what makes the adapter's own snapshot
   * stable across operations that observe no change.
   *
   * Catalog diagnostics stay in the snapshot beside serviceable models, so
   * stored configuration remains visible after an installed catalog changes.
   * Scalar configuration errors still reject resolution.
   */
  const profiles = (): ReadonlyMap<string, ResolvedPiAiProviderProfile> => {
    const raw = config.providers.get()
    if (raw === lastRaw && memoized !== undefined) return memoized
    const next = resolveProfiles(structuredClone(raw) as import('./config.ts').Options['providers'], 'deferred', liveModels)
    lastRaw = raw
    memoized = next
    return next
  }
  const activeProfiles = (): ReadonlyMap<string, ResolvedPiAiProviderProfile> => {
    const next = profiles()
    for (const provider of next.keys()) {
      if (reservedProviders.has(provider)) {
        throw new Error(
          `llm-pi-ai: provider route "${provider}" is reserved by a native adapter; configure its native settings section instead`,
        )
      }
    }
    return next
  }
  profiles()
  ctx.on('internal/config', function (this: import('@deepseek-ai/cordis').Fiber, _raw, next) {
    const raw: unknown = next()
    if (this !== ctx.fiber) return raw
    const candidate = Config(raw as import('./config.ts').Options)
    assertServiceable(
      { providers: structuredClone(candidate.providers.get()) } as import('./config.ts').Options,
      { providers: structuredClone(config.providers.get()) } as import('./config.ts').Options,
    )
    return raw
  })

  const resolveApiKey = async (
    provider: string,
    profile: ResolvedPiAiProviderProfile,
  ): Promise<string | undefined> => {
    const ref = profile.apiKeyEnv
    // Only a profile that names no credential at all defers to pi-ai's
    // provider-native discovery. Once one is named, a miss must fail loud:
    // handing pi-ai `undefined` would let it pick up an unrelated ambient key
    // (OPENAI_API_KEY and friends), billing another tenant for a request the
    // deployment meant to authenticate differently.
    if (ref === undefined) return undefined
    const credentials = ctx.get('credentials')
    const hit = credentials !== undefined
      ? (await credentials.resolve(ref))?.value
      // Without the seam the environment is the whole credential plane.
      : launchEnvironmentOf(ctx).get(ref)?.value
    if (hit !== undefined && hit.length > 0) return assertUsableApiKey(hit, 'llm-pi-ai', ref)
    throw new LlmError(
      `llm-pi-ai: no credential for provider route "${provider}"; its profile resolves ${ref}, which is not`
      + ` set — store ${ref} through the credentials service (the web Models page writes it) or export it,`
      + ' and remove apiKeyEnv only if this provider should authenticate from pi-ai\'s own environment discovery',
      'MISSING_CREDENTIAL',
    )
  }

  const modelsDevDoc = (): Promise<unknown> => {
    modelsDevDocument ??= fetchModelsDevDocument()
    return modelsDevDocument
  }

  const refreshModels = async (provider: string): Promise<void> => {
    const modelsDevRoute = MODELS_DEV_ROUTE_PROVIDERS[provider]
    if (modelsDevRoute === undefined || refreshedRoutes.has(provider)) return
    const inFlight = refreshInFlight.get(provider)
    if (inFlight !== undefined) return inFlight
    const task = (async () => {
      const raw = config.providers.get()[provider]
      // Schemastery materializes an absent `models` as `[]`, and `[]` serves
      // no request, so both mean "the catalog decides" — the same reading
      // `resolveRouteModels` applies. A route that names no credential never
      // fetches: without the key the discovery fallback cannot authenticate
      // anyway, and a keyless profile is a deliberate catalog-only shape. A
      // non-empty models list is strict curation unless the route opted into
      // `liveModelUnion`, in which case the discovered ids join the list.
      if (raw === undefined) return
      if ((raw.models !== undefined && raw.models.length > 0) && raw.liveModelUnion !== true) return
      if (raw.apiKeyEnv === undefined) return
      const profile = profiles().get(provider)
      const baseURL = profile?.baseURL ?? catalogProvider(provider)?.baseUrl
      if (profile === undefined || baseURL === undefined) return
      const adopt = (discovered: readonly PiAiLiveModel[]): void => {
        liveModels.set(provider, discovered)
        lastRaw = undefined
        memoized = undefined
        refreshedRoutes.add(provider)
      }
      const gatewayListing = (): Promise<readonly PiAiLiveModel[]> =>
        discoverModels({
          provider,
          baseURL,
          api: profile.api ?? 'openai-completions',
          forceNetwork: true,
        }, () => ({ headers: profile.headers, resolveApiKey: () => resolveApiKey(provider, profile) }))
      /**
       * NVIDIA's servable chat surface: the published LLM reference unioned
       * with the account's own listing. Both raw sources are partial — the
       * `/models` endpoint is a partial catalog, and the reference documents
       * additional chat endpoints the account listing may omit — so the
       * union is the membership truth. models.dev contributes only
       * enrichment: its NVIDIA entry also lists embeddings, speech, image,
       * and video endpoints that `/v1/chat/completions` does not serve, so
       * membership from it would put unrequestable models in the pickers.
       */
      const nvidiaCatalog = async (): Promise<readonly PiAiLiveModel[]> => {
        const [documented, listed] = await Promise.all([
          fetchNvidiaLlmModels().catch(() => undefined),
          gatewayListing().catch(() => undefined),
        ])
        const servable = documented !== undefined
          ? mergeNvidiaLlmModels(documented, listed ?? [])
          : listed
        if (servable === undefined) {
          throw new Error('the NVIDIA LLM API reference and the endpoint listing are both unavailable')
        }
        let capacities = new Map<string, PiAiLiveModel>()
        try {
          capacities = new Map(
            (parseModelsDevLiveModels(await modelsDevDoc(), 'nvidia') ?? []).map(model => [model.id, model]),
          )
        } catch (_modelsDevUnavailable) {
          // Capacities are enrichment only: NVIDIA's reference and the
          // account listing already answer membership, so an unreachable
          // models.dev costs the route nothing but the fallback defaults.
        }
        return servable.map((model) => {
          const entry = capacities.get(model.id)
          return entry === undefined ? model : { ...model, ...entry }
        })
      }
      try {
        // An explicit liveModelDiscovery asks the endpoint's own listing,
        // whose answer is the most current thing the gateway serves. The
        // default reads models.dev — the catalog source OpenCode serves its
        // pickers from — so a provider's newest ids arrive at startup without
        // a dependency bump, and falls back to the endpoint listing when that
        // fetch fails for any reason; the models.dev error is subsumed by the
        // fallback attempt and, if that also fails, the diagnostic below.
        if (provider === 'nvidia') {
          adopt(await nvidiaCatalog())
          return
        }
        if (raw.liveModelDiscovery === true) {
          adopt(await gatewayListing())
          return
        }
        try {
          const parsed = parseModelsDevLiveModels(await modelsDevDoc(), modelsDevRoute.id, modelsDevRoute.efforts)
          if (parsed === undefined) throw new Error(`models.dev does not publish "${modelsDevRoute.id}"`)
          adopt(parsed)
        } catch (documentError) {
          // Only a route that speaks the OpenAI listing has an endpoint
          // fallback; the shared document fetch stays the single network read
          // the other mapped routes rely on.
          if ((profile.api ?? 'openai-completions') !== 'openai-completions') throw documentError
          adopt(await gatewayListing())
        }
      } catch (error) {
        ctx.logger.warn(`llm-pi-ai: live model discovery for "${provider}" failed; using bundled catalog (${error instanceof Error ? error.message : String(error)})`)
      }
    })()
    refreshInFlight.set(provider, task)
    try {
      await task
    } finally {
      refreshInFlight.delete(provider)
    }
  }

  // One store and one ambient context for the whole plugin instance: both read
  // through `ctx` per call, so they stay correct across the collection rebuilds
  // a configuration change causes, and a sign-in survives one.
  const auth = { credentials: credentialStoreFrom(ctx), authContext: authContextFrom(ctx) }
  const adapter = new PiAiAdapter({
    profiles,
    resolveApiKey,
    auth,
    refreshModels,
    resolveAttachments: () => ctx.get('attachments'),
    resolveImageAccess: (attachments, ref) => resolveImageAttachmentAccess(
      attachments,
      hostPath => ctx.get('fs')?.processPathFromHostPath(hostPath),
      ref,
    ),
    onReplayDegrade: ({ provider, model, reason }) => {
      ctx.logger.warn(
        `llm-pi-ai: unusable replay state on assistant history for route "${provider}/${model}";`
        + ` sending that message as provider-neutral content (${reason})`,
      )
    },
  })
  // Independent of the route set: signing in is what makes a route worth
  // adding, so the flows are offered before any profile names their provider.
  // Scoped to the authorization seam rather than injected outright, because a
  // composition without it (headless, ACP) simply has no surface to sign in
  // from, while everything else this plugin does still works.
  ctx.inject(['authorization'], (authorized) => { registerPiAiFlows(authorized, auth) })
  // The full installed catalog is configurable from the moment the plugin
  // mounts — dormant or not — so configuration surfaces can offer every
  // pi-ai provider before any route exists. Hand-declared routes join it as
  // profiles appear, and leave with them.
  let directory: DirectoryRegistrationHandle | undefined
  let directoryFacts: unknown
  const ensureDirectory = (): void => {
    const entries = directoryEntries(activeProfiles(), settingsNs, reservedProviders)
    if (deepEqualJson(entries, directoryFacts)) return
    // Atomic replace, never dispose-then-register: a route another adapter
    // family already declares (a profile keyed `deepseek-official`) would
    // otherwise leave this plugin's whole directory withdrawn and the Models
    // page empty. The candidate set is validated first, so a collision keeps
    // the previous entries serving and only costs a diagnostic.
    if (directory === undefined) {
      directory = ctx.llm.registerConfigurableProviders(entries)
    } else {
      directory.replace(entries)
    }
    directoryFacts = entries
  }
  ensureDirectory()
  /** Host-owned request inputs for discovery of one configured route. */
  const storedDiscoveryProfile = (
    provider: string | undefined,
  ): StoredModelDiscoveryProfile | undefined => {
    if (provider === undefined) return undefined
    const profile = profiles().get(provider)
    if (profile === undefined) return undefined
    return {
      headers: profile.headers,
      resolveApiKey: () => resolveApiKey(provider, profile),
    }
  }
  // Interrogating an endpoint is a configuration-time action over a draft, so
  // it is offered for the whole namespace rather than per route: the provider
  // a surface is adding does not exist yet. The draft is the whole request
  // except the stored credential and deployment-owned headers: the curated UI
  // accepts neither, so an already-configured route supplies both inside the
  // Host rather than widening the discovery request.
  ctx.llm.registerModelDiscovery(settingsNs, (request, signal) => discoverModels(
    { ...request, ...signal === undefined ? {} : { signal } },
    () => storedDiscoveryProfile(request.provider),
  ))
  // Route effects bind to this apply fiber via the stable `ctx` reference,
  // even when a swap runs inside the scoped settings callback below. A bare
  // mount (zero routes) is the dormant posture: nothing registers until a
  // settings section supplies profiles, and routes drop when it empties.
  let registration: AdapterRegistrationHandle | undefined
  let registeredFacts: unknown
  const ensureRegistrationFacts = (): void => {
    const active = activeProfiles()
    const facts = registrationFacts(active)
    if (deepEqualJson(facts, registeredFacts)) return
    // The registry captures the route set and each route's retry policy at
    // registration, so a change to either must re-register. The swap is
    // atomic (same adapter instance, validated before anything moves): a
    // conflicting route leaves the previous routes serving requests, and
    // `registeredFacts` only advances once the registry actually holds the
    // new set — so returning to a working configuration always re-applies.
    const routes = [...active.keys()]
    if (registration === undefined) {
      // Dormant bare mount: nothing is registered until a section supplies
      // profiles, and an empty section keeps it that way.
      if (routes.length === 0) {
        registeredFacts = facts
        return
      }
      registration = ctx.llm.registerAdapter(routes, adapter)
    } else {
      registration.replace(routes)
    }
    registeredFacts = facts
  }
  ensureRegistrationFacts()
  // Warm the configured ZAI catalog during plugin startup from models.dev
  // (or, with liveModelDiscovery, the endpoint itself). The static pi-ai
  // catalog remains available while this fetch is in flight; a successful
  // response invalidates the immutable profile snapshot and the next
  // picker/model read sees the provider's current IDs.
  for (const provider of Object.keys(MODELS_DEV_ROUTE_PROVIDERS)) void refreshModels(provider)
  // Re-fetch on cadence, not only at mount: models.dev republishes its
  // document continuously, so a long-lived process converges on a provider's
  // newest ids without a restart. The tick reuses the mount path exactly —
  // dropping the shared document and the refreshed set makes each mapped
  // route's next refresh a real fetch — and `refreshModels`'s own gates
  // (route configured, credential named) keep the tick a no-op elsewhere.
  // Like llm-models-dev's `catalogRefreshMs`, the delay is the mount-time
  // value; a settings-layer cadence change takes effect on restart.
  ctx.effect(() => {
    const timer = setInterval(() => {
      modelsDevDocument = undefined
      refreshedRoutes.clear()
      for (const provider of Object.keys(MODELS_DEV_ROUTE_PROVIDERS)) void refreshModels(provider)
    }, config.modelsDevRefreshMs ?? DEFAULT_MODELS_DEV_REFRESH_MS)
    return () => { clearInterval(timer) }
  })

  ctx.on('loader/volatile-update', () => {
    for (const provider of Object.keys(MODELS_DEV_ROUTE_PROVIDERS)) void refreshModels(provider)
    try { ensureRegistrationFacts(); ensureDirectory() }
    catch (error) {
      ctx.logger.error('llm-pi-ai: configuration conflicts with an existing provider route')
      ctx.logger.error(error)
    }
  })
}
