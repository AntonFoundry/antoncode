/** `settings.theme` namespace dictionaries (the Appearance and Font rows' copy). */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'appearance.title': '外观',
  'appearance.light': '浅色',
  'appearance.dark': '深色',
  'appearance.system': '跟随系统',
  'font.title': '字体',
  'font.interface': '界面',
  'font.chat': '对话',
  'font.code': '代码',
  'font.terminal': '终端',
  'font.scale': '缩放',
  'font.size': '字号',
  'font.previewUi': '设置、侧边栏与窗口边框 Settings & Sidebar',
  'font.previewChat': '对话消息与输入框',
} satisfies Record<string, string>

/** The settings.theme namespace key union. */
export type ThemeKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'appearance.title': 'Appearance',
  'appearance.light': 'Light',
  'appearance.dark': 'Dark',
  'appearance.system': 'System',
  'font.title': 'Fonts',
  'font.interface': 'Interface',
  'font.chat': 'Chat',
  'font.code': 'Code',
  'font.terminal': 'Terminal',
  'font.scale': 'Zoom',
  'font.size': 'Font size',
  'font.previewUi': 'Settings, sidebar, and window chrome',
  'font.previewChat': 'Conversation messages and composer',
} satisfies Record<ThemeKey, string>
