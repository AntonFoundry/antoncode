/** `orchestrator` namespace dictionaries (the two conversation view tab labels and the Dag Flow canvas chrome). */

/** Dictionary namespace owned by this plugin. */
export const NS = 'orchestrator'

/** The orchestrator dictionary key set (the source of truth for both locales). */
export type OrchestratorKey =
  | 'view.orchestrator'
  | 'cancel.accepted'
  | 'cancel.failed'
  | 'flow.canvas'
  | 'flow.empty'
  | 'flow.zoomIn'
  | 'flow.zoomOut'
  | 'flow.fit'
  | 'flow.minimap'
  | 'flow.lock'
  | 'flow.unlock'
  | 'flow.close'
  | 'flow.focus'
  | 'flow.field.kind'
  | 'flow.field.status'
  | 'flow.field.session'
  | 'flow.field.path'
  | 'flow.steps'
  | 'flow.legend'
  | 'flow.kind.mission'
  | 'flow.kind.agent'
  | 'flow.kind.task'
  | 'flow.status.queued'
  | 'flow.status.running'
  | 'flow.status.blocked'
  | 'flow.status.verifying'
  | 'flow.status.done'
  | 'flow.status.failed'
  | 'flow.status.stalemate'
  | 'flow.status.pending'
  | 'flow.status.in_progress'
  | 'flow.status.completed'
  | 'flow.status.cancelled'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The Orchestrator and Dag Flow view tab labels, plus the Dag Flow canvas chrome. */
    'orchestrator': OrchestratorKey
  }
}

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh: Record<OrchestratorKey, string> = {
  'view.orchestrator': '编排器',
  'cancel.accepted': '已请求停止会话',
  'cancel.failed': '无法停止会话。请检查访问权限和连接后重试。',
  'flow.canvas': 'DAG 画布',
  'flow.empty': '板上暂无运行',
  'flow.zoomIn': '放大',
  'flow.zoomOut': '缩小',
  'flow.fit': '适应视图',
  'flow.minimap': '缩略图',
  'flow.lock': '锁定平移',
  'flow.unlock': '解锁平移',
  'flow.close': '关闭详情',
  'flow.focus': '定位会话',
  'flow.field.kind': '类型',
  'flow.field.status': '状态',
  'flow.field.session': '会话',
  'flow.field.path': '路径',
  'flow.steps': '后续步骤',
  'flow.legend': '状态图例',
  'flow.kind.mission': '任务组',
  'flow.kind.agent': '子代理',
  'flow.kind.task': '步骤',
  'flow.status.queued': '排队',
  'flow.status.running': '运行中',
  'flow.status.blocked': '阻塞',
  'flow.status.verifying': '校验中',
  'flow.status.done': '完成',
  'flow.status.failed': '失败',
  'flow.status.stalemate': '僵局',
  'flow.status.pending': '待办',
  'flow.status.in_progress': '进行中',
  'flow.status.completed': '已完成',
  'flow.status.cancelled': '已取消',
}

/** English dictionary. */
export const en: Record<OrchestratorKey, string> = {
  'view.orchestrator': 'Orchestrator',
  'cancel.accepted': 'Session stop requested',
  'cancel.failed': 'Could not stop the session. Check access and connection before trying again.',
  'flow.canvas': 'Dag Flow canvas',
  'flow.empty': 'No runs on the board yet',
  'flow.zoomIn': 'Zoom in',
  'flow.zoomOut': 'Zoom out',
  'flow.fit': 'Fit to view',
  'flow.minimap': 'Minimap',
  'flow.lock': 'Lock panning',
  'flow.unlock': 'Unlock panning',
  'flow.close': 'Close inspector',
  'flow.focus': 'Focus session',
  'flow.field.kind': 'Kind',
  'flow.field.status': 'Status',
  'flow.field.session': 'Session',
  'flow.field.path': 'Path',
  'flow.steps': 'Steps',
  'flow.legend': 'Status legend',
  'flow.kind.mission': 'Mission',
  'flow.kind.agent': 'Agent',
  'flow.kind.task': 'Task',
  'flow.status.queued': 'queued',
  'flow.status.running': 'running',
  'flow.status.blocked': 'blocked',
  'flow.status.verifying': 'verifying',
  'flow.status.done': 'done',
  'flow.status.failed': 'failed',
  'flow.status.stalemate': 'stalemate',
  'flow.status.pending': 'pending',
  'flow.status.in_progress': 'in progress',
  'flow.status.completed': 'completed',
  'flow.status.cancelled': 'cancelled',
}
