/** Locale bundles for the built-in plugins settings section. */

/** Locale keys the section renders. */
export type PluginsSettingsLocaleKey = 'nav' | 'title' | 'intro' | 'tabs' | 'empty'

/** English copy. */
export const en: Record<PluginsSettingsLocaleKey, string> = {
  nav: 'Built-in plugins',
  title: 'Built-in plugins',
  intro: 'Inspect the plugins this deployment ships.',
  tabs: 'Plugin views',
  empty: 'This deployment exposes no plugin views.',
}

/** Simplified Chinese copy. */
export const zh: Record<PluginsSettingsLocaleKey, string> = {
  nav: '内置插件',
  title: '内置插件',
  intro: '查看内置部署的插件列表',
  tabs: '插件视图',
  empty: '本部署没有开放任何插件视图。',
}

/** Japanese copy, checked against the English keys. */
export const ja = {
  'nav': '組み込みプラグイン',
  'title': '組み込みプラグイン',
  'intro': 'このデプロイメントに含まれるプラグインを確認します。',
  'tabs': 'プラグインビュー',
  'empty': 'このデプロイメントにはプラグインビューがありません。',
} satisfies Record<keyof typeof en, string>

/** Spanish dictionary, checked against the English keys. */
export const es = {
  nav: 'Complementos integrados',
  title: 'Complementos integrados',
  intro: 'Inspeccione los complementos que incluye esta implementación.',
  tabs: 'Vistas de complementos',
  empty: 'Esta implementación no expone vistas de complementos.',
} satisfies Record<keyof typeof en, string>

/** French dictionary, checked against the English keys. */
export const fr = {
  nav: 'Plugins intégrés',
  title: 'Plugins intégrés',
  intro: 'Inspectez les plugins fournis par ce déploiement.',
  tabs: 'Vues des plugins',
  empty: "Ce déploiement n'expose aucune vue de plugin.",
} satisfies Record<keyof typeof en, string>

/** German dictionary, checked against the English keys. */
export const de = {
  nav: 'Integrierte Plugins',
  title: 'Integrierte Plugins',
  intro: 'Überprüfen Sie die Plugins, die mit dieser Bereitstellung geliefert werden.',
  tabs: 'Plugin-Ansichten',
  empty: 'Diese Bereitstellung stellt keine Plugin-Ansichten bereit.',
} satisfies Record<keyof typeof en, string>

/** Russian dictionary, checked against the English keys. */
export const ru = {
  nav: 'Встроенные плагины',
  title: 'Встроенные плагины',
  intro: 'Проверьте плагины, поставляемые в этом развертывании.',
  tabs: 'Просмотры плагинов',
  empty: 'Это развертывание не предоставляет никаких представлений плагинов.',
} satisfies Record<keyof typeof en, string>

/** Portuguese dictionary, checked against the English keys. */
export const pt = {
  nav: 'Plug-ins integrados',
  title: 'Plug-ins integrados',
  intro: 'Inspecione os plug-ins fornecidos por esta implantação.',
  tabs: 'Visualizações de plug-in',
  empty: 'Esta implantação não expõe visualizações de plug-ins.',
} satisfies Record<keyof typeof en, string>

/**
 * Anton card copy for the c0ntext, gate-policy, and subagent-model cards,
 * held until those cards move onto `plugins.item` companion packages; no
 * surface in this package renders it.
 */
export type PluginsCardLocaleKey =
  | 'gatePolicyTitle'
  | 'gatePolicyDescription'
  | 'gatePolicyEnabled'
  | 'gatePolicyEnabledHint'
  | 'gatePolicyTools'
  | 'gatePolicyToolsHint'
  | 'gatePolicyToolsEmpty'
  | 'gatePolicyAddTool'
  | 'contextTitle'
  | 'contextDescription'
  | 'contextEndpoint'
  | 'contextEndpointHint'
  | 'contextApiKey'
  | 'contextApiKeyHint'
  | 'contextProjectId'
  | 'contextProjectIdHint'
  | 'contextMaxSurfaceRatio'
  | 'contextMaxSurfaceRatioHint'
  | 'contextWindowTokens'
  | 'contextWindowTokensHint'
  | 'contextEvictorEnabled'
  | 'contextEvictorEnabledHint'
  | 'contextRetrievalMode'
  | 'contextRetrievalModeHint'
  | 'contextMemoryOverride'
  | 'contextMemoryOverrideHint'
  | 'contextPagingOverride'
  | 'contextPagingOverrideHint'
  | 'contextCodeMapOverride'
  | 'contextCodeMapOverrideHint'
  | 'subagentModelTitle'
  | 'subagentModelDescription'
  | 'subagentModelDefault'
  | 'subagentModelDefaultHint'
  | 'subagentModelInherit'
  | 'subagentModelCustom'
  | 'subagentModelLoading'
  | 'subagentEffortDefault'
  | 'subagentEffortDefaultHint'
  | 'subagentEffortInherit'

