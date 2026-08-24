import { describe, expect, it } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import type { ToolSchema } from '@deepseek-ai/dsh-llm'
import { CodeRuntime } from '@deepseek-ai/dsh-code-runtime'
import type { CodeRunRequest, CodeRunResult } from '@deepseek-ai/dsh-code-runtime'
import { bindScopeParent, createScope } from '@deepseek-ai/dsh-scope'
import type { Scope } from '@deepseek-ai/dsh-scope'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool, RUN_CODE_NAME, TOOL_SEARCH_NAME } from '@deepseek-ai/dsh-tools'
import type { Config, ToolExecutionResult, ToolMatcher } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'

const testToolSignal = new AbortController().signal

/**
 * Paged Mode unit tier, mirroring code-mode.spec.ts: wire contribution,
 * catalog/rule sections, the grant loop through the executor (including the
 * UNKNOWN_TOOL gate on ungranted direct calls), the matcher seam, and
 * per-agent presentation composition — all without a code runtime, which a
 * paged deployment must not require.
 */

interface SetupOptions {
  mode?: Config['mode']
  pinned?: string[]
}

async function setup(options: SetupOptions = {}) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime, { mode: options.mode ?? 'paged', pinned: options.pinned ?? [] })
  return { ctx, tools: ctx.tools, systemPrompt: ctx.systemPrompt }
}

/** Mint an agent scope configured like production that can register scoped tool policy. */
async function mintAgentScope(ctx: Context, name = 'scoped'): Promise<{ scope: Scope; agent: Agent }> {
  const agent = { id: SessionId(name) } as Agent
  let scope!: Scope
  await ctx.plugin(Object.assign((inner: Context) => { scope = createScope(inner, agent) },
    { inject: ['tools', 'systemPrompt'] }))
  return { scope, agent }
}

/** Register a trivial tool with the given description; returns the calls it received. */
function registerTool(ctx: Context, name: string, description: string): unknown[] {
  const calls: unknown[] = []
  ctx.tools.register(defineTool({
    name,
    description,
    parameters: { value: { type: 'string', required: true } },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    execute(args) {
      calls.push(args)
      return Promise.resolve(`${name}:${args.value}`)
    },
  }))
  return calls
}

/** The stock catalog: one file reader, one file writer, one shell runner. */
function registerCatalog(ctx: Context): Record<string, unknown[]> {
  return {
    read: registerTool(ctx, 'read', 'Read a file from disk.'),
    write: registerTool(ctx, 'write', 'Write a file to disk.'),
    bash: registerTool(ctx, 'bash', 'Run a shell command.'),
  }
}

/** Dispatch tool_search through the registry pipeline, as the loop would. */
async function search(
  ctx: Context,
  intent: string,
  extras: { agent?: Agent; limit?: number } = {},
): Promise<ToolExecutionResult> {
  return ctx.tools.execute({
    signal: testToolSignal,
    callId: CallId(`search:${intent}`),
    name: TOOL_SEARCH_NAME,
    arguments: { intent, ...extras.limit !== undefined ? { limit: extras.limit } : {} },
    ...extras.agent ? { agent: extras.agent } : {},
  })
}

/** Dispatch an ordinary tool through the registry pipeline, as the loop would. */
async function callTool(ctx: Context, name: string, agent?: Agent): Promise<ToolExecutionResult> {
  return ctx.tools.execute({
    signal: testToolSignal,
    callId: CallId(`call:${name}`),
    name,
    arguments: { value: 'x' },
    ...agent ? { agent } : {},
  })
}

/** The concatenated text of one result's text blocks. */
function resultText(result: ToolExecutionResult): string {
  return result.content.map(block => block.type === 'text' ? block.text : `[${block.type}]`).join('\n')
}

/** A scriptable matcher service: each test sets `FakeMatcher.answer` to drive the seam. */
class FakeMatcher extends Service implements ToolMatcher {
  static calls: { intent: string; candidates: string[]; limit: number }[] = []
  static answer: string[] = []

  constructor(ctx: Context) {
    super(ctx, 'toolMatcher')
    FakeMatcher.calls = []
    FakeMatcher.answer = []
  }

  match(intent: string, candidates: readonly ToolSchema[], limit: number): string[] {
    FakeMatcher.calls.push({ intent, candidates: candidates.map(candidate => candidate.name), limit })
    return FakeMatcher.answer
  }
}

