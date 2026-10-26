/**
 * Server side of the fetch carrier: maps an ApiProxy onto a pure
 * WHATWG Request->Response function. Two-level parse: full form (type/rpcId/method +
 * path==method) -> payload dispatched per method. HTTP status expresses only the carrier
 * (404 unknown path / 415 non-JSON media type / 400 non-JSON body / 500 handler crash);
 * business errors are always 200 + ServerResponse.
 */

import { randomUUID } from 'node:crypto'
import type { z } from 'zod'
import type { ApiProxy, MuxFrame, HostFrame } from '../api/index.ts'
import type { AgentMailVerifiedApi } from '../agent-mail-forward.ts'
import { sessionLogQuerySchema } from '../api/downloads.schema.ts'
import type { RequestPayload, ResponseValue, RpcMethodMap } from '../api/rpc-map.ts'
import type { ClientRequest, RpcError, RpcRequest, RpcResponse, ServerRequest, ServerResponse } from '../api/rpc.ts'
import { RpcId } from '../api/rpc.ts'
import type { Wire } from '../api/rpc.schema.ts'
import { clientRequestSchema, clientResponseSchema } from '../api/rpc.schema.ts'
import {
  sessionCancelRequestSchema,
  sessionAttachmentRequestSchema,
  sessionCreateRequestSchema,
  sessionForkExcludingRequestSchema,
  sessionForkRequestSchema,
  sessionHistoryRequestSchema,
  sessionListRequestSchema,
  sessionModelsRequestSchema,
  sessionPromptRequestSchema,
  sessionRenameRequestSchema,
  sessionSearchRequestSchema,
  sessionSelectModelRequestSchema,
  sessionUpdateQueueRequestSchema,
} from '../api/sessions.schema.ts'
import {
  hostCreateDirectoryRequestSchema, hostDescribeRequestSchema,
  hostListDirectoryRequestSchema, hostOpenPathRequestSchema,
  hostPickDirectoryRequestSchema, hostReadTextFileRequestSchema } from '../api/host.schema.ts'
import {
  orchestratorActRequestSchema,
  orchestratorBoardRequestSchema,
} from '../api/orchestrator.schema.ts'
import {
  flowDeleteRequestSchema,
  flowGetRequestSchema,
  flowLibraryDeleteRequestSchema,
  flowLibraryListRequestSchema,
  flowLibrarySaveRequestSchema,
  flowListRequestSchema,
  flowRunGetRequestSchema,
  flowRunsRequestSchema,
  flowRunRequestSchema,
  flowSaveRequestSchema,
} from '../api/flow.schema.ts'
import {
  langflowStartRequestSchema,
  langflowStatusRequestSchema,
  langflowStopRequestSchema,
} from '../api/langflow.schema.ts'
import {
  workspaceArchiveSessionRequestSchema,
  workspaceCreateRequestSchema,
  workspaceDeleteRequestSchema,
  workspaceInsertBeforeRequestSchema,
  workspaceInsertSessionBeforeRequestSchema,
  workspaceListRequestSchema,
  workspaceRenameRequestSchema,
} from '../api/workspace.schema.ts'
import {
  worktreeCreateRequestSchema,
  worktreeListRequestSchema,
  worktreePrefRequestSchema,
  worktreeRemoveRequestSchema,
  worktreeSetPrefRequestSchema,
  worktreeStatusRequestSchema,
} from '../api/worktree.schema.ts'
import { skillListRequestSchema } from '../api/skills.schema.ts'
import {
  agentPresetCopyRequestSchema, agentPresetListRequestSchema, agentPresetOpenDocumentRequestSchema,
  agentPresetReadRequestSchema, agentPresetRemoveRequestSchema, agentPresetSelectRequestSchema,
} from '../api/agent-presets.schema.ts'
import {
  goalCreateRequestSchema,
  goalEditRequestSchema,
  goalPauseRequestSchema,
  goalResumeRequestSchema,
  goalCompleteRequestSchema,
  goalClearRequestSchema,
} from '../api/goals.schema.ts'
import {
  settingsDescribeRequestSchema, settingsMutateRequestSchema, settingsOpenDocumentRequestSchema,
  settingsReplaceRequestSchema, settingsUpdateRequestSchema,
} from '../api/settings.schema.ts'
import {
  credentialsDescribeRequestSchema, credentialsSetRequestSchema, credentialsUnsetRequestSchema,
} from '../api/credentials.schema.ts'
import {
  opencodeOAuthCancelRequestSchema, opencodeOAuthSelectRequestSchema, opencodeOAuthStartRequestSchema,
  opencodeOAuthStatusRequestSchema,
} from '../api/opencode-oauth.schema.ts'
import {
  claudeOAuthCancelRequestSchema, claudeOAuthStartRequestSchema, claudeOAuthSubmitRequestSchema,
} from '../api/claude-oauth.schema.ts'
import { llmDiscoverModelsRequestSchema,
  llmModelsRequestSchema, llmProvidersRequestSchema } from '../api/llm.schema.ts'
