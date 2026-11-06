/**
 * Faithful per-character scene machine, ported from the ttfx Ruby port
 * (`ttfx/scene.rb`). Scenes are plain frame queues with per-frame
 * durations; motion paths step waypoints with easing; events chain scene
 * and path activation. Characters are active while they hold a non-empty
 * scene or an active path. The canvas backend renders resolved
 * `{row, col, sym, fg, bg}` cells with layer/id dedup.
 * @module ui-primitives/ttfx/scene
 */

import type { Rgb } from './color.ts'
import { CharAnim } from './grid.ts'
import type { Canvas } from './grid.ts'
import { coordKey } from './grid.ts'
import { ease } from './easing.ts'
import type { EasingName } from './easing.ts'
import { roundHalfEven } from './pycompat.ts'
import type { Rng } from './rng.ts'

/** Event kinds that can trigger registered actions. */
export type EventKind = 'scene_complete' | 'path_complete' | 'path_activated'

/** Actions fired when a matching event fires on a character. */
export type EventAction =
  | { type: 'scene'; name: string }
  | { type: 'layer'; layer: number }
  | { type: 'deactivate_scene' }
  | { type: 'path'; name: string }
  | { type: 'callback'; id: number }

/** One registered event entry: fire `kind` from `caller` to run `action`. */
export interface EventEntry {
  kind: EventKind
  caller: string
  action: EventAction
}

/** Sync metrics for scenes that follow path progress. */
export type SyncMetric = 'step' | 'distance'

/** One scene frame: symbol + fg + optional bg + duration in ticks. */
export class Frame {
  /** Symbol displayed for this frame. */
  readonly sym: string
  /** Foreground override; null resolves to the character home color. */
  readonly fg: Rgb | null
  /** Background override; null resolves to the character home color. */
  readonly bg: Rgb | null
  /** Ticks for which this frame remains in the playback queue. */
  readonly duration: number
  /** Ticks already consumed during this playback of the frame. */
  ticks = 0

  /** @param sym - frame symbol. @param fg - foreground color or null. */
  constructor(sym: string, fg: Rgb | null, bg: Rgb | null, duration: number) {
    this.sym = sym
    this.fg = fg
    this.bg = bg
    this.duration = duration
  }
}

/** Visual tuple of a frame. */
type Visual = [string, Rgb | null, Rgb | null]

/**
 * Per-character frame queue with optional easing and looping.
 */
export class Scene {
  /** Character-local scene lookup name. */
  readonly name: string
  /** Easing used to select frames, or null for duration-queue playback. */
  readonly easeName: EasingName | null
  /** Path progress measure driving frame selection, or null for tick playback. */
  syncMetric: SyncMetric | null = null
  /** Whether ordinary queue playback restarts after its last frame. */
  looping = false
  /** All frames in insertion order. */
  readonly all: Frame[] = []
  /** Playback queue: indices into {@link Scene.all}. */
  readonly #queue: number[] = []
  #head = 0
  /** Duration-map for eased stepping (frame index per eased tick). */
  readonly #map: number[] = []
  /** Sum of all frame durations in ticks. */
  total: number
  #estep = 0

  /** @param name - scene name. @param easeName - eased stepping when set. */
  constructor(name: string, easeName: EasingName | null = null) {
    this.name = name
    this.easeName = easeName
    this.total = 0
  }

  /**
   * Append a frame.
   * @param sym - frame symbol.
   * @param fg - foreground color or null (home color at render time).
   * @param bg - background color or null (home color at render time).
   * @param duration - ticks before the frame retires (≥ 1).
   * @returns this scene, for chaining.
   */
  addFrame(sym: string, fg: Rgb | null, bg: Rgb | null, duration: number): this {
    if (duration < 1) throw new Error(`Frame duration must be at least 1. Received: ${duration}`)
    const idx = this.all.length
    this.all.push(new Frame(sym, fg, bg, duration))
    this.#queue.push(idx)
    if (this.easeName !== null) {
      for (let d = 0; d < duration; d += 1) this.#map.push(idx)
    }
    this.total += duration
    return this
  }

  /** True once the queue drained. */
  get empty(): boolean {
    return this.#head >= this.#queue.length
  }

