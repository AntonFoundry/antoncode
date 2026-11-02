/**
 * Model-facing delegation through one configured `ctx.subagents` provider.
 * Provider lifecycle controls tool registration and context-sensitive schema
 * wording. Every delegation starts a managed activation and returns its child
 * id; the subagent runtime owns result delivery and resource cleanup.
 * @module @deepseek-ai/dsh-tool-subagent
 */

import type { Context, Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { AgentOptions } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import {
  assertSubagentMaxDepth,
  delegationDepthOf,
  parentAgentOptionsForDelegation,
} from '@deepseek-ai/dsh-subagent'
import type { SubagentProvider } from '@deepseek-ai/dsh-subagent'
import {
  assertAllowedModelSelection,
  hasConfiguredLlmSelection,
  hasDelegationModelRequest,
  preflightChildLlmRoute,
  requestedAgentOptions,
} from './model-selection.ts'
import type { DelegationModelRequest } from './model-selection.ts'
import { registerListSubagentModels } from './list-models.ts'
import { SubagentPresetSelection, type PresetSelectionConfig, type PresetSelectionRequest } from './preset-selection.ts'
import {
  subagentModelSelectionProjectionDefinition,
  subagentModelSelectionPolicy,
} from './model-selection-state.ts'

export const name = 'tool-subagent'
export const inject = ['tools', 'subagents', 'systemPrompt', 'sessionProjections']

// Definition identity keeps shared guidance scoped to the actual visible tools,
// including scoped overrides and independently loaded tool registries.
const delegationTools = new Set<ToolDefinition>()

/** Config: which registered provider this tool delegates to, plus child defaults. */
export interface Config extends PresetSelectionConfig {
  /** The `ctx.subagents` provider name to start runs on (e.g. `spawn`, `acp`). */
  provider: string
  /**
   * Model-facing tool name (default `subagent`). Each loaded instance must use
   * a distinct name.
   */
  toolName?: string
  /**
   * Expose optional child `provider`, `model`, and `reasoning_effort` fields.
   * Requires provider `agentOptions` support. Execution enforces the Session
   * policy, or restricts explicit selection to the current parent route.
   */
  modelSelection?: boolean
  /**
   * Register the shared `list_subagent_models` tool for this scope.
   * Enable on only one instance per scope; defaults to false and does not
   * enable model selection. Discovery is removed when this instance unloads.
   */
  modelDiscovery?: boolean
  /**
   * Agent options applied to every child; omitted fields use child-loop defaults.
   */
  agentOptions?: AgentOptions
  /**
   * Maximum child depth: a non-negative safe integer (`0` forbids delegation),
   * or `'provider-managed'` to send no cap. A numeric cap
   * requires the provider's `depthLimit` capability (mount fails loud
   * otherwise). The provider checks the calling agent's current depth at every
   * start; the tool remains model-visible so runtime policy owns rejection.
   * `'provider-managed'` is for an out-of-process provider whose recursion
   * budget belongs to the child runtime or its own deployment. Omission reads
   * the current Host subagent depth setting (default `1`) at each delegation.
   */
  maxDepth?: number | 'provider-managed'
  /**
   * Live default child route applied when a delegation names no route: a
   * `provider/model` route, a bare model id, or `auto` to ask the optional
   * model-intel service for a task-scored route. Empty or omitted inherits the
   * parent route. Applies only to providers with the `agentOptions` capability.
   */
  childModel: Volatile<string | undefined>
  /** Live per-parent-Session child routes; a row for the calling Session wins over {@link childModel}. */
  childModelBySession: Volatile<Record<string, string>>
  /** Live default child reasoning-effort id applied when a delegation names none. */
  childReasoningEffort: Volatile<string | undefined>
}

export const Config = z.object({
  provider: z.string().required(),
  toolName: z.string().default('subagent'),
  modelSelection: z.boolean().default(false),
  modelDiscovery: z.boolean().default(false),
  // Prevent Schemastery from materializing omitted agentOptions as `{}`.
  agentOptions: z.object({
    provider: z.string(),
    model: z.string(),
    reasoningEffort: z.string().min(1) as z<ReturnType<typeof ReasoningEffortId> | undefined>,
    maxTokens: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER),
  }).default(undefined as unknown as {
    provider: string
    model: string
    reasoningEffort: ReturnType<typeof ReasoningEffortId>
    maxTokens: number
  }),
  agentPreset: z.string().min(1),
  allowedAgentPresets: (z.array(z.string().min(1)).min(1) as z<string[] | undefined>).default(undefined),
  maxDepth: z.union([z.natural().max(Number.MAX_SAFE_INTEGER), z.const('provider-managed' as const)]),
  childModel: z.string().volatile(),
  childModelBySession: z.dict(z.string()).default({}).volatile(),
  // Plain string: the selected provider validates the effort per model during route preflight.
  childReasoningEffort: z.string().volatile(),
})