import {
  termDisposeRequestSchema, termInputRequestSchema, termReadRequestSchema, termResizeRequestSchema, termSpawnRequestSchema,
} from '../api/term.schema.ts'
import {
  subagentHistoryRequestSchema,
  subagentInterruptRequestSchema,
  subagentListRequestSchema,
  subagentPromptRequestSchema,
} from '../api/subagents.schema.ts'
import { jobKillRequestSchema } from '../api/jobs.schema.ts'
import {
  agentMailBeginRequestSchema, agentMailAuthorizeRequestSchema, agentMailRedeemRequestSchema, agentMailRevokeRequestSchema,
  agentMailAddressRequestSchema, agentMailInboxRequestSchema, agentMailSendRequestSchema, agentMailAckRequestSchema,
} from '../api/agent-mail.schema.ts'

/**
 * Unary dispatch table, keyed by (and compiler-locked to) RpcMethodMap: a map row without a
 * route row fails to compile, and each row's schema/invoke pair is checked against that row's
 * payload type — a schema pasted onto the wrong row is a type error, not a runtime surprise.
 * Schemas anchor to the Wire<> widening (the repo-wide exactOptionalPropertyTypes accommodation
 * documented on Wire); the dispatch point carries the one Wire→exact cast.
 * Every invoke receives the carrier Request's signal; routes whose contract
 * declares a signal parameter forward it, and the rest ignore it.
 */
type UnaryRoutes = {
  [K in keyof RpcMethodMap]: {
    schema: z.ZodType<Wire<RequestPayload<K>>>
    invoke(
      api: ApiProxy, request: RpcRequest<RequestPayload<K>>, signal: AbortSignal, origin?: string,
    ): Promise<RpcResponse<ResponseValue<K>>>
  }
}

