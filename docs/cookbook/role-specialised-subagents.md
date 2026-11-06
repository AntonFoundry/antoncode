# Role-specialised subagents

Give a child a focused task and select an independent Agent preset when the role needs a different tool set or standing instructions. The [`tool-subagent` configuration](../../packages/subagent/tool-subagent/README.md#use-this-package) owns delegation options; the [preset declaration](../../packages/preset/agent-preset/README.md#use-this-package) owns the child plugins. Delegation does not grant permissions beyond the scope fixed when the child starts.

## 1. Select the child's composition

Configure `agentPreset` on an in-process spawn tool instance to select the child's default preset. Without an explicit selection, the child shares the parent's current preset revision. Use `allowedAgentPresets` when the model may select among named presets through the `agent_preset` argument; include the configured default in that allowlist.

This typed example selects an independently declared `analyst` preset for a tool named `subagent_analyst`:

```ts
import type { Config } from '@deepseek-ai/dsh-tool-subagent'

const analystSelection = {
  provider: 'spawn',
  toolName: 'subagent_analyst',
  agentPreset: 'analyst',
  allowedAgentPresets: ['analyst'],
} satisfies Pick<Config, 'provider' | 'toolName' | 'agentPreset' | 'allowedAgentPresets'>
void analystSelection
```

The example supplies only the selection fields, not a complete resolved plugin configuration. Declare the `analyst` preset in the registry before attempting a delegation that selects it. An unknown or unloadable preset returns an errored tool result without starting a child. Fork and external providers reject independent preset selection.

## 2. Put the role in the preset

Declare the role's standing instructions and tools in its preset's plugin list. A role intended only to inspect files should expose only the operations it needs; excluding `write` and `edit` alone does not make a child read-only when it can execute shell commands or other mutating tools. Treat tool selection and sandbox permissions as separate controls.

The tool configuration does not accept `persona`, `toolFilter`, `backgroundMode`, or `enableRunInBackground`. Historical child descriptors can retain persona and tool restrictions for cold resume; they are not configuration fields for new delegations. See [child composition](../../packages/subagent/subagent/src/child-agent.ts) for inheritance and historical restoration.

## 3. Delegate independently checkable work

Visible delegation tools share guidance that asks the model to start independent calls together and continue useful work while they run. A hidden tool or unavailable provider contributes no visible delegation name. The [tool package's Model Experience](../../packages/subagent/tool-subagent/README.md#model-experience) owns the exact guidance and its context cost.

Choose tasks whose outputs can be checked without repeating the entire investigation:

| Delegate | Keep with the orchestrator |
|---|---|
| Find call sites and report file references | Decide whether the proposed change is appropriate |
| Implement an explicit, bounded change | Resolve conflicting requirements |
| Run named checks and return their output | Decide whether the checks cover the user-visible behavior |
| Review a diff for a named failure class | Accept or reject the final result |

Request file references, artifacts, and actual check output rather than an unsupported completion summary. A verification role should check the relevant failure cases independently, including limits and larger inputs where the change depends on scale.

## 4. Verify the selected role

Confirm that the role's preset is discoverable, that its intended tools are visible, and that excluded operations remain unavailable through every exposed executor. Start a delegation through the composed tool and verify the child uses the selected preset. Check failure for an unknown preset and for a provider that does not support independent selection; the owning [tool tests](../../packages/subagent/tool-subagent/tests/) and [preset registry tests](../../packages/preset/agent-preset-registry/tests/) provide current fixtures.

Continue a suitable existing child with the [subagent control tools](../../packages/subagent/tool-subagent-control/README.md) when its context already covers the task. Start a new child when the work must run independently or the old context would distort the investigation.
