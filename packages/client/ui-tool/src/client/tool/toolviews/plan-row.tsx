// plan_write / exit_plan_mode toolview: the plan-reference block replacing
// the generic "Tool call" card, registered into the keyed 'tool.call.toolview'
// hole (a product registration, not a sample). The row composes ToolRow
// (chrome, running sweep, whole-row expand) and presents the recorded plan:
// pen-and-list icon, the plan's own title, a one-line summary from the plan
// markdown's first non-empty heading line, and the saved file path as the
// row's clickable file reference — opening it routes through the owner
// openFile face, which splits the chat and renders the markdown buffer
// beside it (the inline-first opener), the always-visible current-plan view.

import type { Context } from '@deepseek-ai/cordis'
import { IconListPenOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ToolCallViewProps } from '../../contract/slots.ts'
import { toolRowModel } from '../models/tool-call-model.ts'
import { ToolRow } from '../components/ToolRow.tsx'
import { CONVERSATION_NS as NS } from '../../locale.ts'

/** Plan row props: the toolview runtime share plus the standard locale seat. */
type PlanRowProps = ToolCallViewProps & PropsLocale<'conversation'>

/** Default plan markdown path; matches the plan-mode tool default. */
const DEFAULT_PLAN_PATH = 'implementation_plan.md'

/**
 * The plan block's row material parsed from the call's frozen args: the plan
 * title (explicit or locale default), the first non-empty markdown heading
 * line as the summary, and the saved file path. `null` on malformed model
 * JSON (mid-stream truncation, rejected calls) — the caller falls back to the
 * generic row summary with the default path.
 */
interface PlanMaterial {
  title: string | null
  summary: string
  filePath: string
}

function planMaterial(argsRaw: string): PlanMaterial | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(argsRaw)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const { plan, title, path } = parsed as { plan?: unknown; title?: unknown; path?: unknown }
  if (plan !== undefined && typeof plan !== 'string') return null
  // First non-empty line, markdown-stripped and bounded: the block's one-line
  // description of what the plan is about.
  const heading = typeof plan === 'string'
    ? plan
      .split('\n')
      .map(line => line.replace(/^#+\s*/, '').replace(/[*_`]/g, '').trim())
      .find(line => line.length > 0)
      ?.slice(0, 200)
    : undefined
  return {
    title: typeof title === 'string' && title.trim().length > 0 ? title.trim() : null,
    // The summary doubles as the row's file link (ToolRow links the summary
    // text), so the saved path stays part of the visible reference.
    summary: heading === undefined
      ? (typeof path === 'string' && path.trim().length > 0 ? path.trim() : DEFAULT_PLAN_PATH)
      : `${heading} · ${typeof path === 'string' && path.trim().length > 0 ? path.trim() : DEFAULT_PLAN_PATH}`,
    filePath: typeof path === 'string' && path.trim().length > 0 ? path.trim() : DEFAULT_PLAN_PATH,
  }
}

/**
 * The plan-reference block: icon + plan title · first plan line in the shared
 * ToolRow chrome, with the saved markdown path as the row's file link. The
 * link click travels the owner openFile face (inline split for markdown), so
 * clicking the block opens the plan beside the chat — the Antigravity
 * artifact-card interaction. Non-ok execution states keep the shared row's
 * dot semantics; the row still names the intended plan path.
 */
export function PlanRow({ toolName, block, openFile, inspect, t }: PlanRowProps) {
  const model = toolRowModel(toolName, block)
  const argsRaw = ('kind' in block ? block.call?.argsRaw : block.argsRaw) ?? ''
  const material = planMaterial(argsRaw)
  return (
    <ToolRow
      t={t}
      variant={model.variant}
      toolName={toolName}
      icon={<IconListPenOutline16 size={14} />}
      title={material?.title ?? t('plan.rowTitle')}
      summary={material ? material.summary : model.summary}
      body={null}
      output={model.output}
      errorSummary={model.errorSummary}
      state={model.state}
      filePath={material?.filePath ?? DEFAULT_PLAN_PATH}
      onOpenFile={openFile}
      inspect={inspect}
    />
  )
}

/**
 * The plan row as a plain registrant plugin following the atomic Tool-view
 * declaration across independent activation and reload lifetimes.
 */
export const planToolview = {
  name: 'plan-toolview',
  inject: ['slots'],
  /**
   * Register the plan block into the Tool-owned keyed view slot under both
   * plan tool names.
   * @param ctx - registrant context (disposal rides ctx.effect inside slots.register).
   */
  apply(ctx: Context): void {
    ctx.slots.inject('tool.call.toolview', function* () {
      yield ctx.slots.register({ name: 'tool.call.toolview', key: 'plan_write', locale: NS }, PlanRow)
      yield ctx.slots.register({ name: 'tool.call.toolview', key: 'exit_plan_mode', locale: NS }, PlanRow)
    })
  },
}
