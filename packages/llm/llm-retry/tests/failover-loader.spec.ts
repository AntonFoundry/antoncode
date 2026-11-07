import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { createUserMessage, LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as retry from '../src/index.ts'

let root: string | undefined
let context: Context | undefined

class LoaderBoundaryAdapter extends LlmAdapter {
  readonly routes: string[] = []

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model, defaultMaxTokens: 1_024, context: { contextWindow: 100_000 } })
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.routes.push(options.provider)
    if (options.provider === 'alpha') throw new LlmError('primary quota exhausted', 'QUOTA')
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'configured backup answered' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'configured backup answered' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

describe('failover in real Loader composition', () => {
  it('loads failover YAML and settles a same-turn cross-route response', { timeout: 60_000 }, async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-failover-loader-'))
    const configPath = join(root, 'cordis.yml')
    await writeFile(configPath, [
      '- name: cordis:llm',
      '- name: cordis:session',
      '- name: cordis:projections',
      '- name: cordis:system',
      '- name: cordis:tools',
      '- name: cordis:native',
      '- name: cordis:agents',
      '- name: cordis:retry',
      '  config:',
      '    failover:',
      '      enabled: true',
      '      sameRouteRetries: 0',
      '      chains:',
      '        - primary: {provider: alpha, model: primary}',
      '          fallbacks:',
      '            - {provider: beta, model: backup}',
      '- name: cordis:loop',
      '',
    ].join('\n'))
    const ctx = new Context()
    context = ctx
    ctx.baseUrl = pathToFileURL(root).href + '/'
    await ctx.plugin(Loader)
    Object.assign(ctx.loader.builtins, {
      include: Include,
      llm: LlmRuntime,
      session: SessionStore,
      projections: SessionProjectionRegistry,
      system: SystemPrompt,
      tools: ToolRuntime,
      native: NativeToolExecutor,
      agents: AgentRegistry,
      retry,
      loop: AgentLoop,
    })
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
    await ctx.loader.await()
    expect([...ctx.loader.entries()].filter(entry => entry.fiber === undefined && !entry.disabled)).toEqual([])

    const adapter = new LoaderBoundaryAdapter()
    const registration = ctx.llm.registerAdapter(['alpha', 'beta'], adapter)
    const agent = await ctx.agentLoop.create(SessionId('loader-failover'), { provider: 'alpha', model: 'primary' })
    const idle = agent.whenIdle()
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'recover across routes' }], source: { kind: 'user' } }))
    await idle

    expect(adapter.routes).toEqual(['alpha', 'beta'])
    expect(agent.session.snapshotEvents().filter(event => event.type === 'llm/failover')).toMatchObject([{
      data: { from: { provider: 'alpha', model: 'primary' }, to: { provider: 'beta', model: 'backup' }, turn: 1, step: 1 },
    }])
    expect(agent.session.deriveMessages().at(-1)).toMatchObject({
      role: 'assistant', content: [{ type: 'text', text: 'configured backup answered' }],
    })
    registration()
    await ctx.fiber.dispose()
    context = undefined
  })
})
