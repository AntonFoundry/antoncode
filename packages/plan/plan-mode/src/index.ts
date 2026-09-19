/**
 * Plan mode is logged per-agent collaboration state: while active, a
 * deployment-owned guidance section is included in each model request, and
 * `exit_plan_mode` presents the completed plan for user review, while the
 * `/plan off` command lets a user leave directly. Sandbox mode and approval
 * policy enforce restrictions independently and do not read or write plan
 * state.
 *
 * The state in force is folded from the session log (`plan/mode`, last one
 * wins), so resume and fork restore it without a live mirror. User selections
 * remain pending until the next accepted in-turn pre-step. The service includes
 * the selected state in the proposed step assembly, then appends `plan/mode`
 * from `agent/pre-step` only when the step is accepted. Same-step request
 * retries reuse their assembly.
 *
 * The exit tool remains registered while plan mode is inactive, so entering
 * or leaving plan mode changes only the prompt section, not the request tool
 * catalog.
 *
 * Agent Note:
 * - .agents/notes/implemented/simplification/2026-07-22-plan-specific-collaboration-state.md
 *
 * @module @deepseek-ai/dsh-plan-mode
 */

import fs from 'node:fs'
import path from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import { z as zod } from 'zod'
import type { ZodType } from 'zod'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent, UserMessage } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { UserQuestionError } from '@deepseek-ai/dsh-user-questions'
// Type-only edge: resolves `ctx.commands` for the optional command child.
import type {} from '@deepseek-ai/dsh-commands'
// Type-only: resolves ctx.sessionProjections for the optional unit child.
import type {} from '@deepseek-ai/dsh-session-projection'
import type { PlanProjection } from './types.ts'
// The `plan` projection-key declaration lives in src/types.ts (its one home);
// this re-export projects the type face onto the package root AND keeps the
// module edge in the emitted index.d.ts, so aggregate programs consuming the
// declarations still receive the SessionProjectionMap merge.
export type * from './types.ts'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * Whether plan mode is in force from this point on: log-only, non-surface,
     * whole-value replace. The last `plan/mode` wins; a log with none folds to
     * inactive through {@link foldPlanMode}.
     */
    'plan/mode': { active: boolean }
    /**
     * Standing implementation plan: log-only, non-surface, whole-value replace.
     * The last `plan/write` wins; folded into `PlanProjection.standingPlan`.
     */
    'plan/write': { plan: string; title?: string; path?: string }
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    planMode: PlanModeController
  }
}

/**
 * The model-facing exit tool's name. It stays registered while plan mode is
 * inactive so the request tool catalog is stable across transitions.
 */
export const EXIT_PLAN_MODE = 'exit_plan_mode'

/** Deployment-owned plan guidance. */
export interface PlanModeConfig {
  /** Guidance rendered as the `plan:policy` prompt section while plan mode is active. */
  section: string
}

/** The review question's id, echoed in the answer this tool reads. */
const REVIEW_ID = 'plan-review'

/** The review question's approve option label. */
const APPROVE_LABEL = 'Approve'

/** The review question's keep-planning option label. */
const KEEP_PLANNING_LABEL = 'Keep planning'

const EXIT_DESCRIPTION
  = 'Use only in plan mode. Present your plan for the user\'s review and, on approval, leave plan mode. '
  + 'Send the COMPLETE plan as markdown, starting with a # heading that names it. '
  + 'The user may approve (carry out the plan from your next step) or keep '
  + 'planning — their feedback comes back in the tool result; revise and present again.'

/** The plan's first markdown heading (any level), or `undefined` when it has none. */
function firstHeading(plan: string): string | undefined {
  for (const line of plan.split('\n')) {
    const match = /^#{1,6}\s+(.+?)\s*$/.exec(line)
    if (match) return match[1]
  }
  return undefined
}

/**
 * The model-facing plan write tool's name. Always registered so agents can
 * record an implementation plan produced by a planning subagent or update it.
 */
export const PLAN_WRITE = 'plan_write'

