# Agent Note: token-meter resume-boundary recovery

Status: implemented

English

## Problem

`ctx.tokenMeter` retained an open step anchor while replaying an open constructor seed. The `session/end-seed` marker separates constructor input from later writes, but the seed may end before the step does. When a new `step/start` followed the seed marker, token-meter treated the stale anchor as a malformed overlapping step and threw on every later measurement. The c0ntext evictor caught that failure, reported `token_meter: down`, and skipped all further eviction, allowing the model-visible history and context-breakdown estimate to grow without bound.

## Decision

The token-meter fold clears a pending step anchor when it reaches the seed's terminal `session/end-seed`. It retains the canonical request header, priced conversation surface, usage totals, and provider anchor. The marker records the end of constructor seed, not proof of interruption or durability repair; only the marker at `session.firstLiveSeq` starts this replay boundary. A marker appended later is an ordinary event and does not clear the anchor.

A `step/start` appended after the seed boundary with no preceding `step/end` inside the seed still fails loudly. This preserves log-corruption detection while discarding a stale step anchor before any subsequent writes.

## Alternatives considered

**Clear all token-meter state at `turn/end`.** A valid turn end follows a real `step/end`, while interrupted tails in this case were committed by another process and contain no closure event. Clearing at every turn end also risks discarding a completed anchor needed for subsequent deltas.

**Rewrite the durable user's session.** This would alter user history and would not prevent the same failure on the next interrupted resume. Recovery remains a fold behavior at the existing seed marker.

## Consequences

Measurement remains available when the constructor seed ends inside an unfinished step and later writes follow the marker. The old partial request is not used as an anchor; provider-reported usage from a later successful request can establish a fresh anchor. The durable surface remains unchanged and may still require ordinary pressure eviction after resume.

## Testing

`packages/llm/token-meter/tests/token-meter.spec.ts` replays an open step through the constructor's seed boundary, begins a new turn and step, and asserts measurement retains prior surface content and consumes the full log. It also confirms a later marker does not clear an open step. Existing malformed overlapping-step tests continue to require failure.