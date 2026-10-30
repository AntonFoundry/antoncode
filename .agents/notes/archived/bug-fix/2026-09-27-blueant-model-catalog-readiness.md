# Agent Note: Blueant reads the host model catalog before opening a session

Status: implemented
Archived: 2026-10-30

English

## Problem

The Blueant model picker resolved or resumed its daily agent session just to list models. A stale or overlapping preset generation could fail during that operation, leaving the picker refreshing and blocking model selection. The menubar marked the Harness green before provider model discovery finished.

## Decision

Blueant loads the session-independent `llm.models` catalog after each Harness process starts and uses the same host catalog for its picker. Listing models does not create or resume an agent session. Session creation stays tied to asking Blueant or explicitly applying a selected route to a live session.

The menubar uses orange while boot or catalog loading is in progress, green after a non-empty catalog loads without provider failures, yellow when recovery is active or some catalog entries are unavailable, and red when the Harness is stopped or the catalog request fails. A failed catalog request retries on a later status poll.

Cordis inspect registrations from overlapping preset generations may share a provider id only when their validated manifests match. The newest active handler serves queries, and disposing it restores the prior handler. A provider id with a different manifest remains an error. This stacking is implemented in `CordisInspectRegistryService` as of 2026-09-29; see the sibling note `2026-09-29-inspect-provider-stacking-across-sessions` for the decision record.

## Alternatives considered

Using `session.models` for the picker requires a live session and couples display setup to preset mounting. Making repeated registrations silently overwrite one another loses the previous generation when the newer one unloads. The host catalog and a disposer-managed registration stack keep both lookups independent of session creation and preserve the active provider generation.

## Consequences

The picker can populate before Blueant has a session, and a green menubar status now confirms model catalog readiness as well as Harness readiness. Tests cover overlapping equal manifests, handler restoration, and conflicting manifests; the app build exercises the native status and picker code.
