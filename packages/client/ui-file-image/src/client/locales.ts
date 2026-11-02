/** Image file viewer copy. */
export const zh = {
  loading: '{path} — 正在加载…',
  failed: '{path} — 无法加载此图片',
  retry: '重试',
  openWithOs: '用默认应用打开',
} satisfies Record<string, string>

/** Image viewer namespace keys. */
export type FileImageKey = keyof typeof zh

/** English copy, checked against the Chinese keys. */
export const en = {
  loading: '{path} — loading…',
  failed: '{path} — could not load this image',
  retry: 'Retry',
  openWithOs: 'Open with default app',
} satisfies Record<FileImageKey, string>

/** Japanese copy, checked against the English keys. */
export const ja = {
  loading: '{path} — 読み込み中…',
  failed: '{path} — この画像を読み込めませんでした',
  retry: '再試行',
  openWithOs: '既定のアプリで開く',
} satisfies Record<keyof typeof en, string>

/** Spanish copy, checked against the English keys. */
export const es = {
  loading: '{path} — cargando…',
  failed: '{path} — no se pudo cargar esta imagen',
  retry: 'Reintentar',
  openWithOs: 'Abrir con la aplicación predeterminada',
} satisfies Record<keyof typeof en, string>

/** French copy, checked against the English keys. */
export const fr = {
  loading: '{path} — chargement…',
  failed: '{path} — impossible de charger cette image',
  retry: 'Réessayer',
  openWithOs: 'Ouvrir avec l’application par défaut',
} satisfies Record<keyof typeof en, string>

/** German copy, checked against the English keys. */
export const de = {
  loading: '{path} — wird geladen…',
  failed: '{path} — dieses Bild konnte nicht geladen werden',
  retry: 'Erneut versuchen',
  openWithOs: 'Mit Standard-App öffnen',
} satisfies Record<keyof typeof en, string>

/** Russian copy, checked against the English keys. */
export const ru = {
  loading: '{path} — загрузка…',
  failed: '{path} — не удалось загрузить изображение',
  retry: 'Повторить',
  openWithOs: 'Открыть в приложении по умолчанию',
} satisfies Record<keyof typeof en, string>

/** Portuguese copy, checked against the English keys. */
export const pt = {
  loading: '{path} — carregando…',
  failed: '{path} — não foi possível carregar esta imagem',
  retry: 'Tentar novamente',
  openWithOs: 'Abrir com o aplicativo padrão',
} satisfies Record<keyof typeof en, string>

/** Locale namespace registered by this plugin. */
export const NS = 'fileImage'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Inline image file viewer. */
    fileImage: FileImageKey
  }
}
