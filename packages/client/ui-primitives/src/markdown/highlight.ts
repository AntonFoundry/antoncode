/**
 * The client's ONE syntax highlighter: a synchronous fine-grained shiki core
 * (JavaScript regex engine — no oniguruma WASM, bundle-friendly) with an
 * explicit grammar allowlist and a CSS-variables theme. Colors live in the
 * theme package's token sheets as `--shiki-*` custom properties (light and
 * dark blocks), never here — the repo's tokens-only styling rule.
 *
 * Only the three markdown-fence and `run_code` grammars (TypeScript, shell,
 * JSON) load into the singleton at boot — the set every session renders. The
 * wider language set (the read card's file-extension hints from the host read
 * tool's `langFromPath` plus the file viewer's `viewerLanguageFor`, and every
 * common fence label the assistant emits — python, rust, yaml, markup, the
 * JVM/FP/scripting families, infra and web-framework grammars, …) imports
 * lazily and registers the first time such a language is requested, so a
 * session that never renders one of those languages pays neither the grammar
 * modules nor their synchronous init. The first render of a lazy language
 * falls back to plain text while its
 * grammar loads, then {@link onGrammarLoaded} notifies subscribers to re-render
 * with highlighting. An unknown or absent language falls back to plain text (no
 * highlighting, still monospace) — never an error.
 */

import { createHighlighterCoreSync, createCssVariablesTheme } from 'shiki/core'
import { createJavaScriptRegexEngine, defaultJavaScriptRegexConstructor } from 'shiki/engine/javascript'
import langTs from '@shikijs/langs/typescript'
import langBash from '@shikijs/langs/shellscript'
import langJson from '@shikijs/langs/json'
import { benderGrammar } from './bender-grammar.ts'
import { janetGrammar } from './janet-grammar.ts'
import type { HighlighterCore, LanguageRegistration } from 'shiki/core'
import type { CSSProperties } from 'react'

/** A shiki grammar module's default export (a `LanguageRegistration[]`), taken
 *  from a boot grammar so no direct language module needs its own type import. */
type LangModule = { default: LanguageRegistration[] }

/**
 * Grammars the singleton loads at boot; each entry's own `name` is the id
 * `codeToTokens`/`codeToHtml` resolve. The JS-family aliases (js/jsx/ts/tsx)
 * resolve to the TypeScript grammar rather than a separate one: it tokenizes
 * plain TS/JS exactly, and JSX/TSX approximately (shiki's TS grammar is not the
 * dedicated TSX grammar, so JSX elements tokenize imperfectly) — an accepted
 * trade to keep the boot set to one JS-family grammar. The read card's wider
 * set loads lazily through {@link LAZY_GRAMMARS}.
 */
const LANGS = [langTs, langBash, langJson]

/**
 * The read card's extension grammars, each behind a dynamic import so its
 * module stays out of the boot chunk until a read of that language renders.
 * Keyed by the grammar id (`LanguageRegistration.name`) the aliases resolve to.
 * `@shikijs/langs`' default export is a `LanguageRegistration[]`; the loader
 * hands the whole array to `loadLanguageSync`, which registers each entry
 * (including embedded sub-grammars). The three boot grammars are absent —
 * already loaded, so no alias value ever points at a missing entry here.
 */
