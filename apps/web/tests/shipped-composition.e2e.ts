// Boots the shipped Web composition over the built dist this lane already uses
// and asserts what that composition produces: the model-visible tool catalog
// and file-reference guidance plus the sandbox/approval knobs it ships with.
// No browser and no model call — these are composition facts, and the browser
// scenarios in this lane cover the surface itself.
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import { CallId } from '@deepseek-ai/dsh-llm'
import { canonicalPath, writableRoots } from '@deepseek-ai/dsh-sandbox'
import { SessionId } from '@deepseek-ai/dsh-session'
// Empty type imports carry the tools/sandboxPolicy/approval Context merges.
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type {} from '@deepseek-ai/dsh-user-approval'
import type {} from '@deepseek-ai/dsh-permission-presets'
import type {} from '@deepseek-ai/dsh-agent-presets'
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { launchWebScaffold, type WebScaffold } from './scaffold.ts'

const FILE_REFERENCE_PROMPT = fileURLToPath(new URL(
  './snapshots/web-runtime-context/file-reference-prompt.expected.md', import.meta.url,
))

/**
 * The catalog the shipped Web composition puts in front of the model, minus the
 * ripgrep-dependent pair below. The absences are deliberate, not incidental
 * gaps: the `cordis_*` toolset executes model-written JavaScript that no
 * sandbox row confines, `web_fetch` chooses its own request target, and
 * `mcp_*` servers spawn outside `ctx.shell`. The composition Agent Note owns the
 * rationale and its sources.
 */
const EXPECTED_TOOLS = [
  'anton_restart',
  'anton_start',
  'anton_status',
  'anton_stop',
  'ask_user_question',
  'bash',
  'create_goal',
  'edit',
  'exit_plan_mode',
  'flow_block_save',
  'flow_get',
  'flow_library_search',
  'flow_list',
  'flow_run',
  'flow_run_status',
  'flow_save',
  'get_goal',
  'interrupt_agent',
  'job_kill',
  'job_list',
  'job_output',
  'list_agents',
  'plan_write',
  'ralph',
  'read',
  'read_image',
  'run_code',
  'send_message',
  'skill',
  'subagent',
  'subagent_fork',
  'todo_write',
  'update_goal',
  'web_search',
  'workflow',
  'write',
]

/**
 * `glob` and `grep` come from `dsh-tool-fs-search`, which spawns the PACKAGED
 * ripgrep binary (`@vscode/ripgrep`) through the subprocess seam, so the pair
 * is always present on every host — asserted as fixed members, not a host
 * dependency.
 */
const RIPGREP_TOOLS = ['glob', 'grep']

let scaffold: WebScaffold | undefined

afterEach(async () => {
  await scaffold?.close()
  scaffold = undefined
})

it('assembles the shipped Web catalog, file-reference guidance, and confined access default', async () => {
  scaffold = await launchWebScaffold()
  const ctx = scaffold.ctx
  // The catalog belongs to an AGENT, not to the process: every model-facing row
  // now lives in a preset mounted under one session's scope, so the global
  // layer holds nothing and a caller must name the agent to see anything. This
  // composes from the deployment default — what a session that names no preset
  // gets — which is the shape this test has always been about.
  // Paged Mode hosts `tool_search` at the global layer; every model-facing
  // domain tool lives in the preset mounted per session below.
  expect(ctx.tools.schemas().map(schema => schema.name)).toEqual(['tool_search'])
  // The shipped presentation default is `paged`: a fresh agent's wire set is
  // the reserved `tool_search` transport alone, and the domain catalog rides
  // the search/grant flow. Pin that default, then present `both` on the same
  // agent so the composition assertions below still see the whole catalog.
  let sawPagedDefault = false
  const handle = await ctx.agents.create({
    sessionId: SessionId('shipped-composition'),
    setup: agentCtx => ctx.agentPresets.mount(agentCtx).then(() => {
      sawPagedDefault = ctx.tools.schemas().length === 1
        && ctx.tools.schemas()[0]?.name === 'tool_search'
      agentCtx.tools.presentAs('both')
    }),
  })
  expect(sawPagedDefault).toBe(true)
  try {
    const names = ctx.tools.schemas(handle.agent).map(schema => schema.name).sort()
    expect(names.filter(name => !RIPGREP_TOOLS.includes(name))).toEqual(EXPECTED_TOOLS)
    // The packaged ripgrep binary ships with the dependency, so the pair is a
    // fixed roster member on every host.
    expect(names.filter(name => RIPGREP_TOOLS.includes(name))).toEqual(RIPGREP_TOOLS)
    const fileReferenceSection = (await ctx.systemPrompt.assemble({ scope: handle.agent })).sections
      .find(section => section.name === 'ui:deliverable-file-references')
    expect(fileReferenceSection?.text).toBe(readFileSync(FILE_REFERENCE_PROMPT, 'utf8').trimEnd())
  } finally {
    await handle.dispose()
  }
  // `workspace-write` is not "the workspace and nothing else": the shared roots
  // helper always admits the temp directories too. Pinning it against an
  // explicit mode keeps the claim independent of this surface's default, and
  // keeps a future sandbox-confinement test from being run inside /tmp — where an
  // "escape" write succeeds by design and reads as a sandbox failure.
  expect(writableRoots(scaffold.ctx.sandboxPolicy.resolve({ mode: 'workspace-write' }))).toEqual(
    expect.arrayContaining([canonicalPath('/tmp'), canonicalPath(tmpdir())]),
  )
  expect(scaffold.ctx.sandboxPolicy.defaultMode).toBe('workspace-write')
  expect(scaffold.ctx.approval.config.policy).toBe('ask')
  expect(scaffold.ctx.permissionPresets.defaultPreset).toBe('workspace-write')

  const commandHandle = await scaffold.ctx.agents.create({
    sessionId: SessionId('shipped-command-catalog'),
    meta: { cwd: scaffold.workspaceCwd },
    agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
  })
  try {
    expect(scaffold.ctx.commands.list(commandHandle.agent)).toContainEqual({
      name: 'feedback',
      description: 'record feedback about this session',
      input: { hint: '<text>' },
    })
  } finally {
    await commandHandle.dispose()
  }
}, 120_000)

