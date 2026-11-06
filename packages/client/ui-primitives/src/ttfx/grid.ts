/**
 * Animatable character arena and canvas layout, ported from the ttfx Ruby
 * port (`ttfx/canvas.rb`). Coordinates are 1-based bottom-up: columns
 * 1..=right, rows 1..=top. The image-grid extension stores each input
 * character's resolved home colors (`homeFg`/`homeBg`) so effects can carry
 * effect palettes in transit while the final frame lands on the image.
 * @module ui-primitives/ttfx/grid
 */

import type { Rgb } from './color.ts'
import type { Scene, MotionPath } from './scene.ts'
import type { Rng } from './rng.ts'

/** Grouping orders accepted by {@link Canvas.groupedIds}. */
export type CharGrouping =
  | 'column_left_to_right'
  | 'column_right_to_left'
  | 'row_bottom_to_top'
  | 'row_top_to_bottom'
  | 'diagonal_bottom_left_to_top_right'
  | 'diagonal_top_right_to_bottom_left'
  | 'diagonal_top_left_to_bottom_right'
  | 'diagonal_bottom_right_to_top_left'
  | 'center_to_outside'
  | 'outside_to_center'

/** One laid-out input cell: symbol plus its home colors. */
export interface GridCell {
  /** Character symbol; `' '` marks a skipped (transparent) cell. */
  sym: string
  /** Home foreground color (top half-block pixel), or null for none. */
  fg: Rgb | null
  /** Home background color (bottom half-block pixel), or null for none. */
  bg: Rgb | null
}

/** Per-character animation state (the scene-machine arena entry). */
export class CharAnim {
  /** Dense arena index, stable for the character lifetime. */
  readonly id: number
  /** Home column in the laid-out grid, 1-based. */
  inputCol: number
  /** Home row in the laid-out grid, 1-based from the bottom. */
  inputRow: number
  /** Original symbol, retained when effects change the current appearance. */
  readonly inputSym: string
  /** Home foreground color resolved at render time when curFg is null. */
  homeFg: Rgb | null
  /** Home background color (bottom half-block pixel). */
  homeBg: Rgb | null
  /** Whether frame rendering may include this character. */
  visible = false
  /** Scene queue entries by name. */
  readonly scenes = new Map<string, Scene>()
  /** Active scene name, or null. */
  active: string | null = null
  /** Symbol used by the current frame. */
  curSym: string
  /** Current foreground override; null resolves to homeFg when rendered. */
  curFg: Rgb | null
  /** Current background override; null resolves to homeBg when rendered. */
  curBg: Rgb | null
  /** Current column before the canvas offset, 1-based. */
  curCol: number
  /** Current row before the canvas offset, 1-based from the bottom. */
  curRow: number
  /** Named motion paths owned by this character. */
  readonly paths = new Map<string, MotionPath>()
  /** Active motion path name, or null when no path is active. */
  activePath: string | null = null
  /** Whether this character fills an unoccupied input cell. */
  isFill = false
  /** Render priority at a shared coordinate; higher values win. */
  layer = 0
  /** Neighbor character ids on the dense grid. */
  links: number[] = []
  /** Arena id one row above, or null at the grid edge. */
  north: number | null = null
  /** Arena id one column right, or null at the grid edge. */
  east: number | null = null
  /** Arena id one row below, or null at the grid edge. */
  south: number | null = null
  /** Arena id one column left, or null at the grid edge. */
  west: number | null = null

  /** @see {@link GridCell}; `homeFg`/`homeBg` carry the image colors. */
  constructor(id: number, col: number, row: number, sym: string, homeFg: Rgb | null, homeBg: Rgb | null) {
    this.id = id
    this.inputCol = col
    this.inputRow = row
    this.inputSym = sym
    this.homeFg = homeFg
    this.homeBg = homeBg
    this.curSym = sym
    this.curFg = null
    this.curBg = null
    this.curCol = col
    this.curRow = row
  }
}

/**
 * Animation canvas: input-sized character arena with fills, neighbor
 * links, and character grouping. The input grid is already laid out, so
 * the canvas clamps it into the (rows, cols) area without text reflow;
 * anchoring is a no-op when the canvas matches the input size.
 */
