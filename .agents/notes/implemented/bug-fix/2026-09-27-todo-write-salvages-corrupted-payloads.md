# Agent Note: todo_write salvages corrupted payloads

Status: implemented

## Problem

A model call to `todo_write` occasionally emits corrupted JSON argument entries (trailing-space keys like `{"content ": ", "}`, junk entries like `{": 0, "}` and `{"": null}`, string entries where objects are expected). The registry's argument validation rejected the whole call with `invalid arguments`, so one corrupted entry lost the agent's entire standing todo tree before the handler could act.

## Decision

The tool's parameter schema tolerates malformed entries so they reach the handler: each nesting level's `items` is a `oneOf` of the documented node object (now without per-property `required` and with `additionalProperties: true`) and a bare string. The handler runs a repair pass (`repairTodoTree`/`repairTodoNode`) before the strict normalizer: object keys are trimmed, string entries become pending nodes, entries without usable `content` are dropped, missing or unknown statuses default to `pending`, invalid priorities are omitted, and `children` beyond level three are ignored. `toTodoTree`/`toTodoNode` remain the durable-shape authority; a non-empty payload whose entries all fail salvage rejects with `invalid todos: no salvageable entries` instead of silently wiping the standing plan. Status and priority enums stay in the schema, so a well-formed key with an invalid enum value still fails validation with the schema message.

## Alternatives considered

A generic coercion hook in the tool registry (`packages/core/tools`) would affect every tool and cannot know each tool's repair rules. Dropping the enums entirely would weaken model guidance and lose precise errors for wrong enum values. Both are rejected; repair is local to the todo package.

## Consequences

Corrupted `todo_write` payloads now preserve every salvageable node instead of failing the whole call. A fourth nesting level is silently truncated rather than rejected. Tests in `packages/todo/tool-todo/tests/tool-todo.spec.ts` cover each corruption shape from the incident, the all-junk rejection, and the depth truncation.
