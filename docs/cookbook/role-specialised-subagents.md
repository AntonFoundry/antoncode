# Role-specialised subagents (a team of agents, not N generalists)

How to make delegation **reliable** and **differentiated**: reliable so the
orchestrator actually decomposes work instead of doing everything inline, and
differentiated so each child holds only the tools its role needs.

No TypeScript required — both levers are composition (`cordis.yml`) config on
`@deepseek-ai/dsh-tool-subagent`. Shipped example:
`apps/cli/config/agent-presets/code/agent.cordis.yml`.

---

## Lever 1 — `backgroundMode: continuable` makes delegation the default

This one is easy to get wrong because the failure is **silent**.

`tool-subagent` registers its standing delegation directive as a
system-prompt section, but only under a condition
(`packages/subagent/tool-subagent/src/index.ts`):

```ts
const backgroundEnabled = config.enableRunInBackground !== false
const continuable = (config.backgroundMode ?? 'one-shot') === 'continuable'
...
if (backgroundEnabled && continuable) {
  ctx.systemPrompt.section({
    name: `tool:${toolName}`,
    text: context => ... 'Delegation is the DEFAULT for decomposable work: ...'
  })
}
```

`backgroundMode` **defaults to `'one-shot'`**, so `continuable` is false and
**the section is never injected**. The consequence is subtle: the tool still
exists and still works, so nothing errors — but nothing pushes the
orchestrator to decompose, so fan-out quietly stops happening. Two
compositions can behave completely differently with no visible difference
except this one key.

The section is also re-evaluated per render and returns `''` when the tool is
absent from scope, so a filtered-away tool removes its own directive too.

**Set `backgroundMode: continuable` on every delegation row you want the
orchestrator to reach for.** The shipped `code`, `cordis` and `standard`
presets all do; `minimal` mounts no delegation at all by design.

> Out-of-process providers (`codex`, `claude-code`) do not support
> `continuable` — mounting them that way fails loud at startup
> (`tool-subagent: provider "X" does not support backgroundMode: continuable`).
> Leave those rows `one-shot`.

---

## Lever 2 — `persona` + `toolFilter` give each role its own shape

Both are already plumbed. `Config` accepts them, the `spawn` and `fork`
providers declare `{ toolFilter: true, persona: true }`, and
`applyChildComposition` applies them per child:

```ts
childCtx.get('agentPresets')?.composeFrom(childCtx, parent.ctx)  // inherit parent's composition
childCtx.systemPrompt.context({ name: 'subagent:delegation', ... })
if (composition.persona !== undefined) {
  childCtx.systemPrompt.section({ name: 'deployment:persona', order: 0, text: composition.persona })
}
if (composition.toolFilter !== undefined) childCtx.tools.restrict(composition.toolFilter)
```

Two properties matter:

- **Scoped.** A child's persona and filter are owned by its own scope —
  invisible to its parent and to its siblings.
- **Monotonic.** `toolFilter` *intersects* the chain it inherits, so a role can
  only ever hold **fewer** tools than its parent, never more. Roles cannot be
  used to widen privilege.

### Define a role by mounting the plugin again

Each role is another row with its own `toolName`:

```yaml
- id: tool-subagent-analyst
  name: '@deepseek-ai/dsh-tool-subagent'
  config:
    provider: spawn
    toolName: subagent_analyst
    backgroundMode: continuable
    persona: >-
      You are an ANALYST subagent. Investigate and report, never change the
      tree... answer with findings and exact references so the delegating
      agent can verify every claim without redoing your work.
    toolFilter:
      deny: [write, edit, bash]
```

### Prefer `deny` over `allow`

`allow` is a whitelist — *everything* not listed is removed, including
infrastructure the child needs to report at all (todo/plan tools, reporting
tools). It is also brittle: **every name in a filter must resolve or startup
fails**, so a whitelist breaks whenever the tool set shifts.

Denying the specific mutation verbs is the narrow, robust cut. Verified global
names include `read`, `write`, `edit`, `read_image`, `glob`, `grep`, `bash`.

---

## The three roles shipped in the `code` preset

| role | tool filter | why |
|---|---|---|
| `subagent_analyst` | `deny: [write, edit, bash]` | structurally cannot mutate; for audits, surveys, "which of these N" — the breadth-first work that fans out cleanly |
| `subagent_implementer` | *(none)* | full toolset; the persona pins it to an explicit spec and demands a verifiable artifact rather than a claim |
| `subagent_verifier` | `deny: [write, edit]` | can run anything, can change nothing |

The generalist `subagent` / `subagent_fork` rows are kept alongside these, so
adding roles regresses nothing.

### Why `verifier` is the important one

A verifier that holds **no write or edit tool** cannot adjust the code or the
test to make them agree. That independence catches the specific failure where
a fix passes its own narrow check and is still wrong.

This is not hypothetical. During the Janet `lanes=8` investigation, two
separate fix attempts **passed their stated verification** — the first was
20/20 clean at N=5000 — and both were still wrong, caught only by widening to
N=20000. A subagent reporting *"fixed, 20/20 green"* would have been believed.
The verifier persona therefore says explicitly: re-run the checks yourself
rather than trusting the claim, test the boundary and the larger case, and a
narrow green result is not a pass.

---

## Choosing what to delegate

The directive delegates *decomposable* work; it does not force fan-out onto a
dependency chain, and should not. The useful split:

| delegate freely | keep inline |
|---|---|
| "read these 12 suites, report which fail and how" | "decide whether this fix is correct" |
| "find every call site of X" | "falsify this hypothesis" |
| "write this file to this spec" | "judge whether the spec is right" |
| "run this battery, report results" | accepting *"tests pass"* as proof |

The rule of thumb: **delegate work whose output is independently checkable
without re-deriving it.** A diff, a file path, a command plus its real output —
all cheap to verify. A conclusion is not.

A corollary worth stating: fan-out does not by itself protect the orchestrator's
context. It replaces raw work with *summaries*, which is better but not free —
integrating many reports costs context too. Ask children for references and
artifacts, not prose.

---

## Verifying a preset edit

A plain `js-yaml` load **will fail** on these files — they carry `!!js` tags
(e.g. `disabled: !!js process.platform === 'win32'`). That is pre-existing and
by design. Validate with the loader's own dialect instead:

```js
import { load } from 'js-yaml'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
const rows = load(readFileSync(preset, 'utf8'), { schema: entryListSchema })
```

Run the script from inside the repo so workspace imports resolve. Then the
relevant gates:

```sh
npx vitest run packages/preset/agent-presets/tests/   # mount, invariant, authoring, discovery
npx vitest run packages/subagent/tool-subagent/tests/  # config validation, capability assertions
```

Both must stay green; a preset edit should not need a plugin rebuild.
