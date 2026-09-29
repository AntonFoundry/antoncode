/**
 * Dag Flow canvas: the Langflow-style node graph over the orchestrator's
 * missions, spawned agents, and plan tasks. Pan on background drag, wheel zoom
 * anchored at the cursor, fit, lock, a minimap, a status legend, and a
 * selection inspector. Read-only: the graph is a projection of the board, so
 * the canvas validates and highlights connections instead of mutating them.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { FC, KeyboardEvent, MouseEvent as ReactMouseEvent } from 'react'
import {
  FLOW_KIND_CLASS,
  FLOW_KINDS,
  FLOW_STATUS_CLASS,
  FLOW_STATUS_ORDER,
  boundsOf,
  centreOn,
  edgeShapes,
  fitView,
  isLiveStatus,
  layoutFlow,
  minimapScale,
  nodeSize,
  panBy,
  placedNodes,
  toPlane,
  zoomAt,
  type FlowBox,
  type FlowGraph,
  type FlowNode,
  type FlowNodeKind,
  type FlowPoint,
  type FlowStatus,
  type FlowView,
} from './flow.ts'
import type { OrchestratorKey } from './locales.ts'
import css from './dagflow.module.css'

/** Localized copy the canvas chrome renders; supplied by the inject face. */
export interface DagFlowLabels {
  /** Accessible name of the canvas and its node group. */
  canvas: string
  /** Empty-state text when the board has no runs. */
  empty: string
  zoomIn: string
  zoomOut: string
  fit: string
  /** Accessible name of the minimap, whose click recentres the view. */
  minimap: string
  lock: string
  unlock: string
  close: string
  /** Inspector button that focuses the selected node's session. */
  focus: string
  fieldKind: string
  fieldStatus: string
  fieldSession: string
  fieldPath: string
  /** Inspector section listing a node's downstream steps. */
  steps: string
  /** Accessible name of the status legend. */
  legend: string
  kind: Record<FlowNodeKind, string>
  status: Record<FlowStatus, string>
}

/** Props of the Dag Flow canvas. */
export interface DagFlowProps {
  /** Graph built from the latest board snapshot. */
  graph: FlowGraph
  labels: DagFlowLabels
  /** Raised with a session id when the user asks to focus that node's session. */
  onFocus: (sessionId: string) => void
}

/**
 * Builds the canvas copy from the plugin's bound translate, so the chrome
 * follows the active locale on every inject.
 * @param t - Bound translate for the plugin's own namespace.
 * @returns The canvas labels, one entry per kind and status.
 */
export function dagFlowLabels(t: (key: OrchestratorKey) => string): DagFlowLabels {
  const kind = Object.fromEntries(FLOW_KINDS.map(k => [k, t(`flow.kind.${k}`)])) as Record<FlowNodeKind, string>
  const status = Object.fromEntries(FLOW_STATUS_ORDER.map(s => [s, t(`flow.status.${s}`)])) as Record<FlowStatus, string>
  return {
    canvas: t('flow.canvas'),
    empty: t('flow.empty'),
    zoomIn: t('flow.zoomIn'),
    zoomOut: t('flow.zoomOut'),
    fit: t('flow.fit'),
    minimap: t('flow.minimap'),
    lock: t('flow.lock'),
    unlock: t('flow.unlock'),
    close: t('flow.close'),
    focus: t('flow.focus'),
    fieldKind: t('flow.field.kind'),
    fieldStatus: t('flow.field.status'),
    fieldSession: t('flow.field.session'),
    fieldPath: t('flow.field.path'),
    steps: t('flow.steps'),
    legend: t('flow.legend'),
    kind,
    status,
  }
}

/** Minimap box in pixels. */
const MINIMAP: FlowPoint = { x: 176, y: 116 }
/** Minimap padding, so node dots never touch its border. */
const MINIMAP_PAD = 6

/** Wheel sensitivity: one pixel of deltaY is this much zoom, exponentially applied. */
const WHEEL_ZOOM = 0.0015

/** Multiplicative step of the zoom buttons and the keyboard zoom. */
const STEP = 1.2

/** The initial viewport for an unmeasured canvas: identity, offset from the edge. */
const INITIAL_VIEW: FlowView = { x: 24, y: 24, scale: 1 }

