# Agent Note: Windows and Linux Anton bundle scripts

Status: implemented

## Problem

Only macOS had an app assembly path (`build-anton-macos.ts` → `Anton.next.app`). The bridge source and every package are platform-portable, and the Landlock launcher already ships `linux-x64`/`linux-arm64` prebuilds, but nothing assembled a Windows or Linux candidate, so "cross build" was aspiration rather than wiring.

## Decision

`scripts/build-anton-windows.ts` and `scripts/build-anton-linux.ts` port the macOS assembly flow per platform: cross-compile the bridge with `bun build --compile --target=bun-windows-x64 | bun-linux-x64 | bun-linux-arm64`, download the target-OS Node archive from nodejs.org with SHA-256 verification (`node:crypto`, not macOS-only `shasum`), sync the same lib-only harness and c0ntext trees with the same shipping excludes, and validate required runtime files plus the no-first-party-TypeScript invariant. Each script generates its launcher: `Start Anton.cmd` and `start-anton.sh`/`anton.desktop`, both carrying the same `ANTON_*` environment contract `AntonApp.swift` establishes. `pnpm run anton:build:windows` / `anton:build:linux` invoke them. The scripts stay duplicated per platform on purpose — archive format, directory layout, and launcher facts differ, and scripts/AGENTS.md keeps platform adaptation in the platform's script rather than a shared layer.

Proven from this macOS host: both cross-compile targets produce real binaries (`file`: PE32+ x86-64 for Windows, ELF aarch64 for Linux). The full assembly (Node archive download, tree rsync, validation) is wired but first proven end-to-end when run on/for real target hardware.

## Alternatives considered

- **Shared bundle-helper module** — rejected: the three scripts share shape, not facts; a parameterized platform layer would reintroduce the coupling scripts/AGENTS.md assigns to each gate.
- **Empty stubs behind the pnpm scripts** (the initial state reviewed here) — rejected: silent no-op success fails the fail-loud rule and would mislead the first real cross-platform run.
- **AppImage/MSI packaging now** — deferred: a validated directory bundle is the parity step with macOS (which also ships a directory `.app`); installers are a follow-up once the bundles boot on real machines.

## Results

- `pnpm run anton:build:windows` assembles `dist/Anton-windows-x64` (x64 only — bun publishes no windows-arm64 target); `pnpm run anton:build:linux [x64|arm64]` assembles `dist/Anton-linux-<arch>`.
- Neither platform signs binaries (no Authenticode/codesign step); each script says so in its output. The c0ntext compose stub bakes in the build machine's checkout path, same as macOS.
