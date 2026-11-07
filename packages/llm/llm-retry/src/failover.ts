/** Host-owned ordered route recovery, durable cooldowns and bounded attempt history. */
import type { Context, Events } from '@deepseek-ai/cordis'
import type { Agent, ModelSelection, RequestErrorAction } from '@deepseek-ai/dsh-agent'
import type { Session, EpochHeader } from '@deepseek-ai/dsh-session'
import { boundContextSummary, contentHasImage, createUserMessage, LlmError, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { ProjectionHandle } from '@deepseek-ai/dsh-session-projection'
import { z } from 'zod'
import type { FailoverAttempt, LlmFailoverEventData } from './types.ts'
import { routeKey, type ResolvedFailoverConfig } from './failover-config.ts'

const selectionSchema = z.object({
  provider: z.string(), model: z.string(),
  reasoningEffort: z.string().transform(ReasoningEffortId).exactOptional(),
})
const stateSchema = z.object({
  sticky: z.object({ primary: selectionSchema, previous: selectionSchema, effective: selectionSchema, until: z.number() }).nullable(),
  attempts: z.array(z.object({ selection: selectionSchema, code: z.string() })).max(64),
  startedAt: z.number().nullable(),
  manualRevision: z.number().int().nonnegative(),
})
type State = z.infer<typeof stateSchema>
type FailurePayload = Parameters<Events['agent/request-error']>[0]
const ELIGIBLE = new Set(['QUOTA', 'ACCOUNT_QUOTA', 'QUOTA_EXCEEDED', 'RATE_LIMIT', 'OVERLOADED', 'MODEL_UNAVAILABLE', 'SERVER'])
const QUOTA = new Set(['QUOTA', 'ACCOUNT_QUOTA', 'QUOTA_EXCEEDED'])

/** Structural read face avoids a dependency cycle with the optional token-meter consumer. */
interface RequestPressureMeter {
  measure(session: Session, header: EpochHeader): { readonly totalTokens: number }
}

function initial(): State { return { sticky: null, attempts: [], startedAt: null, manualRevision: 0 } }
function label(selection: ModelSelection): string { return `${selection.provider}/${selection.model}` }
function stopped(signal: AbortSignal, lifetime: AbortSignal): boolean { return signal.aborted || lifetime.aborted }

function notice(agent: Agent, text: string): void {
  agent.session.append('user/message', createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'model-failover', form: 'notice', summary: boundContextSummary(text) },
  }), { surfaceOp: 'append' })
}

/**
 * Install automatic route recovery without changing global or manual model preferences.
 * @param ctx - Host plugin context; registrations and waits belong to its lifetime.
 * @param config - complete validated limits and ordered exact route chains.
 * @param lifetime - plugin cancellation signal shared with retry waits.
 * @param wait - cancellable retry delay returning false when interrupted.
 * @returns policy callback; undefined delegates to ordinary provider recovery.
 */
