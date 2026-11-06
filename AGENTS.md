# AGENTS.md

DeepSeek Harness is an all-plugin Cordis agent harness. Read [docs/architecture.md](docs/architecture.md) before changing `packages/`; follow [docs/AGENTS.md](docs/AGENTS.md) for documentation.

## Pre-stable APIs and released Session data

Public APIs are pre-stable; update every consumer. Follow [version/status](docs/session-format-status.md) and [type acknowledgements](docs/cookbook/reviewing-persistence-type-changes.md). [Adjacent migration](.agents/notes/implemented/architecture/2026-08-31-released-session-format-migrations.md) may add a version-named successor but never move, overwrite, or delete committed generations; predecessors imply neither fallback nor downgrade support. SQLite uses monotonic `SCHEMA_VERSION`.

Acknowledge [declared persistence-type changes](docs/cookbook/reviewing-persistence-type-changes.md).

Immediately record externally perceptible breaks in an [upgrade guide](.agents/skills/dsh-create-upgrade-guide/SKILL.md).

**Application launch.** Only `dsh` profiles launch supported Node apps; package bins, demos, and public SDK argv escapes are forbidden ([rule](docs/architecture.md#application-launch)).

## Repository layout

```
vendor/      Vendored Cordis (vendor/README.md)
packages/    @deepseek-ai/dsh-<pkg> workspaces at packages/<group>/<pkg>/
python/      Python SDK/runtime (python/README.md)
native/      @deepseek-ai/node-addon-system source (native/README.md)
benchmarks/  performance gates
.agents/     Agent workflows/notes
docs/        Documentation (docs/AGENTS.md)
scripts/     gates and generators
website/     VitePress documentation projection
```

Groups: [packages/README.md](packages/README.md). [Experimental status](packages/experimental/README.md#status) means evaluated capabilities without product-support commitment, independently of optional delivery; nonexperimental packages need product use or an explicit [classification](scripts/product-package-policy.ts).

## Commands

```sh
pnpm install            # pnpm workspaces, node >=24.9
pnpm run clean           # remove build outputs and safe deleted-package residue
pnpm run test           # unit tests
pnpm run test:coverage  # CI coverage gate: per-file 100% on packages/*/*/src
pnpm run test:e2e       # real-API tests; self-skip without DEEPSEEK_API_KEY
pnpm run test:expected  # owner-local process expectations
pnpm run test:snapshot  # keyless recorded-session replay through shipped profiles; filter: -t <name>
pnpm run test:snapshot:record  # re-record expected outputs (needs key)
pnpm run typecheck
pnpm run lint
pnpm run duplication    # cross-file TypeScript clone detection
pnpm run build          # build:artifacts + build:check, concurrently
pnpm run build:artifacts # tsc emits lib/types; tsdown bundles runtime/Web
pnpm run build:check    # typecheck aggregate tests/scripts against current build:artifacts output
pnpm run hygiene        # publint + workspace/package/dependency checks + NodeNext consumer check
pnpm run check:windows-wine  # ONLY when diagnosing a known Windows failure (needs wine); CI owns this signal
pnpm run doc-sync       # documentation gates (scripts/run-gates.ts)
pnpm run test:docs      # quick documentation checks (no build; doc-quick aggregate)
pnpm run website:build  # VitePress build/dead-link check
pnpm anton --profile headless "task"  # run one task from source (needs DEEPSEEK_API_KEY)
pnpm run demo:ptc -- "task"  # headless PTC mode run (needs key)
pnpm run dev:web | dev:desktop  # build:artifacts, then launch; Web also rebuilds client bundles on edits. start:web | start:desktop skip the build
make web|dev-web|desktop|dev-desktop|build  # the same commands; ARGS='--no-open' forwards options
```

### Anton macOS app (apps/anton-bridge)

The app ships only built `lib/`; first rebuild changed packages (`npx tsc -b tsconfig.client.json` + `pnpm --filter <pkg> run bundle`, or a full `pnpm run build`; the `dsh` CLI runtime additionally needs `npm run build:lib:host`), then:

```sh
pnpm run anton:build:macos  # self-contained: quits a running Anton, builds + boot-smokes a staging bundle in dist/, installs /Applications/Anton.app (override with ANTON_INSTALL_DIR; previous bundle kept as Anton.previous.app), relaunches, and verifies
```

**Control the app through `anton`, never custom quit/kill/open chains.** `anton status` reads bridge/harness/memory-service health; `anton restart` reloads the bridge-served harness (installed bundle or checkout under `pnpm run anton:dev`), keeping the app up; `anton stop`/`start` are deliberate lifecycle calls. Restart supersedes the still-available `POST http://127.0.0.1:3742/bridge/api/harness/restart`. All are interruption-safe: read-only/idempotent; none quits the app.

End-to-end staged-bundle boot-smokes fail builds, not launches, for broken plugins. Profile boot loudly retries with the failing loader entry disabled, losing only its features. Persistent harness/bridge failures trigger the Mac watchdog's first-party-only `recovery` profile (amber chip, "Exit Recovery Mode" menu). Repair happens in its Web UI; a one-shot `repair`-profile agent diagnoses `bridge.log`, fixes, rebuilds, and swaps in place (`ANTON_IN_PLACE_SWAP=1`). First run installs `~/.local/bin/anton`, sharing the app's `~/.anton/dsh` home (profiles `web`, `recovery`, `repair`, `headless`; `anton models` lists composition providers/models). The installed `anton` binary includes browser-driver/notification tools for same-tree repairs.

### Host sandbox failures

When sandbox evidence shows blocked credentials, network, IPC, watching, or nested `sandbox-exec`, retry required `gh`, `pnpm`, build, test, or generator commands unchanged with the narrowest host escalation. Never bypass test failures or the product sandbox.

### Run relevant checks locally

Before pushing, use [dsh-pre-push-checks](.agents/skills/dsh-pre-push-checks/SKILL.md); report only executed commands. After `gh stack sync`, validate immediately; do not merge before checks pass.

- Match evidence to the surface: focused behavior tests, model/user-output snapshots, `doc-sync` for docs, built smokes for published paths, and real-API e2e for providers.
- Never default to full suites or repeat passing checks for commit/push. CI owns exhaustive coverage/platform checks; run all locally only by explicit request, for CI diagnosis, or for irreducibly repository-wide changes.
- `test:coverage`, not `test`, is the CI coverage gate ([why](docs/testing.md)).
- Develop with `build:artifacts`; before claiming completion, run `build:check` after the latest `build:artifacts`, or `build` ([layout](docs/development.md#typescript-project-layout)).
- **Web browser automation and GIF recording:** launch with `pnpm dsh web --patch apps/web/tests/pin-browse-picker.overlay.yml` to use the [in-page directory picker](apps/web/tests/pin-browse-picker.overlay.yml); omit this override only when testing native picker behavior explicitly.

## Secrets / .env

Windows packaging/signing: [required reading](apps/desktop/windows-signing/README.md).

Real-API tests/demos read `DEEPSEEK_API_KEY`, optional `DEEPSEEK_BASE_URL`, and root `.env`. cordis.yml allows `!!js` (never `!js`) under plugin `config` and entry `disabled`; other metadata stays literal, so conditional composition also uses overlays ([primer](docs/cordis-primer.md#loader-configuration)). Never commit credentials. CI e2e skips without a key; [testing.md](docs/testing.md) owns key policy.

## Conventions

- Packages use `@deepseek-ai/dsh-<name>`; vendor is [rescoped](docs/rescope.md) and `private: true`. Harness packages declare `@deepseek-ai/cordis` in `peerDependencies`/`devDependencies`. Workspace dependency sections use DSH `workspace:*`, vendor/native `workspace:~` ([rules](.agents/notes/implemented/process/2026-08-10-npm-release-sequences.md)).
- ESM everywhere (`"type": "module"`). Use package names across packages and `.ts` in local relative imports. Config subprocesses run built `lib/` under plain Node; source regressions use their declared launcher ([testing policy](docs/testing.md#test-subprocess-launch-modes)). The `dsh` CLI source launch runs through tsx's ESM-only hook (`node --import tsx/esm`); modules it reaches must stay ESM (no CJS-only exports) ([source-launch contract](.agents/notes/implemented/architecture/2026-07-29-dsh-source-launch-tsx-esm.md)). Raw/Web `cordis.yml` bare plugins must appear in their resolver manifest's `dependencies`; `verify-cordis-config` enforces it.
- **Registrations are effects**: every contribution goes through `ctx.effect()` / `ctx.on()`; a registry's `register()` returns the disposer, directly or through its documented registration handle.
- **Typed events use declaration merging** and merge-extensible maps. Document event `@mode`/payload `@param` and public service parameters/non-void returns. `SessionEventMap` members are required-on-read unless envelopes carry `ignorable: true`. Bump `SESSION_FORMAT_VERSION` only if existing discriminators cannot prevent unsafe interpretation; same-version changes require safe readers ([review](.agents/notes/implemented/process/2026-10-08-session-reader-compatibility-review.md)).
- **Switch on discriminants.** Closed unions end in `assertNever`; merge-extensible unions fall through a documented default.
- **Waterfall listeners MUST call `next()`** to delegate; returning without it short-circuits the chain ([semantics](docs/cordis-primer.md#cordis-waterfall-semantics)).
- **Model-visible ⟺ logged**: anything that reaches a model request must be reconstructable from the session log; a new model-visible input requires a session event.
- **Session projections:** follow [dsh-session-projection](.agents/skills/dsh-session-projection/SKILL.md) when creating, extending, or reviewing one, or migrating a fold helper to one.
- **Plugins, not loop changes**: new behavior goes on documented extension points; changing `agent-loop` requires updating docs/architecture.md.
- **Capability seams comprise Service Definition / Service Provider / Consumer**, never one role; split only independently evolving roles ([glossary](docs/glossary.md#capability-seam)).
- **Prefer maintained dependencies over hand-rolling** when they delete owned code/tests ([policy](.agents/notes/implemented/process/2026-07-26-dependencies-over-hand-rolling.md)).
- **Explicit package defaulting**: the owning implementation uses `resolve(request): Spec`, never hidden `?? default` inside `run()` (`dsh-shell` request/spec template).
- **No hardcoded plugin tunables**: deployment-varying choices need validated, cordis.yml-changeable `Config` fields, not `DEFAULT_*` constants/test hooks. Protocol constants, external specs, and security invariants stay fixed.
- **Misconfiguration fails loud** at load when self-contained, otherwise at the earliest resolvable point; never silently skip a missing referent.
- **Opaque cross-boundary ids are branded** (`Branded<B>` from `dsh-brand`), never bare `string`.
- **Trust typed same-process interfaces**: no runtime validation, fallbacks, or hostile-input tests solely for statically required values. Validate parser/config, queued, model/tool JSON, durable/file, worker, process, and wire inputs.
- **No new assertions to `unknown`** (`as unknown` or `<unknown>`). Preserve or reduce the exact legacy baseline; use typed values or validation for replacements ([rule](.agents/notes/implemented/process/2026-09-19-no-unknown-casts.md)).
- **Never mix source/artifact planes.** Static gates/tests resolve workspace imports via tsconfig `paths` to `src`, passing on clean trees; built-`lib/` gates declare that dependency ([layout](docs/development.md#typescript-project-layout)).
- **Explicit compiler faces**: packages with both Host/Client programs expose face-specific leaves and solution-only roots; repo-wide programs seed a face config, never the root solution ([layout](docs/development.md#typescript-project-layout)).
- **Error handling:** use typed, structured failures and localized, actionable reports. Define handling ownership, containment, and failure guarantees; stop dependent work and visibly report untrusted state or unknown outcomes. Follow [dsh-error-handling](.agents/skills/dsh-error-handling/SKILL.md).
- **An empty `catch` names the error** and why; keep its `try` to one statement.
- **Keep comments local.** Do not restate code, expand unrelated comments, or explain distant behavior without local need ([rationale](.agents/skills/dsh-prose-standard/SKILL.md)).
- **Ban `prove` + `nance`** ([rule](.agents/notes/implemented/process/2026-08-26-ban-ambiguous-origin-label.md)).
- **Prefer parallel-value symmetry**; unexplained asymmetry suggests missed extraction.
- **Tests describe behavior, not correctness.** Change obsolete behavior with its tests; explain why in the PR.
- **Create Agent Notes only for durable decision rationale;** mechanical/local edits are exempt, including local UI changes ([scope](.agents/notes/README.md#when-to-write-one)). Archived notes are frozen: never edit or treat them as current authority ([archive policy](.agents/notes/README.md#archiving-and-deletion)).
- **Official plugin artwork:** use [dsh-official-plugin-artwork](.agents/skills/dsh-official-plugin-artwork/SKILL.md) for official and official experimental plugin icons; obtain designer approval before landing new glyphs.
- **Client UI copy is locale-owned.** Route product text through typed dictionaries and `t` or localized primitive props; `verify-client-ui-i18n` rejects hardcoded copy ([decision](.agents/notes/implemented/architecture/2026-08-23-locale-owned-client-ui-copy.md)). English copy, including plugin titles, uses sentence case ([rule](.agents/skills/dsh-prose-standard/SKILL.md#required-coverage-by-prose-location)).
- **Testing policy** — [docs/testing.md](docs/testing.md). Every non-trivial model- or product-user-visible change updates a keyless recorded-session snapshot; [snapshot ownership](snapshots/AGENTS.md) reserves the top-level tree for session-driven cases and keeps other expected output owner-local. Fixtures replay on macOS/Linux; fix fixtures, not normalizers.
- **Design each tool's UI presentation up front.** Host presenters stay pure; Web cards derive from raw events and persisted result metadata ([cookbook](docs/cookbook/adding-a-tool.md)).
- **Plan unit, e2e, and snapshot coverage** for capability seams, lifecycle paths, and transcript output; include missing snapshot-harness support in the same change.
- **Both SDKs project the loop.** Agent-loop, session-lifecycle, and `SessionEventMap` changes update the TypeScript and Python SDK expected outputs in the same PR; `pnpm run test` covers neither ([surfaces](docs/testing.md#when-a-snapshot-test-is-required)).
- **Commit each feature or bug fix immediately after its narrow checks pass**, with a deliberate message and its Agent Note, README, and tests together; never accumulate uncommitted tasks or commit `dist/` or credentials.
- **Choose PR history deliberately.** Split independent changes; fix introducing PRs before propagation. Standalone/stack branches may merge-forward/rebase. Rewrites use `--force-with-lease`, never `--force`; abort on remote movement. Preserve in-progress merge-forward checkpoints before newer bases ([rationale](.agents/notes/implemented/process/2026-08-02-native-github-stacks-and-optional-rebases.md)).
- **Labels:** one PR `kind/*`, all material `area/*`, and native Issue Type ([taxonomy](.agents/notes/implemented/process/2026-08-08-unified-github-label-taxonomy.md)).
- **PR descriptions:** write/update every description with [dsh-pr-description](.agents/skills/dsh-pr-description/SKILL.md).
- TODO markers: `FIXME`/`TODO`/`XXX` by urgency ([semantics](docs/development.md)).
- Files end with exactly one trailing newline; `git diff --cached --check` (pre-commit) gates it.

## Defensive patterns

Read [docs/defensive-patterns/README.md](docs/defensive-patterns/README.md) before changing a package surface, remote service, client component or state, conversation or Session behavior, or lifecycle, concurrency, subprocess, and teardown code. Its [review principles](docs/defensive-patterns/README.md#why-these-rules) apply per artifact.

## Type safety and documentation

Compile with `strict: true`/`noImplicitAny`; explain why each remaining `any` cannot narrow. Document every module/export's non-obvious contract in concise JSDoc; function-like exports include `@param`/`@returns` (`verify-export-jsdoc`). Heritage-declared members, plugin-protocol slots, and constructors retain docs at the declaring Service Definition, protocol, or class.

Comments/docs state complete contracts/context, not reasoning transcripts. Use direct, concrete terms, never metaphors. Check `contract`, `boundary`, and `shape` against exact alternatives: `response fields`, `JSON validation`, `ESM exports`. Reserve `contract` for relied-upon preconditions, postconditions, invariants, compatibility promises, and obligations; retain literal process, wire, security, transaction, or lifecycle boundaries. Omit control-flow/test narration, review history, and code restatement. Preserve behavior, failure, timing, ownership, and safe use; link rationale. Follow [dsh-prose-standard](.agents/skills/dsh-prose-standard/SKILL.md). Enforce mechanically checkable invariants in executed top-level gates; prove each changed acceptance path rejects an invalid case. Use narrow, justified exceptions, never global rule disabling.

Docs accompany every code change: update affected README and JSDoc contracts together. English-exclusive documentation: no Chinese docs, translations, or translation gates. Current-state prose, one physical line per paragraph, one home per fact, and word budgets live in [docs/AGENTS.md](docs/AGENTS.md).

## Editing these instructions

Root/`packages/` `CLAUDE.md` symlinks `AGENTS.md`; edit the real files. Keep rules self-contained, linking high-level docs. Condense without losing clarity; raise `verify-doc-budgets` ceilings only for required space.

## Vendoring policy

`vendor/` packages are pinned source copies (manifest with upstream SHAs in [vendor/README.md](vendor/README.md)). Update via the sync procedure there; re-apply or retire the logged local modifications; rerun `pnpm run test && pnpm run build`.
