# Agent Note: The sidebar New Workspace capsule

Status: implemented

## Problem

The sidebar's top-level capsule started a New Session, but every Workspace row already offers a plus button that starts a session in place, so the capsule duplicated an existing affordance while the more common top-level gesture — adding a Workspace — had only the small header icon. Users read the prominent button as the way to add a Workspace.

## Decision

The capsule becomes **New Workspace**. The shell keeps only the geometry and the press count: each click raises a monotonic request count on the `sidebar.workspaces` owner share, and the region (ui-workspace) consumes each rising edge into its existing directory-flow add path — the same flow, occupancy gating, adoption, and error dialog as the header's Add workspace action. The region reports hole occupancy back through an owner-share callback, and the shell drops the capsule entirely when no picking affordance exists, matching the header button's no-dead-affordance rule. New Session survives on the wordmark, which already carried it as a shortcut; the collapsed rail's capsule icon raises the same flow.

The owner share is the sanctioned shell→region channel: the shell owns the press count as plain data flowing down, and the availability callback flows up — no cross-package store, no hole observation in the shell, no new slot.

## Alternatives considered

- **Move the capsule into the region package** — removes the owner-share exchange but relocates figma-owned shell geometry and the rail-entry animation contract into ui-workspace for one button.
- **Let the shell observe the directory-flow hole directly** — couples ui-sidebar to a hole name ui-workspace declares, requiring a type-only cross-import that would form a circular project reference.
- **Keep the capsule always rendered and no-op without a picker** — leaves a dead control in a no-flow composition, contradicting the seam's documented default.

## Consequences

A composition without any directory-flow occupant shows no top-level add affordance and no capsule — adding is impossible there by design. The capsule and the header add button are two triggers over one flow, so their busy and error surfaces stay identical by construction.

## Testing

ui-sidebar shell specs cover the press count, the availability-driven hide/show, and the rail press; ui-workspace browser specs cover the rising-edge flow open, the occupancy report, and the dropped request; shell DOM snapshots and the lifecycle-chrome e2e goldens pin the new label.
