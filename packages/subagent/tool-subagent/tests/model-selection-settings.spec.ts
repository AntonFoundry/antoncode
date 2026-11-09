/** Default-off settings and per-session model-selection decisions. */
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import { mountWorkingDirectoryFixture } from '../../subagent/tests/working-directory-fixture.ts'

import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { assembleContextFor } from '@deepseek-ai/dsh-agent'
import { LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import AgentPresets from '@deepseek-ai/dsh-agent-preset-registry'
import { liveConfig } from '../../../settings/settings/tests/live-config.ts'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import * as tool from '../src/index.ts'
import SubagentModelSelectionConfig from '../src/model-selection-settings.ts'
import {
  subagentModelSelectionPolicy,
  subagentModelSelectionProjectionDefinition,
} from '../src/model-selection-state.ts'
import { callSubagent, directConfig, ownContext, text } from './harness.ts'

const ALLOWED_MODELS = [{ provider: 'alpha', model: 'fast-model' }]
const OTHER_MODELS = [{ provider: 'alpha', model: 'other-model' }, { provider: 'beta', model: 'fast-model' }]

/** Recorded policy payloads of one Agent's Session, oldest first. */
function policyEvents(agent: { session: Session }) {
  return agent.session.snapshotEvents()
    .flatMap(event => event.type === 'subagent/model-selection-policy' ? [event.data.allowedModels] : [])
}

const selectionConfigs = new WeakMap<Context, Awaited<ReturnType<typeof liveConfig>>>()
const subagentConfigs = new WeakMap<Context, Awaited<ReturnType<typeof liveConfig>>>()

/** Read whether one Agent's delegation definition contains route fields. */
function selectable(ctx: Context, agent: Awaited<ReturnType<Context['agents']['create']>>['agent']): boolean {
  const schema = ctx.tools.schemas(agent).find(candidate => candidate.name === 'subagent')
  const properties = (schema?.parameters as { properties?: Record<string, unknown> } | undefined)?.properties
  return properties?.['provider'] !== undefined
    && properties['model'] !== undefined
    && properties['reasoning_effort'] !== undefined
    && ctx.tools.schemas(agent).some(candidate => candidate.name === 'list_subagent_models')
}

/** Mount the real settings, Agent, provider, and optional preset tool services. */
async function boot(withPreset = true): Promise<Context> {
  const ctx = ownContext(new Context())
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  ctx.loader.builtins.subagentTool = tool

  await mountAgentLoopTestDependencies(ctx)
  selectionConfigs.set(ctx, await liveConfig(ctx, SubagentModelSelectionConfig))
  await ctx.plugin(AgentLoop, { agents: [] })
  await mountWorkingDirectoryFixture(ctx)
  subagentConfigs.set(ctx, await liveConfig(ctx, SubagentRuntime))
  await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
  await ctx.plugin(AgentPresets, { default: 'model-selection-test' })
  if (withPreset) {
    await ctx.agentPresets.register({ id: 'model-selection-test', plugins: [{
      name: 'cordis:subagentTool',
      config: { provider: 'spawn', modelSelection: true, modelDiscovery: true },
    }] })
  }
  return ctx
}

/** Create one Agent joined to the test's standing preset. */
async function createAgent(ctx: Context, id: string, options: {
  meta?: { parentSession: SessionId; origin: 'subagent' }
  seed?: readonly SessionEvent[]
} = {}) {
  const handle = await ctx.agents.create({
    sessionId: SessionId(id),
    ...options,
    setup: async (agentCtx) => { await ctx.agentPresets.mount(agentCtx, 'model-selection-test') },
  })
  return handle.agent
}

/** Adapter whose exact-model lookup waits for the test, so Settings can change during route preflight. */
class GatedAdapter extends LlmAdapter {
  constructor(
    private readonly entered: PromiseWithResolvers<undefined>,
    private readonly proceed: Promise<undefined>,
  ) {
    super()
  }

  override providerInfo(provider: string) {
    return { id: provider, name: provider }
  }

  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    this.entered.resolve(undefined)
    await this.proceed
    return { provider, id: model, name: model }
  }

  stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    return (async function* () { yield { type: 'finish' as const, reason: { kind: 'stop' as const } } })()
  }
}

