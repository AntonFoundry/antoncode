/** Efficiency-discipline preference stored in the Host user-settings document. */

import z from '@deepseek-ai/schemastery'

/** Settings namespace owned by the efficiency-discipline plugin. */
export const DISCIPLINE_SETTINGS_NAMESPACE = 'tools-discipline'

/** Field carrying the working-economy framing switch. */
export const DISCIPLINE_FIELD = 'efficiencyDiscipline'

/** Default when the user-settings document has no override: framing ON. */
export const DEFAULT_DISCIPLINE = true

/** Durable section shared by the Host schema and the browser scope. */
export interface DisciplineSettings {
  /** Whether the working-economy section joins the agent system prompt. */
  efficiencyDiscipline: boolean
}

/** Durable schema; also the wire envelope the browser scope validates against. */
export const DisciplineSettingsSchema: z<DisciplineSettings> = z.object({
  [DISCIPLINE_FIELD]: z.boolean().default(DEFAULT_DISCIPLINE),
})
