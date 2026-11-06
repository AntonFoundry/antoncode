# Agent Note: Composer effort pill with hover slider

Status: implemented

## Problem

Reasoning effort was reachable only inside the model picker as a second menu row (Model / Effort, each drilling into its own list), and the composer chip fused both facts into one label ("GLM 5.3 Flash Max"). Adjusting effort meant opening the model menu, drilling into Effort, and picking from a radio list — heavyweight for the knob turned most often, and the fused chip label made the two facts hard to tell apart.

## Decision

- The model trigger opens the provider-grouped model list directly; the root Model/Effort pane pair and the effort radio pane are gone, as is the effort suffix on the trigger label.
- A sibling effort pill renders for the selected model when its adapter declares reasoning metadata: its text is the effective level (provider default included), and its hue follows the level — neutral at off/provider default, blue→green→amber→red for low→max, unknown ids neutral. Hues are theme aliases (`--dsw-alias-effort-*` in ui-theme's design-platform.css), not literals.
- Hovering the pill reveals a slider card above it over exactly the declared levels; the thumb sits on the active stop and dragging or clicking a stop submits the same `ModelSelection` write the old menu row used. A click pins the card (touch users), and Escape or an outside click dismisses it.

## Alternatives considered

- **An always-visible segmented control** — one less hover, but five permanent chips in a cramped tool row for a knob most sessions never turn after the first minute.
- **A plain menu on click (no slider)** — cheapest, but the user asked for a drag-scale interaction, and a range input also gives keyboard arrow adjustment for free.

## Consequences

The pill needs reasoning metadata, so models whose adapter declares no efforts (and the keyless replay harness, whose model directory carries none) show no pill — the same posture as the retired Effort row. The level hue ladder is presentation-only; ids remain the adapter-owned vocabulary.

## Testing

`model-select.client.spec.tsx` covers the direct model menu, the pill's effective-level label, the slider's stop list and active thumb, slider writes as selections, provider-default availability, the no-reasoning posture, scroll-into-view, and the rejection toast.
