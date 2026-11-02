# Agent Note: Client syntax highlighting covers Bender, the Janet fork

Status: implemented

## Problem

The client highlighter defined Janet's TextMate grammar in-tree (`ui-primitives` `markdown/janet-grammar.ts`) because `@shikijs/langs` ships none. Bender, maintained as a fork of Janet, keeps Janet's reader syntax and vocabulary while adding its own control forms and replacing the `.janet` extension with `.ben`. A `.ben` read card or a fenced `bender` block therefore rendered as plain monospace text, even though the fork ships its own generated TextMate grammar (`grammar/syntaxes/bender.tmLanguage.json`) whose token classes are identical to Janet's apart from the words and the separately colored `:hint` contract keyword.

## Decision

`ui-primitives` owns the shared rule set once, in `markdown/lisp-dialect-grammar.ts`: `createLispDialectGrammar` builds a registration from a dialect's id, display name, file types, special forms, core functions, and optional separately scoped keyword literals. The comment, string and buffer, number, keyword, constant, operator, delimiter, and quote rules are dialect-independent because the syntax is; only the vocabulary and the scope suffix (`source.<id>`, `keyword.control.<id>`, …) vary. `markdown/janet-grammar.ts` and `markdown/bender-grammar.ts` supply those two dialects, and both register synchronously through `SPECIAL_GRAMMARS` on first use, so either first render is highlighted rather than showing the plain fallback; the boot grammar set stays unchanged.

Bender's word lists come from the fork's own generated grammar: its special forms and control macros (including the reactor `ev/*`, FFI `ffi/*`, and process `proc/*` forms) read as control keywords, and non-namespaced core bindings read as functions, with every remaining `namespace/name` binding covered by the shared namespaced pattern. The fork's source-text twist is the `{:hint …}` declaration contract, so `:hint` carries `keyword.other.hint.bender` — the keyword color — while other keyword literals keep `constant.language.keyword.bender`. Fence aliases accept `bender` and `ben`; `langFromPath` (read cards) and `viewerLanguageFor` (file viewer) map the `.ben` extension to the `bender` id.

## Alternatives considered

**Copy Janet's grammar into a Bender file with renamed scopes.** Rejected: the two rule sets are identical by construction, so a second copy is a clone with a handful of substituted strings; the extraction costs one indirection and keeps a fork's syntax change a single edit.

**Alias `ben` to the `janet` grammar.** Rejected: it highlights with Janet's vocabulary and scope names, so Bender's added control forms fall to the ordinary symbol color, `:hint` loses its contract distinction, and a `.ben` snippet reports Janet scopes to any consumer that inspects them.

**Use the upstream Bender grammar verbatim.** Rejected: `@shikijs/langs` loads JavaScript modules, not generated JSON, and the generated support-function alternation carries several hundred names, most of them namespaced bindings the shared `namespace/name` pattern already matches. The curated list keeps the first render synchronous and the bundle small.

## Consequences

A new Janet-family dialect now costs one vocabulary file; the shared rules stay single-sourced. Bender's token colors are the fork's own taxonomy, so a change to its core vocabulary needs a matching update here rather than automatic regeneration. The `.benx` compiled image is deliberately not mapped: it is a marshalled VM image, not source.

## Testing

`code-block.client.spec.tsx` asserts a Bender snippet highlights synchronously with comment, string, function, and keyword tokens, that `:hint` renders with the keyword color where `:params` renders with the constant color, and that the `ben` alias is case-insensitive. `read-render.spec.ts` and `file-view.client.spec.ts` pin the `.ben` extension mapping in both callers. The existing Janet assertions cover the extracted rule set on the original dialect.
