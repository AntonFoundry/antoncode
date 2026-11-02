/** Host registry for model-visible, read-only Cordis capability queries. */

import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-api-gateway'
import { snapshotJsonValue, type JsonValue } from '@deepseek-ai/dsh-util-values'
import { assertSupportedJsonSchema, validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import type { JsonSchemaNode } from '@deepseek-ai/dsh-tools'
import type {
  CordisInspectMethodManifest, CordisInspectPlatform, CordisInspectProviderManifest,
  CordisInspectProviderView, CordisInspectQueryRequest, CordisInspectQueryResolution,
  CordisInspectRequestId, CordisInspectResolveAck,
} from './types.ts'

/** Context supplied to a Host inspect query. */
export interface HostCordisInspectQueryContext {
  /** Tool-call cancellation. */
  signal: AbortSignal
  /** Agent whose scoped runtime is being inspected. */
  agent: Agent
}

/** Local registration paired with its serializable manifest. */
export interface HostCordisInspectProviderRegistration {
  /** Provider and explicit method directory. */
  manifest: CordisInspectProviderManifest
  /** Execute one declared method. */
  query(method: string, input: JsonValue | undefined, context: HostCordisInspectQueryContext): Promise<JsonValue>
}

/** One live provider id holding a handler per registration that still claims it. */
interface StoredHostProvider {
  /** Registration stack, newest last; the newest handler serves queries. */
  handlers: HostCordisInspectProviderRegistration[]
  /** Live claim count; the entry is removed when this reaches zero. */
  claims: number
}

interface PendingClientQuery {
  request: CordisInspectQueryRequest
  method: CordisInspectMethodManifest
  failure?: string
  settle(resolution: CordisInspectQueryResolution): void
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host registry for Cordis inspect providers and Client manifest/query routing. */
    cordisInspect: CordisInspectRegistryService
  }
}

/** Registry and cross-page router behind the two model-facing inspect tools. */
export class CordisInspectRegistryService extends Service {
  private readonly providers = new Map<string, StoredHostProvider>()
  private readonly pending = new Map<CordisInspectRequestId, PendingClientQuery>()
  private clientManifest: readonly CordisInspectProviderManifest[] | undefined
  private nextRequest = 1

  /**
   * Register the process-global Host registry.
   * @param ctx - owning Host context.
   * @param clientQueryTimeoutMs - maximum wait for a valid Client response, in milliseconds.
   */
  constructor(ctx: Context, private readonly clientQueryTimeoutMs: number) {
    super(ctx, 'cordisInspect')
    ctx.effect(() => () => {
      for (const pending of this.pending.values()) {
        pending.settle({ ok: false, reason: 'cancelled', message: 'Client inspect registry was disposed' })
      }
    }, 'cordis-inspect: pending queries')
  }

  /**
   * Register one Host provider. Preset rows re-register the same static
   * providers once per mounted session, and overlapping generations re-register
   * while the previous handler is still live, so a validated manifest equal to
   * the newest live one stacks: the newest handler serves queries and its
   * disposer restores the prior one. A different manifest under a live id is a
   * loud conflict.
   * @param registration - manifest and local query handler.
   * @returns idempotent disposer releasing this registration's claim.
   */
  register(registration: HostCordisInspectProviderRegistration): () => void {
    const manifest = validateManifest(registration.manifest)
    const existing = this.providers.get(manifest.id)
    const stored: HostCordisInspectProviderRegistration = { ...registration, manifest }
    if (existing === undefined) {
      this.providers.set(manifest.id, { handlers: [stored], claims: 1 })
    } else {
      if (!manifestEquals(this.newestHandler(existing).manifest, manifest)) {
        throw new Error(
          `Host Cordis inspect provider "${manifest.id}" is already registered with a conflicting manifest`
          + ' — a live session or package holds a different version of this provider',
        )
      }
      existing.claims += 1
      existing.handlers.push(stored)
    }
    return releaseClaim(this.providers, manifest.id, stored)
  }

  /** The newest live handler of one stored entry. */
  private newestHandler(stored: StoredHostProvider): HostCordisInspectProviderRegistration {
    return stored.handlers[stored.handlers.length - 1] as HostCordisInspectProviderRegistration
  }

  /**
   * Replace the mirrored Client provider directory.
   * @param providers - complete Client manifest snapshot.
   */
  syncClientManifest(providers: readonly CordisInspectProviderManifest[]): void {
    const ids = new Set<string>()
    const validated = providers.map((provider) => {
      const manifest = validateManifest(provider)
      if (ids.has(manifest.id)) throw new Error(`Client Cordis inspect manifest repeats provider "${manifest.id}"`)
      ids.add(manifest.id)
      return manifest
    })
    this.clientManifest = Object.freeze(validated)
  }

