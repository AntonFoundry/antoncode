import { describe, expect, it } from 'vitest'
import { EFFECT_IDS } from '../src/ttfx/effects.ts'
import type { EffectId } from '../src/ttfx/effects.ts'
import type { GridCell } from '../src/ttfx/grid.ts'
import { runEffect } from '../src/ttfx/run.ts'
import { Canvas } from '../src/ttfx/grid.ts'
import { Rng } from '../src/ttfx/rng.ts'
import { EngineCtx } from '../src/ttfx/scene.ts'
import { BurnEffect } from '../src/ttfx/effects/burn.ts'
import { RainEffect } from '../src/ttfx/effects/rain.ts'
import { SpotlightsEffect } from '../src/ttfx/effects/spotlights.ts'
import { RevealRunner } from '../src/ttfx/run.ts'

const grid: GridCell[][] = [
  [{ sym: 'A', fg: [20, 40, 60], bg: [70, 80, 90] }, { sym: 'B', fg: [30, 50, 70], bg: null }, { sym: ' ', fg: null, bg: null }],
  [{ sym: 'C', fg: [40, 60, 80], bg: [90, 100, 110] }, { sym: 'D', fg: null, bg: [120, 130, 140] }, { sym: 'E', fg: [150, 160, 170], bg: [180, 190, 200] }],
  [{ sym: ' ', fg: null, bg: null }, { sym: 'F', fg: [200, 180, 160], bg: [140, 120, 100] }, { sym: 'G', fg: [80, 60, 40], bg: [20, 10, 5] }],
]

