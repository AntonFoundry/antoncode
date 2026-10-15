# Agent Note: TTFX reveal for the hero mark

Status: implemented

## Problem

The welcome hero used a CSS shake on pointer hover, which did not reveal the mark or match the character-based effect the user requested. The sidebar mark also shares the `FishLogo` component, so changing that component would animate a surface that must remain static.

## Decision

The hero uses `FishLogoAnimated` from `ui-primitives`; the sidebar continues using static `FishLogo`. `FishLogoAnimated` samples `/anton-mark.png` into half-block cells, runs a TTFX reveal in a canvas overlay, and leaves the original image underneath. The hero chooses one effect from the full roster when it mounts; `ConversationRoot` keys `HeroShell` by `sessionId`, so rerenders preserve the choice and each new session gets a fresh selection. Pointer entries cycle through the other eleven effects. The overlay fades away after the terminal frame, exposing the original image. A reduced-motion preference leaves only the image visible.

The engine and effect roster live in [`ui-primitives/src/ttfx`](../../../../packages/client/ui-primitives/src/ttfx/run.ts). The effect palettes resolve to sampled home colors at their terminal frame, including null foreground pixels from the rounded-corner mask. The browser animation is limited to 24 frames per second. [`ttfx-dump.ts`](../../../../packages/client/ui-primitives/scripts/ttfx-dump.ts) decodes the shipped PNG, runs every effect with a fixed seed, dumps representative PNG frames, and verifies exact terminal-raster equality against the sampled resting mark.

## Alternatives considered

**Keep the CSS shake and remove hover animation.** Rejected because the request explicitly asked to replace the shake with a reveal effect, not only remove motion.

**Replace the image with an animated GIF.** Rejected because it would lose pointer-driven effect cycling, deterministic engine behavior, accessibility handling, and exact source-image restoration.

**Add a separate UI package for the effect.** Rejected because the feature is presentation owned by the existing shared `ui-primitives` layer; it creates no service, state lifetime, or independent capability seam.

## Consequences

The hero and sidebar now have separate presentation behavior while preserving one source mark image. The canvas is an overlay, so decoding or animation failure leaves the static image visible. The browser samples a 96-column grid and runs the 12-effect roster locally; the engine has no React or DOM dependency. The implementation is covered by the UI-primitives and ui-conversation test suites, with the repository coverage gate applying to every new source file.

## Testing

The deterministic Node QA run over `apps/web/public/anton-mark.png` reports that every effect's final raster matches the resting image grid and that an earlier frame differs. All ten TTFX specs pass with 100% statements, branches, functions, and lines across every `ttfx` source file; `FishLogoAnimated` also passes its per-file 100% coverage gate. A regression test confirms same-session renders preserve the hero and changing `sessionId` remounts it; the injected random source is sampled once per mount and chooses across the full roster. Focused hero integration tests and workspace typecheck pass. `pnpm run test:gui` still fails only at the unrelated worktree locale assertion (`mode.new` expects “New worktree” but receives “New worktree (next session)”). The web replay was attempted and failed on unrelated existing model-selection, onboarding, reasoning, permission-policy, and steering scenarios; no hero-specific regression was reported.
