/**
 * Dag Flow renderer: an auto-laid-out SVG DAG of the run tree. Node fill is
 * the run state; edges are parent→child handoffs. DOM-building, no transport.
 */
import type { Run } from './contract.ts'
import { STATE_COLOR } from './contract.ts'

const W = 150
const H = 44
const GAP = 28
const SVG = 'http://www.w3.org/2000/svg'

interface Node {
  run: Run
  /** Column = tree depth. */
  x: number
  /** Row within the column. */
  y: number
}

/**
 * Depth-first grid layout of the run tree.
 * @param run - Tree root.
 * @param depth - Current column.
 * @param out - Accumulated nodes.
 * @param links - Accumulated parent→child id pairs.
 * @returns Nodes and links for the whole tree.
 */
function layout(
  run: Run,
  depth = 0,
  out: Node[] = [],
  links: Array<[string, string]> = [],
): { out: Node[]; links: Array<[string, string]> } {
  out.push({ run, x: depth, y: out.filter(n => n.x === depth).length })
  for (const c of run.children) {
    links.push([run.id, c.id])
    layout(c, depth + 1, out, links)
  }
  return { out, links }
}

/** Creates one SVG element with the given attributes. */
function el(name: string, attrs: Record<string, string | number> = {}): SVGElement {
  const n = document.createElementNS(SVG, name)
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v))
  return n
}

/**
 * Builds the scrollable SVG DAG for a run tree.
 * @param root - Tree root, or null for an empty board.
 * @param onFocus - Invoked with a run id when its node is clicked.
 * @returns The scrollable container holding the SVG.
 */
export function dagFlow(root: Run | null, onFocus: (id: string) => void = () => {}): HTMLElement {
  const wrap = document.createElement('div')
  wrap.style.cssText = 'flex:1;overflow:auto;position:relative'
  if (!root) return wrap

  const { out, links } = layout(root)
  const byId = new Map(out.map(n => [n.run.id, n]))
  const maxDepth = out.reduce((m, n) => Math.max(m, n.x), 0)
  const canvas = el('svg', {
    width: (maxDepth + 1) * (W + GAP),
    height: out.length * (H + GAP),
  })

  for (const [from, to] of links) {
    const a = byId.get(from)
    const b = byId.get(to)
    if (a === undefined || b === undefined) continue
    const x1 = a.x * (W + GAP) + W
    const y1 = a.y * (H + GAP) + H / 2
    const x2 = b.x * (W + GAP)
    const y2 = b.y * (H + GAP) + H / 2
    canvas.append(el('path', {
      d: `M${x1},${y1} C${x1 + 40},${y1} ${x2 - 40},${y2} ${x2},${y2}`,
      stroke: '#4b5563',
      fill: 'none',
      'stroke-width': 1.5,
    }))
  }

  for (const n of out) {
    const g = el('g', { transform: `translate(${n.x * (W + GAP)},${n.y * (H + GAP)})` })
    g.append(el('rect', { width: W, height: H, rx: 8, fill: STATE_COLOR[n.run.state], opacity: 0.85 }))
    const t1 = el('text', { x: 8, y: 18, 'font-size': 10, fill: '#fff' })
    t1.textContent = n.run.title.slice(0, 24)
    const t2 = el('text', { x: 8, y: 32, 'font-size': 9, fill: '#e5e7eb' })
    t2.textContent = `${n.run.role} · ${n.run.state}`
    g.append(t1, t2)
    g.style.cursor = 'pointer'
    g.addEventListener('click', () =>{  onFocus(n.run.id) })
    canvas.append(g)
  }
  wrap.append(canvas)
  return wrap
}
