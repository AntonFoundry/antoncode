/**
 * `model` namespace dictionaries.
 *
 * `trigger.selectAria` reads identically to `trigger.fallback` today and is
 * still a separate key: the visible fallback label and the accessible name of
 * an unset trigger are free to diverge per locale, and folding it into
 * `trigger.aria` would announce the degenerate "Select model, current Select
 * model".
 */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'command.description': '选择本会话使用的模型',
  'option.loadError': '目录加载失败：{message}',
  'trigger.fallback': '选择模型',
  'trigger.selectAria': '选择模型',
  'trigger.aria': '选择模型，当前 {model}',
  'menu.aria': '模型列表',
  'search.aria': '搜索模型',
  'search.placeholder': '搜索模型…',
  'effort.providerDefault': 'Default',
  'pill.aria': '推理力度：{effort}',
  'pill.sliderAria': '调整推理等级',
  'status.loading': '正在刷新模型列表…',
  'error.action': '模型操作失败：{message}',
  'action.reload': '重新加载',
  'warning.groupLoad': '{name} 加载失败：{message}',
  'empty.models': '没有可用的模型。',
  'empty.search': '没有匹配的模型。',
  'blocked.composer': '当前模型不可用，请先选择模型',
} satisfies Record<string, string>

/** The model namespace key union. */
export type ModelKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'command.description': 'Select the model for this conversation',
  'option.loadError': 'Catalog failed to load: {message}',
  'trigger.fallback': 'Select model',
  'trigger.selectAria': 'Select model',
  'trigger.aria': 'Select model, current {model}',
  'menu.aria': 'Models',
  'search.aria': 'Search models',
  'search.placeholder': 'Search models…',
  'effort.providerDefault': 'Default',
  'pill.aria': 'Reasoning effort: {effort}',
  'pill.sliderAria': 'Adjust reasoning effort',
  'status.loading': 'Refreshing model list…',
  'error.action': 'Model operation failed: {message}',
  'action.reload': 'Reload',
  'warning.groupLoad': '{name} failed to load: {message}',
  'empty.models': 'No models available.',
  'empty.search': 'No matching models.',
  'blocked.composer': 'This model is unavailable — select one to continue',
} satisfies Record<ModelKey, string>