describe('ttfx effect seeded branches', () => {
  it('keeps every curated effect deterministic across varied random paths', () => {
    for (const effect of EFFECT_IDS) {
      for (const seed of [1, 2, 3, 4, 5, 7, 11, 17, 23]) {
        const frames = runEffect(grid, { effect, seed }, 2500)
        expect(frames.length, `${effect} seed ${seed}`).toBeGreaterThan(0)
        expect(frames.at(-1)?.length, `${effect} final frame seed ${seed}`).toBeGreaterThan(0)
        const replay = runEffect(grid, { effect, seed }, 2500)
        expect(replay, `${effect} deterministic seed ${seed}`).toEqual(frames)
      }
    }
    const options: Partial<Record<EffectId, Record<string, unknown>>> = {
      decrypt: { typing_speed: 1, fast_frames: 1, ciphertext_colors: ['invalid'] },
      burn: { smoke_chance: 1, smoke_pool: 0, burn_colors: ['invalid'], starting_color: 'invalid' },
      rain: {
        rain_colors: ['invalid'],
        activations_per_tick: [1, 1],
        movement_speed: [0.5, 0.5],
        movement_easing: 'linear',
      },
      fireworks: {
        explode_anywhere: true,
        firework_colors: ['invalid'],
        firework_volume: 0.5,
        launch_delay: 0,
        explode_distance: 0.5,
      },
      scattered: { movement_speed: 0.5, final_gradient_frames: 1, hold_ticks: 0 },
      expand: { movement_speed: 0.5, expand_easing: 'linear' },
      middleout: {
        expand_direction: 'horizontal',
        center_movement_speed: 0.8,
        full_movement_speed: 0.8,
      },
      waves: { wave_gradient_stops: ['invalid'], wave_count: 1, wave_length: 2, final_frames: 1 },
      unstable: { rumble_ticks: 1, hold_ticks: 0 },
      spotlights: { search_duration: 1 },
      sweep: {
        sweep_colors: ['invalid'],
        first_sweep_direction: 'row_top_to_bottom',
        second_sweep_direction: 'row_bottom_to_top',
      },
      wipe: {
        wipe_colors: ['invalid'],
        wipe_ease: 'in_out_elastic',
        wipe_delay: 1,
        wipe_direction: 'outside_to_center',
      },
    }
    for (const effect of EFFECT_IDS) {
      const frames = runEffect(grid, { effect, seed: 37, opts: options[effect] ?? {} }, 2500)
      expect(frames.length, `${effect} configured path`).toBeGreaterThan(0)
      expect(frames.at(-1)?.length, `${effect} configured final frame`).toBeGreaterThan(0)
    }
    const optionNames = [
      'typing_speed', 'ciphertext_colors', 'fast_frames', 'starting_color', 'burn_colors',
      'smoke_chance', 'smoke_pool', 'rain_colors', 'rain_symbols', 'movement_speed',
      'activations_per_tick', 'movement_easing', 'explode_anywhere', 'firework_colors',
      'firework_symbol', 'firework_volume', 'launch_delay', 'explode_distance',
      'final_gradient_frames', 'hold_ticks', 'expand_easing', 'expand_direction',
      'center_movement_speed', 'full_movement_speed', 'center_easing', 'full_easing',
      'wave_gradient_stops', 'wave_gradient_steps', 'wave_count', 'wave_length',
      'wave_direction', 'wave_easing', 'final_gradient_steps', 'final_frames',
      'explosion_speed', 'explosion_ease', 'reassembly_speed', 'reassembly_ease',
      'rumble_ticks', 'rumble_delay', 'search_duration', 'search_speed_range',
      'spotlight_count', 'beam_width_ratio', 'beam_falloff', 'sweep_symbols',
      'first_sweep_direction', 'second_sweep_direction', 'sweep_colors', 'sweep_steps',
      'wipe_direction', 'wipe_delay', 'wipe_ease', 'wipe_colors', 'wipe_steps', 'wipe_frames',
    ]
    const fallbackOptions = Object.fromEntries(optionNames.map(name => [name, undefined]))
    const defaults = Object.fromEntries(EFFECT_IDS.map(effect => [effect, fallbackOptions])) as
      Record<EffectId, Record<string, unknown>>
    for (const effect of EFFECT_IDS) {
      const frames = runEffect(grid, { effect, seed: 91, opts: defaults[effect] }, 2500)
      expect(frames.length, `${effect} default-option path`).toBeGreaterThan(0)
    }
    const oneCell: GridCell[][] = [[{ sym: 'x', fg: null, bg: null }]]
    expect(runEffect(oneCell, { effect: 'scattered', seed: 5 }, 300).at(-1)?.length).toBeGreaterThan(0)
    const burnCtx = new EngineCtx(new Canvas(1, 1, oneCell), new Rng(5))
    const burn = new BurnEffect(burnCtx, { smoke_chance: 1, smoke_pool: 0 })
    burn.build()
    burn.onCallback(burnCtx, 0, 0)
    burn.onCallback(burnCtx, 0, 1)
    burn.onCallback(burnCtx, 0, 99)
    const rainCtx = new EngineCtx(new Canvas(3, 3, grid), new Rng(15))
    const ordered = rainCtx.canvas.orderedIds.bind(rainCtx.canvas)
    rainCtx.canvas.orderedIds = ids => ordered(ids).reverse()
    const rain = new RainEffect(rainCtx, {
      rain_colors: ['invalid'],
      activations_per_tick: [1, 1],
      movement_speed: [1, 1],
      movement_easing: 'linear',
    })
    rain.build()
    let rainFrames = 0
    while (rain.nextFrame() !== null && rainFrames < 2500) rainFrames += 1
    expect(rainFrames).toBeGreaterThan(0)
    const wideGrid: GridCell[][] = Array.from({ length: 4 }, (_, row) =>
      Array.from({ length: 4 }, (_, col) => ({
        sym: String.fromCharCode(65 + row * 4 + col),
        fg: [40 + row * 20, 60 + col * 20, 90],
        bg: null,
      })),
    )
    const spotCtx = new EngineCtx(new Canvas(4, 4, wideGrid), new Rng(57))
    const spotlights = new SpotlightsEffect(spotCtx, {
      spotlight_count: 1,
      search_duration: 1,
      search_speed_range: [0.8, 0.8],
      beam_width_ratio: 1,
      beam_falloff: 0.9,
    })
    spotlights.build()
    let spotFinished = false
    for (let i = 0; i < 5000; i += 1) {
      if (spotlights.nextFrame() === null) {
        spotFinished = true
        break
      }
    }
    expect(spotFinished).toBe(true)
    for (let seed = 0; seed < 24; seed += 1) {
      const retryCtx = new EngineCtx(new Canvas(4, 4, wideGrid), new Rng(seed))
      new SpotlightsEffect(retryCtx, { spotlight_count: 1, search_duration: 1 }).build()
    }
    const unstable = new RevealRunner(grid, { effect: 'unstable', seed: 73, opts: { rumble_ticks: 1, hold_ticks: 0 } })
    while (unstable.next() !== null) { /* drain the finite reveal */ }
    expect(unstable.next()).toBeNull()
  })
})