const UNARY_ROUTES: UnaryRoutes = {
  'agentMail.begin': { schema: agentMailBeginRequestSchema, invoke: (api, r, _signal, origin) => api.agentMail.begin(r, origin) },
  'agentMail.authorize': { schema: agentMailAuthorizeRequestSchema, invoke: (api, r, _signal, origin) => api.agentMail.authorize(r, origin) },
  'agentMail.redeem': { schema: agentMailRedeemRequestSchema, invoke: (api, r, _signal, origin) => api.agentMail.redeem(r, origin) },
  'agentMail.revoke': { schema: agentMailRevokeRequestSchema, invoke: (api, r, _signal, origin) => api.agentMail.revoke(r, origin) },
  'agentMail.address': { schema: agentMailAddressRequestSchema, invoke: (api, r, _signal, origin) => api.agentMail.address(r, origin) },
  'agentMail.inbox': { schema: agentMailInboxRequestSchema, invoke: (api, r, _signal, origin) => api.agentMail.inbox(r, origin) },
  'agentMail.send': { schema: agentMailSendRequestSchema, invoke: (api, r, _signal, origin) => api.agentMail.send(r, origin) },
  'agentMail.ack': { schema: agentMailAckRequestSchema, invoke: (api, r, _signal, origin) => api.agentMail.ack(r, origin) },
  'session.list': { schema: sessionListRequestSchema, invoke: (api, r) => api.sessions.list(r) },
  'session.search': { schema: sessionSearchRequestSchema, invoke: (api, r, signal) => api.sessions.search(r, signal) },
  'session.create': { schema: sessionCreateRequestSchema, invoke: (api, r) => api.sessions.create(r) },
  'session.history': { schema: sessionHistoryRequestSchema, invoke: (api, r) => api.sessions.history(r) },
  'session.models': { schema: sessionModelsRequestSchema, invoke: (api, r) => api.sessions.models(r) },
  'session.selectModel': { schema: sessionSelectModelRequestSchema, invoke: (api, r) => api.sessions.selectModel(r) },
  'session.rename': { schema: sessionRenameRequestSchema, invoke: (api, r) => api.sessions.rename(r) },
  'session.fork': { schema: sessionForkRequestSchema, invoke: (api, r) => api.sessions.fork(r) },
  'session.forkExcluding': { schema: sessionForkExcludingRequestSchema, invoke: (api, r) => api.sessions.forkExcluding(r) },
  'session.prompt': { schema: sessionPromptRequestSchema, invoke: (api, r) => api.sessions.prompt(r) },
  'session.attachment': { schema: sessionAttachmentRequestSchema, invoke: (api, r) => api.sessions.attachment(r) },
  'session.updateQueue': { schema: sessionUpdateQueueRequestSchema, invoke: (api, r) => api.sessions.updateQueue(r) },
  'session.cancel': { schema: sessionCancelRequestSchema, invoke: (api, r) => api.sessions.cancel(r) },
  'subagent.list': { schema: subagentListRequestSchema, invoke: (api, r, signal) => api.subagents.list(r, signal) },
  'subagent.history': { schema: subagentHistoryRequestSchema, invoke: (api, r, signal) => api.subagents.history(r, signal) },
  'subagent.prompt': { schema: subagentPromptRequestSchema, invoke: (api, r, signal) => api.subagents.prompt(r, signal) },
  'subagent.interrupt': { schema: subagentInterruptRequestSchema, invoke: (api, r) => api.subagents.interrupt(r) },
  'host.describe': { schema: hostDescribeRequestSchema, invoke: (api, r) => api.host.describe(r) },
  'host.pickDirectory': { schema: hostPickDirectoryRequestSchema, invoke: (api, r, signal) => api.host.pickDirectory(r, signal) },
  'host.listDirectory': { schema: hostListDirectoryRequestSchema, invoke: (api, r, signal) => api.host.listDirectory(r, signal) },
  'host.createDirectory': { schema: hostCreateDirectoryRequestSchema, invoke: (api, r) => api.host.createDirectory(r) },
  'host.openPath': { schema: hostOpenPathRequestSchema, invoke: (api, r, signal) => api.host.openPath(r, signal) },
  'host.readTextFile': { schema: hostReadTextFileRequestSchema, invoke: (api, r, signal) => api.host.readTextFile(r, signal) },
  'orchestrator.board': { schema: orchestratorBoardRequestSchema, invoke: (api, r) => api.orchestrator.board(r) },
  'orchestrator.act': { schema: orchestratorActRequestSchema, invoke: (api, r) => api.orchestrator.act(r) },
  'flow.list': { schema: flowListRequestSchema, invoke: (api, r) => api.flow.list(r) },
  'flow.get': { schema: flowGetRequestSchema, invoke: (api, r) => api.flow.get(r) },
  'flow.save': { schema: flowSaveRequestSchema, invoke: (api, r) => api.flow.save(r) },
  'flow.delete': { schema: flowDeleteRequestSchema, invoke: (api, r) => api.flow.delete(r) },
  'flow.run': { schema: flowRunRequestSchema, invoke: (api, r) => api.flow.run(r) },
  'flow.runs': { schema: flowRunsRequestSchema, invoke: (api, r) => api.flow.runs(r) },
  'flow.runGet': { schema: flowRunGetRequestSchema, invoke: (api, r) => api.flow.runGet(r) },
  'flow.libraryList': { schema: flowLibraryListRequestSchema, invoke: (api, r) => api.flow.libraryList(r) },
  'flow.librarySave': { schema: flowLibrarySaveRequestSchema, invoke: (api, r) => api.flow.librarySave(r) },
  'flow.libraryDelete': { schema: flowLibraryDeleteRequestSchema, invoke: (api, r) => api.flow.libraryDelete(r) },
  'langflow.status': { schema: langflowStatusRequestSchema, invoke: (api, r) => api.langflow.status(r) },
  'langflow.start': { schema: langflowStartRequestSchema, invoke: (api, r) => api.langflow.start(r) },
  'langflow.stop': { schema: langflowStopRequestSchema, invoke: (api, r) => api.langflow.stop(r) },
  'workspace.list': { schema: workspaceListRequestSchema, invoke: (api, r) => api.workspace.list(r) },
  'workspace.create': { schema: workspaceCreateRequestSchema, invoke: (api, r) => api.workspace.create(r) },
  'workspace.rename': { schema: workspaceRenameRequestSchema, invoke: (api, r) => api.workspace.rename(r) },
  'workspace.delete': { schema: workspaceDeleteRequestSchema, invoke: (api, r) => api.workspace.delete(r) },
  'workspace.insertBefore': { schema: workspaceInsertBeforeRequestSchema, invoke: (api, r) => api.workspace.insertBefore(r) },
  'workspace.insertSessionBefore': {
    schema: workspaceInsertSessionBeforeRequestSchema, invoke: (api, r) => api.workspace.insertSessionBefore(r),
  },
  'workspace.archiveSession': { schema: workspaceArchiveSessionRequestSchema, invoke: (api, r) => api.workspace.archiveSession(r) },
  'worktree.list': { schema: worktreeListRequestSchema, invoke: (api, r) => api.worktree.list(r) },
  'worktree.create': { schema: worktreeCreateRequestSchema, invoke: (api, r) => api.worktree.create(r) },
  'worktree.status': { schema: worktreeStatusRequestSchema, invoke: (api, r) => api.worktree.status(r) },
  'worktree.pref': { schema: worktreePrefRequestSchema, invoke: (api, r) => api.worktree.pref(r) },
  'worktree.setPref': { schema: worktreeSetPrefRequestSchema, invoke: (api, r) => api.worktree.setPref(r) },
  'worktree.remove': { schema: worktreeRemoveRequestSchema, invoke: (api, r) => api.worktree.remove(r) },
  'skill.list': { schema: skillListRequestSchema, invoke: (api, r) => api.skills.list(r) },
  'agentPreset.list': { schema: agentPresetListRequestSchema, invoke: (api, r) => api.agentPresets.list(r) },
  'agentPreset.select': { schema: agentPresetSelectRequestSchema, invoke: (api, r) => api.agentPresets.select(r) },
  'agentPreset.read': { schema: agentPresetReadRequestSchema, invoke: (api, r) => api.agentPresets.read(r) },
  'agentPreset.copy': { schema: agentPresetCopyRequestSchema, invoke: (api, r) => api.agentPresets.copy(r) },
  'agentPreset.openDocument': {
    schema: agentPresetOpenDocumentRequestSchema, invoke: (api, r, signal) => api.agentPresets.openDocument(r, signal),
  },
  'agentPreset.remove': { schema: agentPresetRemoveRequestSchema, invoke: (api, r) => api.agentPresets.remove(r) },
  'goal.create': { schema: goalCreateRequestSchema, invoke: (api, r) => api.goals.create(r) },
  'goal.edit': { schema: goalEditRequestSchema, invoke: (api, r) => api.goals.edit(r) },
  'goal.pause': { schema: goalPauseRequestSchema, invoke: (api, r) => api.goals.pause(r) },
  'goal.resume': { schema: goalResumeRequestSchema, invoke: (api, r) => api.goals.resume(r) },
  'goal.complete': { schema: goalCompleteRequestSchema, invoke: (api, r) => api.goals.complete(r) },
  'goal.clear': { schema: goalClearRequestSchema, invoke: (api, r) => api.goals.clear(r) },
  'settings.describe': { schema: settingsDescribeRequestSchema, invoke: (api, r) => api.settings.describe(r) },
  'settings.openDocument': { schema: settingsOpenDocumentRequestSchema, invoke: (api, r, signal) => api.settings.openDocument(r, signal) },
  'settings.update': { schema: settingsUpdateRequestSchema, invoke: (api, r) => api.settings.update(r) },
  'settings.replace': { schema: settingsReplaceRequestSchema, invoke: (api, r) => api.settings.replace(r) },
  'settings.mutate': { schema: settingsMutateRequestSchema, invoke: (api, r) => api.settings.mutate(r) },
  'credentials.describe': { schema: credentialsDescribeRequestSchema, invoke: (api, r) => api.credentials.describe(r) },
  'credentials.set': { schema: credentialsSetRequestSchema, invoke: (api, r) => api.credentials.set(r) },
  'credentials.unset': { schema: credentialsUnsetRequestSchema, invoke: (api, r) => api.credentials.unset(r) },
  'opencodeOAuth.start': { schema: opencodeOAuthStartRequestSchema, invoke: (api, r) => api.opencodeOAuth.start(r) },
  'opencodeOAuth.status': { schema: opencodeOAuthStatusRequestSchema, invoke: (api, r) => api.opencodeOAuth.status(r) },
  'opencodeOAuth.select': { schema: opencodeOAuthSelectRequestSchema, invoke: (api, r) => api.opencodeOAuth.select(r) },
  'opencodeOAuth.cancel': { schema: opencodeOAuthCancelRequestSchema, invoke: (api, r) => api.opencodeOAuth.cancel(r) },
  'claudeOAuth.start': { schema: claudeOAuthStartRequestSchema, invoke: (api, r) => api.claudeOAuth.start(r) },
  'claudeOAuth.submit': { schema: claudeOAuthSubmitRequestSchema, invoke: (api, r) => api.claudeOAuth.submit(r) },
  'claudeOAuth.cancel': { schema: claudeOAuthCancelRequestSchema, invoke: (api, r) => api.claudeOAuth.cancel(r) },
  'llm.providers': { schema: llmProvidersRequestSchema, invoke: (api, r) => api.llm.providers(r) },
  'llm.models': { schema: llmModelsRequestSchema, invoke: (api, r) => api.llm.models(r) },
  'llm.discoverModels': { schema: llmDiscoverModelsRequestSchema, invoke: (api, r, signal) => api.llm.discoverModels(r, signal) },
  'term.spawn': { schema: termSpawnRequestSchema, invoke: (api, r) => api.term.spawn(r) },
  'term.read': { schema: termReadRequestSchema, invoke: (api, r) => api.term.read(r) },
  'term.input': { schema: termInputRequestSchema, invoke: (api, r) => api.term.input(r) },
  'term.resize': { schema: termResizeRequestSchema, invoke: (api, r) => api.term.resize(r) },
  'term.dispose': { schema: termDisposeRequestSchema, invoke: (api, r) => api.term.dispose(r) },
  'jobs.kill': { schema: jobKillRequestSchema, invoke: (api, r) => api.jobs.kill(r) },
}

