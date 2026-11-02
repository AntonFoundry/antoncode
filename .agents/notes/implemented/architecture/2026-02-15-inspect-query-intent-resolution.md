# Inspect query misses resolve intent before failing

2026-02-15 · `tool-cordis` / `cordis-host-runner`

## Context

A live session burned four failed `cordis_inspect_query` round trips on invented
provider ids (`"host"`, `"slots"`) and a qualified method name
(`Builtin.listBuiltins`). Each miss carried a resolvable intent — the registry
just rejected it without the directory the miss was reaching for.

## Decision

The strict exact-string gate stays the contract, but a miss now resolves before
failing, inside the registry (`CordisInspectRegistryService`):

1. Case-insensitive provider match; `Provider.method` qualified names strip to
   the bare method (the provider is already selected separately).
2. Unresolvable provider misses fail with the platform directory plus any
   cross-platform hit, so the model self-corrects in one hop.
3. Unresolvable method misses fail with the declared method list.

Client queries dispatch the resolved provider id and bare method name, so the
browser-side exact-match registry is unchanged. Ambiguity beyond these
deterministic signals still routes through the normal loop (model reads the
directory-bearing error) and, for user-facing doubt, `userQuestions` — not an
LLM resolver inside the read-only inspect path. Real-time capability building
remains the separate `cordis_define` → approval → `cordis_run` seam.

## Consequences

- Qualified method names and case slips succeed outright; genuine misses cost
  one round trip instead of a guess-and-fail ladder.
- Error text is model-visible: pinned by snapshot discipline wherever the full
  transcript is asserted.
