# Agent Note: App-plugin profile — one-click app surfaces over the Emacs-style core

Status: proposed

## Problem

The harness UI is Emacs-shaped: buffers, splits, commands, `M-x`-style
invocation. Power users thrive; everyone else needs a **one-click shortcut**
per application. When we (or third parties) build complex app-plugins — a
mail client, video editor, 3D editor, game editor — each must expose its own
invocation affordance **as plugin UI**, the way a browser extension pins an
icon to the toolbar. The shell must not know any app by name, and nobody
should have to type `M-x app-name` when a click will do.

Part of this shipped on 2026-09-16: the c0ntext plugin's session-header mark
(`conversation.session.header.utilities` occupant driving
`ctx.layout.toggleDetails()`) established the ownership rule this proposal
generalizes.

## Proposal

Ratified ownership rule (already shipped): generic chrome is shell-owned;
everything app-specific is plugin-owned. The shell sidebar button toggles any
plugin-exposed sidebar; a plugin-exposed button spawns that plugin's own
surface; disable/uninstall retracts the button structurally because slot
registrations are fiber effects.

The **app-plugin convention** (authoring contract for future app-plugins):
an app-plugin is an ordinary client plugin package that

1. **declares an invocation affordance** — registers its icon in a generic
   seat (`conversation.session.header.utilities` for a session-header mark,
   `shell.topbar.right` for frame-wide chrome); icon and position are the
   plugin's own directives;
2. **declares a root surface** — normally a `conversation.view` ring entry
   (full-column app view, like Chat/Trajectory), or a dedicated WM buffer
   kind when the app needs window-tree geometry;
3. **declares command parity** — a host-side `commands.register` entry so
   keyboard users invoke the same app from the command directory (both paths
   drive the same state);
4. **owns its lifecycle** — disable/uninstall retracts 1–3 structurally.

Implementation plan: a thin helper package (or ui-layout export) —
`defineAppPlugin({ id, label, icon, order, surface })` — performing 1–3 so
app authors write one declaration instead of hand-wiring slots.

## View activation: the one-click → surface hop (shipped mechanism)

Clicking the header icon must raise the app's root surface. The active view
on the ring is per-session chat-store state inside ui-conversation
(`ConversationSession`: `useStore(s => s.view)` →
`renderSlot('conversation.view', …, { only: active.id })`), and inactive ring
entries are not mounted — so the hop happens through a session provide
channel, not through an occupant's own render.

**Shipped mechanism**: ui-conversation publishes a `sessionViews` provide
contribution; every session-scope occupant receives a `viewActions` prop:

```ts
viewActions: { activate(viewId: string): void }
```

`activate` writes the shared chat store (`actions.setView(viewId)`) through
the slots service's get-or-create instance accessor
(`ctx.slots.storeInstanceOf(handle, sessionId)` — added for this channel,
because `StoreHandle.create` deliberately does not dedupe). The channel
carries only JSON (a view id); view selection is UI state, so no session
event is required. Verified by
`packages/client/ui-conversation/tests/app-view-activation.client.spec.tsx`:
a header-utilities toggle activating a registered `myapp` view flips the ring
selection. An earlier theory — that the header seat's registration
(`store: chatStore`) automatically shares the store with child-seat occupants
— is false: `store` is per registration, and child seats declare none.

## Alternatives considered

- **Shell-level app registry + launcher list**: rejected — discovery is
  already the command directory (host) plus the seats themselves (client);
  a central registry reintroduces the shell-knows-apps coupling the
  ownership rule removes.
- **New WM buffer-kind registry as the v1 surface**: deferred — window-tree
  geometry apps keep using dedicated slots (`terminal.view` pattern) until
  that registry is designed; `conversation.view` covers v1 apps.
- **Direct cross-package import of ui-conversation internals (chatStore
  factory)**: forbidden by client export discipline — which is why the
  header-seat store share is the load-bearing discovery: it hands occupants
  the activation actions without any import.

## Acceptance criteria

- A plugin declaring the convention (icon + view + command) is installed by
  mounting it alone; no shell file changes.
- Clicking its header icon raises its app surface (header-seat store share →
  `setView`); disable/uninstall removes icon, view, and command without
  shell restart.
- The command-directory invocation and the click drive the same state.
- `pnpm run test:gui` green; assembled-output change covered by
  `DSH_SNAPSHOT=replay pnpm run test:web`.

## Risks

- Header-utilities crowding as app-plugins multiply (mitigation: cooperative
  `order`, and a launcher seat can come later without breaking the contract).
- The header-seat store share is load-bearing: if `conversation.session.header`
  ever drops `store: chatStore`, every app-plugin toggle breaks at once. The
  implementing PR for the `defineAppPlugin` helper should add a focused spec
  asserting header utilities occupants receive the chat-store share.
- View activation is UI state only; app plugins needing per-app durable state
  continue using sessions.provide keys or host services.