/** Route lookup that narrows an arbitrary path segment to a map key (single cast point for the string→key refinement). */
function methodFor(path: string): keyof RpcMethodMap | undefined {
  return Object.hasOwn(UNARY_ROUTES, path) ? path as keyof RpcMethodMap : undefined
}

/**
 * Sentinel rpcId for error responses to envelopes whose own rpcId is unreadable: the response
 * must still be a valid ServerResponse (a self-violating shape would turn the server's explicit
 * bad-request report into a client-side parse failure). Fixed value, documented here as wire contract.
 */
const INVALID_REQUEST_RPC_ID = RpcId('invalid-request')

/** Wrap a business error as a ServerResponse full form (rpcId backfilled; an unreadable rpcId uses the invalid-request sentinel). */
function errorResponse(rpcId: RpcId, error: RpcError): Response {
  const body: ServerResponse = { type: 'server-response', rpcId, result: { ok: false, error } }
  return Response.json(body)
}

/** Complete the impl's narrow form into a ServerResponse full form. */
function fullResponse(narrow: RpcResponse<unknown>): Response {
  const body: ServerResponse = { type: 'server-response', rpcId: narrow.rpcId, result: narrow.result }
  return Response.json(body)
}

/**
 * Parse the payload and invoke one unary route. Generic over the map key so
 * the row's schema/invoke pairing typechecks; the only cast collapses the
 * Wire<> widening back to the exact payload (undefined-valued properties and
 * absent ones are indistinguishable after JSON transport).
 */
