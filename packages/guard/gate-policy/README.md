# @deepseek-ai/dsh-gate-policy

English | [中文](README.zh.md)

A deny-with-question gate on the tool-execution path. Each configured rule
pairs a trigger (tool-name patterns plus anchored regexes over the call's
`command` argument) with a checklist. When a call matches, the gate denies it
and the checklist becomes the denial reason — the model reads it as the tool
result, performs the checks, states their outcome, and retries the same call.
A gate never approves anything; it can only block a call until the checks are
stated. Decision record: [the guidebook-gates-and-recipes Agent Note](../../../.agents/notes/proposed/feature/2026-09-13-guidebook-gates-and-recipes.md).

The plugin ships mechanism only. Which actions gate, and what the checklist
demands, are deployment policy in `cordis.yml` — nothing is hardcoded.

## Config

```yaml
- id: gate-policy
  name: '@deepseek-ai/dsh-gate-policy'
  config:
    rules:
      - name: push-gate
        tools: [bash]                  # default; *-wildcard tool-name patterns
        commandPatterns: ['git\s+push(?!.*--dry-run)']
        checklist: |-
          - Run the test suite and show it passing
          - Re-state what is being pushed and why
```

`rules` defaults to `[]` — a deployment without rules gates nothing. Rule
fields:

| Field | Meaning |
|---|---|
| `name` | Required, non-empty. Quoted in the denial so the transcript names the gate. |
| `tools` | `*`-wildcard patterns over the tool name; default `['bash']`. |
| `commandPatterns` | Anchored regex sources tested against the `command` string argument. First matching rule denies. |
| `checklist` | Required, non-empty. The checks the model must perform before retrying. |

Misconfiguration fails loud at plugin load: an invalid regex, an empty rule
name, or an empty checklist throws. A call without a string `command`
argument never matches — gates key on shell command text, not argument
shapes.

## Model Experience

Gated calls add one denied tool result (`Error: Gate '<name>' blocked this
call. … retry this exact call.`), typically followed by the check outputs and
a successful retry — a bounded, one-time cost per gated action. Ungated calls
are untouched: the guard returns `undefined` and no text, state, or latency
is added.

## Known Limitations and Deferred Work

- Triggers match the literal command text; a determined model could evade a
  gate by wrapping the action (e.g. `bash -c` inside another tool, a script
  file). Verified gates that execute the check themselves are deferred; the
  current enforcement relies on the model stating its checks in-transcript.
- Only the `command` argument is inspected; tools whose dangerous arguments
  live elsewhere need their own gate surface.