/**
 * Split a `provider/model` (or bare `model`) route string into agent options.
 *
 * A route may carry a slash-bearing model id: `opengateway/deepseek/deepseek-v4.1-flash`
 * means provider `opengateway`, model `deepseek/deepseek-v4.1-flash`. A
 * last-slash split would name the unregistered provider `opengateway/deepseek`,
 * so the longest registered provider prefix that leaves a non-empty model id
 * wins. Without a registry, or when no registered prefix matches, the last
 * slash splits.
 * @param route - the configured route string.
 * @param knownProviders - registered provider ids, or undefined to split on the last slash.
 * @returns the agent-options override naming provider and model.
 */
export function splitModelRoute(route: string, knownProviders?: Iterable<string>): AgentOptions {
  if (knownProviders !== undefined) {
    let best: { provider: string; model: string } | undefined
    for (const provider of knownProviders) {
      if (provider.length === 0 || !route.startsWith(`${provider}/`)) continue
      const model = route.slice(provider.length + 1)
      if (model.length === 0) continue
      if (best === undefined || provider.length > best.provider.length) best = { provider, model }
    }
    if (best !== undefined) return best
  }
  const slash = route.lastIndexOf('/')
  if (slash <= 0 || slash === route.length - 1) return { model: route }
  return { provider: route.slice(0, slash), model: route.slice(slash + 1) }
}

/** Live child-route defaults read once per delegation. */
export interface ChildModelDefaults {
  /** Global default route, `auto`, or empty. */
  readonly defaultModel: string
  /** Per-parent-Session routes keyed by parent Session id. */
  readonly bySession: Readonly<Record<string, string>>
}

/**
 * Resolve one delegation's default child route: the calling Session's row
 * wins, then the global default. `auto` asks the model-intel service with the
 * task text; an unavailable or unmatched `auto` route inherits the parent route.
 * @param defaults - the live child-route defaults.
 * @param parentSessionId - the calling Session's id.
 * @param taskText - the delegation prompt, scored by the `auto` route.
 * @param autoRoute - the `auto` route resolver, when model-intel is mounted.
 * @param knownProviders - registered provider ids for {@link splitModelRoute}.
 * @returns the agent-options override naming the route, or undefined to inherit.
 */
export async function resolveChildModelRoute(
  defaults: ChildModelDefaults,
  parentSessionId: string,
  taskText: string,
  autoRoute?: (task: string) => Promise<AgentOptions | undefined>,
  knownProviders?: Iterable<string>,
): Promise<AgentOptions | undefined> {
  const sessionRoute = defaults.bySession[parentSessionId]?.trim() ?? ''
  const route = sessionRoute.length > 0 ? sessionRoute : defaults.defaultModel.trim()
  if (route.length === 0) return undefined
  if (route.toLowerCase() === 'auto') return autoRoute?.(taskText)
  return splitModelRoute(route, knownProviders)
}