async function handleUnary<K extends keyof RpcMethodMap>(
  api: ApiProxy, method: K, message: ClientRequest, signal: AbortSignal, origin?: string,
): Promise<Response> {
  const route = UNARY_ROUTES[method]
  const payload = route.schema.safeParse(message.payload)
  if (!payload.success) {
    return errorResponse(message.rpcId, {
      code: 'bad-request', message: `invalid payload for ${method}`, details: { issues: payload.error.issues },
    })
  }
  try {
    return fullResponse(await route.invoke(api, { rpcId: message.rpcId, payload: payload.data }, signal, origin))
  } catch (error: unknown) {
    // The impl never throws business errors; reaching here means the implementation itself crashed — 500, carrier layer.
    return new Response(`handler failure: ${String(error)}`, { status: 500 })
  }
}

/** SSE frame: complete the narrow RpcRequest<frame> into a ServerRequest full form (method = frame type). */
function fullFrame(narrow: RpcRequest<MuxFrame | HostFrame>): ServerRequest {
  return { type: 'server-request', rpcId: narrow.rpcId, method: narrow.payload.type, payload: narrow.payload }
}

/**
 * Wrap a frame stream as an SSE Response; stops when req.signal aborts. An
 * impl throw mid-stream emits one stream/error frame and then closes.
 */
