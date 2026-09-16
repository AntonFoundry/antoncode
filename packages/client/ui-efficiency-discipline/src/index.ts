/** Host registration for the efficiency-discipline preference. */

import type { Context } from '@deepseek-ai/cordis'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import { DISCIPLINE_SETTINGS_NAMESPACE, DisciplineSettingsSchema } from './discipline-settings.ts'

const DISCIPLINE_NAMESPACE = settingsNamespace(DISCIPLINE_SETTINGS_NAMESPACE)

/**
 * Register the durable section so the browser scope and the tools runtime
 * read one persisted field. The tools runtime reads the live value per
 * assembly and falls back to its own default when settings are unavailable.
 */
export function apply(ctx: Context): void {
  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.settings.register(DISCIPLINE_NAMESPACE, DisciplineSettingsSchema)
  })
}
