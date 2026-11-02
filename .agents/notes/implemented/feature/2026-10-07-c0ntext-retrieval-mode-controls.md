# Agent Note: c0ntext retrieval mode controls

Status: implemented

## Problem

c0ntext supports fast and full retrieval modes, but changing the mode requires editing plugin configuration. Users cannot switch the latency and precision tradeoff from the UI when investigating retrieval quality.

## Decision

Expose the existing `retrieveMode` setting in the c0ntext plugin settings card and the context sidebar. The settings card stages the value with its other plugin settings; the sidebar writes the same `c0ntext-context` field immediately. The plugin reads the setting for the next retrieval without a restart. Both controls describe Full as slower and clarify that it does not guarantee relevant results or prevent timeouts.

## Alternatives considered

- **Expose the mode only in plugin settings** — keeps configuration in one place but makes switching from the active context view require leaving the conversation.
- **Expose the mode only in the sidebar** — makes experimentation quick but leaves the setting undiscoverable with the other c0ntext options and unavailable when the sidebar is closed.
- **Add a third slow mode** — duplicates the existing `full` retrieval path without adding a distinct engine behavior.

## Consequences

Fast remains the default. Full enables the engine's existing additional retrieval stages and uses the plugin's full-mode soft timeout; either mode can still return weak matches or fall back when the worker exceeds its budget. The two controls share one stored setting, so changing either updates the other after settings state refreshes.

## Testing

The c0ntext plugin TypeScript and bundle build validates the sidebar control and plugin registration. The settings card package build validates its typed field and rendered selector. No product transcript snapshot was added.
