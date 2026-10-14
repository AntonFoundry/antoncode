/**
 * Curated ttfx effect roster and registry. Each effect is a faithful port
 * from the ttfx Ruby port with one deliberate divergence: its final
 * gradient color resolves to each character's home color (the sampled
 * image color), so the resting frame is the mark itself. Default options
 * are tuned for a ~2-3s hero-mark reveal (the upstream defaults target
 * multi-second terminal runs).
 * @module ui-primitives/ttfx/effects
 */

import type { EngineCtx, FrameCell } from './scene.ts'
import { DecryptEffect } from './effects/decrypt.ts'
import { BurnEffect } from './effects/burn.ts'
import { RainEffect } from './effects/rain.ts'
import { FireworksEffect } from './effects/fireworks.ts'
import { ScatteredEffect } from './effects/scattered.ts'
import { ExpandEffect } from './effects/expand.ts'
import { MiddleoutEffect } from './effects/middleout.ts'
import { WavesEffect } from './effects/waves.ts'
import { UnstableEffect } from './effects/unstable.ts'
import { SpotlightsEffect } from './effects/spotlights.ts'
import { SweepEffect } from './effects/sweep.ts'
import { WipeEffect } from './effects/wipe.ts'

/** The curated hover-cycle roster, in cycle order. */
export const EFFECT_IDS = [
  'decrypt', 'burn', 'rain', 'fireworks', 'scattered', 'expand', 'middleout',
  'waves', 'unstable', 'spotlights', 'sweep', 'wipe',
] as const

/** One roster entry id. */
export type EffectId = (typeof EFFECT_IDS)[number]

/** A runnable effect instance. */
export interface TtfxEffect {
  /** Precompute scenes/paths; called once before the first frame. */
  build(): void
  /**
   * Advance one tick.
   * @returns the rendered cells, or null when the animation completed.
   */
  nextFrame(): FrameCell[] | null
}

/** Extra receiver effects with callback-driven particles implement. */
export interface CallbackEffect extends TtfxEffect {
  /**
   * Handle a registered callback fired by the engine.
   * @param ctx - owning engine context.
   * @param id - character id.
   * @param cbid - registered callback id.
   */
  onCallback(ctx: EngineCtx, id: number, cbid: number): void
}

/** Tuned default options per effect (hero-mark reveal timings). */
export const DEFAULT_EFFECT_OPTS: Record<EffectId, Record<string, unknown>> = {
  decrypt: { typing_speed: 40, fast_frames: 24, ciphertext_colors: ['008000', '00cb00', '00ff00'] },
  burn: { smoke_chance: 0.4, smoke_pool: 600 },
  rain: { activations_per_tick: [14, 22], movement_speed: [0.6, 1.0] },
  fireworks: { firework_volume: 0.12, launch_delay: 5, explode_distance: 0.18 },
  scattered: { movement_speed: 0.9, final_gradient_frames: 9, hold_ticks: 8 },
  expand: { movement_speed: 0.7, expand_easing: 'in_out_quart' },
  middleout: { center_movement_speed: 1.1, full_movement_speed: 1.1 },
  waves: { wave_count: 2, wave_length: 2, final_frames: 5 },
  unstable: { rumble_ticks: 80, hold_ticks: 18 },
  spotlights: { search_duration: 110 },
  sweep: {},
  wipe: {},
}

/**
 * Create a roster effect.
 * @param id - roster entry id.
 * @param ctx - engine context built over the character grid.
 * @param opts - option overrides merged over the tuned defaults.
 * @returns the effect instance (build not yet called).
 */
export function createEffect(id: EffectId, ctx: EngineCtx, opts: Record<string, unknown>): TtfxEffect {
  const merged = { ...DEFAULT_EFFECT_OPTS[id], ...opts }
  switch (id) {
    case 'decrypt': return new DecryptEffect(ctx, merged)
    case 'burn': return new BurnEffect(ctx, merged)
    case 'rain': return new RainEffect(ctx, merged)
    case 'fireworks': return new FireworksEffect(ctx, merged)
    case 'scattered': return new ScatteredEffect(ctx, merged)
    case 'expand': return new ExpandEffect(ctx, merged)
    case 'middleout': return new MiddleoutEffect(ctx, merged)
    case 'waves': return new WavesEffect(ctx, merged)
    case 'unstable': return new UnstableEffect(ctx, merged)
    case 'spotlights': return new SpotlightsEffect(ctx, merged)
    case 'sweep': return new SweepEffect(ctx, merged)
    case 'wipe': return new WipeEffect(ctx, merged)
  }
}
