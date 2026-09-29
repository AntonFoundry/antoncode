/**
 * File-view dispatch: the pure extension→viewer-key routing every `file`
 * buffer resolves through. The key domain is the shipped viewer roster
 * (`markdown` | `image` | `video`); anything else maps to `text`, which has
 * no slot registrant — the LeafPane dispatch's fallback `FileViewer` renders
 * it as plain text. Each viewer key is owned by its own client plugin
 * package (ui-file-markdown / ui-file-image / ui-file-video); this module
 * owns only the routing, so the map and the packages move together with the
 * web-app composition rows.
 */

/** The viewer keys the shipped roster dispatches between. */
export type FileViewKey = 'markdown' | 'image' | 'video' | 'text'

/** Browser-renderable image extensions (SVG renders sandboxed as an `<img>`). */
const IMAGE_EXTENSIONS: readonly string[] = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif']

/** Browser-playable-or-streamable video extensions. */
const VIDEO_EXTENSIONS: readonly string[] = ['mp4', 'm4v', 'webm', 'mov', 'mkv', 'avi']

/** Markdown text extensions (rendered through the shared markdown engine). */
const MARKDOWN_EXTENSIONS: readonly string[] = ['md', 'markdown']

/**
 * Resolve the viewer key for one path (the last dot segment, case-insensitive;
 * extensionless paths are text).
 * @param path - absolute file path.
 * @returns the viewer key the LeafPane dispatches the `file.view` slot with.
 */
export function viewerKeyFor(path: string): FileViewKey {
  const dot = path.lastIndexOf('.')
  const ext = dot === -1 ? '' : path.slice(dot + 1).toLowerCase()
  if (MARKDOWN_EXTENSIONS.includes(ext)) return 'markdown'
  if (IMAGE_EXTENSIONS.includes(ext)) return 'image'
  if (VIDEO_EXTENSIONS.includes(ext)) return 'video'
  return 'text'
}

/** Extensions the opener hands to the host OS default application (every other path opens inline). */
const OS_OPEN_EXTENSIONS: readonly string[] = [
  'tiff', 'pdf', 'zip', 'gz', 'mp3', 'wav', 'woff2', 'woff', 'ttf', 'otf', 'bin', 'wasm', 'sqlite3', 'db',
]

/**
 * Whether the opener face opens this path inline (a viewer key or the text
 * fallback) rather than handing it to the host OS default application.
 * @param path - absolute file path.
 * @returns true when the path renders inside the app.
 */
export function opensInline(path: string): boolean {
  const dot = path.lastIndexOf('.')
  const ext = dot === -1 ? '' : path.slice(dot + 1).toLowerCase()
  return !OS_OPEN_EXTENSIONS.includes(ext)
}
