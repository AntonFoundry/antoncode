# Blueant uses the harness tool permission policy

Status: implemented

## Problem

Blueant's generated `blueant_propose` tool sent commands to a bridge approval ledger independently of the chat permission policy. Chrome mutations shared that ledger. Full-access sessions could still wait for a second approval, and installed plugins could outlive their removal from the preset template.

## Decision

Commands use the harness `bash` tool and its session sandbox policy, cancellation, and output handling. The bridge has no shell execution endpoint, proposal ledger, decision polling, or native approval panel. Chrome fill and click remain harness tools and return action results directly. Startup removes the generated proposal plugin, replaces its roster entry with `bash`, and refreshes Chrome plugins that poll decisions while retaining unrelated preset settings.

This supersedes the separate approval mechanism in [Blueant propose-then-approve](../feature/2026-09-20-blueant-propose-approve.md). Its notification transport and Chrome ownership context remain useful history, not authority for another approval queue.

## Alternatives considered

Forwarding full-access flags to the bridge retains two policy implementations and execution lifecycles. Automatically approving cards leaves the duplicated machinery intact. Both are rejected in favor of the harness dispatcher and shell implementation.

## Consequences

Full-access commands require no Blueant-specific click. Restricted sessions retain the harness shell policy. Chrome mutations have no additional native confirmation. Pending proposals are not migrated; callers issue normal tool calls after reload. Focused tests cover installed-preset migration, preservation of custom settings, and repeat initialization. Native compilation and installer boot smoke validate the app assembly.