const PLAN_WRITE_DESCRIPTION
  = 'Record or update the standing implementation plan for the current work. '
  + 'Use this tool whenever an implementation plan has been produced (e.g. by a planning subagent) '
  + 'or updated. The plan persists across turns and is injected into every subsequent request as a standing guide '
  + 'for both the model and the user. Send the COMPLETE markdown plan, starting with a # heading.'

/**
 * Format the standing implementation plan section text from the session's latest `plan/write` event.
 * Exported for testing and section spec.
 *
 * @param plan - the markdown implementation plan text.
 * @param title - optional headline/title for the plan.
 * @returns the section text.
 */
export function standingImplementationPlanSection(plan: string, title?: string): string {
  const header = title
    ? `Standing implementation plan: ${title}`
    : 'Standing implementation plan'
  return [
    `${header} (the implementation plan currently in force — it persists across turns):`,
    plan,
    'Execute against this implementation plan phase by phase, keeping the standing todo tree in sync with progress. Only a whole new plan replaces it, via plan_write carrying the complete new plan.',
  ].join('\n\n')
}

/**
 * Validate deployment-owned plan guidance. Missing, blank, non-string, or
 * unknown fields fail at plugin load rather than being ignored.
 *
 * @param config Raw plugin config.
 * @returns A detached validated config.
 */
export function resolveConfig(config: PlanModeConfig): PlanModeConfig {
  const section = (config as Partial<PlanModeConfig>).section
  if (typeof section !== 'string') {
    throw new Error('PlanModeConfig needs a string `section`')
  }
  if (section.trim() === '') {
    throw new Error('PlanModeConfig needs a non-empty `section`')
  }
  const unknown = Object.keys(config).filter(key => key !== 'section')
  if (unknown.length > 0) {
    throw new Error(`PlanModeConfig has unknown key(s) ${unknown.join(', ')} — config is { section }`)
  }
  return { section }
}

/**
 * Whether plan mode is active after the first `end` events. The last
 * `plan/mode` wins; a prefix with none is inactive.
 *
 * @param events The session log or any prefix of it.
 * @param end Fold `events[0, end)`; defaults to the whole log.
 * @returns Whether plan mode is active.
 */
export function foldPlanMode(events: readonly SessionEvent[], end = events.length): boolean {
  let active = false
  let index = 0
  for (const event of events) {
    if (index >= end) break
    index++
    if (event.type === 'plan/mode') active = event.data.active
  }
  return active
}

/**
 * Projection unit state: the logged mode plus the latest logged `/plan`
 * selection (`command/run`) not yet resolved by a `plan/mode` commit. Plain
 * JSON (persisted-cache precondition).
 */
interface PlanUnitState {
  active: boolean
  /** The selection's target mode; null when no selection is outstanding. */
  wanted: boolean | null
  standingPlan: { plan: string; title?: string; path?: string } | null
}

/** Wire payload schema of the `plan` projection. */
const planProjectionSchema: ZodType<PlanProjection> = zod.object({
  active: zod.boolean(),
  pending: zod.boolean(),
  standingPlan: zod.union([
    zod.object({
      plan: zod.string(),
      title: zod.string().optional(),
      path: zod.string().optional(),
    }),
    zod.null(),
  ]).optional(),
})

/** Whether the log holds an opened turn without its closing `turn/end`. */
function hasOpenTurn(events: readonly SessionEvent[]): boolean {
  let open = false
  for (const event of events) {
    if (event.type === 'turn/start') open = true
    else if (event.type === 'turn/end') open = false
  }
  return open
}

/** Plan state at the last logged request header, or `undefined` before the first header. */
function planModeAtLastHeader(events: readonly SessionEvent[]): boolean | undefined {
  let lastHeader = -1
  let index = 0
  for (const event of events) {
    if (event.type === 'request/header') lastHeader = index
    index++
  }
  if (lastHeader < 0) return undefined
  return foldPlanMode(events, lastHeader + 1)
}

/**
 * `ctx.planMode`: owns logged plan state, applies and narrates selected state at step start,
 * the `plan:policy` section, the `/plan` command, and the stable exit tool.
 * UIs observe committed flips through `session/event`; there is no live mirror.
 */
export class PlanModeController extends Service {
  static inject = ['tools', 'systemPrompt']

