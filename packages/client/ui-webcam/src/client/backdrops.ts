/**
 * Built-in replace backdrops and remove colors: linear-RGB triplets consumed
 * by the composite shader plus CSS gradients for the picker swatches, derived
 * from the same data so the swatch never lies about the shader output.
 * @module @deepseek-ai/dsh-client-ui-webcam/client/backdrops
 */

/** One built-in vertical-gradient backdrop. */
export interface Backdrop {
  /** Stable id (picker keys, tests). */
  id: string
  /** Picker label (product copy, Chinese). */
  label: string
  /** Top gradient stop, linear 0–1 RGB. */
  top: readonly [number, number, number]
  /** Bottom gradient stop, linear 0–1 RGB. */
  bottom: readonly [number, number, number]
}

/** The built-in gradient backdrops, in picker order. */
export const BACKDROPS: readonly Backdrop[] = [
  { id: 'dawn', label: 'Dawn Mist', top: [0.99, 0.85, 0.67], bottom: [0.91, 0.56, 0.44] },
  { id: 'dusk', label: 'Dusk', top: [0.35, 0.29, 0.62], bottom: [0.90, 0.40, 0.52] },
  { id: 'pine', label: 'Pine Forest', top: [0.42, 0.65, 0.55], bottom: [0.10, 0.29, 0.30] },
  { id: 'abyss', label: 'Deep Sea', top: [0.16, 0.42, 0.69], bottom: [0.03, 0.12, 0.28] },
  { id: 'graphite', label: 'Graphite', top: [0.36, 0.39, 0.44], bottom: [0.13, 0.14, 0.17] },
  { id: 'rose', label: 'Rose', top: [0.98, 0.72, 0.78], bottom: [0.72, 0.28, 0.45] },
]

/** Solid colors for the remove effect, linear 0–1 RGB with labels. */
export const REMOVE_COLORS: { studio: readonly [number, number, number]; green: readonly [number, number, number] } = {
  studio: [0.10, 0.11, 0.14],
  green: [0.00, 0.69, 0.25],
}

/**
 * CSS linear-gradient for one backdrop's picker swatch.
 * @param backdrop - the backdrop to render.
 * @returns a CSS `linear-gradient` value matching the shader's output orientation.
 */
export function backdropCss(backdrop: Backdrop): string {
  const channel = (v: number): string => String(Math.round(v * 255))
  const top = `rgb(${backdrop.top.map(channel).join(' ')})`
  const bottom = `rgb(${backdrop.bottom.map(channel).join(' ')})`
  return `linear-gradient(to bottom, ${top}, ${bottom})`
}

/**
 * Look up a backdrop by index, clamped into range.
 * @param index - store index (may be stale after a backdrop list change).
 * @returns the resolved backdrop.
 */
export function backdropAt(index: number): Backdrop {
  const first = BACKDROPS[0]
  if (first === undefined) throw new Error('webcam: backdrop table is empty')
  const clamped = Math.min(BACKDROPS.length - 1, Math.max(0, index))
  return BACKDROPS[clamped] ?? first
}
