/**
 * Browser Workflows-tab plugin: registers the `dagflow` entry of the
 * conversation view slot (header [ Orchestrator | Workflows | Chat ]), fed by
 * the `flow.*` wire domain through the connection's typed API client.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { IApiClient } from '@deepseek-ai/dsh-host-apiproxy/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: the 'conversation.view' SlotMap row (declared by the slot's
// owning package) must be in the program for the register calls to type.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import { FlowbuilderView } from './flowbuilder.tsx'
import type { FlowbuilderActions } from './flowbuilder.tsx'
import type { FlowDraft } from './graph.ts'
import { NS, en, zh } from './locales.ts'

/** Required services: the conversation slot, the locale service, and the connection carrying the API client. */
export const inject = ['slots', 'locale', 'connection']

/**
 * Client plugin body: register the Workflows tab. The flow.* actions close
 * over the connection's typed API client; the canvas is a pure projection.
 * @param ctx - client root context.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-flowbuilder: dictionaries')
  const t = ctx.locale.bind(NS)
  const api = (ctx.get('connection') as unknown as { api: IApiClient }).api

  const unwrap = async <T>(call: Promise<{ result: { ok: true; value: T } | { ok: false; error: { message: string } } }>): Promise<T> => {
    const { result } = await call
    if (!result.ok) throw new Error(result.error.message)
    return result.value
  }

  const actions: FlowbuilderActions = {
    saveFlow: (draft: FlowDraft) => unwrap(api.flow.save({
      ...(draft.id !== undefined ? { id: draft.id } : {}),
      name: draft.name,
      description: draft.description,
      nodes: draft.nodes,
      edges: draft.edges,
    })).then(saved => saved.flow),
    runFlow: flowId => unwrap(api.flow.run({ flowId })).then(started => started.runId),
    getRun: runId => unwrap(api.flow.runGet({ runId })).then(({ run }) => run),
    listBlocks: query => unwrap(api.flow.libraryList({ ...(query !== undefined ? { query } : {}) })).then(({ blocks }) => blocks),
    saveBlock: async (nodeId, draft) => {
      const node = draft.nodes.find(entry => entry.id === nodeId)
      if (node === undefined) throw new Error('the selected node vanished')
      await unwrap(api.flow.librarySave({
        name: node.title,
        kind: node.kind,
        description: node.title,
        ...(node.code !== undefined ? { code: node.code } : {}),
        ...(node.blockId !== undefined ? { sourceFlowId: draft.id } : {}),
        inputs: [],
        outputs: [],
        params: [],
      }))
    },
  }

  ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view',
    id: 'dagflow',
    order: 6,
    locale: NS,
    label: () => t('view.dagflow'),
    inject: (_sessionId: SessionId) => ({ labels: { t }, actions }),
  }, FlowbuilderView))
}