function sseResponse(frames: AsyncIterable<RpcRequest<MuxFrame | HostFrame>>): Response {
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        // Send an SSE comment line on open so clients/proxies see a live channel (the host
        // stream has no baseline frames and would otherwise emit zero bytes while idle;
        // a comment line is not a frame, so client frame parsing skips it naturally).
        controller.enqueue(encoder.encode(': connected\n\n'))
        for await (const narrow of frames) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(fullFrame(narrow))}\n\n`))
        }
      } catch (error: unknown) {
        // Mid-stream impl failure → one stream/error frame, then close: the client must see
        // the failure instead of a silent end (which reads as a normal disconnect). A fresh
        // rpcId is minted — this is a server-initiated push like any other frame.
        const failure: MuxFrame | HostFrame = { type: 'stream/error', error: { code: 'internal', message: String(error), details: {} } }
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(fullFrame({ rpcId: RpcId(randomUUID()), payload: failure }))}\n\n`))
        } catch {
          // Consumer already cancelled the stream: enqueue-after-cancel is the
          // only reachable error, and there is no one left to tell.
        }
      } finally {
        try {
          controller.close()
        } catch { /* already cancelled by the consumer: a double close is the only reachable error */ }
      }
    },
  })
  return new Response(stream, {
    headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
  })
}

/**
 * Wraps an ApiProxy into a pure fetch function (isomorphic point: feed the returned fetch straight to InProcessApiClient).
 * @param api - the host-side ApiProxy implementation.
 * @returns an object holding `fetch(Request)`; paths outside /api/ return 404.
 */
