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

## View activation: the one-click → surface hop (resolved by the store share)

Clicking the header icon must raise the app's root surface. The active view
on the ring is per-session chat-store state inside ui-conversation
(`ConversationSession`: `useStore(s => s.view)` →
`renderSlot('conversation.view', …, { only: active.id })`), and inactive ring
entries are not mounted — so the hop cannot happen from an occupant's own
render.

**Resolved design (verified against source, no new extension point needed)**:
the session-header seat already shares the per-session chat store — the
`conversation.session.header` registration declares `store: chatStore`
(ui-conversation `apply.ts`), so **every header-utilities occupant receives
the store share** (`PropsStore<ChatStoreState>` with `actions.setView`), and
`setView` activates any registered view id (`resolveActiveView` falls back
gracefully for unregistered ids). The app-plugin's header button therefore
calls its own store share with its own view id:

```tsx
// app plugin's header-utilities occupant; its conversation.view entry
// registered id 'myapp' into the same ring.
const { actions } = props            // PropsStore share at the header seat
const view = useStore(s => s.view)   // 'myapp' while the app surface is up
onClick={() => { actions.setView('myapp') }}
```

Invariants:

- Activation is a plain store write (`actions.setView`), replay-safe, and
  needs no session event (view selection is UI state, not model-visible).
- Nothing crosses plugins but the store share the header seat already
  grants — no provide channel, no window events, no ui-conversation change.
- The composer-dock and shell-overlay seats do NOT share that store; apps
  wanting a toggle there either take the header seat (recommended) or route
  through their own host-side command.

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
