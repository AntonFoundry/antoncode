/** `flowbuilder` namespace dictionaries (the Workflows tab label and the LangFlow embed chrome). */

/** Dictionary namespace owned by this plugin. */
export const NS = 'flowbuilder'

/** The flowbuilder dictionary key set (the source of truth for both locales). */
export type FlowbuilderKey =
  | 'view.dagflow'
  | 'langflow.state.stopped'
  | 'langflow.state.starting'
  | 'langflow.state.running'
  | 'langflow.state.error'
  | 'langflow.start'
  | 'langflow.stop'
  | 'langflow.open'
  | 'langflow.stopped.hint'
  | 'langflow.load.error'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The Workflows tab label and the LangFlow embed chrome copy. */
    'flowbuilder': FlowbuilderKey
  }
}

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh: Record<FlowbuilderKey, string> = {
  'view.dagflow': '工作流',
  'langflow.state.stopped': '未运行',
  'langflow.state.starting': '启动中…',
  'langflow.state.running': '运行中',
  'langflow.state.error': '出错',
  'langflow.start': '启动 LangFlow',
  'langflow.stop': '停止',
  'langflow.open': '新窗口打开',
  'langflow.stopped.hint': '启动本地 LangFlow 服务后即可在此处编排工作流。首次启动可能需要数分钟下载依赖。',
  'langflow.load.error': '无法读取 LangFlow 状态',
}

/** English dictionary. */
export const en: Record<FlowbuilderKey, string> = {
  'view.dagflow': 'Workflows',
  'langflow.state.stopped': 'Stopped',
  'langflow.state.starting': 'Starting…',
  'langflow.state.running': 'Running',
  'langflow.state.error': 'Error',
  'langflow.start': 'Start LangFlow',
  'langflow.stop': 'Stop',
  'langflow.open': 'Open in new window',
  'langflow.stopped.hint': 'Start the local LangFlow server to build workflows here. The first start may take several minutes to download dependencies.',
  'langflow.load.error': 'Failed to read the LangFlow status',
}
