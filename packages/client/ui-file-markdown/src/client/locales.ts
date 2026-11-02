/** Markdown file viewer copy and MarkdownText chrome. */
export const zh = {
  loading: '{path} — 正在加载…',
  failed: '{path}：{message}',
  readUnavailable: '无法读取文件',
  truncated: '仅显示前 512 KiB',
  'code.copy': '复制',
  'code.copied': '已复制',
  'codeBlock.title': '代码',
  'codeBlock.wrap': '自动换行',
  'codeBlock.unwrap': '取消换行',
  footnotes: '脚注',
} satisfies Record<string, string>

/** Markdown viewer namespace keys. */
export type FileMarkdownKey = keyof typeof zh

/** English copy, checked against the Chinese keys. */
export const en = {
  loading: '{path} — loading…',
  failed: '{path}: {message}',
  readUnavailable: 'read unavailable',
  truncated: 'Showing the first 512 KiB',
  'code.copy': 'Copy',
  'code.copied': 'Copied',
  'codeBlock.title': 'Code',
  'codeBlock.wrap': 'Wrap lines',
  'codeBlock.unwrap': 'Unwrap lines',
  footnotes: 'Footnotes',
} satisfies Record<FileMarkdownKey, string>

/** Japanese copy, checked against the English keys. */
export const ja = {
  loading: '{path} — 読み込み中…',
  failed: '{path}: {message}',
  readUnavailable: 'ファイルを読み取れません',
  truncated: '先頭 512 KiB のみ表示しています',
  'code.copy': 'コピー',
  'code.copied': 'コピーしました',
  'codeBlock.title': 'コード',
  'codeBlock.wrap': '折り返す',
  'codeBlock.unwrap': '折り返さない',
  footnotes: '脚注',
} satisfies Record<keyof typeof en, string>

/** Spanish copy, checked against the English keys. */
export const es = {
  loading: '{path} — cargando…',
  failed: '{path}: {message}',
  readUnavailable: 'lectura no disponible',
  truncated: 'Se muestran los primeros 512 KiB',
  'code.copy': 'Copiar',
  'code.copied': 'Copiado',
  'codeBlock.title': 'Código',
  'codeBlock.wrap': 'Ajustar líneas',
  'codeBlock.unwrap': 'No ajustar líneas',
  footnotes: 'Notas a pie de página',
} satisfies Record<keyof typeof en, string>

/** French copy, checked against the English keys. */
export const fr = {
  loading: '{path} — chargement…',
  failed: '{path} : {message}',
  readUnavailable: 'lecture indisponible',
  truncated: 'Affichage des 512 premiers Kio',
  'code.copy': 'Copier',
  'code.copied': 'Copié',
  'codeBlock.title': 'Code',
  'codeBlock.wrap': 'Renvoyer à la ligne',
  'codeBlock.unwrap': 'Ne pas renvoyer à la ligne',
  footnotes: 'Notes de bas de page',
} satisfies Record<keyof typeof en, string>

/** German copy, checked against the English keys. */
export const de = {
  loading: '{path} — wird geladen…',
  failed: '{path}: {message}',
  readUnavailable: 'Lesen nicht verfügbar',
  truncated: 'Es werden die ersten 512 KiB angezeigt',
  'code.copy': 'Kopieren',
  'code.copied': 'Kopiert',
  'codeBlock.title': 'Code',
  'codeBlock.wrap': 'Zeilen umbrechen',
  'codeBlock.unwrap': 'Zeilen nicht umbrechen',
  footnotes: 'Fußnoten',
} satisfies Record<keyof typeof en, string>

/** Russian copy, checked against the English keys. */
export const ru = {
  loading: '{path} — загрузка…',
  failed: '{path}: {message}',
  readUnavailable: 'чтение недоступно',
  truncated: 'Показаны первые 512 КиБ',
  'code.copy': 'Копировать',
  'code.copied': 'Скопировано',
  'codeBlock.title': 'Код',
  'codeBlock.wrap': 'Переносить строки',
  'codeBlock.unwrap': 'Не переносить строки',
  footnotes: 'Сноски',
} satisfies Record<keyof typeof en, string>

/** Portuguese copy, checked against the English keys. */
export const pt = {
  loading: '{path} — carregando…',
  failed: '{path}: {message}',
  readUnavailable: 'leitura indisponível',
  truncated: 'Mostrando os primeiros 512 KiB',
  'code.copy': 'Copiar',
  'code.copied': 'Copiado',
  'codeBlock.title': 'Código',
  'codeBlock.wrap': 'Quebrar linhas',
  'codeBlock.unwrap': 'Não quebrar linhas',
  footnotes: 'Notas de rodapé',
} satisfies Record<keyof typeof en, string>

/** Locale namespace registered by this plugin. */
export const NS = 'fileMarkdown'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Inline markdown file viewer and its MarkdownText chrome. */
    fileMarkdown: FileMarkdownKey
  }
}
