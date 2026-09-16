/** `settings.efficiency` namespace dictionaries (the efficiency row's copy). */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'efficiency.title': '效率规训',
  'efficiency.description': '在系统提示中加入工作经济性规则（推荐工具选择与精炼输出）',
} satisfies Record<string, string>

/** The settings.efficiency namespace key union. */
export type EfficiencyKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'efficiency.title': 'Efficiency discipline',
  'efficiency.description': 'Adds working-economy rules to the agent system prompt (cheap tools first, lean prose)',
} satisfies Record<EfficiencyKey, string>
