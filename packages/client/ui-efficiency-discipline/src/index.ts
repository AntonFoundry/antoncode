/** Host registration for the efficiency-discipline preference. */

import type { Context } from '@deepseek-ai/cordis'
// Type-only: merges the `settings` service whose presentation policy this
// entry declares.
import type {} from '@deepseek-ai/dsh-settings'
import { DisciplineSettingsSchema } from './discipline-settings.ts'
import type { DisciplineSettings } from './discipline-settings.ts'

export type { DisciplineSettings } from './discipline-settings.ts'

/**
 * The preference is this plugin's own Config: settings forms derive from a
 * plugin's schema, so an edit reloads this entry rather than writing into a
 * separately installed section.
 */
export const Config = DisciplineSettingsSchema

/**
 * Declare the entry's settings presentation. The browser half owns the row,
 * so the generated page is suppressed; the tools runtime reads the live value
 * through the settings namespace and falls back to its own default when
 * settings are unavailable.
 * @param ctx - host cordis context.
 * @param _config - validated {@link DisciplineSettings}.
 */
export function apply(ctx: Context, _config: DisciplineSettings): void {
  ctx.inject(['settings'], (child) => {
    child.effect(() => child.settings.configure({ auto: false }, ctx.fiber))
  })
}