  /** Validated deployment-owned guidance. */
  private readonly section: string

  /**
   * Latest selection per session awaiting the next accepted in-turn pre-step.
   * `narrate` is true for user selections and false for the exit tool, whose
   * result already narrates the transition.
   */
  private readonly pendingIntents = new WeakMap<Session, { active: boolean; narrate: boolean }>()

  constructor(ctx: Context, config: PlanModeConfig = { section: '' }) {
    super(ctx, 'planMode')
    this.section = resolveConfig(config).section
    let disposed = false
    // Pre-step is outside Session.append publication, so it can append the
    // log-only mode event inside an open turn without re-entering the session.
    // A failed append remains pending for a later accepted in-turn pre-step,
    // and policy cannot block the step.
    ctx.on('agent/pre-step', async (
      { agent, signal },
      next,
    ): Promise<PreStepDecision> => {
      const decision = await next()
      const pending = this.pendingIntents.get(agent.session)
      if (decision.kind === 'reject' || signal.aborted || pending === undefined) return decision
      const narration = this.narration(agent.session, pending.active)
      try {
        this.onBoundary(agent.session)
      } catch (error) {
        ctx.logger.warn('dsh-plan-mode: failed to append selected plan mode at step start: %o', error)
        return decision
      }
      return !pending.narrate || narration === undefined
        ? decision
        : { ...decision, messages: [...decision.messages, narration] }
    })
    ctx.effect(() => () => { disposed = true }, 'dsh-plan-mode: close service lifetime')

    ctx.systemPrompt.section({
      name: 'plan:policy',
      order: 50,
      text: (context) => {
        if (context.agent === undefined) return ''
        const pending = this.pendingIntents.get(context.agent.session)
        return (pending?.active ?? foldPlanMode(context.agent.session.events)) ? this.section : ''
      },
    })

    ctx.systemPrompt.section({
      name: 'plan:standing-plan',
      order: 52,
      text: (context) => {
        if (context.agent === undefined) return ''
        const events = context.agent.session.events
        for (let i = events.length - 1; i >= 0; i--) {
          const event = events[i]
          if (event !== undefined && event.type === 'plan/write') {
            return standingImplementationPlanSection(event.data.plan, event.data.title)
          }
        }
        return ''
      },
    })

    // The plan projection unit (session-projection RFC): a pure event
    // fold serving clients the whole {active, pending, standingPlan} value. `command/run`
    // records the user's logged /plan selection (the handler calls `set()`
    // before any failing path, so a failed handler cannot leave the recorded
    // command without its plan selection); `plan/mode` records that selection
    // and clears it. `plan/write` updates the standing implementation plan.
    // The unit child activates only when a projection
    // registry is composed (headless assemblies stay unaffected).
    ctx.inject(['sessionProjections'], (projectionCtx) => {
      projectionCtx.sessionProjections.register<'plan', PlanUnitState>({
        key: 'plan',
        schema: planProjectionSchema,
        init: () => ({ active: false, wanted: null, standingPlan: null }),
        apply: (state, event) => {
          if (event.type === 'command/run' && event.data.name === 'plan') {
            if (event.data.args === undefined) return state
            const wanted = event.data.args.trim() !== 'off'
            return wanted === state.wanted ? state : { active: state.active, wanted, standingPlan: state.standingPlan }
          }
          if (event.type === 'plan/mode') {
            return { active: event.data.active, wanted: null, standingPlan: state.standingPlan }
          }
          if (event.type === 'plan/write') {
            return {
              active: state.active,
              wanted: state.wanted,
              standingPlan: {
                plan: event.data.plan,
                ...event.data.title !== undefined ? { title: event.data.title } : {},
                ...event.data.path !== undefined ? { path: event.data.path } : {},
              },
            }
          }
          return state
        },
        view: state => ({
          active: state.active,
          pending: state.wanted !== null && state.wanted !== state.active,
          standingPlan: state.standingPlan,
        }),
        stateVersion: 2,
      })
    })

    // The command child activates only when a command registry is composed.
    ctx.inject(['commands'], (commandCtx) => {
      commandCtx.commands.register({
        name: 'plan',
        description: 'Enter or leave plan mode',
        input: { hint: '[off|message]' },
        handler: ({ agent, rawInput }) => {
          const message = rawInput.trim()
          if (message === 'off') {
            switch (this.set(agent, false)) {
              case 'committed':
                return { kind: 'success', text: 'Plan mode off.' }
              case 'queued':
                return { kind: 'success', text: 'Leaving plan mode (applies from the next step).' }
              case 'cancelled':
                return { kind: 'success', text: 'Plan mode entry cancelled.' }
              case 'noop':
                // Repeat the queued wording while an exit still awaits the
                // next accepted pre-step; only a truly inactive session reads
                // idempotent.
                return foldPlanMode(agent.session.events)
                  ? { kind: 'success', text: 'Leaving plan mode (applies from the next step).' }
                  : { kind: 'success', text: 'Plan mode is already inactive.' }
            }
          }
          const outcome = this.set(agent, true)
          if (message !== '') agent.steer(createUserMessage({ content: [{ type: 'text', text: message }], source: { kind: 'user' } }))
          return {
            kind: 'success',
            text: outcome === 'committed'
              ? 'Plan mode on. Use /plan off to leave.'
              : 'Entering plan mode (applies from the next step). Use /plan off to leave.',
          }
        },
      })
    })

    ctx.tools.register(defineTool({
      name: EXIT_PLAN_MODE,
      description: EXIT_DESCRIPTION,
      parameters: {
        plan: { type: 'string', required: true, description: 'The complete plan, as markdown, starting with a # heading that names it.' },
        path: { type: 'string', description: 'Optional workspace-relative path where the plan markdown is saved. Defaults to "implementation_plan.md".' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            approved: { type: 'boolean', const: true, required: true },
          },
        },
        render: () => [{ type: 'text', text: 'Plan approved — plan mode exited; carry out the plan starting with your next step.' }],
      },
      execute: async (args, exec) => {
        const agent = exec.agent
        if (agent === undefined) throw new Error(`${EXIT_PLAN_MODE} requires a calling agent (no session to switch)`)
        if (!foldPlanMode(agent.session.events)) {
          throw new Error(`${EXIT_PLAN_MODE} is only available in plan mode`)
        }
        if (!/^#\s+\S/.test(args.plan.trim())) {
          throw new Error(`${EXIT_PLAN_MODE} requires a non-empty markdown plan starting with a # heading`)
        }
        const interaction = ctx.get('userQuestions')
        if (interaction === undefined) {
          throw new Error('no user-questions channel is available to review the plan; ask the user to switch the session mode instead')
        }
        const answer = await interaction.ask({
          questions: [{
            id: REVIEW_ID,
            header: 'Plan review',
            question: 'Approve this plan and leave plan mode?',
            detail: args.plan,
            options: [
              { label: APPROVE_LABEL, description: 'Leave plan mode; the plan is carried out from the next step.' },
              { label: KEEP_PLANNING_LABEL, description: 'Stay in plan mode; feedback goes back to the model.' },
            ],
            // Presentation only: a capable UI renders the plan as a review
            // decision instead of a generic question, and answers with one of
            // the labels above either way.
            intent: { kind: 'plan-review', approve: APPROVE_LABEL },
          }],
          agent,
          signal: exec.signal,
        }).catch((cause: unknown) => {
          // A dismissed review is not a failed one: the user took the turn back
          // to say something the two options do not cover. Say so, because the
          // generic channel message names ask_user_question, which the model
          // never called. An abort (turn cancel, provider teardown) keeps its
          // own message — there is no user to wait for.
          if (cause instanceof UserQuestionError && cause.code === 'ASK_CANCELLED') {
            throw new Error('The user dismissed the plan review to speak instead; '
              + 'stay in plan mode, stop here, and wait for their message.')
          }
          throw cause
        })
        // A review may outlive this plugin fiber. Without its pre-step listener,
        // an approved selection could never be appended, so fail and keep planning.
        if (disposed) {
          throw new Error('the plan-mode service was reloaded while the plan was under review; present the plan again')
        }
        const reviewItems = answer.answers.filter(entry => entry.id === REVIEW_ID)
        const item = reviewItems.length === 1 ? reviewItems[0] : undefined
        if (item?.selected.length !== 1 || item.selected[0] !== APPROVE_LABEL || item.custom !== undefined) {
          const feedback = item?.custom ?? ''
          throw new Error(feedback === ''
            ? 'The user chose to keep planning; revise the plan and present it again.'
            : `The user chose to keep planning; their feedback: ${feedback}`)
        }
        // Keep plan guidance for the rest of this assistant tool batch. The
        // silent selection is appended at the next accepted in-turn pre-step,
        // before its request assembly.
        this.pendingIntents.set(agent.session, { active: false, narrate: false })
        const planPath = typeof args.path === 'string' && args.path.trim().length > 0
          ? args.path.trim()
          : 'implementation_plan.md'
        const cwd = agent.session.header.cwd ?? process.cwd()
        const absPath = path.resolve(cwd, planPath)
        try {
          await fs.promises.mkdir(path.dirname(absPath), { recursive: true })
          await fs.promises.writeFile(absPath, args.plan, 'utf-8')
        } catch (error) {
          ctx.logger?.warn?.('exit_plan_mode failed to write plan file to %s: %o', absPath, error)
        }
        const heading = firstHeading(args.plan)
        agent.session.append('plan/write', {
          plan: args.plan,
          title: heading ?? 'Approved Plan',
          path: planPath,
        })
        return { approved: true }
      },
      presentCall: (args) => {
        const planPath = typeof args.path === 'string' && args.path.trim().length > 0 ? args.path.trim() : 'implementation_plan.md'
        return {
          card: 'generic',
          title: firstHeading(args.plan) ?? 'Plan',
          kind: 'other',
          locations: [{ path: planPath }],
          content: [{ type: 'text', text: args.plan }],
        }
      },
      presentResult: (_args, result) => {
        const planPath = typeof _args.path === 'string' && _args.path.trim().length > 0 ? _args.path.trim() : 'implementation_plan.md'
        return {
          card: 'generic',
          title: 'Plan review',
          locations: [{ path: planPath }],
          content: result.content,
        }
      },
    }))

