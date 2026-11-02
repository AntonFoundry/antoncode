/** Video file viewer copy. */
export const zh = {
  failed: '{path} — 无法内联播放此视频',
  retry: '重试',
  openWithOs: '用默认应用打开',
  noSound: '没有声音？',
  remux: '通过转封装播放',
  remuxHint: '（将音轨转换为 AAC）',
} satisfies Record<string, string>

/** Video viewer namespace keys. */
export type FileVideoKey = keyof typeof zh

/** English copy, checked against the Chinese keys. */
export const en = {
  failed: '{path} — this video cannot be played inline',
  retry: 'Retry',
  openWithOs: 'Open with default app',
  noSound: 'No sound?',
  remux: 'Play via remux',
  remuxHint: '(converts the audio track to AAC)',
} satisfies Record<FileVideoKey, string>

/** Japanese copy, checked against the English keys. */
export const ja = {
  failed: '{path} — この動画はインラインで再生できません',
  retry: '再試行',
  openWithOs: '既定のアプリで開く',
  noSound: '音が出ませんか？',
  remux: 'リマックスして再生',
  remuxHint: '（音声トラックを AAC に変換します）',
} satisfies Record<keyof typeof en, string>

/** Spanish copy, checked against the English keys. */
export const es = {
  failed: '{path} — este video no se puede reproducir aquí',
  retry: 'Reintentar',
  openWithOs: 'Abrir con la aplicación predeterminada',
  noSound: '¿Sin sonido?',
  remux: 'Reproducir con remux',
  remuxHint: '(convierte la pista de audio a AAC)',
} satisfies Record<keyof typeof en, string>

/** French copy, checked against the English keys. */
export const fr = {
  failed: '{path} — cette vidéo ne peut pas être lue ici',
  retry: 'Réessayer',
  openWithOs: 'Ouvrir avec l’application par défaut',
  noSound: 'Pas de son ?',
  remux: 'Lire via remux',
  remuxHint: '(convertit la piste audio en AAC)',
} satisfies Record<keyof typeof en, string>

/** German copy, checked against the English keys. */
export const de = {
  failed: '{path} — dieses Video kann nicht eingebettet abgespielt werden',
  retry: 'Erneut versuchen',
  openWithOs: 'Mit Standard-App öffnen',
  noSound: 'Kein Ton?',
  remux: 'Per Remux abspielen',
  remuxHint: '(wandelt die Audiospur in AAC um)',
} satisfies Record<keyof typeof en, string>

/** Russian copy, checked against the English keys. */
export const ru = {
  failed: '{path} — это видео нельзя воспроизвести здесь',
  retry: 'Повторить',
  openWithOs: 'Открыть в приложении по умолчанию',
  noSound: 'Нет звука?',
  remux: 'Воспроизвести через ремукс',
  remuxHint: '(преобразует звуковую дорожку в AAC)',
} satisfies Record<keyof typeof en, string>

/** Portuguese copy, checked against the English keys. */
export const pt = {
  failed: '{path} — este vídeo não pode ser reproduzido aqui',
  retry: 'Tentar novamente',
  openWithOs: 'Abrir com o aplicativo padrão',
  noSound: 'Sem som?',
  remux: 'Reproduzir via remux',
  remuxHint: '(converte a faixa de áudio para AAC)',
} satisfies Record<keyof typeof en, string>

/** Locale namespace registered by this plugin. */
export const NS = 'fileVideo'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Inline video file viewer. */
    fileVideo: FileVideoKey
  }
}