export function toFetchHandler(api: ApiProxy): { fetch: typeof fetch } {
  return {
    // Signature matches global fetch: the isomorphic point hands this function to InProcessApiClient as its transport aspect,
    // Clients call in (url, init) form — normalize to Request before handling.
    async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
      const req = input instanceof Request ? input : new Request(input, init)
      const url = new URL(req.url)
      const path = url.pathname

      // No-envelope read channels (SSE GET streams + host-only download):
      // physical routes that answer directly, without a wire envelope.
      if (path === '/api/events.mux' && req.method === 'GET') {
        return sseResponse(api.events.mux({ rpcId: RpcId(randomUUID()), payload: {} }, req.signal))
      }
      if (path === '/api/events.host' && req.method === 'GET') {
        return sseResponse(api.events.host({ rpcId: RpcId(randomUUID()), payload: {} }, req.signal))
      }
      if (path === '/api/session.export' && (req.method === 'GET' || req.method === 'HEAD')) {
        // Query params are a different boundary from the POST envelope, but
        // the request still casts its brands only through the domain schema.
        const parsed = sessionLogQuerySchema.safeParse(Object.fromEntries(url.searchParams))
        if (!parsed.success) {
          return new Response('missing or invalid sessionId query parameter', { status: 400 })
        }
        const response = await api.downloads.sessionLog(parsed.data, req.signal)
        if (req.method === 'GET') return response
        await response.body?.cancel()
        return new Response(null, { status: response.status, headers: response.headers })
      }
      if (path === '/api/host/media' && (req.method === 'GET' || req.method === 'HEAD')) {
        // The inline viewers' binary channel: path + remux flag ride the
        // query string; the Range header passes verbatim (media-response.ts
        // owns the single-range semantics).
        const filePath = url.searchParams.get('path')
        if (filePath === null || filePath === '') {
          return new Response('missing path query parameter', { status: 400 })
        }
        const range = req.headers.get('range')
        const response = await api.downloads.media({
          path: filePath,
          ...(range !== null ? { range } : {}),
          ...(url.searchParams.get('remux') === '1' ? { remux: true } : {}),
        }, req.signal)
        if (req.method === 'GET') return response
        await response.body?.cancel()
        return new Response(null, { status: response.status, headers: response.headers })
      }

      if (req.method !== 'POST' || !path.startsWith('/api/')) {
        return new Response('not found', { status: 404 })
      }

      // Cross-site write fence: browsers send "simple" POSTs (text/plain,
      // form encodings) without a CORS preflight, so a malicious page could
      // otherwise execute side-effectful RPCs blind — the response stays
      // unreadable cross-origin, but session.prompt would still run. Only the
      // JSON media type is accepted; anything else is forced into a preflight
      // this server never answers. 415 = carrier layer, like the 400 below.
      const mediaType = req.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
      if (mediaType !== 'application/json') {
        return new Response('content type must be application/json', { status: 415 })
      }

      let body: unknown
      try {
        body = await req.json()
      } catch {
        // 400 = carrier layer (body is not even JSON); valid JSON with a bad shape goes 200 + bad-request.
        return new Response('body is not JSON', { status: 400 })
      }

      if (path === '/api/respond') {
        const parsed = clientResponseSchema.safeParse(body)
        if (!parsed.success) return Response.json({ accepted: false, reason: 'bad-response' })
        return Response.json(await api.respond(parsed.data))
      }

      const method = methodFor(path.slice('/api/'.length))
      if (method === undefined) return new Response('not found', { status: 404 })

      const envelope = clientRequestSchema.safeParse(body)
      if (!envelope.success) {
        // Best effort at correlation: salvage a string rpcId from the raw body;
        // otherwise the fixed sentinel keeps the response a valid ServerResponse.
        const rawId = (body as { rpcId?: unknown } | null)?.rpcId
        const rpcId = typeof rawId === 'string' ? RpcId(rawId) : INVALID_REQUEST_RPC_ID
        return errorResponse(rpcId, {
          code: 'bad-request', message: 'invalid client-request message', details: { issues: envelope.error.issues },
        })
      }
      const message: ClientRequest = envelope.data
      if (message.method !== method) {
        return errorResponse(message.rpcId, {
          code: 'bad-request', message: `method "${message.method}" does not match path "${method}"`, details: { issues: [] },
        })
      }
      // Only a native-key MAC from the bridge proves the original browser
      // origin; `Origin` alone is spoofable by direct loopback callers.
      const verifier = (api as Partial<AgentMailVerifiedApi>).verifyAgentMailOrigin
      const origin = method.startsWith('agentMail.') && typeof verifier === 'function'
        ? verifier(req)
        : undefined
      if (method.startsWith('agentMail.') && origin === undefined) {
        return new Response('Agent Mail requires native browser pairing', { status: 403 })
      }
      return handleUnary(api, method, message, req.signal, origin)
    },
  }
}
