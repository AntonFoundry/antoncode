/**
 * Fixed-position inset compensation for CSS zoom. Empirical ground truth on
 * this Chromium build (probed via Playwright): `getBoundingClientRect`
 * returns true viewport coordinates inside zoomed subtrees; a plain
 * `position: fixed` probe paints exactly at its inset; and a fixed probe
 * carrying its own `zoom` paints at inset × own zoom. Each zoomed ancestor
 * compounds the factor multiplicatively, and `zoom` is not inherited
 * (descendants compute to `1`), so the factor for a fixed element is the
 * product of the computed `zoom` values from the element itself up through
 * the root. Primitives that place fixed elements from measured rects divide
 * those rects by this factor so the painted position lands on the anchor.
 */

/**
 * Compute the inset-multiplier zoom factor acting on a fixed-position element.
 * @param element - the fixed-position element (or a stand-in in the same
 *   subtree, when both share one zoom context); null reads as 1.
 * @returns the product of computed `zoom` values from the element through the
 *   document root; 1 wherever the engine reports no numeric zoom.
 */
export function fixedInsetScale(element: Element | null): number {
  if (element === null) return 1
  let scale = 1
  for (let node: Element | null = element; node !== null; node = node.parentElement) {
    const zoom = Number.parseFloat(getComputedStyle(node).zoom)
    if (Number.isFinite(zoom) && zoom > 0) scale *= zoom
  }
  return scale
}