/** A minimal in-repo CodeRuntime, needed only to assemble `code`/`both` scopes for the pinned-ignored test. */
class FakeCodeRuntime extends CodeRuntime {
  readonly language = 'typescript'
  readonly isolation = 'fake'

  run(_request: CodeRunRequest): Promise<CodeRunResult> {
    return Promise.resolve({ logs: [] })
  }
}

describe('paged wire contribution', () => {
  it('contributes only tool_search, plus the catalog and rule sections — and needs no runtime', async () => {
    const { ctx, systemPrompt } = await setup()
    registerCatalog(ctx)

    const assembly = await systemPrompt.assemble()
    expect(assembly.tools.map(tool => tool.name)).toEqual([TOOL_SEARCH_NAME])
    expect(assembly.sections.some(section => section.name === 'tools:sdk')).toBe(false)
    expect(assembly.sections.some(section => section.name === 'tools:code-only')).toBe(false)
    const catalog = assembly.sections.find(section => section.name === 'tools:catalog')
    expect(catalog?.text).toContain('- read — Read a file from disk.')
    expect(catalog?.text).toContain('- write — Write a file to disk.')
    expect(catalog?.text).toContain('- bash — Run a shell command.')
    // The transport never advertises itself (the header's mention is the
    // unlock instruction, not a catalog entry).
    expect(catalog?.text).not.toContain(`- ${TOOL_SEARCH_NAME} —`)
    const rule = assembly.sections.find(section => section.name === 'tools:paged-only')
    expect(rule?.text).toContain(`\`${TOOL_SEARCH_NAME}\``)
    expect(rule?.text).toContain('already-granted tools may be called directly')
  })

  it('keeps knownNames full so prompt-order validation still accepts every catalog tool', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt, { toolOrder: ['read', 'write', 'bash', '<unlisted-tools>'] })
    await ctx.plugin(ToolRuntime, { mode: 'paged' })
    registerCatalog(ctx)

    const assembly = await ctx.systemPrompt.assemble()
    expect(assembly.tools.map(tool => tool.name)).toEqual([TOOL_SEARCH_NAME])
  })

  it('states the rule BEFORE the per-tool guidance that names each tool', async () => {
    const { ctx, systemPrompt } = await setup()
    registerCatalog(ctx)
    ctx.systemPrompt.section({ name: 'tool:read', order: 100, text: 'Use the read tool.' })

    const assembly = await systemPrompt.assemble()
    const names = assembly.sections.map(section => section.name)
    expect(names.indexOf('tools:paged-only')).toBeGreaterThanOrEqual(0)
    expect(names.indexOf('tools:paged-only')).toBeLessThan(names.indexOf('tool:read'))
  })

  it('renders catalog one-liners as first sentence, truncated to about 100 characters', async () => {
    const { ctx, systemPrompt } = await setup()
    registerTool(ctx, 'multi', 'First sentence. Second sentence must not leak into the catalog line.')
    registerTool(ctx, 'wordy', `A${' very long description'.repeat(10)} without any sentence break`)

    const catalog = (await systemPrompt.assemble()).sections.find(section => section.name === 'tools:catalog')
    const lines = catalog?.text.split('\n') ?? []
    expect(lines).toContain('- multi — First sentence.')
    const wordy = lines.find(line => line.startsWith('- wordy — '))
    expect(wordy?.endsWith('…')).toBe(true)
    expect(wordy?.length).toBeLessThanOrEqual('- wordy — '.length + 100)
  })

  it('renders neither paged section under a native deployment, nor tool_search itself', async () => {
    const { ctx, systemPrompt } = await setup({ mode: 'native' })
    registerCatalog(ctx)

    const assembly = await systemPrompt.assemble()
    expect(assembly.tools.map(tool => tool.name)).toEqual(['bash', 'read', 'write'])
    expect(assembly.sections.some(section => section.name === 'tools:catalog')).toBe(false)
    expect(assembly.sections.some(section => section.name === 'tools:paged-only')).toBe(false)
  })

  it('renders the paged sections empty for a scope that opted out to native', async () => {
    const { ctx, systemPrompt } = await setup()
    registerCatalog(ctx)
    const { scope, agent } = await mintAgentScope(ctx)
    scope.ctx.tools.presentAs('native')

    const assembly = await systemPrompt.assemble({ scope: agent })
    expect(assembly.tools.map(tool => tool.name)).toEqual(['bash', 'read', 'write'])
    expect(assembly.sections.find(section => section.name === 'tools:catalog')?.text).toBe('')
    expect(assembly.sections.find(section => section.name === 'tools:paged-only')?.text).toBe('')
  })
})

