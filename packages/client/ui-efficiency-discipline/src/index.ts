/** Host registration for the efficiency-discipline preference and its sections. */

import type { Context } from '@deepseek-ai/cordis'
// Type-only: merges the `settings` service whose presentation policy this
// entry declares.
import type {} from '@deepseek-ai/dsh-settings'
// Type-only: merges the `systemPrompt` service the sections register through.
import type {} from '@deepseek-ai/dsh-system-prompt'
import { DisciplineSettingsSchema } from './discipline-settings.ts'
import type { DisciplineSettings } from './discipline-settings.ts'
import {
  DISCIPLINE_SECTION_ORDER, PLUGIN_DISCIPLINE, TODO_TREE_DISCIPLINE, TOKEN_EFFICIENCY,
} from './discipline-prompt.ts'

export type { DisciplineSettings } from './discipline-settings.ts'
export {
  DISCIPLINE_SECTION_ORDER, PLUGIN_DISCIPLINE, TODO_TREE_DISCIPLINE, TOKEN_EFFICIENCY,
} from './discipline-prompt.ts'

/**
 * The preference is this plugin's own Config: settings forms derive from a
 * plugin's schema, so an edit reloads this entry rather than writing into a
 * separately installed section.
 */
export const Config = DisciplineSettingsSchema

/** The system prompt carries the sections; settings owns the toggle's page. */
export const inject = ['systemPrompt']

/**
 * Register the working-discipline sections and declare the entry's settings
 * presentation. The browser half owns the preference row, so the generated
 * page is suppressed; `efficiencyDiscipline` gates only the working-economy
 * framing, because the plan-first ordering and the plugin-seam rule are not
 * preferences.
 * @param ctx - host cordis context.
 * @param config - validated {@link DisciplineSettings}.
 */
export function apply(ctx: Context, config: DisciplineSettings): void {
  ctx.effect(() => ctx.systemPrompt.section({
    name: 'tools:working-discipline',
    order: DISCIPLINE_SECTION_ORDER,
    text: [
      TODO_TREE_DISCIPLINE,
      ...config.efficiencyDiscipline ? [TOKEN_EFFICIENCY] : [],
      PLUGIN_DISCIPLINE,
    ].join('\n\n'),
  }), 'ui-efficiency-discipline: working-discipline section')

  ctx.inject(['settings'], (child) => {
    child.effect(() => child.settings.configure({ auto: false }, ctx.fiber))
  })
}
