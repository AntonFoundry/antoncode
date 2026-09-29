# Agent Note: Cordis inspect shares identical Host provider registrations

Status: implemented

## Problem

Preset rows mount the same static Host inspect provider for each live session. A second session therefore failed while mounting `tool-cordis` because the provider id was already registered, even though both registrations declared the same methods and schemas.

## Decision

The Host inspect registry keeps one entry and a handler stack for registrations whose validated manifests are identical. The newest live handler serves queries, and its idempotent disposer restores the preceding handler. The provider remains available until the last claim is released. Reusing an id with a different description, method list, or input or output schema still fails at registration.

Manifest comparison treats JSON object key order as insignificant while preserving array and method order.

## Alternatives considered

**Replace the existing registration without retaining the prior handler.** Disposing the newer session would leave the older live session without a provider.

**Permit every duplicate id.** A different provider could silently occupy an existing id and make the inspect directory disagree with the handler serving queries.

## Consequences

Several sessions and overlapping preset generations can mount an identical Host inspect provider without blocking one another. Queries follow the newest generation and return to the preceding one when it unloads. A changed provider manifest remains a loud deployment conflict, and a replacement can register after every existing claim has been released.