/** Joins the class names that apply, dropping falsy ones. */
const cx = (...parts: Array<string | false | undefined>): string => parts.filter(Boolean).join(' ')

/** Format a scale as a percentage label. */
const percent = (scale: number): string => `${Math.round(scale * 100)}%`

/**
 * Dag Flow canvas component.
 * @param props - Graph, localized copy, and the focus callback.
 * @returns The canvas with its chrome, or the empty state when the graph is bare.
 */
export const DagFlow: FC<DagFlowProps> = ({ graph, labels, onFocus }) => {
  const canvasRef = useRef<HTMLDivElement | null>(null)
  const [view, setView] = useState<FlowView>(INITIAL_VIEW)
  const [size, setSize] = useState<FlowPoint>({ x: 0, y: 0 })
  const [selected, setSelected] = useState<string | null>(null)
  const [drag, setDrag] = useState<FlowPoint | null>(null)
  const [locked, setLocked] = useState(false)

  const boxes = useMemo(() => layoutFlow(graph), [graph])
  const bounds = useMemo(() => boundsOf(boxes.values()), [boxes])
  const placed = useMemo(() => placedNodes(graph, boxes), [graph, boxes])
  const shapes = useMemo(() => edgeShapes(graph, boxes), [graph, boxes])
  const minimapK = minimapScale(bounds, MINIMAP, MINIMAP_PAD)
  const selectedNode = graph.nodes.find(n => n.id === selected) ?? null
  const empty = graph.nodes.length === 0

  /** Enlarges a plane point by the minimap's scale and padding offset. */
  const onMap = (point: FlowPoint): FlowPoint => ({
    x: (point.x - bounds.minX) * minimapK + MINIMAP_PAD,
    y: (point.y - bounds.minY) * minimapK + MINIMAP_PAD,
  })

  /** Refits the graph into the canvas box; no-op before the canvas is measured. */
  const fit = useCallback((): void => {
    const element = canvasRef.current
    /* v8 ignore next -- unreachable: fit() runs only after a commit that rendered the canvas. */
    if (element === null) return
    const rect = element.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) return
    const box = { x: rect.width, y: rect.height }
    setSize(box)
    setView(fitView(bounds, box))
  }, [bounds])

  // Fit once, on the first snapshot that has nodes; later polls keep the
  // viewport the user set rather than snapping it back.
  const fitted = useRef(false)
  useEffect(() => {
    if (fitted.current || graph.nodes.length === 0) return
    fitted.current = true
    fit()
  }, [fit, graph.nodes.length])

  // Wheel zoom rides a native non-passive listener: React registers onWheel
  // passively, where preventDefault cannot stop the page from scrolling.
  useEffect(() => {
    const element = canvasRef.current
    if (element === null) return
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault()
      const rect = element.getBoundingClientRect()
      setSize({ x: rect.width, y: rect.height })
      setView(current => zoomAt(current, Math.exp(-event.deltaY * WHEEL_ZOOM), {
        x: event.clientX - rect.left,
        y: event.clientY - rect.top,
      }))
    }
    element.addEventListener('wheel', onWheel, { passive: false })
    return () => { element.removeEventListener('wheel', onWheel) }
  }, [empty])

  /** Zooms by one step about the canvas centre. */
  const zoomBy = (factor: number): void => {
    setView(current => zoomAt(current, factor, { x: size.x / 2, y: size.y / 2 }))
  }

  /** Starts a pan, or clears the selection when the background is clicked. */
  const onCanvasMouseDown = (event: ReactMouseEvent<HTMLDivElement>): void => {
    if (event.target !== event.currentTarget) return
    setSelected(null)
    if (!locked) setDrag({ x: event.clientX, y: event.clientY })
  }

  /** Pans by the pointer delta while a drag is active. */
  const onCanvasMouseMove = (event: ReactMouseEvent<HTMLDivElement>): void => {
    if (drag === null) return
    setView(current => panBy(current, event.clientX - drag.x, event.clientY - drag.y))
    setDrag({ x: event.clientX, y: event.clientY })
  }

  /** Ends a pan. */
  const onCanvasMouseUp = (): void => { setDrag(null) }

  /** Keyboard shortcuts: zoom, fit, and clearing the selection. */
  const onCanvasKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === '+' || event.key === '=') zoomBy(STEP)
    else if (event.key === '-' || event.key === '_') zoomBy(1 / STEP)
    else if (event.key === '0') fit()
    else if (event.key === 'Escape') setSelected(null)
  }

  /** Recentres the view on the plane point under a minimap click. */
  const onMinimapClick = (event: ReactMouseEvent<HTMLDivElement>): void => {
    const rect = event.currentTarget.getBoundingClientRect()
    const point = {
      x: (event.clientX - rect.left - MINIMAP_PAD) / minimapK + bounds.minX,
      y: (event.clientY - rect.top - MINIMAP_PAD) / minimapK + bounds.minY,
    }
    setView(current => centreOn(current, point, size))
  }

  if (empty) {
    return (
      <div className={css.root}>
        <div className={css.empty}>{labels.empty}</div>
      </div>
    )
  }

  const origin = toPlane(view, { x: 0, y: 0 })
  const corner = toPlane(view, size)

  return (
    <div className={css.root}>
      <div
        ref={canvasRef}
        className={cx(css.canvas, drag !== null && css.panning)}
        role="application"
        aria-label={labels.canvas}
        tabIndex={0}
        onMouseDown={onCanvasMouseDown}
        onMouseMove={onCanvasMouseMove}
        onMouseUp={onCanvasMouseUp}
        onMouseLeave={onCanvasMouseUp}
        onKeyDown={onCanvasKeyDown}
      >
        <div
          className={css.grid}
          style={{
            backgroundSize: `${20 * view.scale}px ${20 * view.scale}px`,
            backgroundPosition: `${view.x}px ${view.y}px`,
          }}
        />
        <div className={css.legend} role="list" aria-label={labels.legend}>
          {FLOW_STATUS_ORDER.filter(status => graph.nodes.some(n => n.status === status)).map(status => (
            <span key={status} className={cx(css.legendChip, css[FLOW_STATUS_CLASS[status]])} role="listitem">
              <span className={css.legendDot} />
              {labels.status[status]}
            </span>
          ))}
        </div>
        <div
          className={css.plane}
          role="group"
          aria-label={labels.canvas}
          style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}
        >
          <svg className={css.edges}>
            {shapes.map(shape => (
              <path
                key={shape.id}
                className={cx(css.edge, shape.animated && css.edgeLive, css[FLOW_STATUS_CLASS[shape.status]])}
                d={shape.d}
              />
            ))}
          </svg>
          {placed.map(({ node, box }) => (
            <NodeCard
              key={node.id}
              node={node}
              box={box}
              labels={labels}
              selected={node.id === selected}
              onSelect={() =>{  setSelected(node.id) }}
            />
          ))}
        </div>
        <div className={css.controls}>
          <button type="button" className={css.controlButton} aria-label={labels.zoomOut} onClick={() =>{  zoomBy(1 / STEP) }}>−</button>
          <span className={css.zoomLabel}>{percent(view.scale)}</span>
          <button type="button" className={css.controlButton} aria-label={labels.zoomIn} onClick={() =>{  zoomBy(STEP) }}>+</button>
          <button type="button" className={css.controlButton} aria-label={labels.fit} onClick={fit}>⤢</button>
          <button
            type="button"
            className={cx(css.controlButton, locked && css.controlButtonActive)}
            aria-label={locked ? labels.unlock : labels.lock}
            aria-pressed={locked}
            onClick={() =>{  setLocked(value => !value) }}
          >
            {locked ? '🔒' : '🔓'}
          </button>
        </div>
        <div
          className={css.minimap}
          role="button"
          tabIndex={-1}
          aria-label={labels.minimap}
          onMouseDown={onMinimapClick}
        >
          {placed.map(({ node, box }) => {
            const at = onMap(box)
            return (
              <div
                key={node.id}
                className={cx(css.minimapNode, css[FLOW_STATUS_CLASS[node.status]])}
                style={{
                  left: `${at.x}px`,
                  top: `${at.y}px`,
                  width: `${box.width * minimapK}px`,
                  height: `${box.height * minimapK}px`,
                }}
              />
            )
          })}
          {size.x > 0 && (
            <div
              className={css.minimapViewport}
              style={{
                left: `${onMap(origin).x}px`,
                top: `${onMap(origin).y}px`,
                width: `${Math.max(4, (corner.x - origin.x) * minimapK)}px`,
                height: `${Math.max(4, (corner.y - origin.y) * minimapK)}px`,
              }}
            />
          )}
        </div>
      </div>
      {selectedNode !== null && (
        <aside className={css.inspector} aria-label={selectedNode.label}>
          <div className={css.inspectorHead}>
            <span className={css.inspectorTitle}>{selectedNode.label}</span>
            <button type="button" className={css.inspectorClose} aria-label={labels.close} onClick={() =>{  setSelected(null) }}>×</button>
          </div>
          <div className={css.inspectorRow}>
            <span className={css.inspectorKey}>{labels.fieldKind}</span>
            <span className={css.inspectorValue}>{labels.kind[selectedNode.kind]}</span>
          </div>
          <div className={css.inspectorRow}>
            <span className={css.inspectorKey}>{labels.fieldStatus}</span>
            <span className={css.inspectorValue}>
              <span className={cx(css.badge, css[FLOW_STATUS_CLASS[selectedNode.status]])}>
                <span className={css.badgeDot} />
                {labels.status[selectedNode.status]}
              </span>
            </span>
          </div>
          <div className={css.inspectorRow}>
            <span className={css.inspectorKey}>{labels.fieldSession}</span>
            <span className={css.inspectorValue}>{selectedNode.sessionId}</span>
          </div>
          {selectedNode.path !== '' && (
            <div className={css.inspectorRow}>
              <span className={css.inspectorKey}>{labels.fieldPath}</span>
              <span className={css.inspectorValue}>{selectedNode.path}</span>
            </div>
          )}
          <div className={css.inspectorSection}>
            <span className={css.inspectorSectionTitle}>{labels.steps}</span>
            {graph.nodes.filter(n => n.parentId === selectedNode.id).map(child => (
              <span
                key={child.id}
                className={cx(css.inspectorItem, isLiveStatus(child.status) && css.inspectorItemLive, child.status === 'completed' && css.inspectorItemDone)}
              >
                {labels.status[child.status]} · {child.label}
              </span>
            ))}
          </div>
          <button type="button" className={css.controlButton} onClick={() =>{  onFocus(selectedNode.sessionId) }}>{labels.focus}</button>
        </aside>
      )}
    </div>
  )
}

