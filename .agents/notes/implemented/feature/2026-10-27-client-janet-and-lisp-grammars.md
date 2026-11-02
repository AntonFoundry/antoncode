# Client syntax highlighting covers Janet and the Lisp family

Status: implemented

English

## Problem

The shared client highlighter (`ui-primitives` `markdown/highlight.ts`) loaded an explicit grammar allowlist. A fenced `janet` block had no entry, so a Janet snippet — a Lisp dialect whose syntax is close to Scheme and Clojure — rendered as plain monospace text while `lisp`, `clojure`, and `scheme` fences highlighted. `common-lisp`, `emacs-lisp`, and `fennel` were available in `@shikijs/langs` but also absent from the allowlist, and neither `langFromPath` (read cards) nor `viewerLanguageFor` (file viewer) mapped the Lisp-family file extensions.

## Decision

`ui-primitives` owns a local TextMate grammar for Janet (`markdown/janet-grammar.ts`, built by the shared `markdown/lisp-dialect-grammar.ts`) because `@shikijs/langs` ships no Janet grammar; [Bender's grammar](2026-10-31-client-bender-grammar.md) reuses that builder. It registers synchronously through `SPECIAL_GRAMMARS` on first use, so the first `janet` render is highlighted rather than the plain fallback; the boot grammar set stays unchanged. The grammar colors comments, double-quoted and backtick (long) strings, buffers (`@"…"`, `` @`…` ``), numbers, keyword literals (`:name`), `nil`/`true`/`false`, special forms, core and namespaced functions, operators, delimiters, and quote punctuation.

The lazy allowlist also gains the Lisp-family grammars upstream ships (`common-lisp`, which also serves the `lisp` alias, `emacs-lisp`, `fennel`, `hy`) plus a curated batch of common languages the harness omitted: Elm, Crystal, Fortran, COBOL, Ada, Haxe, D, PureScript, Gleam, GDScript, GLSL, HLSL, WGSL, WebAssembly, Verilog, V, VHDL, assembly, Prolog, Raku, Tcl, Awk, Batch, Just, CUE, Jsonnet, Prisma, Pug, Stylus, Sass, Handlebars, Twig, Liquid, and Razor. Aliases accept `lisp`/`lsp`/`cl`, `elisp`/`el`, `fnl`, `janet`, and the natural fence label of each added grammar. `langFromPath` and `viewerLanguageFor` map the matching file extensions to those ids.

## Alternatives considered

**Alias `janet` to the Scheme or Lisp grammar.** Rejected: Janet has its own keywords, long strings, buffer literals, and keyword literals; aliasing would mis-color them and hide the real gap. A local grammar is small and testable.

**Load Janet at boot.** Rejected: the boot set is deliberately three grammars every session renders. A synchronous first-use registration gives the same no-flicker behavior without adding boot cost to sessions that never show Janet.

**Add every missing language.** Rejected as scope creep. This change covers the reported Janet case, the adjacent Lisp family that shares the same gap, and a curated set of mainstream languages whose absence users run into. The highlighter still imports grammars lazily, so the wider allowlist costs nothing until a language renders.

## Consequences

Janet fences and `.janet` reads/files now highlight on the first render. The Lisp family renders with its own grammars where upstream provides one, and the added languages stop falling back to plain text. The local Janet grammar is maintained in-tree and must be extended when its syntax grows; it is approximately as complete as the upstream Scheme grammar, not a parser.

## Testing

`code-block.client.spec.tsx` asserts a Janet snippet highlights synchronously with comment, string, keyword, and function token colors, and that the fence label is case-insensitive; it also drives the three new lazy grammars. `file-view.client.spec.ts` and `read-render.spec.ts` pin the new extension mappings.
