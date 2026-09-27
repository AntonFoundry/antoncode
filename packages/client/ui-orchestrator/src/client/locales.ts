/** `orchestrator` namespace dictionaries (the two conversation view tab labels). */

/** Dictionary namespace owned by this plugin. */
export const NS = 'orchestrator'

/** The orchestrator dictionary key set (the source of truth for both locales). */
export type OrchestratorKey =
  | 'view.orchestrator'
  | 'view.dagflow'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The Orchestrator and Dag Flow view tab labels. */
    'orchestrator': OrchestratorKey
  }
}

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh: Record<OrchestratorKey, string> = {
  'view.orchestrator': '编排器',
  'view.dagflow': 'DAG 流',
}

/** English dictionary. */
export const en: Record<OrchestratorKey, string> = {
  'view.orchestrator': 'Orchestrator',
  'view.dagflow': 'Dag Flow',
}
