# How VS Code stays fast: the performance discipline of a long-running Electron app

VS Code is kept open for weeks, holds enormous files, and runs hundreds of extensions — yet it
doesn't exhibit the classic long-running Electron decay (growing memory, jank, sluggish lists).
This document explains the concrete engineering practices behind that, with sources. The summary
lesson: the Chromium engine is not what makes typical Electron apps slow. The rot comes from
unbounded retained state, listener leaks, and GC pressure — all of which VS Code fights with
deliberate, *enforced* discipline. Most Electron teams never pay this tax; VS Code pays it
permanently.

## 1. Measurement first, budgets always

- Built-in instrumentation: the `Developer: Startup Performance` command shows a full boot
  timeline; `code --status` dumps process/state diagnostics; `Developer: Process Explorer`
  shows the process tree and per-process load.
- Automated startup benchmarks run against builds so regressions are caught per-change, not
  discovered by users.
- The team's own postmortem on the text buffer rewrite states the culture plainly: "always do
  real world profiling. Every time I found that my assumptions about which methods would be hot
  did not match reality." The hottest text-buffer method turned out to be `getLineContent`, not
  the insert/delete/search operations they had optimized.

## 2. Startup discipline

- **Progressive boot**: the window shell renders first; workbench parts fill in afterward.
  First paint is decoupled from full functionality.
- **Lazy module loading**: the AMD loader resolves modules on demand; heavy subsystems are
  `require`d at first use, not at boot.
- **Lazy extension activation**: every extension declares activation events
  (`onLanguage:`, `onCommand:`, `workspaceContains:`, `onStartupFinished`). Extensions do not
  run at startup unless their trigger fires. Most installed extensions contribute zero startup
  cost.
- **Idle-time scheduling**: `runWhenIdle()` (a `requestIdleCallback` wrapper) and `IdleValue`
  (defer computing a value until first access, during idle) in `vs/base/common/async.ts` push
  non-critical work off the boot path. Helpers like `Throttler`, `Delayer`, and `Sequencer`
  shape asynchronous work throughout the codebase.
- **Layered architecture with enforced import boundaries**: `vs/base` depends on nothing heavy;
  ESLint rules (`code-import-patterns`) prevent modules from pulling large dependencies into
  the startup path.

## 3. Virtualization: the DOM is a budget

The governing law: **DOM size is proportional to the viewport, never to the data.** Everything
scrollable is virtualized.

### Lists (`vs/base/browser/ui/list`)

- `ListView` renders only the rows intersecting the viewport plus a small buffer.
- Mechanics: an inner spacer element is sized to the full content height; visible rows are
  absolutely positioned and shifted with `transform: translateY(...)`. Scrolling moves the
  window of rendered rows; off-screen rows are removed from the DOM.
- Row heights are supplied by an `IVirtualDelegate.getHeight(element)`, so rows can vary in
  height; the scrollbar and offset math use prefix sums over measured heights, not DOM layout.
- Result: a search results list with 100,000 entries contains tens of DOM nodes.

### Trees

- The Explorer, search, source control, and debug views are `ObjectTree` / `DataTree` /
  `AsyncDataTree`. Only *expanded and visible* nodes have DOM. Collapsing a folder removes its
  nodes; nothing is merely hidden.

### The editor (Monaco)

- The text model (see section 5) holds the file. The DOM holds only the lines intersecting the
  viewport plus a small off-screen buffer. A million-line file has the same editor DOM as a
  ten-line file.
- Syntax highlighting of visible lines is viewport-driven; full tokenization runs in a background
  worker incrementally.
- The minimap is a `<canvas>`, not DOM.
- Transient widgets (hovers, suggest popups, find widget overlays) are created on demand and
  disposed on hide.

## 4. Event and disposable discipline

This is the mechanism class that typical Electron apps skip, and it is where their memory goes.

- **Everything is a `Disposable`.** Composition helpers make correct teardown the default:
  `DisposableStore` (register children, dispose all at once), `MutableDisposable` (hold one
  replaceable value), `DisposableMap`. DOM listeners are registered through
  `addDisposableListener`, which returns a disposable tied to the widget's lifetime.
