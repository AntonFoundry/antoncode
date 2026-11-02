---
description: "Shared messaging, interruption, model reassignment, and child discovery tools for users and maintainers composing or debugging continuable-child control."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-subagent-control

English

## Summary

`dsh-tool-subagent-control` lets agents message, interrupt, and switch the model of subagents and list continuable children. One plugin instance registers all four tools for a scope shared by multiple delegation backends. Parents and continuable children inherit the same messaging definition and ordering. Tool presence does not select the delegation lifecycle.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount this package once per tool scope. It requires `tools`, `subagents`, `agents`, and `llm`.

### Minimal configuration

With the required services available, load the subagent service, a backend, the delegation tool, and this package to expose all four control and discovery tools:

```yaml
- name: '@deepseek-ai/dsh-subagent'
- name: '@deepseek-ai/dsh-subagent-spawn-in-process'
- name: '@deepseek-ai/dsh-tool-subagent'
  config:
    provider: spawn
- name: '@deepseek-ai/dsh-tool-subagent-control'
```

This package takes no configuration. Its main entry registers `send_message`, `interrupt_agent`, `set_agent_model`, and `list_agents` together; existing tool restrictions can hide individual tools.

### send_message

Sends a message to an Agent named by `agent_id`: any exact live Agent may target its direct continuable child, while a resident continuable child may also target its direct parent. A working target receives the message at its nearest step boundary through Steer; an inactive target starts or resumes a turn through the continuation lifecycle. The call returns only acceptance (the accepted message's stable `messageId`), never a reply. A failure — an unsupported target, unavailable parent, unknown child, descriptor-less child that cannot be resumed, or rejected admission — states the message was not delivered.

### interrupt_agent

External executions stop permanently and cannot receive follow-ups. Local targets stop only their current turn: queued messages stay parked until a later `send_message`, descendants keep running, and the child stays available for follow-ups. The call returns when the stop request is accepted, not when the target is quiet; interrupting an already-finished agent is an accepted no-op, and self, sibling, stale, and non-ancestor callers get errored results.

### set_agent_model

Switches a running descendant to another model: `agent_id`, `provider`, `model`, and an optional `reasoning_effort`. The tool validates the route through `ctx.llm.resolveCallConfig` first, so an unknown provider, model, or unsupported effort fails the call instead of becoming the child's next failed request, then passes `exec.agent` as the exact live ancestor authority to `ctx.subagents.selectModel()`. The switch reaches the child's next model step and is recorded in the child's own Session, so it also governs a later resume. An omitted effort stays omitted so the replacement model resolves its own default. Nothing queued is consumed or redirected. A target that is not loaded in this process, or a self, stale, or non-ancestor caller, becomes an errored result.

### list_agents

Lists the continuable children below the calling agent: `children` (default) reads direct children from the parent catalog without opening child logs; `descendants` recursively reads child catalogs in stable pre-order, annotating each entry with its durable direct-parent session id and depth. Status comes from the live Agent registry — `running` or `inactive`. External entries are omitted without reading a child Session. Readable one-shot children are omitted from output but their catalogs remain traversal nodes. Unknown modes and unreadable child catalogs, including one-shot children, appear as diagnostics only in `descendants` scope. Ordinary Session forks are not catalog entries, so neither those forks nor their descendants are listed from the source Session. In `descendants` scope, a child whose Session has reported provider usage carries its cumulative token usage and cache-hit rate.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains what the tools delegate to the subagent service; the observable behavior is covered in [Use this package](#use-this-package).

### Design concept

Thin adapters over `ctx.subagents.sendMessage()`, `interrupt()`, and the list projections; the tools perform no lifecycle routing. Residency, cold resume, and authorization belong to the service, and the tools pass the exact live calling agent (`exec.agent`) as both sender and authority.

### Delivery and signal ownership

The tool forwards its execution signal, which owns admission only until inbox acceptance. Once the target accepts a message, it cannot be cancelled through this tool. Every message is framed as `Agent <sender-id> sent a message:` and recorded with `{ kind: 'agent-message', form: 'relay', senderSessionId: sender.id }`; the service derives that attribution and never treats it as authority.

### Listing projection

`list_agents` derives the root id from the calling agent, reads the service catalog without a cursor, refines each candidate's status through the live Agent registry, and omits one-shot children because they cannot accept `send_message`. Descendant traversal preserves each parent catalog's event order. Unknown modes produce diagnostics while their catalogs remain traversable; unreadable catalogs produce diagnostics and stop that branch. Descendants absent from reachable catalogs cannot be discovered.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Shared registration of all four tools |
| [`src/list-agents.ts`](src/list-agents.ts) | `list_agents` registration: direct-child discovery and status refinement |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough; they move from the tool schemas to the continuation service behind them.

- [Subagent subsystem](../../../docs/subsystems/subagent.md) — continuable children, activations, inbox, interrupt, and follow-up authority.
- [dsh-tool-subagent](../tool-subagent/README.md) — the delegation tool that starts continuable children.
- [Generated tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-tool-subagent-control) — the tool schemas.

-----

<a id="model-experience"></a>
## Model Experience

### Tool schema

#### What the model sees

The generated [schemas](../../../docs/tool-catalog.md#deepseek-aidsh-tool-subagent-control): `send_message` takes `agent_id` and `message`; `interrupt_agent` takes `agent_id`; `set_agent_model` takes `agent_id`, `provider`, `model`, and the optional `reasoning_effort` enum; `list_agents` accepts an optional `scope`.

#### Token effect

Fixed schema cost per parent request.

#### KV Cache effect

Prefix-stable; the schema does not change at runtime.

### Interrupt result

#### What the model sees

`interrupt requested for agent <agent_id>` on acceptance. An unauthorized caller — self, sibling, stale, or non-ancestor — is an errored result naming the rejection; an absent or settled target still renders the acceptance line.

#### Token effect

One short acknowledgement per call; the interrupted turn's abort is visible only in the child's own transcript.

#### KV Cache effect

Append-only; each result follows the reusable request prefix.

### Delivery result

#### What the model sees

`message delivered to agent <agent_id>` on acceptance; the canonical output carries the accepted `messageId`. A failure — a non-adjacent target, unavailable parent, unknown child, descriptor-less child that cannot be resumed, or admission rejected — is an errored result whose message states the message was not delivered.

#### Token effect

One short acknowledgement per call; the target's response never returns through this call. A child uses the same tool with its initial task's parent id to append selected content to parent history.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

### Model-switch result

#### What the model sees

`subagent <agent_id> now uses <provider>/<model> for its next model request` on acceptance. An unknown provider or unsupported effort, a target that is not running, or an unauthorized caller is an errored result naming the rejection; nothing is switched in that case.

#### Token effect

One short acknowledgement per call. The child's later requests use the replacement route and its own adapter pricing; parent history gains no other content.

#### KV Cache effect

Append-only; the result follows the reusable request prefix. The child's next request may differ entirely from its prior provider prefix.

### Listing result

#### What the model sees

One line per continuable child in stable catalog order: `<id> [<status>] — <label>` (`running` = executing a turn; `inactive` = no turn executing, whether loaded or stored; neither status describes task completion or outcome). Only `descendants` scope adds `<id> [diagnostic: <reason>]` for an unknown mode or unreadable child catalog, including an unreadable one-shot child. The `descendants` scope inserts ` parent=<id> depth=<n>` before the label dash on every line, in pre-order. In `descendants` scope, a child whose Session has reported provider usage appends ` tokens[in=<n> out=<n> cache-read=<n> cache-write=<n> hit=<p>%]`, where `hit` is the cache-read share of the child's prompt tokens. Readable one-shot children are omitted; `(no subagents)` means no continuable child or diagnostic survived the projection.

#### Token effect

Grows linearly with the listed continuable children and diagnostics — reachable catalog descendants under the `descendants` scope; there is no cursor or cap, so long-lived parents with many persisted children pay the full list each call.

#### KV Cache effect

Append-only; each result follows the reusable request prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define what the control tools cannot observe or steer; they are current package constraints.

- **A delivered message has no independent result** — acceptance returns only its inbox `messageId`; later target work lands in that target's durable Session and is never collected through this tool. A reply is another explicitly addressed `send_message`, not this call's result.
- **Only supported adjacent Agents can communicate** — every sender may target a direct continuable child, only a sender with a resident continuable Activation may target its direct parent, and that parent must remain live; siblings and deeper descendants are not message targets, and only direct-child delivery supports cold activation.
- **Listing is a snapshot, not a delivery promise** — it may race publication, disposal, or a later message, and another process may activate a child this process reports as `inactive`; cross-process accuracy requires a shared lease. `interrupt_agent` performs the authoritative live-lineage check itself, so discovery staleness cannot grant authority.
- **No pagination or deletion** — the complete stably ordered set is returned, and persisted children remain listed for as long as their sessions remain in persistence; a service-level bound or delete operation is a later product decision.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