/** English card copy. */
export const cardEn: Record<PluginsCardLocaleKey, string> = {
  gatePolicyTitle: 'Gate policy',
  gatePolicyDescription: 'Plan-first gating and dangerous-action checklists.',
  gatePolicyEnabled: 'Todo-plan gate',
  gatePolicyEnabledHint: "Write 'true' or 'false' — gated tools are denied until a todo plan exists.",
  gatePolicyTools: 'Gated tools',
  gatePolicyToolsHint: 'Comma-separated tool names (e.g. bash, edit, write).',
  gatePolicyToolsEmpty: 'No tools gated — the plan gate is idle.',
  gatePolicyAddTool: 'Add tool…',
  contextTitle: 'c0ntext',
  contextDescription: 'Context retrieval and surface-management controls.',
  contextEndpoint: 'Engine endpoint',
  contextEndpointHint: 'HTTP endpoint used by the c0ntext worker.',
  contextApiKey: 'API key',
  contextApiKeyHint: 'Engine API key (`ctx_…`); leave blank for a keyless local engine. Same value as the plugin-list card.',
  contextProjectId: 'Project ID',
  contextProjectIdHint: 'Registered c0ntext project identity.',
  contextMaxSurfaceRatio: 'Eviction threshold',
  contextMaxSurfaceRatioHint: 'Eviction begins at this fraction of the model context window.',
  contextWindowTokens: 'Context window (tokens)',
  contextWindowTokensHint: 'Explicit model window; leave blank to resolve it from the selected model.',
  contextEvictorEnabled: 'Automatic eviction',
  contextEvictorEnabledHint: 'Disable this while actively developing to keep the live conversation unchanged.',
  contextRetrievalMode: 'Memory retrieval mode',
  contextRetrievalModeHint: 'Fast skips the zone-anchor pass, entity walk, and reranker. Full enables these extra precision stages and can take longer; it does not prevent timeouts or guarantee relevant results.',
  contextMemoryOverride: 'Prompt override — memory contract',
  contextMemoryOverrideHint: 'Replaces the c0ntext memory-contract section of the system prompt. Leave blank to use the built-in text; saves apply on the next turn without a restart.',
  contextPagingOverride: 'Prompt override — paging reminder',
  contextPagingOverrideHint: 'Replaces the high-context-pressure paging reminder. Leave blank to use the built-in text.',
  contextCodeMapOverride: 'Prompt override — code-map guidance',
  contextCodeMapOverrideHint: 'Replaces the ripwire code-map guidance section. Leave blank to use the built-in text.',
  subagentModelTitle: 'Subagent model',
  subagentModelDescription: 'Which model and reasoning effort delegated children run when a delegation names neither.',
  subagentModelDefault: 'Default child model',
  subagentModelDefaultHint: 'Route children inherit, e.g. openrouter/strong-model. Leave blank to inherit the parent model.',
  subagentModelInherit: 'Inherit the parent session\'s model',
  subagentModelCustom: 'Custom route…',
  subagentModelLoading: 'Loading models…',
  subagentEffortDefault: 'Default reasoning effort',
  subagentEffortDefaultHint: 'Effort children use when a delegation names none. Leave as inherit to keep the route\'s own default.',
  subagentEffortInherit: 'Inherit (route default)',
}

/** Chinese card copy, checked against the English keys. */
export const cardZh: Record<PluginsCardLocaleKey, string> = {
  gatePolicyTitle: '门控策略',
  gatePolicyDescription: '计划优先门控与危险操作清单。',
  gatePolicyEnabled: '待办计划门控',
  gatePolicyEnabledHint: "输入 'true' 或 'false'——在存在待办计划前，受控工具将被拒绝。",
  gatePolicyTools: '受控工具',
  gatePolicyToolsHint: '逗号分隔的工具名（如 bash, edit, write）。',
  gatePolicyToolsEmpty: '未选择任何受控工具——计划门控处于空闲状态。',
  gatePolicyAddTool: '添加工具…',
  contextTitle: 'c0ntext',
  contextDescription: '上下文检索和表层管理设置。',
  contextEndpoint: '引擎接口',
  contextEndpointHint: 'c0ntext worker 使用的 HTTP 接口。',
  contextApiKey: 'API 密钥',
  contextApiKeyHint: '引擎 API 密钥（`ctx_…`）；本地免密引擎留空。与插件列表卡片中的值相同。',
  contextProjectId: '项目 ID',
  contextProjectIdHint: '已注册的 c0ntext 项目标识。',
  contextMaxSurfaceRatio: '驱逐阈值',
  contextMaxSurfaceRatioHint: '表层达到模型上下文窗口的此比例后开始驱逐。',
  contextWindowTokens: '上下文窗口（token）',
  contextWindowTokensHint: '显式模型窗口；留空则从当前模型解析。',
  contextEvictorEnabled: '自动驱逐',
  contextEvictorEnabledHint: '主动开发时可关闭，避免改写当前对话。',
  contextRetrievalMode: '记忆检索模式',
  contextRetrievalModeHint: '快速模式跳过区域锚点、实体遍历和重排器。完整模式启用这些精度阶段，但耗时可能更长；它不能避免超时，也不保证结果相关。',
  contextMemoryOverride: '提示词覆盖 — 记忆契约',
  contextMemoryOverrideHint: '替换系统提示中的 c0ntext 记忆契约段落。留空使用内置文本；保存后下一轮生效，无需重启。',
  contextPagingOverride: '提示词覆盖 — 分页提醒',
  contextPagingOverrideHint: '替换高上下文压力下的分页提醒。留空使用内置文本。',
  contextCodeMapOverride: '提示词覆盖 — 代码地图指引',
  contextCodeMapOverrideHint: '替换 ripwire 代码地图指引段落。留空使用内置文本。',
  subagentModelTitle: '子 Agent 模型',
  subagentModelDescription: '委派调用未指定模型与推理强度时，子 agent 使用哪个模型、哪种推理强度。',
  subagentModelDefault: '默认子模型',
  subagentModelDefaultHint: '子 agent 继承的路由，如 openrouter/strong-model；留空则继承父会话的模型。',
  subagentModelInherit: '继承父会话的模型',
  subagentModelCustom: '自定义路由…',
  subagentModelLoading: '正在加载模型…',
  subagentEffortDefault: '默认推理强度',
  subagentEffortDefaultHint: '委派调用未指定推理强度时子 agent 使用的强度；保持继承则沿用路由自身的默认值。',
  subagentEffortInherit: '继承（路由默认值）',
}