const LAZY_GRAMMARS = new Map<string, () => Promise<LangModule>>([
  ['python', () => import('@shikijs/langs/python')],
  ['ruby', () => import('@shikijs/langs/ruby')],
  ['go', () => import('@shikijs/langs/go')],
  ['rust', () => import('@shikijs/langs/rust')],
  ['java', () => import('@shikijs/langs/java')],
  ['c', () => import('@shikijs/langs/c')],
  ['cpp', () => import('@shikijs/langs/cpp')],
  ['csharp', () => import('@shikijs/langs/csharp')],
  ['kotlin', () => import('@shikijs/langs/kotlin')],
  ['swift', () => import('@shikijs/langs/swift')],
  ['php', () => import('@shikijs/langs/php')],
  ['yaml', () => import('@shikijs/langs/yaml')],
  ['toml', () => import('@shikijs/langs/toml')],
  ['ini', () => import('@shikijs/langs/ini')],
  ['markdown', () => import('@shikijs/langs/markdown')],
  ['mdx', () => import('@shikijs/langs/mdx')],
  ['html', () => import('@shikijs/langs/html')],
  ['css', () => import('@shikijs/langs/css')],
  ['scss', () => import('@shikijs/langs/scss')],
  ['less', () => import('@shikijs/langs/less')],
  ['sql', () => import('@shikijs/langs/sql')],
  ['xml', () => import('@shikijs/langs/xml')],
  ['lua', () => import('@shikijs/langs/lua')],
  ['scala', () => import('@shikijs/langs/scala')],
  ['dart', () => import('@shikijs/langs/dart')],
  ['perl', () => import('@shikijs/langs/perl')],
  ['haskell', () => import('@shikijs/langs/haskell')],
  ['elixir', () => import('@shikijs/langs/elixir')],
  ['erlang', () => import('@shikijs/langs/erlang')],
  ['clojure', () => import('@shikijs/langs/clojure')],
  ['racket', () => import('@shikijs/langs/racket')],
  ['scheme', () => import('@shikijs/langs/scheme')],
  ['common-lisp', () => import('@shikijs/langs/common-lisp')],
  ['emacs-lisp', () => import('@shikijs/langs/emacs-lisp')],
  ['fennel', () => import('@shikijs/langs/fennel')],
  ['ocaml', () => import('@shikijs/langs/ocaml')],
  ['fsharp', () => import('@shikijs/langs/fsharp')],
  ['julia', () => import('@shikijs/langs/julia')],
  ['matlab', () => import('@shikijs/langs/matlab')],
  ['r', () => import('@shikijs/langs/r')],
  ['powershell', () => import('@shikijs/langs/powershell')],
  ['objective-c', () => import('@shikijs/langs/objc')],
  ['groovy', () => import('@shikijs/langs/groovy')],
  ['cmake', () => import('@shikijs/langs/cmake')],
  ['docker', () => import('@shikijs/langs/docker')],
  ['make', () => import('@shikijs/langs/makefile')],
  ['nginx', () => import('@shikijs/langs/nginx')],
  ['diff', () => import('@shikijs/langs/diff')],
  ['graphql', () => import('@shikijs/langs/graphql')],
  ['viml', () => import('@shikijs/langs/viml')],
  ['zig', () => import('@shikijs/langs/zig')],
  ['nim', () => import('@shikijs/langs/nim')],
  ['nix', () => import('@shikijs/langs/nix')],
  ['solidity', () => import('@shikijs/langs/solidity')],
  ['vue', () => import('@shikijs/langs/vue')],
  ['svelte', () => import('@shikijs/langs/svelte')],
  ['astro', () => import('@shikijs/langs/astro')],
  ['latex', () => import('@shikijs/langs/latex')],
  ['properties', () => import('@shikijs/langs/properties')],
  ['json5', () => import('@shikijs/langs/json5')],
  ['vb', () => import('@shikijs/langs/vb')],
  ['coffeescript', () => import('@shikijs/langs/coffeescript')],
  ['reg', () => import('@shikijs/langs/reg')],
  ['protobuf', () => import('@shikijs/langs/protobuf')],
  ['hcl', () => import('@shikijs/langs/hcl')],
  ['terraform', () => import('@shikijs/langs/terraform')],
  ['pascal', () => import('@shikijs/langs/pascal')],
  ['http', () => import('@shikijs/langs/http')],
  ['hy', () => import('@shikijs/langs/hy')],
  ['elm', () => import('@shikijs/langs/elm')],
  ['crystal', () => import('@shikijs/langs/crystal')],
  ['fortran-free-form', () => import('@shikijs/langs/fortran-free-form')],
  ['cobol', () => import('@shikijs/langs/cobol')],
  ['ada', () => import('@shikijs/langs/ada')],
  ['haxe', () => import('@shikijs/langs/haxe')],
  ['d', () => import('@shikijs/langs/d')],
  ['purescript', () => import('@shikijs/langs/purescript')],
  ['gleam', () => import('@shikijs/langs/gleam')],
  ['gdscript', () => import('@shikijs/langs/gdscript')],
  ['glsl', () => import('@shikijs/langs/glsl')],
  ['hlsl', () => import('@shikijs/langs/hlsl')],
  ['wgsl', () => import('@shikijs/langs/wgsl')],
  ['wasm', () => import('@shikijs/langs/wasm')],
  ['verilog', () => import('@shikijs/langs/verilog')],
  ['v', () => import('@shikijs/langs/v')],
  ['vhdl', () => import('@shikijs/langs/vhdl')],
  ['asm', () => import('@shikijs/langs/asm')],
  ['prolog', () => import('@shikijs/langs/prolog')],
  ['raku', () => import('@shikijs/langs/raku')],
  ['tcl', () => import('@shikijs/langs/tcl')],
  ['awk', () => import('@shikijs/langs/awk')],
  ['bat', () => import('@shikijs/langs/bat')],
  ['just', () => import('@shikijs/langs/just')],
  ['cue', () => import('@shikijs/langs/cue')],
  ['jsonnet', () => import('@shikijs/langs/jsonnet')],
  ['prisma', () => import('@shikijs/langs/prisma')],
  ['pug', () => import('@shikijs/langs/pug')],
  ['stylus', () => import('@shikijs/langs/stylus')],
  ['sass', () => import('@shikijs/langs/sass')],
  ['handlebars', () => import('@shikijs/langs/handlebars')],
  ['twig', () => import('@shikijs/langs/twig')],
  ['liquid', () => import('@shikijs/langs/liquid')],
  ['razor', () => import('@shikijs/langs/razor')],
])