/** Props of one node card. */
interface NodeCardProps {
  node: FlowNode
  box: FlowBox
  labels: DagFlowLabels
  selected: boolean
  onSelect: () => void
}

/**
 * One node card: accent rail, kind chip, title, subtitle, status badge, and one
 * handle per port on the matching edge.
 * @param props - Node, its box, localized copy, selection state, and the select callback.
 * @returns The positioned card.
 */
const NodeCard: FC<NodeCardProps> = ({ node, box, labels, selected, onSelect }) => {
  const size = nodeSize(node.kind)
  return (
    <div
      className={cx(
        css.node,
        css[FLOW_KIND_CLASS[node.kind]],
        css[FLOW_STATUS_CLASS[node.status]],
        selected && css.nodeSelected,
        isLiveStatus(node.status) && css.nodeLive,
      )}
      role="button"
      tabIndex={-1}
      aria-label={`${labels.kind[node.kind]} ${node.label}`}
      style={{ left: `${box.x}px`, top: `${box.y}px`, width: `${size.width}px`, height: `${size.height}px` }}
      onClick={onSelect}
    >
      <div className={css.nodeHeader}>
        <span className={css.iconChip}>{node.kind.slice(0, 1).toUpperCase()}</span>
        <span className={css.title}>{node.label}</span>
        <span className={css.badge}>
          <span className={css.badgeDot} />
          {labels.status[node.status]}
        </span>
      </div>
      <span className={css.subtitle}>{node.subtitle}</span>
      {node.inputs.map(port => (
        <span key={port.id} className={cx(css.handle, css.handleInput)}>
          <span className={cx(css.handleLabel, css.handleLabelInput)}>{port.label}</span>
        </span>
      ))}
      {node.outputs.map(port => (
        <span key={port.id} className={cx(css.handle, css.handleOutput)}>
          <span className={cx(css.handleLabel, css.handleLabelOutput)}>{port.label}</span>
        </span>
      ))}
    </div>
  )
}
