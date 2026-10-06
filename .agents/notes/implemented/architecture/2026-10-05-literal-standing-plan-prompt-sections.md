# Agent Note: Literal standing-plan prompt sections

Status: implemented

## Problem

Saved todo and implementation-plan text can contain `{{...}}` prose that the prompt renderer interprets as a registered variable, causing every request carrying the standing plan to fail.

## Decision

Prompt sections may set `interpolate: false` when their text includes model- or user-authored content. Todo and implementation-plan standing sections use this setting so saved content reaches the model unchanged. Other sections retain strict variable interpolation, including errors for unknown or valueless references.

## Alternatives considered

- **Register a `source` variable** — gives special meaning to user-authored text and still fails for other literal groups or assemblies where the value is unavailable.
- **Add brace escaping to the renderer** — requires each dynamic-content producer to encode and maintain text correctly; disabling interpolation for the whole standing section matches its content, which has no runtime variables.

## Consequences

Standing plan content is literal, so contributors cannot interpolate registered variables within those sections. Deployment-authored guidance and other prompt sections keep the existing strict interpolation behavior.

## Testing

System-prompt rendering and both standing-plan section suites cover literal `{{source}}` content and preserve strict interpolation for ordinary sections.