/**
 * Grammars the client defines itself because no `@shikijs/langs` package ships
 * one. They register synchronously on first use, so their first render is
 * highlighted rather than showing the plain fallback. Janet and its Bender fork
 * (same reader syntax, `.ben` files) are the current pair, both built from
 * `lisp-dialect-grammar.ts`.
 */
const SPECIAL_GRAMMARS = new Map<string, LanguageRegistration>([
  ['bender', benderGrammar],
  ['janet', janetGrammar],
])

/**
 * Language ids (and aliases) the highlighter accepts; everything else renders
 * plain. A Map, not an object: fence info strings are assistant-authored, so
 * a label like `constructor` or `__proto__` must miss instead of resolving an
 * inherited property and crashing the renderer inside shiki. Keys cover both
 * the markdown-fence aliases `CodeBlock` uses and the file-extension hint ids
 * the read tool's `langFromPath` emits, so both callers resolve the same
 * grammars. The JS family maps to the TypeScript grammar (see {@link LANGS} for
 * the JSX/TSX approximation). A value not in {@link LANGS} names a
 * {@link LAZY_GRAMMARS} entry loaded on first use.
 */
const LANG_ALIASES = new Map<string, string>([
  ['typescript', 'typescript'],
  ['ts', 'typescript'],
  ['tsx', 'typescript'],
  ['javascript', 'typescript'],
  ['js', 'typescript'],
  ['jsx', 'typescript'],
  ['shellscript', 'shellscript'],
  ['bash', 'shellscript'],
  ['sh', 'shellscript'],
  ['shell', 'shellscript'],
  ['zsh', 'shellscript'],
  ['json', 'json'],
  ['jsonc', 'json'],
  ['py', 'python'],
  ['python', 'python'],
  ['rb', 'ruby'],
  ['ruby', 'ruby'],
  ['go', 'go'],
  ['rs', 'rust'],
  ['rust', 'rust'],
  ['java', 'java'],
  ['c', 'c'],
  ['cpp', 'cpp'],
  ['cs', 'csharp'],
  ['csharp', 'csharp'],
  ['kotlin', 'kotlin'],
  ['swift', 'swift'],
  ['php', 'php'],
  ['yaml', 'yaml'],
  ['yml', 'yaml'],
  ['toml', 'toml'],
  ['ini', 'ini'],
  ['md', 'markdown'],
  ['markdown', 'markdown'],
  ['mdx', 'mdx'],
  ['html', 'html'],
  ['css', 'css'],
  ['scss', 'scss'],
  ['less', 'less'],
  ['sql', 'sql'],
  ['xml', 'xml'],
  ['lua', 'lua'],
  ['scala', 'scala'],
  ['dart', 'dart'],
  ['perl', 'perl'],
  ['pl', 'perl'],
  ['pm', 'perl'],
  ['haskell', 'haskell'],
  ['hs', 'haskell'],
  ['elixir', 'elixir'],
  ['ex', 'elixir'],
  ['exs', 'elixir'],
  ['erlang', 'erlang'],
  ['erl', 'erlang'],
  ['hrl', 'erlang'],
  ['clojure', 'clojure'],
  ['clj', 'clojure'],
  ['cljs', 'clojure'],
  ['cljc', 'clojure'],
  ['edn', 'clojure'],
  ['common-lisp', 'common-lisp'],
  ['lisp', 'common-lisp'],
  ['lsp', 'common-lisp'],
  ['cl', 'common-lisp'],
  ['emacs-lisp', 'emacs-lisp'],
  ['elisp', 'emacs-lisp'],
  ['el', 'emacs-lisp'],
  ['fennel', 'fennel'],
  ['fnl', 'fennel'],
  ['janet', 'janet'],
  ['bender', 'bender'],
  ['ben', 'bender'],
  ['racket', 'racket'],
  ['rkt', 'racket'],
  ['scheme', 'scheme'],
  ['scm', 'scheme'],
  ['ocaml', 'ocaml'],
  ['ml', 'ocaml'],
  ['mli', 'ocaml'],
  ['fsharp', 'fsharp'],
  ['f#', 'fsharp'],
  ['fs', 'fsharp'],
  ['fsi', 'fsharp'],
  ['fsx', 'fsharp'],
  ['julia', 'julia'],
  ['jl', 'julia'],
  ['matlab', 'matlab'],
  ['r', 'r'],
  ['powershell', 'powershell'],
  ['ps1', 'powershell'],
  ['psm1', 'powershell'],
  ['psd1', 'powershell'],
  ['objective-c', 'objective-c'],
  ['objc', 'objective-c'],
  ['m', 'objective-c'],
  ['mm', 'objective-c'],
  ['groovy', 'groovy'],
  ['gradle', 'groovy'],
  ['cmake', 'cmake'],
  ['docker', 'docker'],
  ['dockerfile', 'docker'],
  ['make', 'make'],
  ['mk', 'make'],
  ['nginx', 'nginx'],
  ['conf', 'nginx'],
  ['diff', 'diff'],
  ['patch', 'diff'],
  ['graphql', 'graphql'],
  ['gql', 'graphql'],
  ['viml', 'viml'],
  ['vim', 'viml'],
  ['zig', 'zig'],
  ['nim', 'nim'],
  ['nix', 'nix'],
  ['solidity', 'solidity'],
  ['sol', 'solidity'],
  ['vue', 'vue'],
  ['svelte', 'svelte'],
  ['astro', 'astro'],
  ['latex', 'latex'],
  ['tex', 'latex'],
  ['properties', 'properties'],
  ['json5', 'json5'],
  ['vb', 'vb'],
  ['coffeescript', 'coffeescript'],
  ['coffee', 'coffeescript'],
  ['reg', 'reg'],
  ['protobuf', 'protobuf'],
  ['proto', 'protobuf'],
  ['hcl', 'hcl'],
  ['terraform', 'terraform'],
  ['tf', 'terraform'],
  ['tfvars', 'terraform'],
  ['pascal', 'pascal'],
  ['pas', 'pascal'],
  ['http', 'http'],
  ['hy', 'hy'],
  ['elm', 'elm'],
  ['crystal', 'crystal'],
  ['cr', 'crystal'],
  ['fortran', 'fortran-free-form'],
  ['fortran-free-form', 'fortran-free-form'],
  ['f90', 'fortran-free-form'],
  ['f95', 'fortran-free-form'],
  ['f03', 'fortran-free-form'],
  ['f08', 'fortran-free-form'],
  ['cobol', 'cobol'],
  ['cob', 'cobol'],
  ['ada', 'ada'],
  ['adb', 'ada'],
  ['ads', 'ada'],
  ['haxe', 'haxe'],
  ['hx', 'haxe'],
  ['d', 'd'],
  ['dlang', 'd'],
  ['purescript', 'purescript'],
  ['purs', 'purescript'],
  ['gleam', 'gleam'],
  ['gdscript', 'gdscript'],
  ['gd', 'gdscript'],
  ['glsl', 'glsl'],
  ['vert', 'glsl'],
  ['frag', 'glsl'],
  ['hlsl', 'hlsl'],
  ['wgsl', 'wgsl'],
  ['wasm', 'wasm'],
  ['wat', 'wasm'],
  ['verilog', 'verilog'],
  ['v', 'v'],
  ['vlang', 'v'],
  ['vhdl', 'vhdl'],
  ['vhd', 'vhdl'],
  ['asm', 'asm'],
  ['assembly', 'asm'],
  ['nasm', 'asm'],
  ['prolog', 'prolog'],
  ['pro', 'prolog'],
  ['raku', 'raku'],
  ['perl6', 'raku'],
  ['tcl', 'tcl'],
  ['awk', 'awk'],
  ['bat', 'bat'],
  ['batch', 'bat'],
  ['just', 'just'],
  ['justfile', 'just'],
  ['cue', 'cue'],
  ['jsonnet', 'jsonnet'],
  ['prisma', 'prisma'],
  ['pug', 'pug'],
  ['jade', 'pug'],
  ['stylus', 'stylus'],
  ['styl', 'stylus'],
  ['sass', 'sass'],
  ['handlebars', 'handlebars'],
  ['hbs', 'handlebars'],
  ['twig', 'twig'],
  ['liquid', 'liquid'],
  ['razor', 'razor'],
  ['cshtml', 'razor'],
])

