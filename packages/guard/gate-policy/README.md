---
description: "Apply deployment-configured tool-call checklists, confirmations, and plan-first requirements."
kind: "package-reference"
---

# @deepseek-ai/dsh-gate-policy

## Summary

Block tool calls that match deployment-configured command rules and return the checklist required before retrying. Rules can instead require human approval through the shared approval pipeline. An optional plan gate requires a todo tree and, above a configured size, a recorded implementation plan. Empty rules leave command calls ungated.

## Table of Contents

- [Understand the implementation](#understand-the-implementation)
- [Config](#config)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

## Understand the implementation

A deny-with-question gate on the tool-execution path. Each configured rule pairs a trigger (tool-name patterns plus regexes over its selected command scope) with a checklist. When a call matches, the gate denies it and the checklist becomes the denial reason — the model reads it as the tool result, performs the checks, states their outcome, and retries the same call. A gate never approves anything; it can only block a call until the checks are stated. Decision record: [the guidebook-gates-and-recipes Agent Note](../../../.agents/notes/proposed/feature/2026-09-13-guidebook-gates-and-recipes.md).

The plugin ships mechanism only. Which actions gate, and what the checklist demands, are deployment policy in `cordis.yml` — nothing is hardcoded.

## Config

```yaml
- id: gate-policy name: '@deepseek-ai/dsh-gate-policy' config: rules: - name: push-gate tools: [bash]                  # default; *-wildcard tool-name patterns commandPatterns: ['git\s+push(?!.*--dry-run)'] checklist: |- - Run the test suite and show it passing - Re-state what is being pushed and why
```

`rules` defaults to `[]` — a deployment without rules gates nothing. Rule fields:

| Field | Meaning |
|---|---|
| `name` | Required, non-empty. Quoted in the denial so the transcript names the gate. |
| `tools` | `*`-wildcard patterns over the tool name; default `['bash']`. |
| `commandPatterns` | Regex sources tested against the selected command scope. First matching rule denies. |
| `commandScope` | `raw` (default) tests the complete `command` string unchanged. `shellCommands` anchors each pattern at each normalized executable command; unsupported syntax retains raw checks. |
| `checklist` | Required, non-empty. The checks the model must perform before retrying. |

### Shell command matching (opt-in)

Set `commandScope: shellCommands` only on rules intended to match executable commands rather than literal text. Patterns are implicitly anchored at the executable start; for example, `npm\s+publish\b` matches `cd repo && npm publish`, quoted executable/subcommand words, absolute executable paths, literal `env`/`sudo`/`command`/`exec` wrappers, and nested `bash -c` scripts. It does not match `grep publish package.json`, commit messages, or source paths. Multiword quoted operands retain their separation and do not become executable subcommands. Quoted `cat`/`tee` heredocs are data; unquoted or executable heredocs retain raw checks.

Simple `$NAME` and `${NAME}` references are accepted only in leading shell assignments or `export NAME=value` operands; the classifier never reads their values. Executable-variable references and other expansions retain raw checks. Unsupported shell constructs, substitutions, malformed quoting, unknown executables, opaque interpreter scripts, and excessive nested shells retain the original raw regex checks. This conservative fallback can still gate a Python or Node source-editing script that contains deployment text. Use direct file-edit tools for such source edits; do not treat this classifier as a security sandbox or assume that it resolves aliases, scripts, variables, or arbitrary program behavior. Existing raw rules, checklists, confirmations, and rule order are unchanged. Enabling this scope requires the updated plugin code and an explicit deployment-policy edit; a source change alone does not alter installed profile rules.

### Guidebook verdicts (opt-in)

The guard is synchronous, so c0ntext guidebook recipes are pre-fetched into an in-memory cache and refreshed on an interval. When enabled and a matching rule denies, the denial appends a `Guidebook` section listing stored recipes whose `intent` shares at least one token (lowercased, length ≥ 3) with the rule name or the checklist — a deterministic narrowing, no scoring. An empty cache, a disabled flag, or a failed refresh leaves the denial unchanged; fetch failures are logged and swallowed so telemetry never costs a run.

```yaml
config: verdictsEnabled: true verdictsEndpoint: http://127.0.0.1:8090
  # verdictsApiKey: ctx_…            # or env ANTON_CONTEXT_API_KEY
  # verdictsTimeoutMs: 4000
  # verdictsRefreshMs: 300000
```

| Field | Meaning |
|---|---|
| `verdictsEnabled` | Defaults to `false` — opt-in, never shipped on. |
| `verdictsEndpoint` | Base URL of the c0ntext worker; empty keeps verdicts inert. |
| `verdictsApiKey` / `verdictsApiKeyEnv` | API key sent as `X-API-Key`; env override wins, default env `ANTON_CONTEXT_API_KEY`. |
| `verdictsTimeoutMs` | Per-request timeout for `GET /recipes/list`; default `4000`. |
| `verdictsRefreshMs` | Cache refresh interval; default `300000`. The timer is disposed with the plugin fiber. |

### Todo-plan gate (opt-in)

A second guard enforcing the plan-first discipline: while the calling session's log carries no `todo/write` event, the gated tools are denied with a teaching denial ("Call todo_write with your plan …, then retry"). Furthermore, when the todo tree contains `minTodosForImplementationPlan` (default `3`) or more items (counting top-level items and nested children), mutation tools are blocked until an implementation plan is recorded via `plan_write` or an approved `exit_plan_mode`. The denial teaches the plan-before-tree order: record the plan via `plan_write` before the tree grows past the threshold — delegating reconnaissance to a `subagent` to draft it while delegation works, and authoring it inline from current knowledge when delegation fails — so a failed delegation never stalls the session on the gate. `todo_write`, `plan_write`, and `subagent` are never gated. The three facts the gate needs — whether a todo tree exists, how large it is, and whether an implementation plan was recorded — come from a host-only session projection this package owns and registers before any guard, so the synchronous guard never folds the log itself and its state stays fixed-size however long the log grows. A call carrying no session cannot be evaluated and passes: a discipline nudge must never break execution.

A rule marked `confirm` is settled in the `tools/pre-execute` waterfall, which may await, by returning an `ask` decision that hands the choice to the shared approval pipeline; the synchronous guard passes such a match through untouched. Plain rules deny in the guard, where nothing needs awaiting. The plan gate's knobs live in this plugin's own `Config`, so a Settings edit reloads the entry and re-applies the plugin rather than feeding a second live settings source.

```yaml
config:
  todoPlanGate:
    enabled: true                      # default false
    tools: [bash, edit, write, multiedit]  # default; *-wildcard patterns
    requireImplementationPlan: true    # default true
    minTodosForImplementationPlan: 3   # default 3
```

| Field | Meaning |
|---|---|
| `enabled` | Defaults to `false` — opt-in, never shipped on. |
| `tools` | `*`-wildcard patterns over the tool name; default the write-side tools. `todo_write`, `plan_write`, and `subagent` are always exempt. |
| `requireImplementationPlan` | Require an implementation plan when the todo tree is large; default `true`. |
| `minTodosForImplementationPlan` | Total todos threshold to require an implementation plan; default `3`. |

Misconfiguration fails loud at plugin load: an invalid regex, an empty rule name, or an empty checklist throws. A call without a string `command` argument never matches — gates key on shell command text, not argument shapes.

## Model Experience

### Tool-call denials

#### What the model sees

A matched plain rule returns `Gate '<name>' blocked this call` followed by its configured checklist and retry instruction. Optional cached guidebook matches append recipe guidance. A confirm rule asks through the approval pipeline; denied approval or approval failure returns the checklist denial. The optional todo-plan gate returns a teaching denial until the required logged planning facts exist.

#### Token effect

Denied results and any subsequent checks/retry add transcript tokens. Ungated calls add no model-facing text. Checklist and recipe lengths depend on deployment configuration.

#### KV Cache effect

Denials append after the existing request history. Changing a rule does not add schemas or rewrite an earlier request prefix; a later denial has variable suffix content.

## Known Limitations and Deferred Work

- Triggers match the literal command text; a determined model could evade a gate by wrapping the action (e.g. `bash -c` inside another tool, a script file). Verified gates that execute the check themselves are deferred; the current enforcement relies on the model stating its checks in-transcript.
- Only the `command` argument is inspected; tools whose dangerous arguments live elsewhere need their own gate surface.
- Guidebook matching is deliberately naive token overlap between the gate text and recipe intents: it may miss relevant recipes (synonyms) or surface loose ones (shared generic words). Relevance ranking belongs to the c0ntext engine; the guard only narrows its cached inventory.

### Dev Note

- See the module JSDoc for the owning contract and its rationale.
