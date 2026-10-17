# Agent Note: In-app OpenCode workspace login

Status: implemented

## Problem

The Zen workspace session could only be created from a terminal (`dsh
opencode-login`). A user who installs the app, picks `opencode-free`, and
has no CLI on PATH meets an auth failure naming a command they cannot run —
and on Windows no `dsh` entry point existed at all. The device flow itself
was also CLI-bound: `runZenLogin` blocks on a terminal for the code, the
approval wait, and the workspace pick.

## Decision

Harness-owned login flow, three slices:

- `ZenLoginFlow` (`llm-opencode`) holds pending logins server-side around
  the existing pure device-flow functions: `start` issues the code and polls
  in the background, `snapshot` reports UI-safe progress, `select` records
  the workspace and persists through the credentials seam, `cancel` abends
  the wait. Snapshots never carry token material. Provided as
  `ctx.opencodeOAuth` (effect-registered with disposal that aborts pending
  drivers); the CLI keeps its inline flow.
- `opencodeOAuth.start/status/select/cancel` RPC methods (apiproxy,
  loopback-pinned like `credentials.*`) call the flow via `ctx.get` with a
  merge-only type import — no host→provider dependency, mirroring the
  flowbuilder precedent. The UI needs no new push channel: completion lands
  in the credentials file, and the existing `credentials/updated` event
  refreshes the page.
- The Models page renders a Log in button on OpenCode rows opening a dialog
  (code + link, approval poll, workspace picker, logout/re-login), following
  the page's card/busy/error idioms. The failure guidance now names the
  button beside the CLI command.

Windows gaps closed along the way: `dsh.cmd` first-run launcher (no PATH
mutation, location logged), `cmd /c start` browser opener, and the
`%APPDATA%\Anton\dsh` home candidate. Rejected: backend-spawned CLI
subprocess for the button (stdout parsing plus a second credential writer —
the seam stays single-writer).

## Alternatives considered

- **Slash-command login** — single-shot command results cannot carry the
  minutes-long approval wait or the workspace pick; rejected.
- **UI drives the console device flow directly** — browser CORS plus secrets
  in frontend code; rejected.
- **Auto-writing the session into every known home** — two copies refreshing
  independently invalidate each other's refresh tokens; rejected in favor of
  one explicit home plus the mismatch hint.

## Consequences

App users log in without a terminal on any platform; CLI/headless flows are
unchanged. Abandoned logins poll until the console expires the code; the
manager caps concurrent pendings and evicts old terminals. The fixture API
gains a canned two-poll-then-picker flow so UI work needs no network.

## Follow-up: Claude coverage, session dots, row logout, credential reset

The same shape now covers Claude (`claudeOAuth.start/submit/cancel`,
`ClaudeLoginFlow` with paste-back submit instead of polling,
`ClaudeLoginDialog` with a paste field). Rows also consult the OAuth
session for the status dot (a logged-in workspace reads green on its
session, not red on its missing key), the row button toggles between
Login and direct Logout depending on session state, and shipped rows
with stored credentials gain Delete (credentials reset: unsets the key
and/or session refs without touching the deployment-owned profile).

## Testing

`zen-login-flow.spec.ts` (9: lifecycle, validation, caps, secrecy of
snapshots, disposal), `api-proxy-opencode-oauth.spec.ts` (3: full RPC round
trip with persistence, error codes, unavailable plugin), and
`opencode-login.client.spec.tsx` (3: row button, device-flow completion,
denial, active session) against scripted consoles; existing suites pass
unchanged (503 total across the touched packages).
