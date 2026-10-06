/** `sidebar` namespace dictionaries: shell controls (brand row, New Workspace, fold toggle). */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'workspace.new': '新建工作区',
  'workspace.new.label': '新建工作区',
  'session.new.label': '新建会话',
  'toggle.open': '打开侧边栏',
  'toggle.collapse': '收起侧边栏',
} satisfies Record<string, string>

/** The sidebar namespace key union. */
export type SidebarKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'workspace.new': 'New Workspace',
  'workspace.new.label': 'New workspace',
  'session.new.label': 'New session',
  'toggle.open': 'Open sidebar',
  'toggle.collapse': 'Collapse sidebar',
} satisfies Record<SidebarKey, string>
