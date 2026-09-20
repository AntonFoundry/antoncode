# Blueant act tier — propose-then-approve shell actions (Phase 4c remainder)

2026-09-20 — antoncode workspace, Anton bridge + macOS app + Blueant preset.

## What changed

- **Bridge** (`apps/anton-bridge/src/index.ts`): a propose-then-approve
  ledger beside the notification inbox. `POST /bridge/api/propose
  {command, rationale?}` enqueues an inbox entry with `kind: 'proposal'`
  and records a `pending` decision; `POST /bridge/api/propose/decide
  {id, approved}` records the human verdict and, when approved, executes
  the command with `Bash.spawn` — cwd `~/Library/Application Support/
  Anton/blueant`, 30s wall clock (kill on expiry), 10 KB combined output
  cap; `GET /bridge/api/propose/decision?id=` returns the verdict and
  output for the proposing tool to poll.
- **Mac app** (`ApprovalPanel.swift` + `AntonApp.swift`): proposal-kind
  inbox entries open a small floating non-activating panel showing the
  exact command with **Approve & Run** (Return) and **Deny** (Esc /
  close) buttons. Proposal ids are claimed against duplicate display but
  deliberately NOT acked until decided — ack-on-sight would strand the
  tool waiting on a verdict nobody saw. Closing the panel denies.
- **Blueant preset**: `plugins/propose.js` registers `blueant_propose
  {command, rationale?, waitMs?}` — enqueue, poll the decision every 2s
  (default 90s window, 300s cap, honors `exec.signal`), return DENIED /
  APPROVED+exit/output / TIMEOUT as model-facing text. Roster and
  template + deployed copies updated. `scripts/build-anton-macos.ts`
  gains `ApprovalPanel.swift` in the swiftc source list.

## Decisions and their reasons

- **The bridge executes approved commands, not the tool.** The verdict
  and output must survive tool-call cancellation; execution is bounded
  (30s/10KB, Blueant workspace cwd) and the human gate is the click —
  the same trust tier as the notification permission dialogs.
- **Closing the panel = Deny.** An ignored proposal must not linger as
  a zombie the tool waits on; silence is refusal.
- **Proposals skip the notification queue ack.** They ride the same
  `pending` poll for transport, but the ack happens in
  `decideProposal`, not in the delivery claim, so an undecided
  proposal keeps its place in the bridge queue.
- **The proposing tool polls instead of blocking on a push channel** —
  there is no bridge→tool channel; 2s polling over loopback is
  invisible next to the human decision time.

## Failures met on the way

- The preset template's propose block closed with the template-literal
  form `` ].join('\n')}` `` while the array was a plain literal — the
  stray backtick swallowed the rest of the file and broke every later
  block; bun and tsc both flagged unrelated-looking lines. Block closers
  must match how the block was opened.
- `cat -A` does not exist on macOS (BSD cat); use `cat -e`/`sed -n` for
  byte-level inspection.

## What this unblocks

- The Act tier is complete end to end: Blueant can now *do* things on
  the machine with explicit per-action consent. Phase 5a (journal
  collector) is the next lane and needs no new gates — it is Capture.