export class Canvas {
  /** Requested terminal height in cells. */
  readonly rows: number
  /** Requested terminal width in cells. */
  readonly cols: number
  /** Left canvas coordinate, fixed at 1. */
  readonly left = 1
  /** Bottom canvas coordinate, fixed at 1. */
  readonly bottom = 1
  /** Right input extent clipped to terminal columns, at least 1. */
  readonly right: number
  /** Top input extent clipped to terminal rows, at least 1. */
  readonly top: number
  /** Integer canvas center column using the engine rounding convention. */
  readonly centerColumn: number
  /** Integer canvas center row using the engine rounding convention. */
  readonly centerRow: number
  /** Minimum home column among kept input characters. */
  textLeft!: number
  /** Maximum home column among kept input characters. */
  textRight!: number
  /** Maximum home row among kept input characters. */
  textTop!: number
  /** Minimum home row among kept input characters. */
  textBottom!: number
  /** Inclusive column span of the kept input characters. */
  textWidth!: number
  /** Inclusive row span of the kept input characters. */
  textHeight!: number
  /** Integer midpoint of the kept text column bounds. */
  textCenterColumn!: number
  /** Integer midpoint of the kept text row bounds. */
  textCenterRow!: number
  /** Canvas-to-terminal column translation, fixed at zero. */
  readonly colOffset = 0
  /** Canvas-to-terminal row translation, fixed at zero. */
  readonly rowOffset = 0
  /** First renderable terminal column after applying the offset. */
  readonly visibleLeft: number
  /** Last renderable terminal column after applying the offset. */
  readonly visibleRight: number
  /** Last renderable terminal row after applying the offset. */
  readonly visibleTop: number
  /** First renderable terminal row after applying the offset. */
  readonly visibleBottom: number
  /** The full character arena (input characters then fills). */
  readonly anims: CharAnim[] = []
  /** Arena ids of visible input characters, in arena order. */
  kept: number[] = []
  /** Arena ids of fill characters for unoccupied cells. */
  readonly fills: number[] = []
  readonly #coordMap = new Map<number, number>()

  /**
   * @param rows - terminal rows (≥ input height; usually exactly it).
   * @param cols - terminal columns (≥ input width; usually exactly it).
   * @param lines - laid-out input grid, top line first, cells per line.
   */
  constructor(rows: number, cols: number, lines: readonly (readonly GridCell[])[]) {
    this.rows = rows
    this.cols = cols
    const inputWidth = lines.reduce((w, line) => Math.max(w, line.length), 0)
    const inputHeight = lines.length
    const w = Math.min(inputWidth, cols)
    const h = Math.min(inputHeight, rows)
    this.right = Math.max(1, w)
    this.top = Math.max(1, h)
    this.centerColumn = clampLow(floorDiv(this.right, 2) + (this.right % 2 !== 0 && this.right > 1 ? 1 : 0), this.left)
    this.centerRow = clampLow(floorDiv(this.top, 2) + (this.top % 2 !== 0 && this.top > 1 ? 1 : 0), this.bottom)
    this.visibleRight = Math.min(this.right + this.colOffset, cols)
    this.visibleLeft = Math.max(this.left + this.colOffset, 1)
    this.visibleTop = Math.min(this.top + this.rowOffset, rows)
    this.visibleBottom = Math.max(this.bottom + this.rowOffset, 1)
    this.#buildCharacters(lines)
    this.#anchorText()
    this.kept = this.kept.filter((id) => {
      const a = this.#at(id)
      return a.inputRow <= this.top && a.inputCol <= this.right
    })
    this.#buildFills()
    this.#buildNeighborMap()
    this.#buildTextMetrics()
  }

