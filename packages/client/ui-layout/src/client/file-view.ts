/**
 * File-view dispatch: the pure extension→viewer-key routing every `file`
 * buffer resolves through. The key domain is the shipped viewer roster
 * (`markdown` | `image` | `video`); anything else maps to `text`, which has
 * no slot registrant — the LeafPane dispatch's fallback `FileViewer` renders
 * it as text, syntax-highlighted when {@link viewerLanguageFor} resolves the
 * extension to a grammar. Each viewer key is owned by its own client plugin
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

/**
 * Extension → grammar hint for the text fallback's syntax highlighting. The
 * values are language ids (aliases) ui-primitives' shared shiki highlighter
 * accepts — the same set the markdown fence aliases and the host read tool's
 * `langFromPath` resolve — so an unknown extension here degrades to plain text
 * inside `CodeBlock`, never an error. Own-property access only: a filename
 * whose extension is an `Object.prototype` key (`foo.constructor`) must miss,
 * not resolve an inherited member.
 */
const LANG_BY_EXTENSION: Readonly<Record<string, string>> = {
  ts: 'ts', tsx: 'tsx', js: 'js', jsx: 'jsx', mjs: 'js', cjs: 'js',
  json: 'json', jsonc: 'json', json5: 'json5',
  py: 'py', rb: 'rb', go: 'go', rs: 'rs', java: 'java',
  c: 'c', h: 'c', cc: 'cpp', cpp: 'cpp', hpp: 'cpp', cxx: 'cpp',
  cs: 'cs', kt: 'kotlin', swift: 'swift', php: 'php',
  scala: 'scala', dart: 'dart', groovy: 'groovy', gradle: 'groovy',
  pl: 'perl', pm: 'perl', hs: 'hs', ex: 'ex', exs: 'exs', erl: 'erl', hrl: 'hrl',
  clj: 'clj', cljs: 'cljs', cljc: 'cljc', edn: 'edn', rkt: 'rkt', scm: 'scm',
  janet: 'janet', lisp: 'lisp', cl: 'lisp', lsp: 'lisp', el: 'elisp', fnl: 'fennel',
  hy: 'hy', elm: 'elm', cr: 'crystal', f90: 'fortran', f95: 'fortran',
  f03: 'fortran', f08: 'fortran', cob: 'cobol', cbl: 'cobol', ada: 'ada',
  adb: 'ada', ads: 'ada', hx: 'haxe', d: 'd', di: 'd', purs: 'purescript',
  gleam: 'gleam', gd: 'gdscript', glsl: 'glsl', hlsl: 'hlsl', wgsl: 'wgsl',
  wat: 'wasm', vh: 'verilog', vhd: 'vhdl', asm: 'asm', nasm: 'asm', s: 'asm',
  pro: 'prolog', raku: 'raku', tcl: 'tcl', awk: 'awk', bat: 'bat', just: 'just',
  cue: 'cue', jsonnet: 'jsonnet', prisma: 'prisma', pug: 'pug', styl: 'stylus',
  sass: 'sass', hbs: 'handlebars', twig: 'twig', liquid: 'liquid', cshtml: 'razor',
  ml: 'ml', mli: 'mli', fs: 'fs', fsi: 'fsi', fsx: 'fsx', jl: 'jl',
  m: 'objc', mm: 'objc', r: 'r',
  ps1: 'ps1', psm1: 'ps1', psd1: 'ps1',
  sh: 'sh', bash: 'sh', zsh: 'sh',
  yaml: 'yaml', yml: 'yaml', toml: 'toml', ini: 'ini', properties: 'properties', conf: 'conf',
  html: 'html', htm: 'htm', css: 'css', scss: 'scss', less: 'less',
  sql: 'sql', xml: 'xml', lua: 'lua', graphql: 'graphql', gql: 'gql', http: 'http',
  dockerfile: 'dockerfile', mk: 'mk', cmake: 'cmake', diff: 'diff', patch: 'patch',
  vim: 'vim', zig: 'zig', nim: 'nim', nix: 'nix', sol: 'sol', reg: 'reg', proto: 'proto',
  hcl: 'hcl', tf: 'tf', tfvars: 'tfvars',
  vue: 'vue', svelte: 'svelte', astro: 'astro',
  tex: 'tex', latex: 'latex', pas: 'pas', vb: 'vb', coffee: 'coffee',
}

/**
 * Derive the syntax-highlighting language hint for a text-fallback path.
 * Pure and case-insensitive on the extension; a dotfile with no extension
 * (`.gitignore`) and an unknown extension both yield `undefined` (plain text).
 * @param path - the file path the viewer opened.
 * @returns the grammar hint for {@link LANG_BY_EXTENSION}, or `undefined` when the extension maps to none.
 */
export function viewerLanguageFor(path: string): string | undefined {
  const dot = path.lastIndexOf('.')
  // A leading dot is a dotfile (no extension), not an empty extension.
  if (dot <= 0) return undefined
  const ext = path.slice(dot + 1).toLowerCase()
  return Object.hasOwn(LANG_BY_EXTENSION, ext) ? LANG_BY_EXTENSION[ext] : undefined
}

/** Extensions the opener hands to the host OS default application (every other path opens inline). */
const OS_OPEN_EXTENSIONS: readonly string[] = [
  'tiff', 'pdf', 'zip', 'gz', 'mp3', 'wav', 'woff2', 'woff', 'ttf', 'otf', 'bin', 'wasm', 'sqlite3', 'db',
]

/**
 * Whether the opener face opens this path inline (a viewer key or the text
 * fallback) rather than handing it to the host OS default application.
 * Directory-ish paths (the workspace itself, `.`/`..` segments, trailing
 * separators) never render in a file buffer — they hand off to the Host so
 * gestures like "Show in folder" reach the OS.
 * @param path - absolute file path.
 * @returns true when the path renders inside the app.
 */
export function opensInline(path: string): boolean {
  if (path.endsWith('/') || /(^|\/)\.{1,2}$/.test(path)) return false
  const dot = path.lastIndexOf('.')
  const ext = dot === -1 ? '' : path.slice(dot + 1).toLowerCase()
  return !OS_OPEN_EXTENSIONS.includes(ext)
}