describe('reserved transport', () => {
  it('rejects registering the reserved name, whatever the configured mode', async () => {
    const { ctx } = await setup({ mode: 'native' })
    expect(() => registerTool(ctx, TOOL_SEARCH_NAME, 'impostor')).toThrow('is reserved')
  })

  it('rejects a restriction naming the reserved transport', async () => {
    const { ctx } = await setup()
    registerCatalog(ctx)
    const { scope } = await mintAgentScope(ctx)
    expect(() => scope.ctx.tools.restrict({ deny: [TOOL_SEARCH_NAME] })).toThrow('reserved')
  })

  it('never inserts run_code into a paged scope', async () => {
    const { ctx } = await setup()
    registerCatalog(ctx)
    expect(ctx.tools.get(RUN_CODE_NAME)).toBeUndefined()
    expect(ctx.tools.get(TOOL_SEARCH_NAME)).toBeDefined()
  })
})

describe('grant loop', () => {
  it('exposes only tool_search initially and pages ungranted tools out of schemas()', async () => {
    const { ctx } = await setup()
    registerCatalog(ctx)
    const { agent } = await mintAgentScope(ctx)

    expect(ctx.tools.schemas(agent).map(schema => schema.name)).toEqual([TOOL_SEARCH_NAME])
    expect(ctx.tools.get('read', agent)).toBeUndefined()
    // The global view is paged too under a paged deployment default.
    expect(ctx.tools.get('read')).toBeUndefined()
  })

  it('denies a model-direct call naming an ungranted tool as UNKNOWN_TOOL before policy', async () => {
    const { ctx } = await setup()
    const calls = registerCatalog(ctx)
    const { agent } = await mintAgentScope(ctx)
    const observed: string[] = []
    ctx.on('tools/pre-execute', (exec, next) => {
      observed.push(exec.name)
      return next()
    })

    const denied = await callTool(ctx, 'read', agent)
    expect(denied.isError).toBe(true)
    expect(denied.error?.info).toEqual({ name: 'ToolNotFoundError', code: 'UNKNOWN_TOOL' })
    // The denial names the route back, not a bare `unknown tool`.
    expect(denied.error?.message).toContain(TOOL_SEARCH_NAME)
    expect(denied.error?.message).toContain('grant')
    expect(calls.read).toEqual([])
    // Denied at execution creation: policy never observes a call that can only fail.
    expect(observed).toEqual([])
  })

  it('treats a genuinely unknown name as an ordinary unknown tool, not a collapse', async () => {
    const { ctx } = await setup()
    registerCatalog(ctx)
    const { agent } = await mintAgentScope(ctx)
    const observed: string[] = []
    ctx.on('tools/pre-execute', (exec, next) => {
      observed.push(exec.name)
      return next()
    })

    const denied = await callTool(ctx, 'nonexistent', agent)
    expect(denied.error?.info).toEqual({ name: 'ToolNotFoundError', code: 'UNKNOWN_TOOL' })
    expect(denied.error?.message).not.toContain(TOOL_SEARCH_NAME)
    expect(observed).toEqual(['nonexistent'])
  })

  it('grants the matched tools into the calling scope; they are visible and executable next', async () => {
    const { ctx, systemPrompt } = await setup()
    const calls = registerCatalog(ctx)
    const { agent } = await mintAgentScope(ctx)

    const found = await search(ctx, 'read a file', { agent, limit: 1 })
    expect(found.isError).toBe(false)
    const text = resultText(found)
    expect(text).toContain('## read')
    expect(text).toContain('Read a file from disk.')
    expect(text).toContain('Parameters:')
    expect(text).toContain('now granted')

    // The wire set refreshes: the granted tool appears with its full schema.
    expect(ctx.tools.schemas(agent).map(schema => schema.name)).toEqual(['read', TOOL_SEARCH_NAME])
    const assembly = await systemPrompt.assemble({ scope: agent })
    expect(assembly.tools.map(tool => tool.name)).toEqual(['read', TOOL_SEARCH_NAME])

    const allowed = await callTool(ctx, 'read', agent)
    expect(allowed).toMatchObject({ isError: false, value: 'read:x' })
    expect(calls.read).toEqual([{ value: 'x' }])
    // Ungranted tools stay paged out.
    expect(ctx.tools.schemas(agent).map(schema => schema.name)).not.toContain('write')
  })

  it('pages scoped own-layer registrations like any other tool', async () => {
    const { ctx } = await setup()
    registerCatalog(ctx)
    const { scope, agent } = await mintAgentScope(ctx)
    scope.ctx.tools.register(defineTool({
      name: 'local',
      description: 'A scope-local helper.',
      parameters: { value: { type: 'string', required: true } },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      execute: args => Promise.resolve(`local:${args.value}`),
    }))

    expect(ctx.tools.schemas(agent).map(schema => schema.name)).toEqual([TOOL_SEARCH_NAME])
    const denied = await callTool(ctx, 'local', agent)
    expect(denied.error?.info).toEqual({ name: 'ToolNotFoundError', code: 'UNKNOWN_TOOL' })

    const found = await search(ctx, 'local helper', { agent })
    expect(found.isError).toBe(false)
    expect(ctx.tools.schemas(agent).map(schema => schema.name)).toEqual(['local', TOOL_SEARCH_NAME])
    const allowed = await callTool(ctx, 'local', agent)
    expect(allowed).toMatchObject({ isError: false, value: 'local:x' })
  })

  it('inherits a grant down the scope chain, like an inherited registration', async () => {
    const { ctx } = await setup()
    registerCatalog(ctx)
    const standing = await mintAgentScope(ctx, 'preset:paged-like')
    standing.scope.ctx.tools.presentAs('paged')
    const joined = await mintAgentScope(ctx, 'joined-agent')
    bindScopeParent(joined.agent, standing.agent)

    // The grant lands in the CALLING scope; descendants of that scope see it.
    const found = await search(ctx, 'read a file', { agent: standing.agent, limit: 1 })
    expect(found.isError).toBe(false)
    expect(ctx.tools.schemas(joined.agent).map(schema => schema.name)).toEqual(['read', TOOL_SEARCH_NAME])
  })

  it('emits tools/change exactly when a grant lands', async () => {
    const { ctx } = await setup()
    registerCatalog(ctx)
    const { agent } = await mintAgentScope(ctx)
    let changes = 0
    ctx.on('tools/change', () => { changes += 1 })

    await search(ctx, 'read a file', { agent, limit: 1 })
    expect(changes).toBe(1)
    // A no-match search grants nothing and notifies nobody.
    await search(ctx, 'xyzzy quantum', { agent })
    expect(changes).toBe(1)
  })

  it('answers a no-match search with catalog hints', async () => {
    const { ctx } = await setup()
    registerCatalog(ctx)

    const missed = await search(ctx, 'xyzzy quantum')
    expect(missed.isError).toBe(false)
    const text = resultText(missed)
    expect(text).toContain('No tools matched')
    expect(text).toContain('read')
  })
})