  /** Arena character by id (ids are dense and always valid by construction). */
  #at(id: number): CharAnim {
    return this.anims[id] as CharAnim
  }

  /** Build the arena from the laid-out grid (spaces are skipped). */
  #buildCharacters(lines: readonly (readonly GridCell[])[]): void {
    const inputHeight = lines.length
    let id = 0
    for (let r = 0; r < lines.length; r += 1) {
      const line = lines[r] as readonly GridCell[]
      for (let c = 0; c < line.length; c += 1) {
        const cell = line[c] as GridCell
        if (cell.sym !== ' ') {
          this.anims.push(new CharAnim(id, c + 1, inputHeight - r, cell.sym, cell.fg, cell.bg))
          id += 1
        }
      }
    }
  }

  /** Keep arena entries that land inside the canvas; fail loud when empty. */
  #anchorText(): void {
    this.kept = this.anims
      .filter(a => a.inputCol >= this.left && a.inputCol <= this.right && a.inputRow >= this.bottom && a.inputRow <= this.top)
      .map(a => a.id)
    if (this.kept.length === 0) throw new Error('all input characters fall outside the canvas after anchoring')
  }

  /** Text metrics over the kept characters (1-based bottom-up). */
  #buildTextMetrics(): void {
    const first = this.#at(this.kept[0] as number)
    let textLeft = first.inputCol
    let textRight = first.inputCol
    let textTop = first.inputRow
    let textBottom = first.inputRow
    for (const id of this.kept) {
      const a = this.#at(id)
      textLeft = Math.min(textLeft, a.inputCol)
      textRight = Math.max(textRight, a.inputCol)
      textTop = Math.max(textTop, a.inputRow)
      textBottom = Math.min(textBottom, a.inputRow)
    }
    this.textLeft = textLeft
    this.textRight = textRight
    this.textTop = textTop
    this.textBottom = textBottom
    this.textWidth = Math.max(1, textRight - textLeft + 1)
    this.textHeight = Math.max(1, textTop - textBottom + 1)
    this.textCenterRow = textBottom + floorDiv(textTop - textBottom, 2)
    this.textCenterColumn = textLeft + floorDiv(textRight - textLeft, 2)
  }

  /** Fill characters for every unoccupied canvas cell (row-major). */
  #buildFills(): void {
    const occupied = new Set<number>()
    for (const id of this.kept) {
      const a = this.#at(id)
      occupied.add(coordKey(a.inputRow, a.inputCol))
    }
    for (let r = 1; r <= this.top; r += 1) {
      for (let c = 1; c <= this.right; c += 1) {
        if (!occupied.has(coordKey(r, c))) {
          const id = this.anims.length
          const f = new CharAnim(id, c, r, ' ', null, null)
          f.isFill = true
          this.anims.push(f)
          this.fills.push(id)
        }
      }
    }
  }

  /** Coordinate → arena id over kept inputs + fills (dense grid). */
  #buildNeighborMap(): void {
    for (const id of [...this.kept, ...this.fills]) {
      const a = this.#at(id)
      this.#coordMap.set(coordKey(a.inputRow, a.inputCol), id)
    }
    for (const id of [...this.kept, ...this.fills]) {
      const a = this.#at(id)
      a.north = this.#coordMap.get(coordKey(a.inputRow + 1, a.inputCol)) ?? null
      a.east = this.#coordMap.get(coordKey(a.inputRow, a.inputCol + 1)) ?? null
      a.south = this.#coordMap.get(coordKey(a.inputRow - 1, a.inputCol)) ?? null
      a.west = this.#coordMap.get(coordKey(a.inputRow, a.inputCol - 1)) ?? null
    }
  }

  /**
   * Arena id at a coordinate.
   * @param col - cell column (1-based).
   * @param row - cell row (1-based).
   * @returns the arena id, or null when unoccupied.
   */
  charByCoord(col: number, row: number): number | null {
    return this.#coordMap.get(coordKey(row, col)) ?? null
  }

  /**
   * Kept ids sorted top-to-bottom, left-to-right (display order).
   * @param ids - id list; omitted → all kept ids.
   * @returns sorted ids.
   */
  orderedIds(ids?: readonly number[]): number[] {
    const list = ids ?? this.kept
    return [...list].sort((a, b) => {
      const ca = this.#at(a)
      const cb = this.#at(b)
      return cb.inputRow - ca.inputRow || ca.inputCol - cb.inputCol
    })
  }

  /**
   * Bucket kept ids into reveal groups.
   * @param grouping - grouping order (see {@link CharGrouping}).
   * @param ids - id list; omitted → all kept ids.
   * @returns non-empty id buckets in grouping order.
   */
  groupedIds(grouping: CharGrouping, ids?: readonly number[]): number[][] {
    const list = ids ?? this.kept
    const sorted = [...list].sort((a, b) => {
      const ca = this.#at(a)
      const cb = this.#at(b)
      return ca.inputRow - cb.inputRow || ca.inputCol - cb.inputCol
    })
    const keyOf = (id: number): number => {
      const a = this.#at(id)
      switch (grouping) {
        case 'column_left_to_right':
        case 'column_right_to_left':
          return a.inputCol
        case 'row_bottom_to_top':
        case 'row_top_to_bottom':
          return a.inputRow
        case 'diagonal_bottom_left_to_top_right':
        case 'diagonal_top_right_to_bottom_left':
          return a.inputRow + a.inputCol
        case 'diagonal_top_left_to_bottom_right':
        case 'diagonal_bottom_right_to_top_left':
          return a.inputCol - a.inputRow
        case 'center_to_outside':
        case 'outside_to_center':
          return Math.abs(a.inputCol - this.textCenterColumn) + Math.abs(a.inputRow - this.textCenterRow)
      }
    }
    const firstKey = Math.min(...sorted.map(keyOf))
    const lastKey = Math.max(...sorted.map(keyOf))
    let groups = buckets(sorted, firstKey, lastKey, keyOf)
    if (grouping === 'column_right_to_left' || grouping === 'row_top_to_bottom' || grouping === 'outside_to_center' ||
      grouping === 'diagonal_top_right_to_bottom_left' || grouping === 'diagonal_bottom_right_to_top_left') {
      groups = groups.reverse()
    }
    return groups
  }

  /** Kept input characters plus fills (full-canvas effects).
   * @returns arena entries in kept-input order followed by fill order.
   */
  renderAnims(): CharAnim[] {
    return [...this.kept, ...this.fills].map(id => this.#at(id))
  }

  /** Every kept id followed by every fill id.
   * @returns a new array of the kept and fill arena ids.
   */
  allIds(): number[] {
    return [...this.kept, ...this.fills]
  }

  /** Number of kept input characters. */
  get charCount(): number {
    return this.kept.length
  }

  /**
   * Random column, optionally restricted to the text bounds.
   * @param rng - draw source.
   * @param withinText - restrict to text bounds.
   * @returns column in the chosen range.
   */
  randomColumn(rng: Rng, withinText: boolean): number {
    return withinText ? rng.randint(this.textLeft, this.textRight) : rng.randint(this.left, this.right)
  }

  /**
   * Random row, optionally restricted to the text bounds.
   * @param rng - draw source.
   * @param withinText - restrict to text bounds.
   * @returns row in the chosen range.
   */
  randomRow(rng: Rng, withinText: boolean): number {
    return withinText ? rng.randint(this.textBottom, this.textTop) : rng.randint(this.bottom, this.top)
  }

  /**
   * Random coordinate; `outsideScope` picks one cell past a random edge.
   * The RNG call order (above, below, left, right, then choice) is part of
   * the deterministic contract.
   * @param rng - draw source.
   * @param outsideScope - pick just outside an edge.
   * @param withinText - restrict in-canvas picks to text bounds.
   * @returns `[col, row]`.
   */
  randomCoord(rng: Rng, outsideScope: boolean, withinText: boolean): [number, number] {
    if (outsideScope) {
      const above: [number, number] = [this.randomColumn(rng, false), this.top + 1]
      const below: [number, number] = [this.randomColumn(rng, false), this.bottom - 1]
      const left: [number, number] = [this.left - 1, this.randomRow(rng, false)]
      const right: [number, number] = [this.right + 1, this.randomRow(rng, false)]
      return rng.choice([above, below, left, right])
    }
    return [this.randomColumn(rng, withinText), this.randomRow(rng, withinText)]
  }
}

/** Bucket key for a coordinate (row * 1e6 + col; rows ≤ 1e6).
 * @param row - grid row.
 * @param col - grid column.
 * @returns the numeric coordinate key.
 */
export function coordKey(row: number, col: number): number {
  return row * 1_000_000 + col
}

/** Ruby/Python floor division. */
function floorDiv(a: number, b: number): number {
  return Math.floor(a / b)
}

/** Clamp to a lower bound. */
function clampLow(v: number, low: number): number {
  return v < low ? low : v
}

/** Group sorted ids into non-empty key buckets. */
function buckets(ids: number[], firstKey: number, lastKey: number, keyOf: (id: number) => number): number[][] {
  if (firstKey > lastKey) return []
  const count = lastKey - firstKey + 1
  const out: number[][] = Array.from({ length: count }, () => [])
  for (const id of ids) {
    const k = keyOf(id)
    /* v8 ignore next -- first and last keys are extrema of this same finite-key id list. */
    if (k >= firstKey && k <= lastKey) (out[k - firstKey] as number[]).push(id)
  }
  return out.filter(b => b.length > 0)
}