/** All token colors resolve through `--shiki-*` custom properties (theme package sheets). */
const cssVariablesTheme = createCssVariablesTheme({
  name: 'css-variables',
  variablePrefix: '--shiki-',
  fontStyle: true,
})

/**
 * The client regex engine compiles each TextMate pattern when its scanner is
 * created. Shiki otherwise defers patterns longer than 3,000 characters until
 * their first match; that compilation counts against Shiki's 500 ms per-line
 * budget and can return a partial token stream under host contention. Eager
 * compilation leaves the same budget in place for scanning user content.
 */
const regexEngine = createJavaScriptRegexEngine({
  forgiving: true,
  regexConstructor: pattern => defaultJavaScriptRegexConstructor(pattern, {
    lazyCompileLength: Number.POSITIVE_INFINITY,
  }),
})

let singleton: HighlighterCore | undefined

/** Representative paths through every boot grammar, compiled before user content is timed. */
const BOOT_GRAMMAR_WARMUPS = [
  { lang: 'typescript', code: 'const answer: number = 42' },
  { lang: 'shellscript', code: 'printf \'%s\\n\' "$HOME"' },
  { lang: 'json', code: '{"ready":true}' },
] as const

/** Construct and pre-tokenize the boot grammars outside the user-content scan budget. */
function createHighlighter(): HighlighterCore {
  const instance = createHighlighterCoreSync({
    themes: [cssVariablesTheme],
    langs: LANGS,
    engine: regexEngine,
  })
  for (const sample of BOOT_GRAMMAR_WARMUPS) {
    instance.codeToTokens(sample.code, {
      lang: sample.lang,
      theme: 'css-variables',
      tokenizeTimeLimit: 0,
    })
  }
  return instance
}