  /**
   * Return the complete known Host and Client provider directory.
   * @returns Host providers followed by the Client providers.
   */
  list(): CordisInspectProviderView[] {
    return [
      ...[...this.providers.values()].map(provider => view('host', this.newestHandler(provider).manifest)),
      ...(this.clientManifest ?? []).map(provider => view('client', provider)),
    ]
  }

  /** Resolve one requested Host provider id, tolerating case misses before failing with the directory. */
  private resolveHostProvider(providerId: string): HostCordisInspectProviderRegistration {
    const exact = this.providers.get(providerId)
    if (exact !== undefined) return this.newestHandler(exact)
    for (const [id, stored] of this.providers) {
      if (id.toLowerCase() === providerId.toLowerCase()) return this.newestHandler(stored)
    }
    throw unresolvedProviderError('Host', providerId, [...this.providers.keys()], 'Client', [...(this.clientManifest ?? []).map(manifest => manifest.id)])
  }

  /** Resolve one requested Client provider manifest, tolerating case misses before failing with the directory. */
  private resolveClientProvider(providerId: string): CordisInspectProviderManifest {
    const manifest = this.clientManifest ?? []
    const exact = manifest.find(candidate => candidate.id === providerId)
    if (exact !== undefined) return exact
    const ids = manifest.map(candidate => candidate.id)
    const caseHit = ids.find(id => id.toLowerCase() === providerId.toLowerCase())
    if (caseHit !== undefined) return manifest.find(candidate => candidate.id === caseHit) as CordisInspectProviderManifest
    throw unresolvedProviderError('Client', providerId, ids, 'Host', [...this.providers.keys()])
  }

  /**
   * Execute one provider query on its owning platform.
   * @param platform - Host or Client runtime.
   * @param providerId - provider selected from {@link list}.
   * @param methodName - declared method name.
   * @param input - optional lossless JSON input.
   * @param agent - requesting Agent and scope.
   * @param signal - tool-call cancellation.
   * @returns provider JSON data; Client queries fail fast when Gateway has no live Client
   * and retain only the first observed failure diagnostic for timeout reporting.
   */
  async query(
    platform: CordisInspectPlatform,
    providerId: string,
    methodName: string,
    input: JsonValue | undefined,
    agent: Agent,
    signal: AbortSignal,
  ): Promise<JsonValue> {
    if (platform === 'host') {
      const registration = this.resolveHostProvider(providerId)
      const resolvedMethod = resolveMethodName(registration.manifest, methodName)
      const method = findMethod(registration.manifest, resolvedMethod)
      validateInput('Host', providerId, method, input)
      signal.throwIfAborted()
      const data = await registration.query(resolvedMethod, input, { agent, signal })
      signal.throwIfAborted()
      return validateOutput('Host', providerId, method, data)
    }
    return await this.queryClient(providerId, methodName, input, agent, signal)
  }

  /**
   * Accept the first valid Client response for a pending query.
   * @param agent - Agent whose Session owns the query.
   * @param requestId - Pending Client query identity.
   * @param resolution - Client provider result or failure.
   * @returns acknowledgement with accepted true only for a success that settles the query; only the first failure diagnostic is retained.
   */
  resolveClientQuery(
    agent: Agent,
    requestId: CordisInspectRequestId,
    resolution: CordisInspectQueryResolution,
  ): CordisInspectResolveAck {
    const pending = this.pending.get(requestId)
    if (pending === undefined || pending.request.agentId !== agent.id) return { accepted: false }
    // A failed page must not prevent another page from supplying a valid result.
    if (!resolution.ok) {
      pending.failure ??= `${resolution.reason}: ${resolution.message}`
      return { accepted: false }
    }
    try {
      resolution = {
        ok: true,
        data: validateOutput('Client', pending.request.provider, pending.method, resolution.data),
      }
    } catch (error) {
      pending.failure ??= error instanceof Error ? error.message : String(error)
      return { accepted: false }
    }
    pending.settle(resolution)
    return { accepted: true }
  }