- **Owners dispose children.** Widgets dispose their subscriptions and DOM listeners on hide or
  removal; services own and dispose their registrations. Event helpers (`Event.once`,
  `Event.debounce`, `Event.filter`) produce managed, auto-disposable subscriptions.
- **Leak detection is enforced by tests, not convention.** `ensureNoDisposablesAreLeakedInTestSuite()`
  installs a global `DisposableTracker` for the suite; if any disposable created during a test
  is not disposed at teardown, the test fails with the creation stack trace. The helper is being
  adopted across the codebase via tracked issues (microsoft/vscode#190503, #200091) and an
  ESLint rule (`code-ensure-no-disposables-leak-in-test`) fails suites that lack the call.
- `setDisposableTracker` is also used in debug contexts to attribute leaked subscriptions to
  their creation site at runtime.

This is the direct antidote to the "component mounted, listener attached, never detached" leak
that bloats long-running Slack/Discord sessions.

## 5. Data structures: the piece tree text buffer

The 2018 rewrite (Peng Lyu, "Text Buffer Reimplementation") is the flagship example of fixing
memory at the data-structure level:

- **Old buffer**: one string per line in an array. Fast random line access (`O(1)`), but file
  open required splitting the whole file into strings; memory ballooned to a multiple of file
  size (V8 string overhead, sliced-string effects); performance degraded sharply beyond ~100k
  lines.
- **New buffer ("piece tree")**: a piece table (an immutable original buffer fed by 64KB file
  chunks + append-only change buffers) whose pieces are nodes in a red-black tree. Each node
  caches the text length and newline count of its left subtree, making lookup efficient both by
  byte offset and by line number (`O(log n)`). Memory after load stays close to the raw file
  size; edits are an append plus a few tree rotations.
- Concrete numbers from the team: for `checker.ts` repeated 8 times (~11.4MB, ~200k lines), the
  line array held 20.3MB against the piece tree's 12.99MB. Modern re-runs of the original
  benchmarks (rebornix/PieceTree) measure the old line-array implementation retaining **1.7–3.2x
  the heap** of the piece tree, and taking **560ms** for 1000 random edits and **~10 seconds**
  for sequential end inserts on a ~187MB document, where the piece trees stay in the
  0.6–3.2ms range.
- **The rejected path is as instructive as the taken one**: a C++ text buffer prototype was
  abandoned because JavaScript↔C++ boundary crossing (string conversion, lost inlining) ate the
  gains. The decision was to keep the runtime in JavaScript and change only the data structure
  and algorithms.
- Honest follow-up work existed too: Find initially ran line-by-line over the piece tree and was
  later optimized; bulk edits needed their own passes. Performance work is continuous.

## 6. DOM hygiene beyond virtualization

- `clearNode` drops children cheaply; styles are managed through centralized style sheets
  (`createStyleSheet`, rule updates keyed by identifier) rather than per-element inline churn;
  class toggling over style writes.
- Reads and writes to layout-triggering APIs (`getBoundingClientRect`, offsets) are batched to
  avoid layout thrashing; element dimensions are cached during resize flows.
- Long tasks are chunked with the async helpers from section 2 so the renderer thread keeps a
  steady frame budget.

## 7. Process model: keep the UI thread cheap

- The main process owns window lifecycle; the **renderer** runs the workbench UI and nothing
  else; the **extension host** runs all extension code in a separate Node process; **file
  watching** runs out of process (a watcher service based on `@parcel/watcher`); terminal PTYs
  live in a pty host; full-text search shells out to **ripgrep**; the TypeScript extension
  drives a `tsserver` subprocess — all inside the extension host, never the UI thread.
- Consequence: heavy work (analysis, search, watching, terminals) cannot jank the UI thread. A
  misbehaving extension hangs its own host, not the window.
- The renderer is a sandboxed Chromium process; its crash does not lose the window or the
  workspace state.

## 8. Memory practices

- **Bounded caches only**: `LRUCache` and friends in `vs/base/common/map.ts`; caches are keyed
  and capped, never an unbounded `Map.set` that lives for the session.
- **Unload paths exist**: extension host restarts dispose an entire extension's world; webview
  editors release their state when hidden and deserialize on demand.
- **Memory is observed**: process memory is reported through telemetry; heap snapshots and
  `--inspect` profiling are documented workflows; the extension host exposes `--max-memory`.
- The text buffer itself holds ~file-size memory instead of a multiple of it (section 5).

## 9. What VS Code does NOT do (honesty section)

- It is still the DOM, still retained mode, still Electron. Text is not GPU-rendered; there is
  no alternative scene graph. The wins come from keeping the DOM *small* and *churned slowly*,
  not from leaving the browser paradigm.
- The baseline cost is real: an idle VS Code sits at a few hundred MB across its processes, and
  startup is hundreds of milliseconds. Virtualization bounds what *data* costs; it does not
  eliminate the platform tax.
- The discipline is a permanent tax, paid issue by issue, test by test. That is precisely why
  "write it like VS Code" is rare: it is a continuous budget item, not a one-time optimization.

## 10. What transfers to a clay + raylib + Deno stack

Transfers directly:

- **Budgets and measurement**: frame-time logging, memory watchdogs, a profile before every
  optimization. The piece tree story's real lesson is that assumptions about hot paths are
  usually wrong.
- **Viewport-proportional work**: our equivalent of virtualization is culling — never build
  clay layout commands for content outside the viewport, even though rebuilding is cheap. The
  DOM never made building 100k rows cheap either; the win was refusing to try.
- **Disposable discipline**: adopt the `DisposableStore` pattern (TypeScript's `using` /
  Explicit Resource Management makes this ergonomic) and a test-global leak tracker that fails
  on undisposed resources, exactly like `ensureNoDisposablesAreLeakedInTestSuite`.
- **Bounded state**: LRU caches everywhere; slotmap pools with integer handles for scene-graph
  nodes so node lifetime bugs fail loudly instead of leaking quietly.
- **Off-load heavy work**: Deno workers and subprocesses for search, parsing, and I/O-heavy
  tasks; the frame loop thread stays empty between frames.

Unnecessary in this stack:

- Most DOM micro-hygiene (style-sheet management, reflow batching) — those are taxes on working
  against a browser engine that this stack does not pay.
- The piece tree — only relevant if the tool contains a real text editor.

## 11. The discipline, compressed

1. Measure before optimizing; assumptions about hot paths are usually wrong.
2. DOM (or command) size scales with the viewport, never the data.
3. Every resource is disposed; a test suite fails if one isn't.
4. Caches are bounded or they are leaks.
5. Heavy work never runs on the UI thread.
6. Lazy-load everything that isn't the first frame.
7. Fix memory in data structures, not by tuning around them.
8. Performance is a continuous budget, not a phase.

## Sources

- Peng Lyu, "Text Buffer Reimplementation", VS Code blog, March 2018 —
  https://code.visualstudio.com/blogs/2018/03/23/text-buffer-reimplementation
- microsoft/vscode#41042 ("Explore new text buffer for performance improvement") and PR #41172
  (piece tree adoption, benchmark tables)
- rebornix/PieceTree — modern reproduction of the original benchmarks
  (line array retains 1.7–3.2x piece-tree heap; edit-time numbers quoted above)
- microsoft/vscode wiki, "Writing Tests" — `ensureNoDisposablesAreLeakedInTestSuite`;
  adoption issues microsoft/vscode#190503 and #200091; PR #127329 (tracker implementation)
- VS Code source layout: `vs/base/common/lifecycle.ts` (Disposable/DisposableStore),
  `vs/base/common/async.ts` (runWhenIdle/IdleValue/Throttler/Delayer),
  `vs/base/browser/ui/list/listWidget.ts` (ListView virtualization),
  `vs/base/common/map.ts` (LRUCache)