/** Tool-description policy that makes parallel delegation the default for decomposable work. */
const DELEGATION_DEFAULT_WORDING = ' Delegation is the DEFAULT for decomposable work: when a task splits into two or more '
  + 'independent pieces — separate files, surfaces, or concerns — fan them out to parallel subagent calls in one '
  + 'message instead of doing them inline; keep only single-step or strictly sequential actions inline.'

/**
 * Model-facing wording from the provider's conversation-history descriptor
 * ({@link SubagentProvider.inheritsParentContext}).
 * A fresh child needs a standalone prompt; a forked child already sees the
 * conversation's completed turns — telling the model to restate everything
 * (or, worse, that the child "does not see this conversation") would be false
 * for a fork.
 * @param inheritsConversation - whether the child's conversation is seeded
 *   with the parent's completed turns; this says nothing about tool, service,
 *   scope, or authority inheritance.
 * @returns the tool `description` and the `prompt` parameter description.
 */
function providerWording(inheritsConversation: boolean): { description: string; promptDescription: string } {
  if (inheritsConversation) {
    return {
      description:
        'Delegate a task to a subagent that inherits this conversation: a child agent seeded with all '
        + 'completed turns so far (it does not see the current in-flight turn). Use this when the subtask '
        + 'builds on this conversation\'s context — a follow-up analysis, '
        + 'a review, a continuation — without consuming this conversation\'s context for the work itself. '
        + 'You receive its result, not its intermediate steps.' + DELEGATION_DEFAULT_WORDING,
      promptDescription:
        'The task for the subagent. It already sees this conversation\'s completed turns, so build on them '
        + 'freely and state only what is new.',
    }
  }
  return {
    description:
      'Delegate a self-contained task to a subagent (a separate agent that works in its own context) '
      + 'to offload focused, independent work — research, a scoped '
      + 'implementation, an analysis — so it does not consume this conversation\'s context. The subagent '
      + 'returns its result, not its intermediate steps.' + DELEGATION_DEFAULT_WORDING,
    promptDescription:
      'The complete, self-contained task for the subagent. It does not share this '
      + 'conversation\'s context, so include everything it needs.',
  }
}