  /**
   * First queued frame's visual; required before activation.
   * @returns `[sym, fg, bg]` of the head frame.
   */
  activate(): Visual {
    if (this.empty) throw new Error(`Scene ${this.name} has no frames.`)
    const f = this.all[this.#queue[this.#head] as number] as Frame
    return [f.sym, f.fg, f.bg]
  }

  /**
   * Tick the head frame, retiring it at duration. Looping scenes restore
   * the queue when it runs out.
   * @returns `[sym, fg, bg]` of the current head frame.
   */
  nextVisual(): Visual {
    const f = this.all[this.#queue[this.#head] as number] as Frame
    const vis: Visual = [f.sym, f.fg, f.bg]
    f.ticks += 1
    if (f.ticks === f.duration) {
      f.ticks = 0
      this.#head += 1
      if (this.looping && this.empty) this.#head = 0
    }
    return vis
  }

  /**
   * Eased stepping: visual by eased position over the duration map.
   * @returns `[visual, completed]`.
   */
  nextEased(): [Visual, boolean] {
    const fin = Math.max(0, this.total - 1)
    const factor = ease(this.easeName as EasingName, this.#estep / this.total)
    const fi = Math.min(fin, Math.max(0, roundHalfEven(factor * fin)))
    const f = this.all[this.#map[fi] as number] as Frame
    this.#estep += 1
    return [[f.sym, f.fg, f.bg], this.#estep === this.total]
  }

  /** Restore original order, zero tick counters and the easing step. */
  reset(): void {
    for (const f of this.all) f.ticks = 0
    this.#head = 0
    this.#estep = 0
  }
}

/** A movement path: waypoints, segments, and stepping state. */
export class MotionPath {
  /** Character-local motion path lookup name. */
  readonly name: string
  /** Distance consumed per tick using doubled-row terminal geometry. */
  readonly speed: number
  /** Distance easing, or null for linear traversal. */
  readonly ease: EasingName | null
  /** Ticks to wait at the final waypoint before completion. */
  readonly hold: number
  /** Whether completion reactivates a path with multiple segments. */
  readonly loop: boolean
  /** Render layer applied at activation, or null to retain the character layer. */
  readonly layer: number | null
  /** Waypoints `[col, row, control]`; control is a bezier control-point list. */
  readonly waypoints: [number, number, readonly (readonly [number, number])[] | null][] = []
  /** Segments `[fromRef, toIndex, length]`; fromRef -1 = path origin. */
  readonly segments: [number, number, number][] = []
  /** Combined segment length, including the activation origin segment. */
  total = 0
  /** Traversal ticks consumed since the latest activation. */
  step = 0
  /** Rounded total-distance-to-speed ratio for the active traversal. */
  maxSteps = 0
  /** Remaining ticks at the final waypoint. */
  holdLeft: number
  /** Most recently sampled eased distance along the full path. */
  lastDist = 0
  /** Activation-origin segment tuple, or null before activation. */
  origin: [number, number, number] | null = null
  /** Character coordinates captured at activation, or null before activation. */
  originWp: [number, number] | null = null

  /** @see {@link EngineCtx.motionNewPath} for parameter semantics. */
  constructor(name: string, speed: number, easeName: EasingName | null, hold: number, loop: boolean, layer: number | null = null) {
    this.name = name
    this.speed = speed
    this.ease = easeName
    this.hold = hold
    this.loop = loop
    this.layer = layer
    this.holdLeft = hold
  }

  /**
   * Progress ratio over the whole path for synced scenes.
   * @param byStep - true: step/maxSteps; false: distance consumed.
   * @returns ratio clamped into [0, 1].
   */
  syncRatio(byStep: boolean): number {
    if (byStep) {
      const denom = Math.max(1, this.maxSteps)
      const num = Math.max(1, this.step)
      return num / denom
    }
    const total = Math.max(1, this.total)
    const remaining = Math.max(1, this.total - this.lastDist)
    const reached = Math.max(1, total - remaining)
    return reached / total
  }
}

/** One rendered cell: 1-based bottom-up coordinates with resolved colors. */
export interface FrameCell {
  row: number
  col: number
  sym: string
  fg: Rgb | null
  bg: Rgb | null
}

/** Callback receiver for `callback` event actions. */
export interface EffectCallbackReceiver {
  /**
   * Handle a fired callback.
   * @param ctx - owning engine context.
   * @param id - character id.
   * @param cbid - registered callback id.
   */
  onCallback(ctx: EngineCtx, id: number, cbid: number): void
}

/**
 * Minimal engine context for animation-only effects. Owns the characters,
 * the active set (canonical ascending-id order), the event table, and the
 * canvas frame rendering.
 */
export class EngineCtx {
  /** Canvas layout and shared character arena rendered by this engine. */
  readonly canvas: Canvas
  /** Seeded random source shared by the effect and its helper algorithms. */
  readonly rng: Rng
  /** The character arena (alias of canvas.anims). */
  readonly chars: CharAnim[]
  /** Active character ids (ascending-id canonical order). */
  active: number[] = []
  readonly #events = new Map<number, EventEntry[]>()

  /** @param canvas - owning canvas. @param rng - draw source. */
  constructor(canvas: Canvas, rng: Rng) {
    this.canvas = canvas
    this.rng = rng
    this.chars = canvas.anims
  }

  /** Arena character by id (ids are dense and always valid by construction).
   * @param id - Character arena id owned by this engine.
   * @returns the mutable character state at the arena id.
   */
  anim(id: number): CharAnim {
    return this.chars[id] as CharAnim
  }

  /**
   * Append an arena character (overflow copies, particles).
   * @param sym - input symbol.
   * @param col - 1-based column.
   * @param row - 1-based row.
   * @returns the new arena id.
   */
  addCharacter(sym: string, col: number, row: number): number {
    const id = this.chars.length
    const a = new CharAnim(id, col, row, sym, null, null)
    this.chars.push(a)
    return id
  }

  /** Create an empty scene on a character.
   * @param id - Character arena id owned by this engine.
   * @param name - Character-local scene name.
   * @returns the new empty scene, replacing any scene with that name.
   */
  newScene(id: number, name: string): Scene {
    const sc = new Scene(name)
    this.anim(id).scenes.set(name, sc)
    return sc
  }

  /** Create an eased scene on a character.
   * @param id - Character arena id owned by this engine.
   * @param name - Character-local scene name.
   * @param easeName - Easing that maps playback ticks to frame indices.
   * @returns the new empty eased scene, replacing any scene with that name.
   */
  newSceneEased(id: number, name: string, easeName: EasingName): Scene {
    const sc = new Scene(name, easeName)
    this.anim(id).scenes.set(name, sc)
    return sc
  }

  /** Create a synced scene on a character (visual follows path progress).
   * @param id - Character arena id owned by this engine.
   * @param name - Character-local scene name.
   * @param metric - Active-path step or distance progress used to select frames.
   * @returns the new empty path-synchronized scene, replacing any scene with that name.
   */
  newSceneSynced(id: number, name: string, metric: SyncMetric): Scene {
    const sc = new Scene(name)
    sc.syncMetric = metric
    this.anim(id).scenes.set(name, sc)
    return sc
  }

  /** Create a looping scene on a character.
   * @param id - Character arena id owned by this engine.
   * @param name - Character-local scene name.
   * @returns the new empty looping scene, replacing any scene with that name.
   */
  newSceneLoop(id: number, name: string): Scene {
    const sc = new Scene(name)
    sc.looping = true
    this.anim(id).scenes.set(name, sc)
    return sc
  }

  /** Scene by name on a character.
   * @param id - Character arena id owned by this engine.
   * @param name - Existing character-local scene name.
   * @returns the existing mutable scene; the caller must create it before lookup.
   */
  scene(id: number, name: string): Scene {
    return this.anim(id).scenes.get(name) as Scene
  }

  /**
   * Append a frame to a character's scene.
   * @param id - Character arena id owned by this engine.
   * @param name - Existing scene to append to.
   * @param sym - Frame symbol.
   * @param duration - Ticks before the appended frame retires; must be at least 1.
   * @param fg - Foreground override, or null for the home color.
   * @param bg - optional background override (home color when null).
   */
  addFrame(id: number, name: string, sym: string, duration: number, fg: Rgb | null, bg: Rgb | null = null): void {
    this.scene(id, name).addFrame(sym, fg, bg, duration)
  }

  /**
   * Activate a scene: current visual becomes the scene's first frame
   * (resume semantics — playback is not reset).
   * @param id - Character arena id owned by this engine.
   * @param name - Existing non-empty scene to resume without resetting playback.
   */
  activateScene(id: number, name: string): void {
    const a = this.anim(id)
    const [sym, fg, bg] = (a.scenes.get(name) as Scene).activate()
    a.active = name
    a.curSym = sym
    a.curFg = fg
    a.curBg = bg
  }

  /** Set character visibility.
   * @param id - Character arena id owned by this engine.
   * @param flag - Whether rendering may include this character.
   */
  setVisible(id: number, flag: boolean): void {
    this.anim(id).visible = flag
  }

  /** Direct visual override, bypassing scenes.
   * @param id - Character arena id owned by this engine.
   * @param sym - Current symbol override.
   * @param fg - Foreground override, or null for the home color.
   * @param bg - Background override, or null for the home color.
   */
  setAppearance(id: number, sym: string, fg: Rgb | null, bg: Rgb | null = null): void {
    const a = this.anim(id)
    a.curSym = sym
    a.curFg = fg
    a.curBg = bg
  }

  /** Clear a character's active scene.
   * @param id - Character arena id owned by this engine.
   */
  deactivateScene(id: number): void {
    this.anim(id).active = null
  }

  /** Reset a scene's playback to its first frame.
   * @param id - Character arena id owned by this engine.
   * @param name - Existing scene whose frames and tick counters are reset.
   */
  resetScene(id: number, name: string): void {
    (this.anim(id).scenes.get(name) as Scene).reset()
  }

  /** hypot with the row delta doubled (terminal cell aspect convention).
   * @param c1col - Starting column.
   * @param c1row - Starting row.
   * @param c2col - Ending column.
   * @param c2row - Ending row.
   * @returns Euclidean distance with the row delta doubled.
   */
  lineLength(c1col: number, c1row: number, c2col: number, c2row: number): number {
    return Math.hypot(c2col - c1col, (c2row - c1row) * 2)
  }

  /** Lerp + banker's rounding to integer coords.
   * @param scol - Starting column.
   * @param srow - Starting row.
   * @param ecol - Ending column.
   * @param erow - Ending row.
   * @param t - Interpolation factor; values outside [0, 1] extrapolate.
   * @returns integer [column, row] coordinates using half-even rounding.
   */
  coordOnLine(scol: number, srow: number, ecol: number, erow: number, t: number): [number, number] {
    const x = (1 - t) * scol + t * ecol
    const y = (1 - t) * srow + t * erow
    return [roundHalfEven(x), roundHalfEven(y)]
  }

  /** Teleport a character.
   * @param id - Character arena id owned by this engine.
   * @param col - New current column, before the canvas offset.
   * @param row - New current row, before the canvas offset.
   */
  motionSetCoordinate(id: number, col: number, row: number): void {
    const a = this.anim(id)
    a.curCol = col
    a.curRow = row
  }

  /**
   * Create a motion path on a character.
   * @param speed - cells per tick (> 0).
   * @param easeName - path easing or null for linear.
   * @param hold - ticks to hold at the end before completion (≥ 0).
   * @param loop - reactivate the path on completion (multi-segment only).
   * @param layer - render layer while active (null keeps the current one).
   * @returns the path name (auto-numbered when empty).
   * @param id - Character arena id owned by this engine.
   * @param name - Path name to replace, or an empty string to allocate a numeric name.
   */
  motionNewPath(
    id: number,
    name: string,
    speed: number,
    easeName: EasingName | null,
    hold: number,
    loop: boolean,
    layer: number | null = null,
  ): string {
    if (speed <= 0) throw new Error(`Path speed must be greater than 0. Received: ${speed}`)
    let pname = name
    if (pname === '') {
      let n = this.anim(id).paths.size
      while (this.anim(id).paths.has(String(n))) n += 1
      pname = String(n)
    }
    this.anim(id).paths.set(pname, new MotionPath(pname, speed, easeName, hold, loop, layer))
    return pname
  }

  /**
   * Append a waypoint; from the second waypoint on, segment lengths and
   * maxSteps update.
   * @param control - optional bezier control points (absolute coords).
   * @param id - Character arena id owned by this engine.
   * @param pname - Existing path to extend.
   * @param col - Waypoint column.
   * @param row - Waypoint row.
   */
  motionAddWaypoint(id: number, pname: string, col: number, row: number, control?: readonly (readonly [number, number])[]): void {
    const p = this.anim(id).paths.get(pname) as MotionPath
    const ctrl = control !== undefined && control.length > 0 ? [...control] : null
    p.waypoints.push([col, row, ctrl])
    if (p.waypoints.length < 2) return
    const prev = p.waypoints[p.waypoints.length - 2] as [number, number, readonly (readonly [number, number])[] | null]
    const d = ctrl === null
      ? this.lineLength(prev[0], prev[1], col, row)
      : Geometry.bezierLength(prev[0], prev[1], ctrl, col, row)
    p.total += d
    const e = p.waypoints.length - 1
    p.segments.push([e - 1, e, d])
    p.maxSteps = roundHalfEven(p.total / p.speed)
  }

  /**
   * Replace a one-waypoint target while retaining the path's speed/easing
   * (rings-style orbit retarget).
   * @param id - Character arena id owned by this engine.
   * @param pname - Existing path whose waypoints and origin are replaced.
   * @param col - New target column.
   * @param row - New target row.
   */
  motionRetargetPath(id: number, pname: string, col: number, row: number): void {
    const p = this.anim(id).paths.get(pname) as MotionPath
    p.waypoints.length = 0
    p.segments.length = 0
    p.total = 0
    p.maxSteps = 0
    p.origin = null
    p.originWp = null
    this.motionAddWaypoint(id, pname, col, row)
  }

  /**
   * Activate a path from the character's current position: the origin
   * segment reaches the first waypoint, stepping restarts, and the
   * `path_activated` event fires.
   * @param id - Character arena id owned by this engine.
   * @param pname - Existing non-empty path to restart at the current character position.
   */
  motionActivatePath(id: number, pname: string): void {
    const a = this.anim(id)
    const p = a.paths.get(pname) as MotionPath
    if (p.waypoints.length === 0) throw new Error(`activate_path: empty path ${pname}`)
    const first = p.waypoints[0] as [number, number, readonly (readonly [number, number])[] | null]
    const d = first[2] === null
      ? this.lineLength(a.curCol, a.curRow, first[0], first[1])
      : Geometry.bezierLength(a.curCol, a.curRow, first[2], first[0], first[1])
    if (p.origin === null) {
      p.segments.unshift([-1, 0, d])
    } else {
      p.total -= p.origin[2]
      p.segments[0] = [-1, 0, d]
    }
    p.origin = [-1, 0, d]
    p.originWp = [a.curCol, a.curRow]
    p.total += d
    a.activePath = pname
    p.step = 0
    p.holdLeft = p.hold
    p.maxSteps = roundHalfEven(p.total / p.speed)
    if (p.layer !== null) a.layer = p.layer
    this.fireEvent(id, 'path_activated', pname)
  }

  /** Deactivate a path (clears the active path when it matches).
   * @param id - Character arena id owned by this engine.
   * @param pname - Path to deactivate when active, or null to deactivate any path.
   */
  motionDeactivatePath(id: number, pname: string | null): void {
    const a = this.anim(id)
    if (pname === null || a.activePath === pname) a.activePath = null
  }

  /**
   * Chain paths: each path's completion activates the next.
   * @param loop - the last path's completion reactivates the first.
   * @param id - Character arena id owned by this engine.
   * @param names - Ordered existing path names; fewer than two registers no actions.
   */
  chainPaths(id: number, names: readonly string[], loop: boolean): void {
    if (names.length < 2) return
    for (let i = 1; i < names.length; i += 1) {
      this.registerEvent(id, 'path_complete', names[i - 1] as string, { type: 'path', name: names[i] as string })
    }
    if (loop) {
      const last = names[names.length - 1] as string
      this.registerEvent(id, 'path_complete', last, { type: 'path', name: names[0] as string })
    }
  }

  /** One step along the active path; returns the new `[col, row]`. */
  #pathStep(p: MotionPath): [number, number] {
    if (p.maxSteps === 0 || p.step >= p.maxSteps || p.total === 0) {
      const last = p.waypoints[p.waypoints.length - 1] as [number, number, readonly (readonly [number, number])[] | null]
      return [last[0], last[1]]
    }
    p.step += 1
    const ratio = p.step / p.maxSteps
    const factor = p.ease === null ? ratio : ease(p.ease, ratio)
    let left = factor * p.total
    p.lastDist = left
    let idx: number | null = null
    for (let i = 0; i < p.segments.length; i += 1) {
      const seg = p.segments[i] as [number, number, number]
      if (left <= seg[2]) {
        idx = i
        break
      }
      left -= seg[2]
    }
    if (idx === null) {
      idx = p.segments.length - 1
      left += (p.segments[idx] as [number, number, number])[2]
    }
    const seg = p.segments[idx] as [number, number, number]
    let t = 0
    if (seg[2] !== 0) {
      t = left / seg[2]
      if (t > 1 && p.ease === null) t = 1
    }
    const s = seg[0] === -1
      ? (p.originWp as [number, number])
      : (p.waypoints[seg[0]] as [number, number, readonly (readonly [number, number])[] | null])
    const e = p.waypoints[seg[1]] as [number, number, readonly (readonly [number, number])[] | null]
    return e[2] === null
      ? this.coordOnLine(s[0], s[1], e[0], e[1], t)
      : Geometry.coordOnBezier(s[0], s[1], e[2], e[0], e[1], t)
  }

  /**
   * Step the character's active path; on completion holds, then either
   * loops (multi-segment) or deactivates and fires `path_complete`.
   * @param id - Character arena id owned by this engine.
   * @param effect - Optional receiver for callback actions fired at path completion.
   */
  motionMove(id: number, effect?: EffectCallbackReceiver): void {
    const a = this.anim(id)
    const pname = a.activePath
    if (pname === null) return
    const p = a.paths.get(pname) as MotionPath
    if (p.segments.length === 0) return
    const coord = this.#pathStep(p)
    a.curCol = coord[0]
    a.curRow = coord[1]
    if (p.step !== p.maxSteps) return
    if (p.hold !== 0 && p.holdLeft === p.hold) {
      p.holdLeft -= 1
      return
    }
    if (p.holdLeft !== 0) {
      p.holdLeft -= 1
      return
    }
    if (p.loop && p.segments.length > 1) {
      this.motionDeactivatePath(id, pname)
      this.motionActivatePath(id, pname)
    } else {
      this.motionDeactivatePath(id, pname)
      this.fireEvent(id, 'path_complete', pname, effect)
    }
  }

  /** Add an id to the active set (idempotent).
   * @param id - Character arena id owned by this engine.
   */
  activeInclude(id: number): void {
    if (!this.active.includes(id)) this.active.push(id)
  }

  /** Active ids in ascending order (the canonical snapshot).
   * @returns a sorted copy of the active ids.
   */
  activeSnapshot(): number[] {
    return [...this.active].sort((a, b) => a - b)
  }

  /** Clear the active set. */
  activeClear(): void {
    this.active.length = 0
  }

  /** True when nothing is active. */
  get activeEmpty(): boolean {
    return this.active.length === 0
  }

  /**
   * Register an event: when `kind` fires from `caller`, run `action`.
   * @returns the registered entry (for tests).
   * @param id - Character arena id owned by this engine.
   * @param kind - Event kind to match.
   * @param caller - Scene or path name whose event triggers the action.
   * @param action - Action appended to the character event table.
   */
  registerEvent(id: number, kind: EventKind, caller: string, action: EventAction): EventEntry {
    let list = this.#events.get(id)
    if (list === undefined) {
      list = []
      this.#events.set(id, list)
    }
    const entry: EventEntry = { kind, caller, action }
    list.push(entry)
    return entry
  }

  /** Convenience wrapper firing a `scene_complete` event.
   * @param id - Character arena id owned by this engine.
   * @param callerScene - Completed scene name matched against event registrations.
   * @param effect - Optional receiver for registered callback actions.
   */
  fireSceneComplete(id: number, callerScene: string, effect?: EffectCallbackReceiver): void {
    this.fireEvent(id, 'scene_complete', callerScene, effect)
  }

  /** Run all actions registered for an event.
   * @param id - Character arena id owned by this engine.
   * @param kind - Event kind to dispatch.
   * @param caller - Scene or path name matched against registered callers.
   * @param effect - Optional callback receiver; callback actions are skipped when omitted.
   */
  fireEvent(id: number, kind: EventKind, caller: string, effect?: EffectCallbackReceiver): void {
    const list = this.#events.get(id)
    if (list === undefined) return
    for (const { kind: k, caller: c, action } of list) {
      if (k !== kind || c !== caller) continue
      switch (action.type) {
        case 'scene': this.activateScene(id, action.name); break
        case 'layer': this.anim(id).layer = action.layer; break
        case 'deactivate_scene': this.deactivateScene(id); break
        case 'path': this.motionActivatePath(id, action.name); break
        case 'callback':
          if (effect !== undefined) effect.onCallback(this, id, action.id)
          break
        /* v8 ignore next -- EventAction is closed and every declared tag is handled above. */
        default: {
          const exhaustive: never = action
          return exhaustive
        }
      }
    }
  }

  /** Drop a character's event table.
   * @param id - Character arena id owned by this engine.
   */
  clearCharEvents(id: number): void {
    this.#events.delete(id)
  }

  /**
   * Cycle two sequences into pairs with the exact `cyclic_distribution`
   * generator semantics.
   * @returns pairs aligned to `larger`'s length.
   * @param larger - Sequence whose order and length determine the result.
   * @param smaller - Non-empty sequence distributed across the larger sequence.
   */
  cyclicPairs<T, U>(larger: readonly T[], smaller: readonly U[]): [T, U][] {
    const rf = Math.trunc(larger.length / smaller.length)
    let oc = larger.length % smaller.length
    let used = false
    let si = 0
    let rep = 0
    const out: [T, U][] = []
    for (const el of larger) {
      if (rep >= rf) {
        if (oc > 0) {
          if (used) {
            si += 1
            rep = 0
            used = false
          } else {
            used = true
            oc -= 1
          }
        } else {
          si += 1
          rep = 0
        }
      }
      rep += 1
      out.push([el, smaller[si] as U])
    }
    return out
  }

  /**
   * Apply a gradient to a scene's frames: symbols and colors cycled
   * against each other (one frame per pair).
   * @param bg - optional per-frame background color.
   * @param id - Character arena id owned by this engine.
   * @param sceneName - Existing scene receiving the generated frames.
   * @param symbols - Non-empty symbols distributed against the color sequence.
   * @param duration - Ticks for each appended frame; must be at least 1.
   * @param pairs - Non-empty gradient colors distributed against the symbols.
   */
  applyGradient(id: number, sceneName: string, symbols: readonly string[], duration: number, pairs: readonly Rgb[], bg?: Rgb | null): void {
    if (symbols.length >= pairs.length) {
      for (const [sym, pr] of this.cyclicPairs(symbols, pairs)) {
        this.addFrame(id, sceneName, sym, duration, pr, bg ?? null)
      }
    } else {
      for (const [pr, sym] of this.cyclicPairs(pairs, symbols)) {
        this.addFrame(id, sceneName, sym, duration, pr, bg ?? null)
      }
    }
  }

  /** Step one character's active scene, firing completion events.
   * @param id - Character arena id owned by this engine.
   * @param effect - Optional receiver for callback actions fired on scene completion.
   */
  stepAnimation(id: number, effect?: EffectCallbackReceiver): void {
    const a = this.anim(id)
    if (a.active === null) return
    const sc = a.scenes.get(a.active)
    if (sc === undefined || sc.empty) return
    if (sc.syncMetric !== null) {
      this.#stepSynced(id, a, sc, effect)
      return
    }
    if (sc.easeName === null) {
      const [sym, fg, bg] = sc.nextVisual()
      a.curSym = sym
      a.curFg = fg
      a.curBg = bg
      // oxlint-disable-next-line typescript/no-unnecessary-condition -- nextVisual advances the queue and can drain the scene.
      if (sc.empty) {
        sc.reset()
        const done = a.active
        a.active = null
        this.fireSceneComplete(id, done, effect)
      }
    } else {
      const [vis, done] = sc.nextEased()
      a.curSym = vis[0]
      a.curFg = vis[1]
      a.curBg = vis[2]
      if (done) {
        sc.reset()
        const aname = a.active
        a.active = null
        this.fireSceneComplete(id, aname, effect)
      }
    }
  }

  /** Synced scene stepping: visual follows path progress; frames never drain. */
  #stepSynced(id: number, a: CharAnim, sc: Scene, effect?: EffectCallbackReceiver): void {
    const pname = a.activePath
    if (pname === null) {
      const lastIdx = Math.max(0, sc.all.length - 1)
      const f = sc.all[lastIdx] as Frame
      a.curSym = f.sym
      a.curFg = f.fg
      a.curBg = f.bg
      sc.reset()
      const aname = a.active as string
      a.active = null
      this.fireSceneComplete(id, aname, effect)
      return
    }
    const p = a.paths.get(pname) as MotionPath
    const ratio = p.syncRatio(sc.syncMetric === 'step')
    const fin = Math.max(0, sc.all.length - 1)
    const fi = Math.min(fin, Math.max(0, roundHalfEven(ratio * fin)))
    const f = sc.all[fi] as Frame
    a.curSym = f.sym
    a.curFg = f.fg
    a.curBg = f.bg
  }

  /** True while a character still has a non-looping active scene or path.
   * @param id - Character arena id owned by this engine.
   * @returns true for an active path or a non-empty non-looping scene.
   */
  charActive(id: number): boolean {
    const a = this.anim(id)
    if (a.activePath !== null) return true
    if (a.active === null) return false
    const sc = a.scenes.get(a.active)
    if (sc === undefined) return false
    if (sc.looping) return false
    return !sc.empty
  }

  /**
   * Tick a snapshot of actives in ascending-id order (motion before
   * animation), then prune finished characters.
   * @param effect - Optional receiver for callbacks fired during this tick.
   */
  update(effect?: EffectCallbackReceiver): void {
    const snap = this.activeSnapshot()
    for (const id of snap) {
      this.motionMove(id, effect)
      this.stepAnimation(id, effect)
    }
    this.active = this.active.filter(id => this.charActive(id))
  }

  /**
   * Rendered cells for the canvas backend: visible characters inside the
   * visible window, deduped per coordinate by layer then id, colors
   * resolved to the home colors when the current value is null.
   * @returns cells in arena order.
   */
  frameCells(): FrameCell[] {
    const cv = this.canvas
    const grid = new Map<number, CharAnim>()
    for (const a of this.chars) {
      if (!a.visible) continue
      const r = a.curRow + cv.rowOffset
      const c = a.curCol + cv.colOffset
      if (r < cv.visibleBottom || r > cv.visibleTop) continue
      if (c < cv.visibleLeft || c > cv.visibleRight) continue
      const key = coordKey(r, c)
      const prev = grid.get(key)
      if (prev === undefined || a.layer > prev.layer || (a.layer === prev.layer && a.id > prev.id)) {
        grid.set(key, a)
      }
    }
    const cells: FrameCell[] = []
    for (const a of this.chars) {
      const key = coordKey(a.curRow + cv.rowOffset, a.curCol + cv.colOffset)
      if (grid.get(key) !== a) continue
      cells.push({
        row: a.curRow + cv.rowOffset,
        col: a.curCol + cv.colOffset,
        sym: a.curSym,
        fg: a.curFg ?? a.homeFg,
        bg: a.curBg ?? a.homeBg,
      })
    }
    return cells
  }
}

/** Geometry helpers (ttfx `src/utils/geometry.rs`). */
export const Geometry = {
  /**
   * De Casteljau of arbitrary degree, rounded only at the end.
   * @returns `[col, row]` at parameter t.
   */
  coordOnBezier(
    scol: number,
    srow: number,
    control: readonly (readonly [number, number])[],
    ecol: number,
    erow: number,
    t: number,
  ): [number, number] {
    if (control.length === 0) {
      const x = (1 - t) * scol + t * ecol
      const y = (1 - t) * srow + t * erow
      return [roundHalfEven(x), roundHalfEven(y)]
    }
    const pts: [number, number][] = [[scol, srow], ...control.map(c => [c[0], c[1]] as [number, number]), [ecol, erow]]
    let remaining = pts.length
    while (remaining > 1) {
      for (let i = 0; i < remaining - 1; i += 1) {
        const a = pts[i] as [number, number]
        const b = pts[i + 1] as [number, number]
        pts[i] = [
          (1 - t) * a[0] + t * b[0],
          (1 - t) * a[1] + t * b[1],
        ]
      }
      remaining -= 1
    }
    const head = pts[0] as [number, number]
    return [roundHalfEven(head[0]), roundHalfEven(head[1])]
  },

  /** Doubled-row line length (terminal cell aspect convention). */
  lineLengthDoubled(c1col: number, c1row: number, c2col: number, c2row: number): number {
    return Math.hypot(c2col - c1col, (c2row - c1row) * 2)
  },

  /** 10-sample polyline stopping at t=0.9 (faithful length underestimate). */
  bezierLength(
    scol: number,
    srow: number,
    control: readonly (readonly [number, number])[],
    ecol: number,
    erow: number,
  ): number {
    let len = 0
    let pc = scol
    let pr = srow
    for (let t = 1; t < 10; t += 1) {
      const cc = Geometry.coordOnBezier(scol, srow, control, ecol, erow, t / 10)
      len += Geometry.lineLengthDoubled(pc, pr, cc[0], cc[1])
      pc = cc[0]
      pr = cc[1]
    }
    return len
  },

  /**
   * Extrapolate past target by offset (non-doubled hypot length, rounded).
   * @returns `[col, row]`.
   */
  extrapolateRay(ocol: number, orow: number, tcol: number, trow: number, offset: number): [number, number] {
    const dx = tcol - ocol
    const dy = trow - orow
    const base = Math.hypot(dx, dy)
    const total = base + offset
    if (total === 0 || (ocol === tcol && orow === trow)) return [tcol, trow]
    const t = total / base
    const x = (1 - t) * ocol + t * tcol
    const y = (1 - t) * orow + t * trow
    return [roundHalfEven(x), roundHalfEven(y)]
  },

  /**
   * Column-major ellipse cells (diameter 0 → empty).
   * @returns `[col, row]` pairs inside the circle.
   */
  coordsInCircle(h: number, k: number, diameter: number): [number, number][] {
    const out: [number, number][] = []
    if (diameter === 0) return out
    const a2 = diameter ** 2
    const b2 = (diameter / 2) ** 2
    for (let x = h - diameter; x <= h + diameter; x += 1) {
      const xc = (x - h) ** 2 / a2
      const maxY = Math.trunc(Math.sqrt(b2 * (1 - xc)))
      for (let y = k - maxY; y <= k + maxY; y += 1) out.push([x, y])
    }
    return out
  },
}