  private async queryClient(
    providerId: string,
    methodName: string,
    input: JsonValue | undefined,
    agent: Agent,
    signal: AbortSignal,
  ): Promise<JsonValue> {
    const provider = this.resolveClientProvider(providerId)
    const resolvedMethod = resolveMethodName(provider, methodName)
    const method = findMethod(provider, resolvedMethod)
    validateInput('Client', providerId, method, input)
    signal.throwIfAborted()
    const gateway = this.ctx.get('typertGateway')
    if (gateway !== undefined && !gateway.hasLiveClient()) {
      throw new Error(`Client inspect query ${providerId}.${resolvedMethod} has no connected Harness page. Open or reconnect the Harness page, then retry.`)
    }
    const requestId = `inspect-${this.nextRequest++}` as CordisInspectRequestId
    const request: CordisInspectQueryRequest = {
      requestId,
      agentId: agent.id,
      provider: provider.id,
      method: resolvedMethod,
      ...input === undefined ? {} : { input },
    }
    const result = new Promise<CordisInspectQueryResolution>((resolve) => {
      this.pending.set(requestId, {
        request,
        method,
        settle: (resolution) => {
          this.pending.delete(requestId)
          resolve(resolution)
          try {
            this.ctx.emit('cordis/inspect-query-resolved', { requestId })
          } catch (error) {
            console.error('[cordis-host-runner] notifying Client inspect completion failed:', error)
          }
        },
      })
    })
    const onAbort = (): void => {
      this.pending.get(requestId)?.settle({
        ok: false,
        reason: 'cancelled',
        message: `Client inspect query ${providerId}.${resolvedMethod} was cancelled`,
      })
    }
    const timer = setTimeout(() => {
      const pending = this.pending.get(requestId)
      if (pending === undefined) return
      const detail = pending.failure === undefined
        ? 'Open or reconnect the Harness page, then retry.'
        : `Client failure: ${pending.failure}`
      pending.settle({
        ok: false,
        reason: 'provider-error',
        message: `Client inspect query ${providerId}.${resolvedMethod} timed out after ${this.clientQueryTimeoutMs}ms. ${detail}`,
      })
    }, this.clientQueryTimeoutMs)
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      if (signal.aborted) onAbort()
      else this.ctx.emit('cordis/inspect-query', request)
      const resolution = await result
      if (!resolution.ok) throw new Error(`${providerId}.${resolvedMethod}: ${resolution.message}`)
      return resolution.data
    } finally {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      this.pending.delete(requestId)
    }
  }
}

function view(platform: CordisInspectPlatform, manifest: CordisInspectProviderManifest): CordisInspectProviderView {
  return { platform, ...manifest, methods: [...manifest.methods] }
}

/**
 * Build the idempotent disposer for one registration claim.
 * @param providers - the live provider map.
 * @param id - provider id the claim was taken under.
 * @param stored - the claim's own handler entry in the stack.
 * @returns a disposer that removes the handler and decrements the claim,
 * restoring the prior handler while claims remain and removing the entry at
 * zero; it is a no-op once the entry was replaced.
 */
function releaseClaim(
  providers: Map<string, StoredHostProvider>,
  id: string,
  stored: HostCordisInspectProviderRegistration,
): () => void {
  let released = false
  return () => {
    if (released) return
    const entry = providers.get(id)
    if (entry === undefined || !entry.handlers.includes(stored)) return
    released = true
    entry.handlers = entry.handlers.filter(handler => handler !== stored)
    entry.claims -= 1
    if (entry.claims === 0) providers.delete(id)
  }
}

/** Whether two validated manifests declare the identical directory. */
function manifestEquals(a: CordisInspectProviderManifest, b: CordisInspectProviderManifest): boolean {
  return a.id === b.id && a.description === b.description
    && a.methods.length === b.methods.length
    && a.methods.every((method, index) => {
      const other = b.methods[index] as CordisInspectMethodManifest
      return method.name === other.name && method.description === other.description
        && jsonEquals(method.inputSchema, other.inputSchema)
        && jsonEquals(method.outputSchema, other.outputSchema)
    })
}

/** Deep equality over lossless JSON values, key order insensitive. */
function jsonEquals(a: JsonValue, b: JsonValue): boolean {
  if (a === b) return true
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b)
      && a.length === b.length
      && a.every((item, index) => jsonEquals(item, b[index] as JsonValue))
  }
  if (typeof a === 'object' && a !== null && typeof b === 'object' && b !== null) {
    const aRecord = a as Record<string, JsonValue>
    const bRecord = b as Record<string, JsonValue>
    const aKeys = Object.keys(aRecord).sort()
    const bKeys = Object.keys(bRecord).sort()
    return aKeys.length === bKeys.length && aKeys.every((key, index) => {
      const otherKey = bKeys[index] as string
      const aValue = aRecord[key]
      const bValue = bRecord[otherKey]
      return key === otherKey && aValue !== undefined && bValue !== undefined && jsonEquals(aValue, bValue)
    })
  }
  return false
}