/**
 * Install one delegation-tool composition.
 * The owning composition shares its registrations across Agents; child startup resolves the selected preset.
 * @param ctx - Context that owns the registrations.
 * @param config - delegation-tool configuration.
 * @returns when the plugin is ready.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  for (const field of ['persona', 'toolFilter']) {
    if (Object.hasOwn(config, field)) {
      throw new Error(`tool-subagent: ${field} is no longer supported; configure persona and tool plugins in an Agent Preset and select it with agentPreset (spawn only)`)
    }
  }
  const presets = new SubagentPresetSelection(config)
  if (presets.configured && ctx.get('agentPresets') === undefined) {
    throw new Error('tool-subagent: agent preset selection requires the agent-presets service')
  }
  // Direct apply() bypasses Schemastery's numeric constraints. A direct-apply
  // omission stays capless (the schema default only runs through the loader).
  if (config.maxDepth !== 'provider-managed') assertSubagentMaxDepth(config.maxDepth)
  const toolName = config.toolName ?? 'subagent'

  const modelSelectionEnabled = config.modelSelection === true
  const subagentModelSelectionProjectionHandle = await ctx.sessionProjections.register(subagentModelSelectionProjectionDefinition)

  const assertSubagentProviderConfiguration = (subagentProvider: SubagentProvider): void => {
    presets.assertProvider(subagentProvider)
    if (ctx.subagents.resolveMaxDepth(config.maxDepth) !== undefined && !subagentProvider.capabilities.depthLimit) {
      throw new Error(
        `tool-subagent: provider "${subagentProvider.name}" cannot enforce maxDepth (no depthLimit capability) — `
        + 'set maxDepth: \'provider-managed\' to leave the recursion budget to the provider',
      )
    }
    if (config.agentOptions !== undefined && !subagentProvider.capabilities.agentOptions) {
      throw new Error(
        `tool-subagent: provider "${subagentProvider.name}" does not support child agentOptions`,
      )
    }
    if (modelSelectionEnabled && !subagentProvider.capabilities.agentOptions) {
      throw new Error(
        `tool-subagent: provider "${subagentProvider.name}" does not support child model selection`,
      )
    }
  }

  // Validate provider-owned config outside the optional LLM binding so an
  // invalid provider always rejects its registration or this plugin's load.
  ctx.on('subagent/provider-added', (subagentProvider) => {
    if (subagentProvider.name === config.provider) assertSubagentProviderConfiguration(subagentProvider)
  })
  const initialProvider = ctx.subagents.getProvider(config.provider)
  if (initialProvider !== undefined) assertSubagentProviderConfiguration(initialProvider)

  if (config.modelDiscovery === true) registerListSubagentModels(ctx, subagentModelSelectionProjectionHandle)

  /**
   * Merge the live child-route and effort defaults over the configured child
   * options. A route overrides only the provider and model fields it names.
   * The optional model-intel and llm services are read per call because they
   * may mount after this plugin.
   */
  const withChildModelDefaults = async (
    configured: AgentOptions | undefined,
    parentSessionId: string,
    taskText: string,
  ): Promise<AgentOptions | undefined> => {
    // `model-intel` is untyped on Context; this is the one method the `auto` route uses.
    const intel = ctx.get('model-intel') as { resolveAutoRoute(task: string): Promise<AgentOptions | undefined> } | undefined
    const llm = ctx.get('llm')
    const route = await resolveChildModelRoute(
      { defaultModel: config.childModel.get() ?? '', bySession: config.childModelBySession.get() },
      parentSessionId,
      taskText,
      intel === undefined ? undefined : task => intel.resolveAutoRoute(task),
      llm?.listProviders().map(provider => provider.id),
    )
    const effort = config.childReasoningEffort.get()?.trim() ?? ''
    if (route === undefined && effort.length === 0) return configured
    return {
      ...configured,
      ...route,
      ...effort.length === 0 ? {} : { reasoningEffort: ReasoningEffortId(effort) },
    }
  }

  // Load order and HMR replacement can change provider availability while
  // this fiber remains active.
  let mounted: { subagentProvider: SubagentProvider; definition: ToolDefinition; disposeTool: () => void } | undefined
  const mount = (subagentProvider: SubagentProvider): void => {
    assertSubagentProviderConfiguration(subagentProvider)
    const wording = providerWording(subagentProvider.inheritsParentContext)
    const providerRouteDefaults = subagentProvider.agentRouteDefaults
    const selectionDescription = providerRouteDefaults !== undefined
      ? ' Supply `provider` and `model` together. Omitted values use child defaults, falling back to this backend\'s route defaults. When the effective route changes, an omitted `reasoning_effort` uses the model\'s default.'
      : ' Supply `provider` and `model` together. Omitted values use child defaults, falling back to compatible parent values. When the effective route changes, an omitted `reasoning_effort` uses the model\'s default.'
    const definition = defineTool({
      name: toolName,
      description: wording.description
        + ' This tool starts an independently managed subagent and immediately returns its id. The runtime notifies you when it finishes.'
        + (subagentProvider.prepareContinuable !== undefined
          ? ' The child reports results with `send_message`; use `send_message` to steer it while running or continue its conversation after it finishes. Prefer that continuation over a new child when an existing child already owns the task context.'
          : ' The completion notice includes its final answer. This backend does not accept follow-up messages.')
        + (modelSelectionEnabled ? selectionDescription : '')
        + (modelSelectionEnabled && subagentProvider.inheritsParentContext
          ? ' Changing the route can prevent provider-side reuse of the inherited conversation prefix.'
          : ''),
      parameters: {
        cwd: {
          type: 'string',
          description: 'Initial child working directory. Relative paths use your current directory; omitted inherits it. Later directory changes in either agent are independent.',
        },
        description: {
          type: 'string',
          required: true,
          description: subagentProvider.prepareContinuable !== undefined
            ? 'A short (3-5 word) durable label naming the domain this child owns (subsystem, surface, or responsibility), not the one-off request. Later tasks match this label to decide whether to continue this child instead of starting a new one.'
            : 'A short (3-5 word) description of the delegated task, for display.',
        },
        prompt: {
          type: 'string',
          required: true,
          description: wording.promptDescription,
        },
        ...presets.choices === undefined ? {} : {
          agent_preset: {
            type: 'string' as const,
            enum: [...presets.choices],
            description: presets.description,
          },
        },
        ...modelSelectionEnabled ? {
          provider: {
            type: 'string' as const,
            description: 'Child LLM provider id.',
          },
          model: {
            type: 'string' as const,
            description: 'Model id within that provider.',
          },
          reasoning_effort: {
            type: 'string' as const,
            description: 'Model-specific reasoning effort id.',
          },
        } : {},
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            kind: { type: 'string', required: true, const: 'activation' },
            subagentId: { type: 'string', required: true },
          },
        },
        render: (_args, value) => [{ type: 'text', text: `started subagent ${value.subagentId}` }],
      },
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const parent = exec.agent
        if (!parent) {
          // Non-agent callers provide no parent for delegation ownership.
          throw new Error('subagent tool requires a calling agent (exec.agent was undefined)')
        }

        const routes = subagentModelSelectionPolicy(subagentModelSelectionProjectionHandle, parent.session)
        const modelSelectionPolicy = routes === undefined ? undefined : { routes }
        const agentPreset = presets.resolve(args as PresetSelectionRequest)
        const modelRequest = args as DelegationModelRequest
        const parentOptions = parentAgentOptionsForDelegation(parent)
        const configuredAgentOptions = subagentProvider.capabilities.agentOptions
          ? await withChildModelDefaults(config.agentOptions, parent.id, args.prompt)
          : config.agentOptions
        const requiresRoutePreflight = hasDelegationModelRequest(modelRequest)
          || hasConfiguredLlmSelection(configuredAgentOptions)
        const configuredChildAgentOptions = requiresRoutePreflight && providerRouteDefaults !== undefined
          ? { ...providerRouteDefaults, ...configuredAgentOptions }
          : configuredAgentOptions
        const requestedChildAgentOptions = requestedAgentOptions(
          parentOptions,
          configuredChildAgentOptions,
          modelRequest,
          modelSelectionEnabled,
        )
        assertAllowedModelSelection(
          modelSelectionPolicy,
          parentOptions,
          requestedChildAgentOptions,
          modelRequest,
        )
        if (requiresRoutePreflight) {
          const llm = ctx.get('llm')
          if (llm === undefined) {
            throw new Error('cannot resolve the selected child LLM route because the `llm` service is unavailable')
          }
          await preflightChildLlmRoute(
            llm,
            parentOptions,
            requestedChildAgentOptions,
            exec.signal,
            providerRouteDefaults === undefined,
          )
          if (ctx.subagents.getProvider(config.provider) !== subagentProvider) {
            throw new Error(`subagent provider "${config.provider}" changed while resolving the child LLM route; retry the delegation`)
          }
        }
        exec.signal.throwIfAborted()
        const maxDepth = ctx.subagents.resolveMaxDepth(config.maxDepth)
        const request = {
          ...args.cwd === undefined ? {} : { cwd: args.cwd },
          prompt: [{ type: 'text', text: args.prompt }] as ContentBlock[],
          parent,
          ...agentPreset === undefined ? {} : { agentPreset },
          ...requestedChildAgentOptions !== undefined ? { agentOptions: requestedChildAgentOptions } : {},
          ...maxDepth !== undefined ? { maxDepth } : {},
        }

        const started = await ctx.subagents.startActivation({
          provider: config.provider,
          label: args.description,
          request,
          signal: exec.signal,
          delivery: 'parent',
        })
        return { kind: 'activation' as const, subagentId: started.childId }
      },
    })
    const disposeTool = ctx.effect(() => {
      const unregister = ctx.tools.register(definition)
      delegationTools.add(definition)
      return () => {
        delegationTools.delete(definition)
        unregister()
      }
    })
    // oxlint-disable-next-line typescript/no-misused-promises -- Tool and guidance disposal are synchronous.
    mounted = { subagentProvider, definition, disposeTool }
  }

  // Register listeners before checking presence so no synchronous change is missed.
  ctx.on('subagent/provider-added', (subagentProvider) => {
    if (subagentProvider.name === config.provider && mounted === undefined) mount(subagentProvider)
  })
  ctx.on('subagent/provider-removed', (name) => {
    if (name !== config.provider || mounted === undefined) return
    mounted.disposeTool()
    mounted = undefined
  })
  const present = ctx.subagents.getProvider(config.provider)
  if (present !== undefined) {
    mount(present)
  } else {
    // A backend fiber may activate later; a misspelled provider remains visible in this log.
    ctx.logger.info(`subagent provider "${config.provider}" not registered yet; the "${config.toolName ?? 'subagent'}" tool will register when it appears`)
  }
  ctx.systemPrompt.section({
    name: `tool:${toolName}`,
    order: ctx.systemPrompt.getSectionOrder('TOOL_SUBAGENT'),
    text: (context) => {
      if (mounted === undefined) return ''
      const visible = [...delegationTools]
        .filter(tool => ctx.tools.get(tool.name, context.scope) === tool)
        .map(tool => tool.name)
        .sort()
      if (visible[0] !== toolName) return ''
      const names = visible.map(name => `\`${name}\``).join(' or ')
      return `Start independent delegations with ${names} together in one assistant message and continue useful work while they run. When only waiting for their results remains, end your turn instead of sleeping or polling; the next result starts a new turn.`
        + ' Delegation is the DEFAULT for decomposable work: when a task splits into two or more independent '
        + 'pieces — separate files, surfaces, or concerns — fan them out to parallel delegation calls in one '
        + 'assistant message instead of doing them inline. Keep only genuinely single-step or strictly '
        + 'sequential actions inline; do not wait to be asked to parallelize.'
        + ' For relatively large tasks, multi-phase projects, or complex sets of to-dos, delegate codebase '
        + 'exploration to a subagent to draft the implementation plan — but the plan never waits on '
        + 'delegation: if the subagent fails or is unavailable, author the plan from current knowledge and '
        + 'record it with plan_write before writing the todo tree or mutating code.'
        + (modelSelectionEnabled
          ? ' Leave `provider`, `model`, and `reasoning_effort` unset unless the task needs a different model: '
            + 'a delegation that omits them runs on the configured child-model default.'
          : '')
        + ' Before starting a new child, when `list_agents` and `send_message` are available, list your '
        + 'continuable children and continue one whose label and domain already cover this task with '
        + '`send_message`; its conversation prefix is largely cached, so continuing it costs far less than '
        + 'restating the context. Start a new child only when no existing child fits, when the work must run '
        + 'independently, or when the old context would contaminate the task. Name each new child for the '
        + 'durable domain it owns (subsystem, surface, or responsibility), never for the one-off request, so '
        + 'later tasks can recognize it.'
    },
  })
  ctx.systemPrompt.context({
    name: `tool:${toolName}:depth`,
    order: ctx.systemPrompt.getContextOrder('SUBAGENT_DELEGATION'),
    text: (context) => {
      if (context.agent === undefined || mounted === undefined
        || ctx.tools.get(toolName, context.scope) !== mounted.definition) return ''
      const maxDepth = ctx.subagents.resolveMaxDepth(config.maxDepth)
      if (maxDepth === undefined) return ''
      const depth = delegationDepthOf(context.agent)
      if (depth < maxDepth) return ''
      return `Delegation depth for \`${toolName}\`: current ${depth}, maximum ${maxDepth}, remaining levels 0.`
        + ` Do not call \`${toolName}\` at this depth; carry out the work directly.`
    },
  })
}
