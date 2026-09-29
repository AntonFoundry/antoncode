/**
 * The Workflows canvas component: pure presentation over the inject face.
 * All data (draft, flows, blocks, run projection) and all mutations (the
 * `on*` callbacks) arrive through props; local state is selection and
 * pending-port interaction only.
 */
import { createElement, useMemo, useState } from 'react'
import type { ChangeEvent as ReactChangeEvent, FC, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react'
type AnyKeyboard = ReactKeyboardEvent<HTMLElement>
type AnyPointer = ReactPointerEvent<HTMLElement>
type InputChange = ReactChangeEvent<HTMLInputElement>
type SelectChange = ReactChangeEvent<HTMLSelectElement>
type AreaChange = ReactChangeEvent<HTMLTextAreaElement>
import type { BlockWire, FlowRunWire, FlowWire } from '@deepseek-ai/dsh-host-apiproxy/client'
import type { ConvViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import {
  NODE_H, NODE_W, PALETTE_KINDS, addNode, applyRunStates, connect, disconnect, emptyDraft,
  moveNode, portPosition, removeNode, updateNode,
} from './graph.ts'
import type { FlowDraft } from './graph.ts'
import type { FlowbuilderKey } from './locales.ts'
import styles from './flowbuilder.module.css'

/** Chrome copy, rebuilt per inject so it follows the active locale. */
export interface FlowbuilderLabels {
  /** Translate one dictionary key. */
  t: (key: FlowbuilderKey) => string
}

/** The callbacks the plugin injects: the complete flow.* mutation surface. */
export interface FlowbuilderActions {
  /** Save the draft; resolves the stored record (or rejects with the wire error message). */
  saveFlow(draft: FlowDraft): Promise<FlowWire>
  /** Start one run; resolves the run id. */
  runFlow(flowId: string): Promise<string>
  /** Poll one run record. */
  getRun(runId: string): Promise<FlowRunWire>
  /** List library blocks, optionally filtered. */
  listBlocks(query?: string): Promise<BlockWire[]>
  /** Save one library block from a selected node. */
  saveBlock(nodeId: string, draft: FlowDraft): Promise<void>
}

/** Inject face: chrome copy plus the actions. */
export interface FlowbuilderInjected {
  labels: FlowbuilderLabels
  actions: FlowbuilderActions
}

/** Component props: the slot's standard share plus the inject face. */
export type FlowbuilderViewProps = ConvViewProps & FlowbuilderInjected

/** Draft plus its stored id, carried through the toolbar's save path. */
interface EditorState {
  draft: FlowDraft
  selectedId?: string
  pendingPort?: { nodeId: string; port: string }
  error?: string
  runNodes?: Record<string, { status: string; error?: string }>
  runResult?: string
  running: boolean
}

/**
 * The Workflows view.
 * @param props - inject face (labels, actions).
 * @returns The canvas editor.
 */
export const FlowbuilderView: FC<FlowbuilderViewProps> = ({ labels, actions }) => {
  const { t } = labels
  const [editor, setEditor] = useState<EditorState>({ draft: emptyDraft(), running: false })
  const [blocks, setBlocks] = useState<BlockWire[]>([])
  const [libraryOpen, setLibraryOpen] = useState(false)

  const runView = useMemo(
    () => (editor.runNodes === undefined ? undefined : applyRunStates(editor.draft.nodes, editor.runNodes)),
    [editor.draft.nodes, editor.runNodes],
  )

  const patch = (next: { [K in keyof EditorState]?: EditorState[K] | undefined }): void => {
    setEditor((previous) => {
      // Undefined-valued patch keys clear the field, keeping the draft's
      // optional members exact-optional across every patch.
      const merged = Object.entries({ ...previous, ...next }).filter(([, value]) => value !== undefined)
      return Object.fromEntries(merged) as unknown as EditorState
    })
  }

  const onSave = (): void => {
    patch({ error: undefined })
    actions.saveFlow(editor.draft)
      .then(flow => patch({ draft: { ...editor.draft, id: flow.id } }))
      .catch((error: unknown) => patch({ error: error instanceof Error ? error.message : String(error) }))
  }

  const onRun = (): void => {
    if (editor.draft.id === undefined) {
      patch({ error: 'Save the workflow before running it.' })
      return
    }
    patch({ running: true, error: undefined, runNodes: undefined, runResult: undefined })
    actions.runFlow(editor.draft.id)
      .then((runId) => {
        const poll = (): void => {
          actions.getRun(runId)
            .then((run) => {
              if (run.status === 'running') { setTimeout(poll, 800); return }
              patch({
                running: false,
                runNodes: run.nodes,
                ...(run.error !== undefined ? { error: run.error } : {}),
                ...(run.result !== undefined ? { runResult: JSON.stringify(run.result) } : {}),
              })
            })
            .catch((error: unknown) => { patch({ running: false, error: String(error) }) })
        }
        poll()
      })
      .catch((error: unknown) => patch({ running: false, error: error instanceof Error ? error.message : String(error) }))
  }

  const onCanvasPointerDown = (event: AnyPointer): void => {
    // A bare canvas click clears the pending connect port.
    if (event.target === event.currentTarget) patch({ pendingPort: undefined })
  }

  const startDrag = (event: AnyPointer, nodeId: string): void => {
    const node = editor.draft.nodes.find(entry => entry.id === nodeId)
    if (node === undefined) return
    const parent = event.currentTarget.parentElement
    if (parent === null) return
    const canvas = parent.getBoundingClientRect()
    const startX = event.clientX - canvas.left - node.x
    const startY = event.clientY - canvas.top - node.y
    const move = (moveEvent: PointerEvent): void => {
      const nextX = moveEvent.clientX - canvas.left - startX
      const nextY = moveEvent.clientY - canvas.top - startY
      setEditor(previous => ({ ...previous, draft: moveNode(previous.draft, nodeId, nextX, nextY) }))
    }
    const up = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const onPortClick = (nodeId: string, port: string, side: 'in' | 'out'): void => {
    const pending = editor.pendingPort
    if (pending === undefined && side === 'out') { patch({ pendingPort: { nodeId, port } }); return }
    if (pending === undefined || side !== 'in') return
    const next = connect(editor.draft, pending, { nodeId, port })
    patch({ pendingPort: undefined, ...(next === undefined ? { error: 'That input port already has an edge.' } : { draft: next }) })
  }

  const onKeyDown = (event: AnyKeyboard, nodeId: string): void => {
    if (event.key === 'Delete' || event.key === 'Backspace') {
      patch({ draft: removeNode(editor.draft, nodeId), selectedId: undefined })
    }
  }

  const selected = editor.draft.nodes.find(node => node.id === editor.selectedId)

  const openLibrary = (): void => {
    setLibraryOpen(true)
    actions.listBlocks().then(setBlocks).catch((error: unknown) => patch({ error: String(error) }))
  }

  const saveSelectionAsBlock = (): void => {
    if (selected === undefined) return
    actions.saveBlock(selected.id, editor.draft)
      .then(() => openLibrary())
      .catch((error: unknown) => patch({ error: error instanceof Error ? error.message : String(error) }))
  }

  const instantiateBlock = (block: BlockWire): void => {
    const grown = addNode(editor.draft, 'library', 60 + editor.draft.nodes.length * 24, 60 + editor.draft.nodes.length * 18)
    const last = grown.nodes[grown.nodes.length - 1]
    if (last !== undefined) patch({ draft: updateNode(grown, last.id, { blockId: block.id }) })
  }

  return createElement('div', { className: styles.shell },
    createElement('div', { className: styles.toolbar },
      createElement('button', {
        type: 'button',
        onClick: () => setEditor({ draft: emptyDraft(), running: false }),
      }, t('flow.new')),
      createElement('input', {
        className: styles.nameField,
        value: editor.draft.name,
        'aria-label': t('flow.field.name'),
        onChange: (event: InputChange) => patch({ draft: { ...editor.draft, name: event.target.value } }),
      }),
      createElement('button', { type: 'button', 'data-testid': 'save', onClick: onSave }, t('flow.save')),
      createElement('button', { type: 'button', 'data-testid': 'run', disabled: editor.running, onClick: onRun },
        editor.running ? t('flow.running') : t('flow.run')),
      createElement('button', { type: 'button', onClick: openLibrary }, t('flow.library')),
      createElement('span', { className: styles.hint }, t('flow.connect.hint')),
    ),
    editor.error !== undefined && createElement('div', { className: styles.errorStrip, role: 'alert' },
      `${t('flow.error')}: ${editor.error}`),
    editor.runResult !== undefined && createElement('div', { className: styles.resultStrip },
      `${t('flow.result')}: ${editor.runResult}`),
    createElement('div', { className: styles.body },
      createElement('div', { className: styles.palette },
        createElement('div', { className: styles.paletteTitle }, t('flow.palette')),
        PALETTE_KINDS.map(entry => createElement('button', {
          key: entry.kind,
          type: 'button',
          className: styles.paletteItem,
          onClick: () => patch({ draft: addNode(editor.draft, entry.kind, 80, 80) }),
        }, entry.title)),
        createElement('button', {
          type: 'button',
          className: styles.paletteItem,
          disabled: selected === undefined,
          onClick: saveSelectionAsBlock,
        }, t('flow.library.saveBlock')),
      ),
      createElement('div', {
        className: styles.canvas,
        onPointerDown: onCanvasPointerDown,
        'data-testid': 'canvas',
      },
      createElement('svg', { className: styles.edges },
        editor.draft.edges.map((edge) => {
          const from = editor.draft.nodes.find(node => node.id === edge.from.nodeId)
          const to = editor.draft.nodes.find(node => node.id === edge.to.nodeId)
          if (from === undefined || to === undefined) return null
          const a = portPosition(from, 'out')
          const b = portPosition(to, 'in')
          const mid = (a.x + b.x) / 2
          return createElement('g', { key: edge.id },
            createElement('path', {
              d: `M ${a.x} ${a.y} C ${mid} ${a.y}, ${mid} ${b.y}, ${b.x} ${b.y}`,
              className: styles.edgePath,
            }),
            createElement('title', null, edge.id),
          )
        }),
      ),
      editor.draft.nodes.map((node) => {
        const run = runView?.get(node.id)
        const statusClass = run === undefined ? '' : styles[`run_${run.status}` as keyof typeof styles] ?? ''
        return createElement('div', {
          key: node.id,
          className: `${styles.node} ${editor.selectedId === node.id ? styles.nodeSelected : ''} ${statusClass}`,
          style: { left: node.x, top: node.y, width: NODE_W, height: NODE_H },
          tabIndex: 0,
          onKeyDown: (event: AnyKeyboard) => onKeyDown(event, node.id),
          onPointerDown: (event: AnyPointer) => {
            patch({ selectedId: node.id })
            startDrag(event, node.id)
          },
          'data-node-kind': node.kind,
        },
        createElement('div', { className: styles.nodeTitle },
          `${node.title} · ${node.kind}${run !== undefined ? ` · ${run.status}` : ''}`),
        run?.error !== undefined && createElement('div', { className: styles.nodeError }, run.error),
        createElement('button', {
          type: 'button',
          className: styles.portIn,
          'aria-label': `in ${node.id}`,
          onClick: () => onPortClick(node.id, 'in', 'in'),
        }),
        createElement('button', {
          type: 'button',
          className: styles.portOut,
          'aria-label': `out ${node.id}`,
          onClick: () => onPortClick(node.id, 'out', 'out'),
        }),
        createElement('button', {
          type: 'button',
          className: styles.nodeDelete,
          'aria-label': `${t('flow.delete')} ${node.id}`,
          onClick: () => patch({ draft: removeNode(editor.draft, node.id), selectedId: undefined }),
        }, '×'),
        )
      }),
      editor.pendingPort !== undefined && createElement('div', { className: styles.pendingBadge },
        t('flow.connect.hint')),
      ),
      createElement('div', { className: styles.inspector },
        createElement('div', { className: styles.paletteTitle }, t('flow.inspector')),
        selected === undefined
          ? createElement('div', { className: styles.hint }, t('flow.inspector.empty'))
          : createElement('div', { className: styles.inspectorForm },
            createElement('label', { className: styles.field },
              t('flow.field.title'),
              createElement('input', {
                value: selected.title,
                onChange: (event: InputChange) => patch({ draft: updateNode(editor.draft, selected.id, { title: event.target.value }) }),
              }),
            ),
            createElement('label', { className: styles.field },
              t('flow.field.kind'),
              createElement('select', {
                value: selected.kind,
                onChange: (event: SelectChange) => patch({ draft: updateNode(editor.draft, selected.id, { kind: event.target.value }) }),
              }, PALETTE_KINDS.map(entry => createElement('option', { key: entry.kind, value: entry.kind }, entry.kind)))),
            (selected.kind === 'code' || selected.kind === 'condition') && createElement('label', { className: styles.field },
              t('flow.field.code'),
              createElement('textarea', {
                rows: 8,
                value: selected.code ?? '',
                onChange: (event: AreaChange) => patch({ draft: updateNode(editor.draft, selected.id, { code: event.target.value }) }),
              })),
            selected.kind === 'library' && createElement('label', { className: styles.field },
              t('flow.field.block'),
              createElement('select', {
                value: selected.blockId ?? '',
                onChange: (event: SelectChange) => patch({ draft: updateNode(editor.draft, selected.id, { blockId: event.target.value }) }),
              }, blocks.map(block => createElement('option', { key: block.id, value: block.id }, block.name)))),
            createElement('div', { className: styles.field },
              t('flow.field.params'),
              Object.entries(selected.params).map(([key, value]) => createElement('div', { key: key, className: styles.paramRow },
                createElement('code', null, `${key}=${String(value)}`)))),
            runView?.get(selected.id)?.error !== undefined
              && createElement('div', { className: styles.nodeError }, runView.get(selected.id)?.error),
          ),
      ),
      libraryOpen && createElement('div', { className: styles.library },
        createElement('div', { className: styles.paletteTitle }, t('flow.library')),
        createElement('button', { type: 'button', onClick: () => setLibraryOpen(false) }, '×'),
        blocks.length === 0
          ? createElement('div', { className: styles.hint }, t('flow.library.empty'))
          : blocks.map(block => createElement('div', { key: block.id, className: styles.libraryRow },
            createElement('span', null, `${block.name} [${block.kind}]`),
            createElement('button', {
              type: 'button',
              onClick: () => instantiateBlock(block),
            }, t('flow.library.instantiate'))))),
    ),
    createElement('div', { className: styles.edgeStrip },
      editor.draft.edges.map(edge => createElement('button', {
        key: edge.id,
        type: 'button',
        className: styles.edgeChip,
        onClick: () => patch({ draft: disconnect(editor.draft, edge.id) }),
      }, `${t('flow.disconnect')}: ${edge.from.nodeId} → ${edge.to.nodeId}`))),
  )
}
