# INVALID_ARGS sibling-tool hint

## Context

A roadrash session repeatedly called `bash` with another tool's argument
payload (`grep`'s `{path, pattern}`, `read_image`'s `{file_path}`), burning
turns on `INVALID_ARGS` denials and "fixing tool usage" recovery loops. Under
`paged` presentation the model sees one-line catalog summaries until a
`tool_search` grant lands, so the always-granted transport is the path of
least resistance when the model half-remembers a sibling's arguments.

## Change

`toolsMatchingArgumentKeys` (dsh-tools schema.ts) is a pure matcher: a
candidate matches when its required properties are all supplied and every
supplied key is a declared property. `hintedToolArgsError` (dsh-tools
index.ts) runs it when a `ToolArgsError`'s violations only name missing
required properties; a unique (or few) match appends a corrective hint naming
the tool to retry with. No match leaves the error byte-identical.

## Design constraints discovered

The hint must be a module-level pure function, not a class method: the
ToolRuntime instance is a Cordis service Proxy, and passing a hostile thrown
value through any `this.method(value, …)` boundary lets proxy-side
instrumentation property-get the value, throwing the trap error out of the
containing catch and breaking hostile-value normalization (the
`normalizes a hostile thrown value…` spec caught this). The sibling view is
resolved before the call; the thrown value never crosses a method boundary.

## Model-visible effect

`Error: invalid arguments: missing required property "command"; missing
required property "description"; the supplied properties (path, pattern)
match tool "grep" — retry with that tool and the same arguments`

Recovery is one round-trip instead of a confusion loop; execution is never
rerouted — the named tool still requires its own call, so approvals and
guards keep binding to the tool the model actually names.