function validateManifest(manifest: CordisInspectProviderManifest): CordisInspectProviderManifest {
  if (manifest.id.trim() === '') throw new Error('Cordis inspect provider id must not be empty')
  if (manifest.description.trim() === '') throw new Error(`Cordis inspect provider "${manifest.id}" needs a description`)
  const names = new Set<string>()
  const methods = manifest.methods.map((method) => {
    if (method.name.trim() === '') throw new Error(`Cordis inspect provider "${manifest.id}" has an empty method name`)
    if (names.has(method.name)) throw new Error(`Cordis inspect provider "${manifest.id}" repeats method "${method.name}"`)
    if (method.description.trim() === '') throw new Error(`Cordis inspect method ${manifest.id}.${method.name} needs a description`)
    assertSupportedJsonSchema(method.inputSchema)
    assertSupportedJsonSchema(method.outputSchema)
    names.add(method.name)
    return Object.freeze({ ...method })
  })
  return Object.freeze({ ...manifest, methods: Object.freeze(methods) })
}

function findMethod(manifest: CordisInspectProviderManifest, name: string): CordisInspectMethodManifest {
  const method = manifest.methods.find(candidate => candidate.name === name)
  if (method !== undefined) return method
  const declared = manifest.methods.map(candidate => candidate.name)
  throw new Error(
    `Cordis inspect provider "${manifest.id}" has no method "${name}"; declared methods: `
    + `${declared.join(', ')}. Call cordis_inspect_list for each method's schemas.`,
  )
}

/**
 * Strip a `Provider.method` qualified name to its bare method name. Models
 * frequently emit the qualified form; the provider is already selected
 * separately, so the prefix carries no selection information.
 * @param manifest - provider manifest whose method names are candidates.
 * @param name - requested method name, bare or `Provider.method`.
 * @returns the bare method name to look up.
 */
function resolveMethodName(manifest: CordisInspectProviderManifest, name: string): string {
  const dot = name.lastIndexOf('.')
  if (dot < 0) return name
  const bare = name.slice(dot + 1)
  return manifest.methods.some(candidate => candidate.name === bare) ? bare : name
}

/**
 * Build the model-facing failure for a provider id that matches no registration,
 * carrying the directory the miss was reaching for plus any cross-platform hit.
 * @param platform - platform the query named.
 * @param providerId - requested provider id.
 * @param known - provider ids registered on `platform`.
 * @param otherPlatform - the opposite platform.
 * @param otherKnown - provider ids registered on `otherPlatform`.
 * @returns an error whose message names every resolvable referent.
 */
function unresolvedProviderError(
  platform: 'Host' | 'Client',
  providerId: string,
  known: readonly string[],
  otherPlatform: 'Host' | 'Client',
  otherKnown: readonly string[],
): Error {
  const parts = [
    `${platform} Cordis inspect provider "${providerId}" is not registered`,
    known.length > 0
      ? `registered ${platform} providers: ${known.join(', ')}`
      : `no ${platform} providers are registered`,
  ]
  const lower = providerId.toLowerCase()
  const crossHit = otherKnown.find(id => id.toLowerCase() === lower)
  if (crossHit !== undefined) parts.push(`provider "${crossHit}" exists on the ${otherPlatform} platform; resend the query with platform set accordingly`)
  else if (otherKnown.length > 0) parts.push(`${otherPlatform} providers: ${otherKnown.join(', ')}`)
  parts.push('call cordis_inspect_list for the full directory')
  return new Error(`${parts.join('; ')}`)
}

function validateInput(
  platform: 'Host' | 'Client',
  provider: string,
  method: CordisInspectMethodManifest,
  input: JsonValue | undefined,
): void {
  const violations = validateJsonSchemaValue(method.inputSchema as JsonSchemaNode, input ?? {}, 'input')
  if (violations.length > 0) throw new Error(`${platform} Cordis inspect ${provider}.${method.name} rejected input: ${violations.join('; ')}`)
}

function validateOutput(
  platform: 'Host' | 'Client',
  provider: string,
  method: CordisInspectMethodManifest,
  data: JsonValue,
): JsonValue {
  const snapshot = snapshotJsonValue(data)
  if (snapshot === undefined) throw new Error(`${platform} Cordis inspect ${provider}.${method.name} returned a non-JSON value`)
  const violations = validateJsonSchemaValue(method.outputSchema as JsonSchemaNode, snapshot, 'output')
  if (violations.length > 0) throw new Error(`${platform} Cordis inspect ${provider}.${method.name} returned invalid output: ${violations.join('; ')}`)
  return snapshot
}