export async function installFailover(
  ctx: Context,
  config: ResolvedFailoverConfig,
  lifetime: AbortSignal,
  wait: (delayMs: number, signal: AbortSignal) => Promise<boolean>,
): Promise<(payload: FailurePayload) => Promise<RequestErrorAction>> {
  const operations = new Set<Promise<unknown>>()
  const admittedRevision = new WeakMap<Agent, number>()
  function track<T>(operation: Promise<T>): Promise<T> {
    const tracked = operation.finally(() => operations.delete(tracked))
    operations.add(tracked)
    return tracked
  }
  ctx.effect(() => async () => { await Promise.allSettled([...operations]) })
  const handle: ProjectionHandle<State> = await ctx.sessionProjections.register({
    key: 'llmFailover', stateVersion: 2, stateSchema,
    init: initial,
    apply: (state, event) => {
      if (event.type === 'model/selection') return { ...initial(), manualRevision: state.manualRevision + 1 }
      if (event.type === 'step/start') {
        return { ...state, attempts: [], startedAt: null }
      }
      if (event.type === 'turn/end') {
        return state.attempts.length === 0 && state.startedAt === null
          ? state : { ...state, attempts: [], startedAt: null }
      }
      if (event.type === 'llm/failover') {
        return { ...state, sticky: {
          primary: event.data.primary, previous: event.data.from, effective: event.data.to, until: event.data.cooldownUntil,
        } }
      }
      if (event.type === 'assistant/message' && state.sticky !== null
        && routeKey(state.sticky.primary) === routeKey(state.sticky.effective)) {
        return { ...state, sticky: null }
      }
      if (event.type === 'llm/failover-attempt') {
        return { ...state, startedAt: state.startedAt ?? event.data.startedAt,
          attempts: [...state.attempts.slice(-63), event.data.attempt] }
      }
      return state
    },
  })
  const chainFor = (selection: ModelSelection) => config.chains.find(chain => routeKey(chain.primary) === routeKey(selection))

  function switchRoute(agent: Agent, data: LlmFailoverEventData): void {
    agent.session.append('llm/failover', data)
    notice(agent, `[automatic model switch: ${label(data.from)} → ${label(data.to)}; ${data.failureCode ?? data.reason}]`)
  }

  async function compatibility(
    agent: Agent, from: ModelSelection, to: ModelSelection, signal: AbortSignal,
    pending: readonly UserMessage[] = [],
    final = false,
  ): Promise<string | undefined> {
    const llm = ctx.get('llm')
    if (llm === undefined) throw new Error('llm-retry: enabled failover requires the llm service')
    const previousContext = agent.session.requestContext()
    let sourceWindow = previousContext?.provider === from.provider && previousContext.model === from.model
      ? previousContext.contextWindow : undefined
    try {
      sourceWindow = (await llm.resolveModelInfo(from.provider, from.model, signal)).context?.contextWindow ?? sourceWindow
    } catch (error) {
      if (!(error instanceof LlmError) || error.code !== 'MODEL_UNAVAILABLE') throw error
    }
    const target = await llm.resolveModelInfo(to.provider, to.model, signal)
    if (target.context === undefined) return 'UNKNOWN_CONTEXT_CAPACITY'
    const messages = [...agent.session.deriveMessages(), ...pending]
    if (messages.some(message => contentHasImage(message.content)) && !target.inputModalities?.includes('image')) {
      return 'UNSUPPORTED_IMAGE_INPUT'
    }
    const currentHeader = agent.session.requestHeader()
    const explicitMaxTokens = currentHeader?.adapterDefaults?.maxTokens === true ? undefined : currentHeader?.config.maxTokens
    const resolved = await llm.resolveCallConfig({
      ...to, ...explicitMaxTokens === undefined ? {} : { maxTokens: explicitMaxTokens },
    }, signal)
    if (final || sourceWindow === undefined || target.context.contextWindow < sourceWindow) {
      const meter = ctx.get('tokenMeter') as RequestPressureMeter | undefined
      if (meter === undefined && !final) return 'SMALLER_CONTEXT_CAPACITY'
      const previous = agent.session.requestHeader()
      const header: EpochHeader = { config: resolved, ...previous?.tools === undefined ? {} : { tools: previous.tools } }
      const pressure = meter?.measure(agent.session, header).totalTokens ?? 0
      // Bytes deliberately overestimate unseen text tokens; pending input is not durable yet.
      if (messages.some(message => contentHasImage(message.content) || message.content.some(block => block.type === 'file'))) {
        return 'UNMEASURED_ATTACHMENT_CAPACITY'
      }
      const inputBytes = Buffer.byteLength(JSON.stringify({ messages, tools: header.tools }), 'utf8')
      const pendingBudget = pending.reduce((total, message) => total + Buffer.byteLength(JSON.stringify(message), 'utf8'), 0)
      const output = resolved.maxTokens ?? target.defaultMaxTokens
      const inputBudget = Math.max(pressure + pendingBudget, inputBytes) + config.contextHeadroomTokens
      if (output === undefined || inputBudget + output >= target.context.contextWindow) {
        return 'INSUFFICIENT_CONTEXT_CAPACITY'
      }
    }
    return undefined
  }

  ctx.on('agent/model-selection', (payload, next) => track((async () => {
    const { agent, turn, step, requestedSelection, signal, messages } = payload
    admittedRevision.set(agent, handle.stateOf(agent.session).manualRevision)
    const selected = await next()
    if (stopped(signal, lifetime)) return selected
    const selectionState = handle.stateOf(agent.session)
    const sticky = selectionState.sticky
    if (sticky === null || chainFor(sticky.primary) === undefined) return selected
    const target = Date.now() >= sticky.until ? sticky.primary : sticky.effective
    if (routeKey(target) === routeKey(selected)) return selected
    const fused = AbortSignal.any([signal, lifetime, AbortSignal.timeout(config.maxElapsedMs)])
    let rejection: string | undefined
    try {
      rejection = await compatibility(agent, requestedSelection, target, fused, messages)
    } catch (error) {
      fused.throwIfAborted()
      if (stopped(signal, lifetime)) return selected
      if (handle.stateOf(agent.session).manualRevision !== selectionState.manualRevision) return agent.model.current() ?? selected
      if (!(error instanceof LlmError) || error.code !== 'MODEL_UNAVAILABLE') throw error
      switchRoute(agent, { primary: sticky.primary, from: requestedSelection, to: sticky.effective,
        reason: 'failure', failureCode: error.code, cooldownUntil: Date.now() + config.cooldownMs, turn, step })
      return selected
    }
    fused.throwIfAborted()
    if (handle.stateOf(agent.session).manualRevision !== selectionState.manualRevision) return agent.model.current() ?? selected
    if (stopped(signal, lifetime) || rejection !== undefined) return selected
    if (Date.now() >= sticky.until) {
      switchRoute(agent, { primary: sticky.primary, from: requestedSelection, to: target,
        reason: 'cooldown-expired', cooldownUntil: 0, turn, step })
    }
    return target
  })()))

  ctx.on('agent/request-prepared', payload => track((async () => {
    if (payload.routeRecovery !== true || stopped(payload.signal, lifetime)) return
    const sticky = handle.stateOf(payload.agent.session).sticky
    if (sticky === null) return
    const target = { provider: payload.provider, model: payload.model }
    const fused = AbortSignal.any([payload.signal, lifetime, AbortSignal.timeout(config.maxElapsedMs)])
    const rejection = await compatibility(payload.agent, sticky.previous, target, fused, [], true)
    payload.signal.throwIfAborted()
    if (stopped(payload.signal, lifetime)) return
    if (rejection !== undefined) {
      throw new LlmError(`Automatic model recovery cannot preserve input on ${label(target)}: ${rejection}`, 'FAILOVER_INCOMPATIBLE')
    }
  })()))

  return payload => track((async () => {
    const { agent, turn, step, modelSelection: failed, failure, signal } = payload
    if (!ELIGIBLE.has(failure.code) || failure.status === 401 || failure.status === 403 || stopped(signal, lifetime)) return
    const state = handle.stateOf(agent.session)
    const manual = agent.model.current()
    if (state.manualRevision !== admittedRevision.get(agent)
      || (manual !== undefined && routeKey(manual) !== routeKey(failed))) {
      throw new LlmError('Automatic model recovery was superseded by a manual model selection; continue on the selected model.', 'FAILOVER_SUPERSEDED')
    }
    const superseded = (): boolean => handle.stateOf(agent.session).manualRevision !== state.manualRevision
    const assertCurrentSelection = (): void => {
      if (superseded()) throw new LlmError('Automatic model recovery was superseded by a manual model selection; continue on the selected model.', 'FAILOVER_SUPERSEDED')
    }
    const primary = state.sticky?.primary ?? failed
    const chain = chainFor(primary)
    if (chain === undefined) return
    const startedAt = state.startedAt ?? Date.now()
    const attempts: FailoverAttempt[] = [...state.attempts]
    function record(selection: ModelSelection, code: string): void {
      const attempt = { selection, code }
      attempts.push(attempt)
      agent.session.append('llm/failover-attempt', { primary, attempt, startedAt, turn, step })
    }
    record(failed, failure.code)
    const exhausted = (): never => {
      agent.session.append('llm/failover-exhausted', { primary, attempted: attempts, turn, step })
      const summary = attempts.map(attempt => `${label(attempt.selection)} (${attempt.code})`).join('; ')
      const message = `Automatic model failover exhausted: ${summary}. Check provider availability or choose a working model.`
      notice(agent, message)
      throw new LlmError(message, 'FAILOVER_EXHAUSTED')
    }
    const remaining = () => config.maxElapsedMs - (Date.now() - startedAt)
    const checkBudget = (): void => {
      if (attempts.length >= config.maxAttempts || remaining() <= 0) exhausted()
    }
    checkBudget()
    const failuresHere = attempts.filter(attempt => routeKey(attempt.selection) === routeKey(failed)).length
    if (!QUOTA.has(failure.code) && failure.code !== 'MODEL_UNAVAILABLE' && failuresHere <= config.sameRouteRetries) {
      const delay = Math.max(config.retryDelayMs, failure.providerRetryAfterMs ?? 0)
      if (delay < remaining()) {
        if (await wait(delay, AbortSignal.any([signal, lifetime]))) {
          assertCurrentSelection()
          return { kind: 'retry', expiresAt: startedAt + config.maxElapsedMs }
        }
        return
      }
    }
    const candidates = [chain.primary, ...chain.fallbacks]
    const failedIndex = candidates.findIndex(route => routeKey(route) === routeKey(failed))
    for (const candidate of candidates.slice(failedIndex + 1)) {
      if (stopped(signal, lifetime)) return
      checkBudget()
      if (attempts.some(attempt => routeKey(attempt.selection) === routeKey(candidate))) continue
      if (attempts.some(attempt => QUOTA.has(attempt.code) && attempt.selection.provider === candidate.provider)) continue
      const deadline = AbortSignal.timeout(Math.max(1, remaining()))
      const fused = AbortSignal.any([signal, lifetime, deadline])
      let rejection: string | undefined
      try {
        rejection = await compatibility(agent, failed, candidate, fused, payload.pendingMessages)
      } catch (error) {
        signal.throwIfAborted()
        if (stopped(signal, lifetime)) return
        if (deadline.aborted) exhausted()
        if (!(error instanceof LlmError) || !['NO_ADAPTER', 'MODEL_UNAVAILABLE'].includes(error.code)) throw error
        rejection = error.code
      }
      if (stopped(signal, lifetime)) return
      assertCurrentSelection()
      checkBudget()
      if (rejection !== undefined) {
        record(candidate, rejection)
        continue
      }
      switchRoute(agent, { primary, from: failed, to: candidate, reason: 'failure', failureCode: failure.code,
        cooldownUntil: Date.now() + config.cooldownMs, turn, step })
      return { kind: 'retry-route', selection: candidate, expiresAt: startedAt + config.maxElapsedMs }
    }
    return exhausted()
  })())
}
