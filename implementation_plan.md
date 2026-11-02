# Upstream reconvergence, then superagent absorption

## Objective

Bring the Anton fork from upstream `0.1.0-rc.7` to `0.2.2-alpha.2` by **merging shared ancestry**, preserve the 30 additive Anton packages, gain `plugin-manager`/`engines.dsh`, then install `dsh-superagent-prototype` as a bundle. Rename to antoncode-harness **last**.

## Established facts

- Shared root commit with upstream: `b67e81ac97`. Fork point (merge-base): `99f6f02fec`, the `0.1.0-rc.7` release merge, 2026-08-17.
- Divergence: ahead 484, behind 12,518. Upstream remote already added as `upstream`; release tags fetched as `upstream-dsh-v*`.
- Conflict surface: 1,200 files (we modified AND upstream changed). ~250 `.agents/notes`, ~65 docs → policy resolution. ~700 real code, concentrated in `packages/client` 252, `apps/web` 117, `packages/host` 48, `llm` 35, `subagent` 34, `core` 29.
- Our value: 771 added files / 30 added packages, almost entirely in directories upstream never touches.
- We deleted 2,193 upstream files (1,386 `.agents/notes`) — deletions re-conflict on merge unless resolved by policy.
- Upstream gained `packages/boot/plugin-manager` + `plugin-market` + `config-editor` + `hmr`; `engines.dsh` is its compatibility gate (`plugin-manager/src/versions.ts:8`).
- Superagent needs DSH `^0.2.1-alpha.2` + Cordis `4.0.5-alpha.1`; its 3 "missing" identities exist upstream (`experimental/session-inspector`, `preset/agent-preset` — ours is `agent-presets`, renamed upstream).

## Strategy

Staged merge along upstream release tags on a throwaway branch, never on `main`. Each stage must reach a green build before the next. Anton packages are additive, so they survive merges; our modifications to upstream files are the cost centre and get retired into extension points where possible rather than re-merged forever.

## Phase 0 — Safety and baseline

1. Tag current state `anton-pre-merge` and push; confirm `/Applications/Anton.app` keeps running from the installed bundle, independent of this checkout.
2. Record the baseline: `pnpm run build`, `pnpm run typecheck`, `pnpm run test` results as the comparison point.
3. Create `merge/upstream-0.2` from `main`. All merge work happens there.

## Phase 1 — Resolution policy (decide before touching conflicts)

1. `.agents/notes` (~250 conflicts, 1,386 our deletions): take upstream wholesale, re-add Anton notes afterward. Removes ~20% of the surface mechanically.
2. `docs/` (~65): take upstream; re-apply Anton-specific docs as new files.
3. Lockfile, generated catalogs, `lib/` artifacts: regenerate, never hand-merge.
4. Record the policy in an Agent Note so resolution is consistent across stages.

## Phase 2 — Staged merges

Merge in order, building green at each stop:

1. `upstream-dsh-v0.1.7-rc.2` — stay on the 0.1 line; absorbs renames and package moves while the API is closest to ours.
2. `upstream-dsh-v0.2.0-rc.2` — the major-line break. Expect the bulk of `packages/client` and `apps/web` conflicts here.
3. `upstream-dsh-v0.2.1-alpha.2` — superagent's declared floor. Validate superagent install at this point.
4. `upstream-dsh-v0.2.2-alpha.2` — current upstream head.

Per stage: resolve conflicts by policy, `pnpm install`, `pnpm run typecheck`, `pnpm run build`, targeted tests for every conflicted package, commit the stage.

## Phase 3 — Anton package reconciliation

1. Re-point the 8 `llm-*` providers at the 0.2.x LLM seam; upstream's `llm` changed under us (35 conflicts).
2. Re-point the 10 `client/ui-*` packages at the 0.2.x client UI seam (252 conflicts — the largest single risk).
3. Reconcile `agent-presets` (ours, plural) with upstream `agent-preset` (singular): adopt upstream's package, port our preset rows onto it.
4. Rebuild `apps/anton-bridge` against the new boot/profile mechanism; verify `anton status|restart|stop|start`.
5. Retire as many of the 1,697 upstream-file modifications as possible into documented extension points; log what must stay patched and why.

## Phase 4 — Superagent absorption

1. With `plugin-manager` present, install `dsh-superagent` as a bundle via the plugin manager / `dsh.bundle.patch`, not by vendoring source.
2. Supply the profile `stateDir` it refuses to start without (`examples/profile.cordis.patch.yml`).
3. Configure the GitHub source; leave the Feishu row disabled as upstream ships it.
4. Translate the two Chinese-labelled presets (router/worker) and decide whether they live as bundle rows or Anton agent presets.
5. Validate end to end: a GitHub request becomes a ticket becomes a session.

## Phase 5 — Rename (last)

1. Rename root package identity and the `deepseek-harness` directory to `antoncode-harness`; update `apps/anton-bridge` paths, the `anton` launcher, `~/.anton/dsh` references, and the app build.
2. Rebuild and reinstall the Mac app; verify boot, recovery profile, and the Web GUI at `127.0.0.1:3080`.
3. Keep the `upstream` remote and the Anton-additive-directories convention documented, so the next reconvergence is a routine merge.

## Decision gate

If Phase 2 stage 2 (`0.2.0-rc.2`) exceeds a reasonable conflict budget, fall back to **rebuild-on-upstream**: start from upstream `0.2.2-alpha.2` and replay the 30 additive Anton packages onto it, abandoning the 1,697 upstream-file modifications. Cheaper than it sounds precisely because our value is additive — this is the escape hatch, not the opening move.