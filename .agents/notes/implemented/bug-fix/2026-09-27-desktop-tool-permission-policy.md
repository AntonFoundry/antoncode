# Agent Note: Desktop actions use the harness tool permission policy

Status: implemented

English

## Problem

An earlier in-app assistant shipped a second approval mechanism: a `propose` tool wrote commands into a bridge ledger, Chrome mutations shared that ledger, and the Mac app presented its own approval panel. Full-access sessions could still wait for a second click, the bridge grew shell execution state it did not own, and installed plugins could outlive their removal from the generated composition.

## Decision

Desktop actions are ordinary harness tools under the session permission policy, and the bridge owns no execution or approval state:

- **Shell** runs through the harness `bash` tool with its sandbox policy, cancellation, and output handling. The bridge has no shell endpoint, proposal ledger, decision polling, or native approval panel.
- **Browser mutations** are the `browser_fill` and `browser_click` tools in `apps/anton-bridge/src/desktop-tools.ts`; each performs the action and returns the page result directly. A restricted session denies the call through the same policy that denies a shell command.
- **Mounted once.** The desktop-tools plugin is part of the main profile, so the browser and notification tools are governed by the same policy as every other tool in the session; there is no separate composition to keep in sync.

The retired ledger is history only. Its transport idea survives as the notification inbox in [Desktop notifications](../feature/2026-09-20-desktop-notifications.md), which carries nudges, not approvals.

## Alternatives considered

- **Forward the full-access flag to the bridge.** Keeps two policy implementations and two execution lifecycles, which is the duplication this decision removes.
- **Auto-approve proposal cards.** Leaves the duplicate machinery in place and makes the second gate meaningless.
- **Keep approvals only for browser actions.** Splits one session's policy by tool family; a session that can run a shell command does not need a weaker rule for typing into an isolated browser.

## Consequences

Full-access sessions act without a second click; restricted sessions keep the harness policy for both shell and browser. There is no pending-proposal store to migrate: callers issue ordinary tool calls. The browser driver still runs in a separate, visible Chrome profile, so a permitted action touches no personal cookies or tabs.