describe('matcher seam', () => {
  it('ranks name hits above description hits and breaks ties by catalog order', async () => {
    const { ctx } = await setup()
    registerCatalog(ctx)
    const { agent } = await mintAgentScope(ctx)

    // "read a file": read scores a name hit plus description hits; write only
    // description hits; bash nothing. limit 1 isolates the ranking.
    const found = await search(ctx, 'read a file', { agent, limit: 1 })
    expect(resultText(found)).toContain('## read')
    expect(resultText(found)).not.toContain('## write')
    expect(ctx.tools.schemas(agent).map(schema => schema.name)).toEqual(['read', TOOL_SEARCH_NAME])
  })

  it('clamps the requested limit into 1..10', async () => {
    const { ctx } = await setup()
    registerCatalog(ctx)
    await ctx.plugin(FakeMatcher)
    FakeMatcher.answer = ['read', 'write', 'bash']

    await search(ctx, 'anything', { limit: 99 })
    expect(FakeMatcher.calls[0]?.limit).toBe(10)
    await search(ctx, 'anything')
    expect(FakeMatcher.calls[1]?.limit).toBe(5)
    await search(ctx, 'anything', { limit: 0 })
    expect(FakeMatcher.calls[2]?.limit).toBe(1)
  })

  it('stops granting at the clamped limit even when the matcher returns more', async () => {
    const { ctx } = await setup()
    registerCatalog(ctx)
    await ctx.plugin(FakeMatcher)
    FakeMatcher.answer = ['read', 'write', 'bash']
    const { agent } = await mintAgentScope(ctx)

    const found = await search(ctx, 'anything', { agent, limit: 2 })
    expect(found.isError).toBe(false)
    expect(ctx.tools.schemas(agent).map(schema => schema.name)).toEqual(['read', 'write', TOOL_SEARCH_NAME])
  })

  it('answers plainly when the catalog itself is empty', async () => {
    const { ctx } = await setup()

    const missed = await search(ctx, 'anything')
    expect(missed.isError).toBe(false)
    expect(resultText(missed)).toBe('No tools matched the given intent.')
  })

  it('lets a mounted toolMatcher service override the default matcher', async () => {
    const { ctx } = await setup()
    registerCatalog(ctx)
    await ctx.plugin(FakeMatcher)
    // Deliberately orthogonal to the intent: the seam, not keywords, decides.
    FakeMatcher.answer = ['write']
    const { agent } = await mintAgentScope(ctx)

    const found = await search(ctx, 'read a file', { agent })
    expect(found.isError).toBe(false)
    expect(FakeMatcher.calls[0]?.intent).toBe('read a file')
    expect(FakeMatcher.calls[0]?.candidates).toEqual(['read', 'write', 'bash'])
    expect(ctx.tools.schemas(agent).map(schema => schema.name)).toEqual(['write', TOOL_SEARCH_NAME])
  })

  it('drops matcher answers outside the catalog and repeats before granting', async () => {
    const { ctx } = await setup()
    registerCatalog(ctx)
    await ctx.plugin(FakeMatcher)
    FakeMatcher.answer = ['write', 'nonexistent', 'write']
    const { agent } = await mintAgentScope(ctx)

    const found = await search(ctx, 'anything', { agent })
    expect(found.isError).toBe(false)
    expect(resultText(found).split('## write')).toHaveLength(2)
    expect(ctx.tools.schemas(agent).map(schema => schema.name)).toEqual(['write', TOOL_SEARCH_NAME])
  })
})

