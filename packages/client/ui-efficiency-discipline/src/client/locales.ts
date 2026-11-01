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

/** Japanese dictionary. */
export const ja = {
  'efficiency.title': '効率の規律',
  'efficiency.description': 'エージェントのシステムプロンプトに作業経済性の規則を追加します（安価なツールの優先と簡潔な出力）',
} satisfies Record<EfficiencyKey, string>

/** Spanish dictionary. */
export const es = {
  'efficiency.title': 'Disciplina de eficiencia',
  'efficiency.description': 'Añade reglas de economía de trabajo al mensaje del sistema (herramientas baratas primero, prosa concisa)',
} satisfies Record<EfficiencyKey, string>

/** French dictionary. */
export const fr = {
  'efficiency.title': 'Discipline d\'efficacité',
  'efficiency.description': 'Ajoute des règles d\'économie de travail au message système (outils simples d\'abord, propos concis)',
} satisfies Record<EfficiencyKey, string>

/** German dictionary. */
export const de = {
  'efficiency.title': 'Effizienzdisziplin',
  'efficiency.description': 'Ergänzt Regeln für sparsames Arbeiten im Systemprompt (günstige Werkzeuge zuerst, knappe Prosa)',
} satisfies Record<EfficiencyKey, string>

/** Russian dictionary. */
export const ru = {
  'efficiency.title': 'Дисциплина эффективности',
  'efficiency.description': 'Добавляет правила экономии работы в системный запрос (сначала дешёвые инструменты, краткий текст)',
} satisfies Record<EfficiencyKey, string>

/** Portuguese dictionary. */
export const pt = {
  'efficiency.title': 'Disciplina de eficiência',
  'efficiency.description': 'Acrescenta regras de economia de trabalho ao prompt do sistema (ferramentas baratas primeiro, texto enxuto)',
} satisfies Record<EfficiencyKey, string>