    ctx.tools.register(defineTool({
      name: PLAN_WRITE,
      description: PLAN_WRITE_DESCRIPTION,
      parameters: {
        plan: {
          type: 'string',
          required: true,
          description: 'The complete implementation plan, as markdown, starting with a # heading that names it.',
        },
        title: {
          type: 'string',
          description: 'Optional short title for the plan.',
        },
        path: {
          type: 'string',
          description: 'Optional workspace-relative file path to save the plan markdown. Defaults to "implementation_plan.md".',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            recorded: { type: 'boolean', required: true },
            title: { type: 'string', required: true },
            path: { type: 'string', required: true },
            bytes: { type: 'integer', required: true },
          },
        },
        render: (_args, value) => [{
          type: 'text',
          text: `Recorded implementation plan: ${value.title} in ${value.path} (${value.bytes} bytes). It is now the standing plan in force across turns.`,
        }],
      },
      execute: async (args, exec) => {
        const agent = exec.agent
        if (agent === undefined) {
          throw new Error(`${PLAN_WRITE} requires an owning agent session`)
        }
        const plan = args.plan.trim()
        if (!/^#{1,6}\s+\S/.test(plan)) {
          throw new Error(`${PLAN_WRITE} requires a non-empty markdown plan starting with a # heading`)
        }
        const heading = firstHeading(plan)
        const title = typeof args.title === 'string' && args.title.trim().length > 0
          ? args.title.trim()
          : (heading ?? 'Implementation Plan')
        const planPath = typeof args.path === 'string' && args.path.trim().length > 0
          ? args.path.trim()
          : 'implementation_plan.md'

        const cwd = agent.session.header.cwd ?? process.cwd()
        const absPath = path.resolve(cwd, planPath)
        try {
          await fs.promises.mkdir(path.dirname(absPath), { recursive: true })
          await fs.promises.writeFile(absPath, plan, 'utf-8')
        } catch (error) {
          ctx.logger?.warn?.('plan_write failed to write plan file to %s: %o', absPath, error)
        }

        agent.session.append('plan/write', { plan, title, path: planPath })
        return {
          recorded: true,
          title,
          path: planPath,
          bytes: plan.length,
        }
      },
      presentCall: (args) => {
        const planPath = typeof args.path === 'string' && args.path.trim().length > 0 ? args.path.trim() : 'implementation_plan.md'
        const title = typeof args.title === 'string' && args.title.trim().length > 0
          ? args.title.trim()
          : (firstHeading(args.plan) ?? 'Implementation Plan')
        return {
          card: 'generic',
          title,
          kind: 'other',
          locations: [{ path: planPath }],
          content: [{ type: 'text', text: args.plan }],
        }
      },
      presentResult: (_args, result) => {
        const planPath = typeof _args.path === 'string' && _args.path.trim().length > 0 ? _args.path.trim() : 'implementation_plan.md'
        return {
          card: 'generic',
          title: 'Implementation Plan Recorded',
          locations: [{ path: planPath }],
          content: result.content,
        }
      },
    }))
  }

  /**
   * Read the logged plan state and any selected state awaiting the next
   * accepted in-turn pre-step.
   *
   * @param agent The agent to read.
   * @returns Current logged state plus a pending selection, when present.
   */
  get(agent: Agent): { active: boolean; pending?: boolean } {
    const active = foldPlanMode(agent.session.events)
    const pending = this.pendingIntents.get(agent.session)
    return pending === undefined ? { active } : { active, pending: pending.active }
  }

  /**
   * Select whether plan mode should be active. Between turns the method
   * appends the change immediately because no in-turn pre-step will run until
   * another prompt starts a turn. The open-turn fold is the idle signal:
   * agent status stays `running` through post-turn checkpointing, when no
   * further in-turn pre-step runs. During an open turn the selection remains
   * pending until the next accepted in-turn pre-step. Repeated selection of
   * the current or already-pending state is a no-op.
   *
   * @param agent The agent to switch.
   * @param active Whether plan mode should be active.
   * @returns what happened: `committed` (logged now), `queued` (awaiting the
   * next accepted in-turn pre-step), `cancelled` (an opposite pending selection
   * was cleared; the logged state already matches), or `noop` (already in that
   * state).
   */
  set(agent: Agent, active: boolean): 'committed' | 'queued' | 'cancelled' | 'noop' {
    const session = agent.session
    const pending = this.pendingIntents.get(session)
    const target = pending?.active ?? foldPlanMode(session.events)
    if (active === target) return 'noop'
    if (hasOpenTurn(session.events)) {
      this.pendingIntents.set(session, { active, narrate: true })
      return foldPlanMode(session.events) === active ? 'cancelled' : 'queued'
    }
    // No open turn: commit now. Delete only after append succeeds so a
    // failed durable write leaves the selection retryable, not dropped.
    if (active === foldPlanMode(session.events)) {
      this.pendingIntents.delete(session)
      return 'cancelled'
    }
    session.append('plan/mode', { active })
    this.pendingIntents.delete(session)
    const narration = this.narration(session, active)
    if (narration !== undefined) agent.inject(narration)
    return 'committed'
  }

  /** Append one pending selection before the next request assembly. */
  private onBoundary(session: Session): void {
    const pending = this.pendingIntents.get(session)
    if (pending === undefined) return
    const target = pending.active
    if (target === foldPlanMode(session.events)) {
      this.pendingIntents.delete(session)
      return
    }
    session.append('plan/mode', { active: target })
    // Delete only after append succeeds so a later accepted in-turn pre-step
    // can retry a failed durable write.
    this.pendingIntents.delete(session)
  }

  /** Build a user-switch notice when the last logged header described the other mode. */
  private narration(session: Session, target: boolean): UserMessage | undefined {
    const told = planModeAtLastHeader(session.events)
    if (told === undefined || told === target) return
    const text = target
      ? 'The user switched this session to plan mode.'
      : 'The user switched this session back to the default mode.'
    return createUserMessage({
      content: [{ type: 'text', text }],
      // The narration is already one sentence, so it is its own summary.
      source: { kind: 'plugin', plugin: 'plan-mode', form: 'notice', summary: text },
    })
  }
}

export default PlanModeController