describe('per-agent presentation', () => {
  it('gives one agent Paged Mode while the deployment stays native', async () => {
    const { ctx, systemPrompt } = await setup({ mode: 'native' })
    const calls = registerCatalog(ctx)
    const { scope, agent } = await mintAgentScope(ctx)

    scope.ctx.tools.presentAs('paged')

    const paged = await systemPrompt.assemble({ scope: agent })
    expect(paged.tools.map(tool => tool.name)).toEqual([TOOL_SEARCH_NAME])
    expect(paged.sections.find(section => section.name === 'tools:catalog')?.text).toContain('- read —')
    expect(paged.sections.find(section => section.name === 'tools:paged-only')?.text).toContain(TOOL_SEARCH_NAME)
    // Announced surface and callable surface must agree for THIS agent.
    const denied = await callTool(ctx, 'read', agent)
    expect(denied.error?.info).toEqual({ name: 'ToolNotFoundError', code: 'UNKNOWN_TOOL' })
    expect(calls.read).toEqual([])

    // The deployment default is untouched: the global view stays native.
    const native = await systemPrompt.assemble()
    expect(native.tools.map(tool => tool.name)).toEqual(['bash', 'read', 'write'])
    expect(native.sections.some(section => section.name === 'tools:catalog')).toBe(false)
    const allowed = await callTool(ctx, 'read')
    expect(allowed).toMatchObject({ isError: false, value: 'read:x' })
  })

  it('completes the grant loop for the paged agent without touching native siblings', async () => {
    const { ctx } = await setup({ mode: 'native' })
    registerCatalog(ctx)
    const pagedScope = await mintAgentScope(ctx, 'paged')
    const plain = await mintAgentScope(ctx, 'plain')
    pagedScope.scope.ctx.tools.presentAs('paged')

    // The transport one agent presents must not be dispatchable by another.
    expect(ctx.tools.get(TOOL_SEARCH_NAME, pagedScope.agent)).toBeDefined()
    expect(ctx.tools.get(TOOL_SEARCH_NAME, plain.agent)).toBeUndefined()

    await search(ctx, 'read a file', { agent: pagedScope.agent, limit: 1 })
    expect(ctx.tools.schemas(pagedScope.agent).map(schema => schema.name)).toEqual(['read', TOOL_SEARCH_NAME])
    // A sibling's native view does not inherit the paged agent's grant.
    expect(ctx.tools.schemas(plain.agent).map(schema => schema.name)).toEqual(['read', 'write', 'bash'])
  })
})

