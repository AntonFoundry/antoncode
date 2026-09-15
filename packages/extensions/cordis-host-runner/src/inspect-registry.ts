/** Host registry for model-visible, read-only Cordis capability queries. */

import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { snapshotJsonValue } from '@deepseek-ai/dsh-session'
import type { JsonValue } from '@deepseek-ai/dsh-session/types'
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

interface PendingClientQuery {
  request: CordisInspectQueryRequest
  method: CordisInspectMethodManifest
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
  private readonly providers = new Map<string, HostCordisInspectProviderRegistration>()
  private readonly pending = new Map<CordisInspectRequestId, PendingClientQuery>()
  private clientManifest: readonly CordisInspectProviderManifest[] | undefined
  private nextRequest = 1

  /** Register the process-global Host registry. */
  constructor(ctx: Context) {
    super(ctx, 'cordisInspect')
  }

  /**
   * Register one Host provider.
   * @param registration - manifest and local query handler.
   * @returns idempotent disposer.
   */
  register(registration: HostCordisInspectProviderRegistration): () => void {
    const manifest = validateManifest(registration.manifest)
    if (this.providers.has(manifest.id)) throw new Error(`Host Cordis inspect provider "${manifest.id}" is already registered`)
    const stored = { ...registration, manifest }
    this.providers.set(manifest.id, stored)
    return () => {
      if (this.providers.get(manifest.id) === stored) this.providers.delete(manifest.id)
    }
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
      ...[...this.providers.values()].map(provider => view('host', provider.manifest)),
      ...(this.clientManifest ?? []).map(provider => view('client', provider)),
    ]
  }

  /** Resolve one requested Host provider id, tolerating case misses before failing with the directory. */
  private resolveHostProvider(providerId: string): HostCordisInspectProviderRegistration {
    const exact = this.providers.get(providerId)
    if (exact !== undefined) return exact
    const ids = [...this.providers.keys()]
    const caseHit = ids.find(id => id.toLowerCase() === providerId.toLowerCase())
    if (caseHit !== undefined) return this.providers.get(caseHit) as HostCordisInspectProviderRegistration
    throw unresolvedProviderError('Host', providerId, ids, 'Client', [...(this.clientManifest ?? []).map(manifest => manifest.id)])
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
   * @returns provider JSON data.
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
   * @returns whether this response settled the still-pending query.
   */
  resolveClientQuery(
    agent: Agent,
    requestId: CordisInspectRequestId,
    resolution: CordisInspectQueryResolution,
  ): CordisInspectResolveAck {
    const pending = this.pending.get(requestId)
    if (pending === undefined || pending.request.agentId !== agent.id) return { accepted: false }
    if (!resolution.ok) return { accepted: false }
    try {
      resolution = {
        ok: true,
        data: validateOutput('Client', pending.request.provider, pending.method, resolution.data),
      }
    } catch {
      return { accepted: false }
    }
    this.pending.delete(requestId)
    pending.settle(resolution)
    this.ctx.emit('cordis/inspect-query-resolved', { requestId })
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
    const requestId = `inspect-${this.nextRequest++}` as CordisInspectRequestId
    const request: CordisInspectQueryRequest = {
      requestId,
      agentId: agent.id,
      provider: provider.id,
      method: resolvedMethod,
      ...input === undefined ? {} : { input },
    }
    const result = new Promise<CordisInspectQueryResolution>((resolve) => {
      this.pending.set(requestId, { request, method, settle: resolve })
    })
    const onAbort = (): void => {
      const pending = this.pending.get(requestId)
      if (pending === undefined) return
      this.pending.delete(requestId)
      pending.settle({ ok: false, reason: 'cancelled', message: `Client inspect query ${providerId}.${resolvedMethod} was cancelled` })
      this.ctx.emit('cordis/inspect-query-resolved', { requestId })
    }
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) onAbort()
    else this.ctx.emit('cordis/inspect-query', request)
    try {
      const resolution = await result
      if (!resolution.ok) throw new Error(`${providerId}.${resolvedMethod}: ${resolution.message}`)
      return resolution.data
    } finally {
      signal.removeEventListener('abort', onAbort)
    }
  }
}

function view(platform: CordisInspectPlatform, manifest: CordisInspectProviderManifest): CordisInspectProviderView {
  return { platform, ...manifest, methods: [...manifest.methods] }
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