it('lets a preset producer reach the background-job registry', async () => {
  scaffold = await launchWebScaffold()
  const ctx = scaffold.ctx
  const handle = await ctx.agents.create({
    sessionId: SessionId('shipped-background-job'),
    meta: { cwd: scaffold.workspaceCwd },
    setup: agentCtx => ctx.agentPresets.mount(agentCtx).then(() => undefined),
  })
  try {
    const signal = new AbortController().signal
    // The shipped presentation default is `paged`: grant `bash` through the
    // `tool_search` transport before calling it directly — the same flow the
    // model drives.
    const search = await ctx.tools.execute({
      signal,
      callId: CallId('shipped-tool-search'),
      name: 'tool_search',
      arguments: { intent: 'run a bash command in the background' },
      agent: handle.agent,
    })
    expect(JSON.stringify(search.content)).toContain('bash')
    // The job controls ride the same grant flow before the controller calls them.
    await ctx.tools.execute({
      signal,
      callId: CallId('shipped-tool-search-jobs'),
      name: 'tool_search',
      arguments: { intent: 'list and collect background job output and kill jobs' },
      agent: handle.agent,
    })
    // The todo-plan gate denies execution tools until the session records a
    // todo plan; `todo_write` itself is never gated.
    await ctx.tools.execute({
      signal,
      callId: CallId('shipped-todo-plan'),
      name: 'todo_write',
      arguments: { todos: [{ content: 'probe the background-job registry', status: 'in_progress' }] },
      agent: handle.agent,
    })
    // `tool-bash` is a preset row and `tasks` is a host registry; the producer
    // resolves it with `ctx.get`, so a registry hidden behind a preset realm
    // fails here — with every task control still listed in the catalog above.
    const started = await ctx.tools.execute({
      signal,
      callId: CallId('shipped-bash-background'),
      name: 'bash',
      arguments: {
        command: 'printf SHIPPED_BACKGROUND_OK',
        description: 'shipped background probe',
        run_in_background: true,
      },
      agent: handle.agent,
    })
    expect({ isError: started.isError, content: started.content }).toEqual({
      isError: false,
      content: [{ type: 'text', text: 'started background job bash-1' }],
    })

    // The controller reads what the producer started: same registry, one
    // owner. A per-preset registry would list nothing here even on success.
    const listed = await ctx.tools.execute({
      signal,
      callId: CallId('shipped-task-list'),
      name: 'job_list',
      arguments: {},
      agent: handle.agent,
    })
    expect(listed.isError).toBe(false)
    expect(listed.content).toEqual([
      { type: 'text', text: expect.stringContaining('bash-1 [bash]') as unknown as string },
    ])

    // The full round trip: the output a host-plane producer wrote is collected
    // through a preset-plane control, which is the linkage the realm severed.
    const collected = await ctx.tools.execute({
      signal,
      callId: CallId('shipped-task-output'),
      name: 'job_output',
      arguments: { job_id: 'bash-1', wait: true },
      agent: handle.agent,
    })
    expect(collected.isError).toBe(false)
    expect(collected.content).toEqual([
      { type: 'text', text: expect.stringContaining('SHIPPED_BACKGROUND_OK') as unknown as string },
    ])
  } finally {
    await handle.dispose()
  }
}, 120_000)