let policySessionCounter = 0

/** Observe settings through the policy captured by a fresh top-level Agent. */
async function capturePolicy(ctx: Context) {
  const { agent } = await ctx.agents.create({ sessionId: SessionId(`settings-policy-${++policySessionCounter}`) })
  const policy = await ctx.sessionProjections.register(subagentModelSelectionProjectionDefinition)
  return subagentModelSelectionPolicy(policy, agent.session)
}

describe('SubagentModelSelectionConfig', () => {
  it('uses the composed default without a settings provider', async () => {
    const ctx = ownContext(new Context())
    await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(SubagentModelSelectionConfig, { enabled: true, allowedModels: ALLOWED_MODELS })

    expect(await capturePolicy(ctx)).toEqual(ALLOWED_MODELS)
    await ctx.fiber.dispose()
  })

  it('defaults off and follows the validated user layer', async () => {
    const ctx = ownContext(new Context())
    await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
    await ctx.plugin(AgentLoop, { agents: [] })

    selectionConfigs.set(ctx, await liveConfig(ctx, SubagentModelSelectionConfig))

    expect(await capturePolicy(ctx)).toBeUndefined()
    await selectionConfigs.get(ctx)!.update({
      enabled: true,
      allowedModels: ALLOWED_MODELS,
    })
    expect(await capturePolicy(ctx)).toEqual(ALLOWED_MODELS)
    await ctx.fiber.dispose()
  })

  it('rejects duplicate routes, enabled empty settings, and a malformed durable policy', async () => {
    const ctx = ownContext(new Context())
    await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
    await ctx.plugin(AgentLoop, { agents: [] })

    selectionConfigs.set(ctx, await liveConfig(ctx, SubagentModelSelectionConfig))
    await ctx.sessionProjections.register(subagentModelSelectionProjectionDefinition)

    // File-written invalid settings reject Agent creation even without delegation tools.
    await selectionConfigs.get(ctx)!.update({ allowedModels: [...ALLOWED_MODELS, ...ALLOWED_MODELS] })
    await expect(capturePolicy(ctx)).rejects.toThrow('repeats route "alpha/fast-model"')

    await selectionConfigs.get(ctx)!.update({ enabled: true, allowedModels: [] })
    await expect(capturePolicy(ctx)).rejects.toThrow('enabled subagent model selection requires at least one allowed model')
    await selectionConfigs.get(ctx)!.update({
      enabled: false,
      allowedModels: ALLOWED_MODELS,
    })
    expect(await capturePolicy(ctx)).toBeUndefined()
    await selectionConfigs.get(ctx)!.update({ allowedModels: [] })
    expect(await capturePolicy(ctx)).toBeUndefined()

    const revokedOnly = Session.create(SessionId('empty-policy'))
    revokedOnly.append('subagent/model-selection-policy', { allowedModels: [] })
    const policy = await ctx.sessionProjections.register(subagentModelSelectionProjectionDefinition)
    expect(subagentModelSelectionPolicy(policy, revokedOnly)).toBeUndefined()

    const malformed = Session.create(SessionId('malformed-policy'))
    malformed.append('subagent/model-selection-policy', {
      allowedModels: [{ provider: 1, model: 'fast-model' }],
    } as never)
    expect(() => subagentModelSelectionPolicy(policy, malformed))
      .toThrow('requires non-empty provider and model ids')
    await ctx.fiber.dispose()
  })

  it('projects the latest recorded policy and treats an empty list as revocation', async () => {
    const ctx = ownContext(new Context())
    await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
    const policy = await ctx.sessionProjections.register(subagentModelSelectionProjectionDefinition)
    const session = Session.create(SessionId('latest-policy'))
    session.append('subagent/model-selection-policy', { allowedModels: ALLOWED_MODELS })
    session.append('subagent/model-selection-policy', { allowedModels: OTHER_MODELS })
    expect(subagentModelSelectionPolicy(policy, session)).toEqual(OTHER_MODELS)
    session.append('subagent/model-selection-policy', { allowedModels: [] })
    expect(subagentModelSelectionPolicy(policy, session)).toBeUndefined()
    session.append('subagent/model-selection-policy', { allowedModels: ALLOWED_MODELS })
    expect(subagentModelSelectionPolicy(policy, session)).toEqual(ALLOWED_MODELS)

    const { init, apply } = subagentModelSelectionProjectionDefinition
    const replayed = session.snapshotEvents().reduce(apply, init())
    expect(replayed).toEqual(ALLOWED_MODELS)
    const unrelated = { ...session.snapshotEvents()[0]!, type: 'user/message' } as never
    expect(apply(replayed, unrelated)).toBe(replayed)
    await ctx.fiber.dispose()
  })

  it('records Settings edits into existing and new root Sessions without changing definitions', async () => {
    const ctx = await boot()
    const disabled = await createAgent(ctx, 'disabled')
    expect(selectable(ctx, disabled)).toBe(true)
    const policy = await ctx.sessionProjections.register(subagentModelSelectionProjectionDefinition)
    expect(subagentModelSelectionPolicy(policy, disabled.session)).toBeUndefined()
    const definition = ctx.tools.get('subagent', disabled)

    await selectionConfigs.get(ctx)!.update({
      enabled: true,
      allowedModels: ALLOWED_MODELS,
    })
    expect(subagentModelSelectionPolicy(policy, disabled.session)).toEqual(ALLOWED_MODELS)
    const enabled = await createAgent(ctx, 'enabled')
    expect(subagentModelSelectionPolicy(policy, enabled.session)).toEqual(ALLOWED_MODELS)
    expect(selectable(ctx, enabled)).toBe(true)
    expect(selectable(ctx, disabled)).toBe(true)
    expect(ctx.tools.get('subagent', disabled)).toBe(definition)

    await selectionConfigs.get(ctx)!.update({ enabled: false })
    const disabledAgain = await createAgent(ctx, 'disabled-again')
    expect(subagentModelSelectionPolicy(policy, disabledAgain.session)).toBeUndefined()
    expect(subagentModelSelectionPolicy(policy, enabled.session)).toBeUndefined()
    expect(selectable(ctx, disabledAgain)).toBe(true)
    expect(selectable(ctx, enabled)).toBe(true)
    expect(policyEvents(disabledAgain)).toEqual([])
    expect(policyEvents(enabled)).toEqual([ALLOWED_MODELS, []])
    await ctx.fiber.dispose()
  })

  it('installs a direct Agent setup before Agent publication', async () => {
    const ctx = await boot(false)
    await selectionConfigs.get(ctx)!.update({
      enabled: true,
      allowedModels: ALLOWED_MODELS,
    })
    let prepared: Awaited<ReturnType<Context['agents']['create']>>['agent'] | undefined
    let visibleAtAgentCreated = false
    ctx.on('agent/created', () => {
      visibleAtAgentCreated = prepared !== undefined && selectable(ctx, prepared)
    })

    const handle = await ctx.agents.create({
      sessionId: SessionId('direct-agent-setup'),
      setup: async (agentCtx, agent) => {
        prepared = agent
        const fiber = agentCtx.inject(tool.inject, (runtimeCtx) => {
          return tool.apply(runtimeCtx, directConfig({
            provider: 'spawn',
            modelSelection: true,
            modelDiscovery: true,
          }))
        })
        await fiber.await()
      },
    })

    expect(visibleAtAgentCreated).toBe(true)
    expect(selectable(ctx, handle.agent)).toBe(true)
    await handle.dispose()
    await ctx.fiber.dispose()
  })

  it('records the current authorization when a blank Session later joins a preset', async () => {
    const ctx = await boot()
    const disabled = await createAgent(ctx, 'already-disabled')
    const joining = await ctx.agents.create({ sessionId: SessionId('joining-preset') })
    await selectionConfigs.get(ctx)!.update({ enabled: true, allowedModels: ALLOWED_MODELS })
    await ctx.agentPresets.select(joining.agent, 'model-selection-test')
    const policy = await ctx.sessionProjections.register(subagentModelSelectionProjectionDefinition)
    expect(subagentModelSelectionPolicy(policy, joining.agent.session)).toEqual(ALLOWED_MODELS)
    expect(subagentModelSelectionPolicy(policy, disabled.session)).toEqual(ALLOWED_MODELS)
    await ctx.fiber.dispose()
  })

  it('records authorization without delegation tools and follows Settings when a preset gains tools', async () => {
    const ctx = await boot(false)
    await selectionConfigs.get(ctx)!.update({ enabled: true, allowedModels: ALLOWED_MODELS })
    const removeEmptyPreset = await ctx.agentPresets.register({ id: 'late-tools', plugins: [] })
    const inside = await ctx.agents.create({
      sessionId: SessionId('existing-inside'),
      setup: async (agentCtx) => { await ctx.agentPresets.mount(agentCtx, 'late-tools') },
    })
    const outside = await ctx.agents.create({ sessionId: SessionId('existing-outside') })
    await selectionConfigs.get(ctx)!.update({ enabled: false })
    await removeEmptyPreset()
    await ctx.agentPresets.register({ id: 'late-tools', plugins: [{
      name: 'cordis:subagentTool',
      config: { provider: 'spawn', modelSelection: true, modelDiscovery: true },
    }] })
    await ctx.agentPresets.select(inside.agent, 'late-tools')
    expect(selectable(ctx, inside.agent)).toBe(true)
    expect(selectable(ctx, outside.agent)).toBe(false)
    const policy = await ctx.sessionProjections.register(subagentModelSelectionProjectionDefinition)
    expect(subagentModelSelectionPolicy(policy, inside.agent.session)).toBeUndefined()
    expect(subagentModelSelectionPolicy(policy, outside.agent.session)).toBeUndefined()
    expect(policyEvents(inside.agent)).toEqual([ALLOWED_MODELS, []])
    await ctx.fiber.dispose()
  })

  it('does not register tools when recording the Session policy triggers a registry refresh', async () => {
    const ctx = await boot()
    try {
      await selectionConfigs.get(ctx)!.update({
        enabled: true,
        allowedModels: ALLOWED_MODELS,
      })
      ctx.on('session/event', (_session, event) => {
        if (event.type === 'subagent/model-selection-policy') {
          ctx.emit('tools/change')
        }
      })
      const register = vi.spyOn(ctx.tools, 'register')

      const agent = await createAgent(ctx, 'policy-refresh')

      expect(selectable(ctx, agent)).toBe(true)
      expect(register).not.toHaveBeenCalled()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('rejects a forced route outside the Session policy before child creation', async () => {
    const ctx = await boot()
    await selectionConfigs.get(ctx)!.update({
      enabled: true,
      allowedModels: ALLOWED_MODELS,
    })
    const agent = await createAgent(ctx, 'enforced')

    const result = await executeToolFixture(ctx, {
      signal: new AbortController().signal,
      callId: ToolCallId('disallowed-session-route'),
      name: 'subagent',
      arguments: {
        description: 'forced route',
        prompt: 'do it',
        provider: 'alpha',
        model: 'other-model',
      },
      agent,
    })

    expect(result.isError).toBe(true)
    expect(text(result)).toContain('is not allowed for this Session')
    await ctx.fiber.dispose()
  })

  it('shares definitions across Agents and updates visibility when selecting another preset', async () => {
    const ctx = await boot()
    await ctx.agentPresets.register({ id: 'minimal', plugins: [] })
    const createComposed = async (id: string) => ctx.agents.create({
      sessionId: SessionId(id),
      setup: async (agentCtx) => { await ctx.agentPresets.mount(agentCtx, 'model-selection-test') },
    })

    const disabled = await createComposed('preset-disabled')
    expect(selectable(ctx, disabled.agent)).toBe(true)
    await selectionConfigs.get(ctx)!.update({
      enabled: true,
      allowedModels: ALLOWED_MODELS,
    })
    const enabled = await createComposed('preset-enabled')
    expect(selectable(ctx, enabled.agent)).toBe(true)
    expect(selectable(ctx, disabled.agent)).toBe(true)
    expect(ctx.tools.get('subagent', enabled.agent)).toBe(ctx.tools.get('subagent', disabled.agent))
    expect(ctx.tools.get('subagent')).toBeUndefined()
    const preset = await ctx.agentPresets.acquireScope('model-selection-test')
    try { expect(ctx.tools.get('subagent', enabled.agent)).toBe(ctx.tools.get('subagent', preset.key)) }
    finally { await preset[Symbol.asyncDispose]() }

    await ctx.agentPresets.select(enabled.agent, 'minimal')
    expect(selectable(ctx, enabled.agent)).toBe(false)
    const next = () => Promise.resolve({ kind: 'enter' as const, messages: [] })
    const payload = {
      agent: enabled.agent,
      modelSelection: { provider: 'mock', model: 'mock' },
      messages: [],
      turn: 1,
      step: 1,
      signal: new AbortController().signal,
    }
    await expect(ctx.waterfall(ctx as never, 'agent/pre-step', payload, next))
      .resolves.toEqual({ kind: 'enter', messages: [] })

    await ctx.agentPresets.select(enabled.agent, 'model-selection-test')
    expect(selectable(ctx, enabled.agent)).toBe(true)
    await expect(ctx.waterfall(ctx as never, 'agent/pre-step', payload, next))
      .resolves.toEqual({ kind: 'enter', messages: [] })

    await enabled.dispose()
    expect(selectable(ctx, disabled.agent)).toBe(true)
    await disabled.dispose()
    await ctx.fiber.dispose()
  })

  it('keeps shared delegation and discovery hidden by the existing inherited-tool filter', async () => {
    const ctx = await boot()
    try {
      const parent = await createAgent(ctx, 'filter-parent')
      const child = (await ctx.agents.create({
        sessionId: SessionId('filter-child'),
        meta: { parentSession: parent.id, origin: 'subagent' },
        setup: async (childCtx) => {
          await ctx.agentPresets.mount(childCtx, 'model-selection-test')
          childCtx.tools.restrict({ deny: ['subagent', 'list_subagent_models'] })
        },
      })).agent
      expect(ctx.tools.get('subagent', parent)).toBeDefined()
      expect(ctx.tools.get('subagent', child)).toBeUndefined()
      expect(ctx.tools.get('list_subagent_models', child)).toBeUndefined()
      const result = await executeToolFixture(ctx, {
        name: 'subagent', callId: ToolCallId('filtered-delegation'), arguments: {},
        agent: child, signal: new AbortController().signal,
      })
      expect(result.isError).toBe(true)
      expect(text(result)).toContain('unknown tool')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('records the current Settings into child, orphan, and seeded root Sessions', async () => {
    const ctx = await boot()
    await selectionConfigs.get(ctx)!.update({
      enabled: true,
      allowedModels: ALLOWED_MODELS,
    })
    const policy = await ctx.sessionProjections.register(subagentModelSelectionProjectionDefinition)
    const parent = await createAgent(ctx, 'parent')
    const child = await createAgent(ctx, 'child', {
      meta: { parentSession: parent.id, origin: 'subagent' },
    })
    expect(selectable(ctx, child)).toBe(true)
    expect(subagentModelSelectionPolicy(policy, child.session)).toEqual(ALLOWED_MODELS)

    const orphan = await createAgent(ctx, 'orphan', {
      meta: { parentSession: SessionId('missing-parent'), origin: 'subagent' },
    })
    expect(selectable(ctx, orphan)).toBe(true)
    expect(subagentModelSelectionPolicy(policy, orphan.session)).toEqual(ALLOWED_MODELS)

    const sameSeed = Session.create(SessionId('same-seed'))
    sameSeed.append('subagent/model-selection-policy', { allowedModels: ALLOWED_MODELS })
    const resumedSame = await createAgent(ctx, 'resumed-same', { seed: sameSeed.snapshotEvents() })
    expect(policyEvents(resumedSame)).toEqual([ALLOWED_MODELS])

    const staleSeed = Session.create(SessionId('stale-seed'))
    staleSeed.append('subagent/model-selection-policy', { allowedModels: OTHER_MODELS })
    const resumedStale = await createAgent(ctx, 'resumed-stale', { seed: staleSeed.snapshotEvents() })
    expect(subagentModelSelectionPolicy(policy, resumedStale.session)).toEqual(ALLOWED_MODELS)
    expect(policyEvents(resumedStale)).toEqual([OTHER_MODELS, ALLOWED_MODELS])

    const resumedEmpty = await createAgent(ctx, 'resumed-empty', { seed: [] })
    expect(selectable(ctx, resumedEmpty)).toBe(true)
    expect(subagentModelSelectionPolicy(policy, resumedEmpty.session)).toEqual(ALLOWED_MODELS)

    await selectionConfigs.get(ctx)!.update({ enabled: false })
    const resumedRevoked = await createAgent(ctx, 'resumed-revoked', { seed: staleSeed.snapshotEvents() })
    expect(subagentModelSelectionPolicy(policy, resumedRevoked.session)).toBeUndefined()
    expect(policyEvents(resumedRevoked)).toEqual([OTHER_MODELS, []])
    const resumedDisabled = await createAgent(ctx, 'resumed-disabled', { seed: [] })
    expect(policyEvents(resumedDisabled)).toEqual([])
    await ctx.fiber.dispose()
  })

  it('records Settings edits into a live parent and its live child, and revocation restores parent-route-only selection', async () => {
    const ctx = await boot()
    try {
      await selectionConfigs.get(ctx)!.update({ enabled: true, allowedModels: ALLOWED_MODELS })
      const policy = await ctx.sessionProjections.register(subagentModelSelectionProjectionDefinition)
      const parent = await createAgent(ctx, 'live-parent')
      const child = await createAgent(ctx, 'live-child', {
        meta: { parentSession: parent.id, origin: 'subagent' },
      })

      await selectionConfigs.get(ctx)!.update({ allowedModels: OTHER_MODELS })
      expect(subagentModelSelectionPolicy(policy, parent.session)).toEqual(OTHER_MODELS)
      expect(subagentModelSelectionPolicy(policy, child.session)).toEqual(OTHER_MODELS)

      // An unchanged authorization appends nothing.
      await selectionConfigs.get(ctx)!.update({ allowedModels: OTHER_MODELS })
      expect(policyEvents(parent)).toEqual([ALLOWED_MODELS, OTHER_MODELS])

      await selectionConfigs.get(ctx)!.update({ enabled: false, allowedModels: [] })
      expect(subagentModelSelectionPolicy(policy, parent.session)).toBeUndefined()
      expect(subagentModelSelectionPolicy(policy, child.session)).toBeUndefined()
      expect(policyEvents(child)).toEqual([ALLOWED_MODELS, OTHER_MODELS, []])
      const recorded = parent.session.snapshotEvents().filter(event => event.type === 'subagent/model-selection-policy')
      expect(recorded.map(event => parent.session.deriveEventMessage(event))).toEqual([null, null, null])

      const result = await executeToolFixture(ctx, {
        signal: new AbortController().signal,
        callId: ToolCallId('revoked-session-route'),
        name: 'subagent',
        arguments: { description: 'revoked route', prompt: 'do it', provider: 'alpha', model: 'fast-model' },
        agent: parent,
      })
      expect(result.isError).toBe(true)
      expect(text(result)).toContain('without a recorded model-selection policy')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('revokes live authorizations and warns when a Settings edit is invalid', async () => {
    const ctx = await boot()
    try {
      await selectionConfigs.get(ctx)!.update({ enabled: true, allowedModels: ALLOWED_MODELS })
      const policy = await ctx.sessionProjections.register(subagentModelSelectionProjectionDefinition)
      const agent = await createAgent(ctx, 'invalid-edit')
      const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => undefined)

      await selectionConfigs.get(ctx)!.update({ allowedModels: [...OTHER_MODELS, ...OTHER_MODELS] })

      expect(subagentModelSelectionPolicy(policy, agent.session)).toBeUndefined()
      expect(policyEvents(agent)).toEqual([ALLOWED_MODELS, []])
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(
        'subagent model selection settings are invalid; revoking model selection in live Sessions',
      ))
      await expect(createAgent(ctx, 'invalid-edit-new')).rejects.toThrow('repeats route "alpha/other-model"')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('records the remaining live Sessions when one Session rejects its append', async () => {
    const ctx = await boot()
    try {
      const policy = await ctx.sessionProjections.register(subagentModelSelectionProjectionDefinition)
      const failing = await createAgent(ctx, 'append-fails')
      const healthy = await createAgent(ctx, 'append-succeeds')
      const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => undefined)
      vi.spyOn(failing.session, 'append').mockImplementationOnce(() => { throw new Error('append rejected') })

      await selectionConfigs.get(ctx)!.update({ enabled: true, allowedModels: ALLOWED_MODELS })

      expect(subagentModelSelectionPolicy(policy, failing.session)).toBeUndefined()
      expect(subagentModelSelectionPolicy(policy, healthy.session)).toEqual(ALLOWED_MODELS)
      expect(warn).toHaveBeenCalledWith(
        'subagent model selection policy was not recorded in session "append-fails": Error: append rejected',
      )
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('records the current Settings into already-live Agents when the service activates or reloads', async () => {
    const ctx = ownContext(new Context())
    try {
      await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
      await ctx.plugin(AgentLoop, { agents: [] })
      const { agent } = await ctx.agents.create({ sessionId: SessionId('before-activation') })
      const policy = await ctx.sessionProjections.register(subagentModelSelectionProjectionDefinition)
      expect(subagentModelSelectionPolicy(policy, agent.session)).toBeUndefined()

      const first = await ctx.plugin(SubagentModelSelectionConfig, { enabled: true, allowedModels: ALLOWED_MODELS })
      expect(policyEvents(agent)).toEqual([ALLOWED_MODELS])

      await first.dispose()
      const reloaded = await ctx.plugin(SubagentModelSelectionConfig, { enabled: true, allowedModels: OTHER_MODELS })
      expect(policyEvents(agent)).toEqual([ALLOWED_MODELS, OTHER_MODELS])

      await reloaded.dispose()
      await ctx.plugin(SubagentModelSelectionConfig, { enabled: true, allowedModels: OTHER_MODELS })
      expect(policyEvents(agent)).toEqual([ALLOWED_MODELS, OTHER_MODELS])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('removes the Settings listener when its fiber is disposed', async () => {
    const ctx = await boot()
    try {
      const policy = await ctx.sessionProjections.register(subagentModelSelectionProjectionDefinition)
      const agent = await createAgent(ctx, 'listener-disposal')
      const settings = selectionConfigs.get(ctx)!
      await settings.update({ enabled: true, allowedModels: ALLOWED_MODELS })
      expect(policyEvents(agent)).toEqual([ALLOWED_MODELS])

      await settings.entry.fiber!.dispose()
      // A live listener would restore the Settings value on the next update notification.
      agent.session.append('subagent/model-selection-policy', { allowedModels: OTHER_MODELS })
      ctx.emit('loader/volatile-update', [['allowedModels']])
      expect(subagentModelSelectionPolicy(policy, agent.session)).toEqual(OTHER_MODELS)
      expect(policyEvents(agent)).toEqual([ALLOWED_MODELS, OTHER_MODELS])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('re-checks the Session policy after route preflight before starting a child', async () => {
    const ctx = await boot()
    try {
      await selectionConfigs.get(ctx)!.update({ enabled: true, allowedModels: ALLOWED_MODELS })
      const agent = await createAgent(ctx, 'revoked-during-preflight')
      const entered = Promise.withResolvers<undefined>()
      const proceed = Promise.withResolvers<undefined>()
      ctx.llm.registerAdapter(['alpha'], new GatedAdapter(entered, proceed.promise))
      const started = vi.spyOn(ctx.subagents, 'startActivation')

      const call = executeToolFixture(ctx, {
        signal: new AbortController().signal,
        callId: ToolCallId('revoked-during-preflight'),
        name: 'subagent',
        arguments: { description: 'route work', prompt: 'do it', provider: 'alpha', model: 'fast-model' },
        agent,
      })
      await entered.promise
      await selectionConfigs.get(ctx)!.update({ enabled: false })
      proceed.resolve(undefined)
      const result = await call

      expect(result.isError).toBe(true)
      expect(text(result)).toContain('child LLM route "alpha/fast-model" is not allowed for this Session')
      expect(started).not.toHaveBeenCalled()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('permits independently configured delegation tools without a settings service', async () => {
    const ctx = ownContext(new Context())
    await mountAgentLoopTestDependencies(ctx)
    await mountWorkingDirectoryFixture(ctx)
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
    await ctx.plugin(tool, { provider: 'spawn', modelSelection: true })
    await ctx.plugin(tool, { provider: 'spawn', toolName: 'another_spawn', modelSelection: true })
    expect(ctx.tools.get('subagent')).toBeDefined()
    expect(ctx.tools.get('another_spawn')).toBeDefined()
    expect(ctx.tools.get('list_subagent_models')).toBeUndefined()
    await ctx.fiber.dispose()
  })
})

it('reads the saved default depth at each delegation without remounting the tool', async () => {
  const ctx = await boot(false)
  const depths: Array<number | undefined> = []
  try {
    ctx.subagents.registerProvider({
      name: 'capture-depth',
      capabilities: { agentOptions: true, agentPreset: false, outputSchema: true, depthLimit: true },
      inheritsParentContext: false,
      start: async (request) => {
        depths.push(request.maxDepth)
        return { id: SessionId(`depth-${depths.length}`),
          result: Promise.resolve({ output: [], stopReason: 'completed' as const }), dispose: async () => {} }
      },
    })
    await ctx.plugin(tool, { provider: 'capture-depth' })
    const { agent } = await ctx.agents.create({ sessionId: SessionId('live-depth-context') })
    const initial = await ctx.systemPrompt.assemble(assembleContextFor(agent))
    expect(initial.contexts.find(part => part.name === 'tool:subagent:depth')?.text)
      .toBe('')
    await callSubagent(ctx, { description: 'first', prompt: 'work' })
    await subagentConfigs.get(ctx)!.update({ maxDepth: 5 })
    const updated = ctx.systemPrompt.refreshContext(initial, assembleContextFor(agent))
    expect(updated.contexts.find(part => part.name === 'tool:subagent:depth')?.text)
      .toBe('')
    await callSubagent(ctx, { description: 'second', prompt: 'work' })
    await subagentConfigs.get(ctx)!.update({ maxDepth: 0 })
    const disabled = ctx.systemPrompt.refreshContext(initial, assembleContextFor(agent))
    expect(disabled.contexts.find(part => part.name === 'tool:subagent:depth')?.text)
      .toBe('Delegation depth for `subagent`: current 0, maximum 0, remaining levels 0. Do not call `subagent` at this depth; carry out the work directly.')
    expect(disabled.sections).toEqual(initial.sections)
    expect(disabled.tools).toEqual(initial.tools)
    await subagentConfigs.get(ctx)!.update({ maxDepth: 2 })
    expect(ctx.systemPrompt.refreshContext(disabled, assembleContextFor(agent))
      .contexts.find(part => part.name === 'tool:subagent:depth')?.text).toBe('')
    await subagentConfigs.get(ctx)!.update({ maxDepth: 0 })
    await callSubagent(ctx, { description: 'disabled', prompt: 'work' })
    expect(depths).toEqual([1, 5, 0])
  } finally {
    await ctx.fiber.dispose()
  }
})
