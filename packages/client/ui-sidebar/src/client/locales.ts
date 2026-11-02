/** `sidebar` namespace dictionaries for shell controls (brand row, New Workspace, fold toggle, memory separator) and global panels. */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'session.new': '新会话',
  'workspace.new': '新建工作区',
  'workspace.new.label': '新建工作区',
  'session.new.label': '新建会话',
  'toggle.open': '打开侧边栏',
  'toggle.collapse': '收起侧边栏',
  'panels.label': '全局面板',
  'panels.more': '更多',
  'version.copied': '版本号复制成功',
  'memory.resize.label': '调整记忆面板大小',
  'memory.resize.title': '拖动以调整执行树大小',
} satisfies Record<string, string>

/** The sidebar namespace key union. */
export type SidebarKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'session.new': 'New Session',
  'workspace.new': 'New Workspace',
  'workspace.new.label': 'New workspace',
  'session.new.label': 'New session',
  'toggle.open': 'Open sidebar',
  'toggle.collapse': 'Collapse sidebar',
  'panels.label': 'Global panels',
  'panels.more': 'More',
  'version.copied': 'Version copied',
  'memory.resize.label': 'Resize the memory panel',
  'memory.resize.title': 'Drag to resize the execution tree',
} satisfies Record<SidebarKey, string>

/** Japanese copy, checked against the English keys. */
export const ja = {
  'session.new': '新規セッション',
  'workspace.new': '新規ワークスペース',
  'workspace.new.label': '新規ワークスペース',
  'session.new.label': '新規セッション',
  'toggle.open': 'サイドバーを開く',
  'toggle.collapse': 'サイドバーを折りたたむ',
  'panels.label': 'グローバルパネル',
  'panels.more': 'その他',
  'version.copied': 'バージョンをコピーしました',
  'memory.resize.label': 'メモリパネルのサイズを変更',
  'memory.resize.title': 'ドラッグして実行ツリーのサイズを変更',
} satisfies Record<keyof typeof en, string>

/** Spanish dictionary, checked against the English keys. */
export const es = {
  'session.new': 'Nueva sesión',
  'workspace.new': 'Nuevo espacio de trabajo',
  'workspace.new.label': 'Nuevo espacio de trabajo',
  'session.new.label': 'Nueva sesión',
  'toggle.open': 'Abrir barra lateral',
  'toggle.collapse': 'Contraer barra lateral',
  'panels.label': 'Paneles globales',
  'panels.more': 'Más',
  'version.copied': 'Versión copiada',
  'memory.resize.label': 'Cambiar el tamaño del panel de memoria',
  'memory.resize.title': 'Arrastra para cambiar el tamaño del árbol de ejecución',
} satisfies Record<keyof typeof en, string>

/** French dictionary, checked against the English keys. */
export const fr = {
  'session.new': 'Nouvelle séance',
  'workspace.new': 'Nouvel espace de travail',
  'workspace.new.label': 'Nouvel espace de travail',
  'session.new.label': 'Nouvelle séance',
  'toggle.open': 'Ouvrir la barre latérale',
  'toggle.collapse': 'Réduire la barre latérale',
  'panels.label': 'Panneaux globaux',
  'panels.more': 'Plus',
  'version.copied': 'Version copiée',
  'memory.resize.label': 'Redimensionner le panneau de mémoire',
  'memory.resize.title': 'Faites glisser pour redimensionner l\'arbre d\'exécution',
} satisfies Record<keyof typeof en, string>

/** German dictionary, checked against the English keys. */
export const de = {
  'session.new': 'Neue Sitzung',
  'workspace.new': 'Neuer Arbeitsbereich',
  'workspace.new.label': 'Neuer Arbeitsbereich',
  'session.new.label': 'Neue Sitzung',
  'toggle.open': 'Seitenleiste öffnen',
  'toggle.collapse': 'Seitenleiste einklappen',
  'panels.label': 'Globale Bereiche',
  'panels.more': 'Mehr',
  'version.copied': 'Version kopiert',
  'memory.resize.label': 'Speicherbereich in der Größe ändern',
  'memory.resize.title': 'Ziehen, um die Größe des Ausführungsbaums zu ändern',
} satisfies Record<keyof typeof en, string>

/** Russian dictionary, checked against the English keys. */
export const ru = {
  'session.new': 'Новая сессия',
  'workspace.new': 'Новое рабочее пространство',
  'workspace.new.label': 'Новое рабочее пространство',
  'session.new.label': 'Новая сессия',
  'toggle.open': 'Открыть боковую панель',
  'toggle.collapse': 'Свернуть боковую панель',
  'panels.label': 'Глобальные панели',
  'panels.more': 'Ещё',
  'version.copied': 'Версия скопирована',
  'memory.resize.label': 'Изменить размер панели памяти',
  'memory.resize.title': 'Перетащите, чтобы изменить размер дерева выполнения',
} satisfies Record<keyof typeof en, string>

/** Portuguese dictionary, checked against the English keys. */
export const pt = {
  'session.new': 'Nova sessão',
  'workspace.new': 'Novo espaço de trabalho',
  'workspace.new.label': 'Novo espaço de trabalho',
  'session.new.label': 'Nova sessão',
  'toggle.open': 'Abrir barra lateral',
  'toggle.collapse': 'Recolher barra lateral',
  'panels.label': 'Painéis globais',
  'panels.more': 'Mais',
  'version.copied': 'Versão copiada',
  'memory.resize.label': 'Redimensionar o painel de memória',
  'memory.resize.title': 'Arraste para redimensionar a árvore de execução',
} satisfies Record<keyof typeof en, string>