describe('pinned set', () => {
  it('wires a pinned tool with its full schema from the first turn, without a grant', async () => {
    const { ctx, systemPrompt } = await setup({ pinned: ['read'] })
    registerCatalog(ctx)

    expect(ctx.tools.schemas().map(schema => schema.name)).toEqual(['read', TOOL_SEARCH_NAME])
    const assembly = await systemPrompt.assemble()
    expect(assembly.tools.map(tool => tool.name)).toEqual(['read', TOOL_SEARCH_NAME])
    const read = assembly.tools.find(tool => tool.name === 'read')
    expect(read?.description).toBe('Read a file from disk.')
    expect(read?.parameters).toMatchObject({
      type: 'object',
      properties: { value: { type: 'string' } },
      required: ['value'],
    })
  })

  it('lets a pinned tool execute directly without a tool_search round-trip', async () => {
    const { ctx } = await setup({ pinned: ['read'] })
    const calls = registerCatalog(ctx)
    const { agent } = await mintAgentScope(ctx)

    const allowed = await callTool(ctx, 'read', agent)
    expect(allowed).toMatchObject({ isError: false, value: 'read:x' })
    expect(calls.read).toEqual([{ value: 'x' }])
  })

  it('omits a pinned tool from the catalog section and from tool_search candidates', async () => {
    const { ctx, systemPrompt } = await setup({ pinned: ['read'] })
    registerCatalog(ctx)

    const catalog = (await systemPrompt.assemble()).sections.find(section => section.name === 'tools:catalog')
    expect(catalog?.text).not.toContain('- read —')
    expect(catalog?.text).toContain('- write — Write a file to disk.')
    expect(catalog?.text).toContain('- bash — Run a shell command.')

    // The matcher's candidate list is the same discovery surface.
    await ctx.plugin(FakeMatcher)
    await mintAgentScope(ctx)
    await search(ctx, 'anything')
    expect(FakeMatcher.calls[0]?.candidates).toEqual(['write', 'bash'])
  })

  it('unions pinned and dynamically granted tools without duplicates', async () => {
    const { ctx } = await setup({ pinned: ['read'] })
    registerCatalog(ctx)
    const { agent } = await mintAgentScope(ctx)

    const found = await search(ctx, 'write a file', { agent, limit: 1 })
    expect(found.isError).toBe(false)
    expect(ctx.tools.schemas(agent).map(schema => schema.name)).toEqual(['read', 'write', TOOL_SEARCH_NAME])
  })

  it('does not wire a pinned tool that a scoped restriction removes', async () => {
    const { ctx, systemPrompt } = await setup({ pinned: ['read'] })
    registerCatalog(ctx)
    const { scope, agent } = await mintAgentScope(ctx)
    scope.ctx.tools.restrict({ deny: ['read'] })

    expect(ctx.tools.schemas(agent).map(schema => schema.name)).toEqual([TOOL_SEARCH_NAME])
    const assembly = await systemPrompt.assemble({ scope: agent })
    expect(assembly.tools.map(tool => tool.name)).toEqual([TOOL_SEARCH_NAME])
  })

  it('ignores pinned under native, code, and both', async () => {
    // native: the pinned set never enters the granted-name path.
    const native = await setup({ mode: 'native', pinned: ['read'] })
    registerCatalog(native.ctx)
    expect(native.ctx.tools.schemas().map(schema => schema.name)).toEqual(['read', 'write', 'bash'])
    expect(native.ctx.tools.get(TOOL_SEARCH_NAME)).toBeUndefined()

    // code: only run_code is wired; pinning changes nothing.
    const code = await setup({ mode: 'code', pinned: ['read'] })
    await code.ctx.plugin(FakeCodeRuntime)
    registerCatalog(code.ctx)
    expect((await code.systemPrompt.assemble()).tools.map(tool => tool.name)).toEqual([RUN_CODE_NAME])

    // both: every visible tool plus run_code; no paged transport or catalog appears.
    const both = await setup({ mode: 'both', pinned: ['read'] })
    await both.ctx.plugin(FakeCodeRuntime)
    registerCatalog(both.ctx)
    const bothAssembly = await both.systemPrompt.assemble()
    expect(bothAssembly.tools.map(tool => tool.name)).toEqual(['bash', 'read', RUN_CODE_NAME, 'write'])
    expect(bothAssembly.sections.some(section => section.name === 'tools:catalog')).toBe(false)
  })
})