/** The synchronous highlighter (one instance per document); pre-warmed below, lazy as the fallback. */
function highlighter(): HighlighterCore {
  singleton ??= createHighlighter()
  return singleton
}

/** Grammar ids whose lazy import is in flight or done, so it is requested once. */
const requested = new Set<string>()
/** Subscribers re-rendered after a lazy grammar registers (React callers). */
const listeners = new Set<() => void>()
/** Bumped on each lazy-grammar load; the `useSyncExternalStore` snapshot. */
let loadCount = 0

/**
 * Subscribe to lazy-grammar load completions; `listener` fires after a
 * {@link LAZY_GRAMMARS} grammar finishes registering on the singleton, so a
 * caller that rendered its plain fallback while the grammar loaded can
 * re-highlight. Uses the `useSyncExternalStore` subscribe signature; pair it with
 * {@link grammarLoadCount} as the snapshot. Returns an unsubscribe function.
 * @param listener - invoked (no args) on each grammar-load completion.
 * @returns a disposer that removes the listener.
 */
export function subscribeGrammarLoaded(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/**
 * The lazy-grammar load counter — a value that changes on every load, so a
 * `useSyncExternalStore` snapshot re-renders the subscriber when a grammar
 * registers. Opaque: only its identity across renders matters.
 * @returns the current load count.
 */
export function grammarLoadCount(): number {
  return loadCount
}

/**
 * Ensure the grammar `resolved` names is registered. A boot grammar (not in
 * {@link LAZY_GRAMMARS}) and an already-loaded lazy grammar report ready
 * synchronously; a lazy grammar not yet loaded starts its import (once) and
 * reports not-ready, so the caller renders plain until a
 * {@link subscribeGrammarLoaded} listener fires.
 * @param resolved - the grammar id an alias resolved to.
 * @returns whether the grammar is registered and ready to tokenize now.
 */
function ensureGrammar(resolved: string): boolean {
  const special = SPECIAL_GRAMMARS.get(resolved)
  if (special !== undefined) {
    if (!highlighter().getLoadedLanguages().includes(resolved)) highlighter().loadLanguageSync(special)
    return true
  }
  const load = LAZY_GRAMMARS.get(resolved)
  // A boot grammar (already registered) has no lazy loader; it is always ready.
  if (load === undefined) return true
  if (highlighter().getLoadedLanguages().includes(resolved)) return true
  if (!requested.has(resolved)) {
    requested.add(resolved)
    void load().then((mod) => {
      highlighter().loadLanguageSync(mod.default)
      loadCount += 1
      for (const listener of listeners) listener()
    })
  }
  return false
}

// Engine + grammar construction costs a long task (~120-175ms); building it
// during the first finalized fence's render would jank exactly when a stream
// completes. Warm the singleton in a deferred task at module load (= plugin
// boot) instead; the lazy path above stays as the correctness fallback for a
// fence that renders before the timer fires. `unref` (Node-only) keeps a
// non-browser import from pinning the event loop.
const warmupTimer = setTimeout(() => { highlighter() }, 0)
;(warmupTimer as { unref?: () => void }).unref?.()

/**
 * Highlight `code` into shiki's HTML (a single `<pre class="shiki">` tree)
 * when `lang` maps to a registered grammar; `undefined` means the caller
 * renders its plain fallback. A lazy grammar not yet loaded returns `undefined`
 * for this call and loads in the background; subscribe with
 * {@link onGrammarLoaded} to re-highlight once it registers.
 * @param code - the source text.
 * @param lang - the language hint (a markdown fence info string or a fixed caller id).
 * @returns the highlighted HTML, or `undefined` for unknown or not-yet-loaded languages.
 */
export function highlightToHtml(code: string, lang: string | undefined): string | undefined {
  const resolved = lang === undefined ? undefined : LANG_ALIASES.get(lang.toLowerCase())
  if (resolved === undefined) return undefined
  if (!ensureGrammar(resolved)) return undefined
  return highlighter().codeToHtml(code, { lang: resolved, theme: 'css-variables' })
}

/**
 * One highlighted run of a line: the text and the inline style shiki assigned
 * it. The css-variables theme colors every run through a `--shiki-*` custom
 * property, so `style.color` is always present; it is held as a style object
 * rather than a bare color so a run spreads onto a `<span style>` uniformly.
 */
export interface HighlightSpan {
  text: string
  style: CSSProperties
}

/**
 * Tokenize `code` into per-line highlighted runs when `lang` maps to a
 * registered grammar; `undefined` means the caller renders its plain fallback.
 * A line-numbered view needs the token runs split per line (one gutter number
 * per line), which the single-`<pre>` {@link highlightToHtml} does not expose,
 * so this returns shiki's own 2D line/token structure narrowed to what a run
 * renders. Each run's color is a `--shiki-*` custom property, keeping token
 * colors on the theme package's sheets exactly as the HTML path does; the
 * css-variables theme carries no font-style bits, matching that path's
 * color-only output. The trailing newline shiki appends as a final empty line
 * is dropped so the run count matches the caller's own line array.
 * @param code - the source text.
 * @param lang - the language hint (a file-extension-derived language id).
 * @returns one entry per source line (each an array of runs), or `undefined` for unknown or not-yet-loaded languages.
 */
export function highlightLines(code: string, lang: string | undefined): HighlightSpan[][] | undefined {
  const resolved = lang === undefined ? undefined : LANG_ALIASES.get(lang.toLowerCase())
  if (resolved === undefined) return undefined
  if (!ensureGrammar(resolved)) return undefined
  const { tokens } = highlighter().codeToTokens(code, { lang: resolved, theme: 'css-variables' })
  // shiki tokenizes `a\nb` into two lines; a trailing newline (`a\n`) adds a
  // third, empty line the caller's own line array does not carry. Drop that
  // one terminator line so the two structures stay in step. The explicit
  // `last !== undefined` (over `tokens[...]?.length`) keeps a single branch for
  // per-file coverage, matching TerminalBlock's terminator check.
  const last = tokens[tokens.length - 1]
  const lines = tokens.length > 1 && last !== undefined && last.length === 0
    ? tokens.slice(0, -1)
    : tokens
  return lines.map(line => line.map(token => ({ text: token.content, style: { color: token.color } })))
}
