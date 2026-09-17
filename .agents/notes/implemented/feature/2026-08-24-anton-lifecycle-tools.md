# Agent Note: Anton lifecycle tools moved to a dedicated plugin

Status: implemented

English

## Problem

The c0ntext memory plugin contained an `anton_restart` tool and bridge-specific configuration even though process supervision belongs to the Anton Bridge. That coupled a context-memory package to one product launcher and left lifecycle behavior split across two plugins.

## Decision

`@deepseek-ai/dsh-tool-anton-lifecycle` owns the complete lifecycle surface: `anton_status`, `anton_start`, `anton_stop`, and `anton_restart`. It uses one bounded HTTP helper for the Bridge control API, validates the endpoint during plugin registration, supports an environment override, and provides per-tool enable flags. The c0ntext plugin is now limited to context mirroring, eviction, search, and rehydration.

The bridge remains the authority for starting and stopping processes. Stop and restart explicitly document self-termination: the current harness process normally dies before it can render a result. Refusals and unreachable-bridge failures remain explicit diagnostics.

## Verification

The package has unit tests for HTTP routing, refusal/error behavior, environment endpoint selection, configuration gating, self-termination semantics, and the package invariant, plus a real Loader composition test. The package is included in the host TypeScript references, base bundle manifest and patch, and generated tool catalog.

## Known limitation

The bundled c0ntext engine is shipped as app resources but uses Docker Compose; recipients still need a compatible Docker runtime and network access for first-time images/builds.
