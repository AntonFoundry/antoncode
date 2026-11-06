---
description: "Configure working-economy guidance while retaining plan-first and plugin-ownership instructions."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-efficiency-discipline

English

## Summary

Enable or disable working-economy guidance from General settings. The guidance encourages targeted reads, concise reporting, and completing work without reducing scope to conserve tokens. Plan-first ordering and plugin-ownership instructions remain active regardless of the switch. The preference is durable and updates the Host prompt contribution.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

## Use this package

Use the Efficiency discipline row in General settings. Its `efficiencyDiscipline` preference defaults to `true`; the [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-client-ui-efficiency-discipline) owns the accepted schema. The Host namespace is `tools-discipline`.

## Understand the implementation

The Host registers `tools:working-discipline` at order 97. It joins the plan-first text, the optional working-economy text, and the plugin-ownership text. The browser uses the shared configuration form, a viewing-state store, and localized row copy; it suppresses a duplicate generated settings page.

## Model Experience

### Working-discipline instructions

#### What the model sees

The `tools:working-discipline` system-prompt section contains the three package-owned fragments below in order. Disabling `efficiencyDiscipline` removes only Working economy.

##### Plan-first ordering

```markdown
Working discipline: for any multi-step work — a feature, an investigation, a bug fix, a diagnosis, any task with more than one step — the order is fixed: plan first, record the plan, then write the todo tree, then execute. Step 1: analyze the request and form the plan before any tool work. Step 2: when the work is non-trivial — 3 or more tasks, multi-phase, cross-package, or architectural — record the plan with plan_write BEFORE writing the todo tree; deployments may deny execution tools until a plan exists for trees this large. Delegating codebase exploration to a subagent to draft the plan is preferred while delegation works, but the plan never waits on it: if the subagent fails or is unavailable, author the plan from current knowledge, record it with plan_write, and proceed inline — never stall on a failed delegation. Step 3: only then write the todo tree with todo_write and execute against it, updating statuses as you go (mark a node completed the moment it is done). Smaller work may go straight to the tree. The tree is a general-purpose nested plan, not a feature-implementation ritual: investigations and debugging get one too. Only a genuinely trivial single-step request may skip it. A long phased plan encodes EVERY phase and sub-task in the tree up front — including low-priority, optional, and deferred items (leave them pending and set their priority); nothing stays off the tree, and a partial tree is never the plan. When later phases or follow-ups remain, leave them pending on the tree rather than reporting everything completed. The recorded plan is the standing implementation plan in force across turns; refine it there as understanding improves.
```

##### Working economy

```markdown
Working economy: context is managed automatically (eviction at a high watermark); you will not run out, and you never need to check or conserve capacity. Economy means latency and precision, not survival: the cheap tool first: grep or ripgrep before reading files, a targeted read with offset and limit before a whole file, one batched command before several round-trips, the smallest output that answers the question. Lean prose: never restate the task or the user's words back, no filler transitions, summarize findings instead of echoing transcripts. Never truncate, defer, or shrink work to save tokens: if a task needs a large action, do it in full on the first try.
```

##### Plugin ownership

```markdown
Plugin and package decisions: before creating a new plugin or package, NAME the capability seam it would own — a service other consumers depend on, a tool surface, its own state lifetime, its own wire or protocol vocabulary, or independently evolvable providers. If you can name the seam, the plugin is justified. If you cannot — if the change is a presentation detail of a surface that already exists (rendering, chrome, labels inside an existing view or shared engine) — extend that surface's shared layer instead and add zero new packages. When the user asks for a visible behavior change, prefer the smallest existing extension point that reaches the surface. Precedents: diagram rendering extended the shared markdown engine rather than becoming a chat plugin, while the agent window-manager board was a real plugin because it owns slots, layout state, and injected faces.
```

#### Token effect

The section adds its rendered text to requests where registered. Disabling the preference removes the working-economy fragment but retains the other two.

#### KV Cache effect

The section is stable while text and preference are unchanged. Changing the preference changes system-prompt content; the agent loop and provider update mode determine prefix reuse.

## Known Limitations and Deferred Work

- The switch controls prompt guidance, not execution enforcement; deployment tool guards own denial policy.
- Plan-first and plugin-ownership instructions cannot be disabled through this preference.
- The browser row requires the matching Host namespace and shared configuration form.

### Dev Note

None.
