/** Streaming system-prompt promotion followed by canonical V3 envelope conversion. */

import { createHash } from 'node:crypto'
import { SessionFormatError, SessionFormatUnsupportedMigrationError, defineSessionFormatMigration, sessionFormatCount } from '@deepseek-ai/dsh-session-format'
import type { SessionFormatEvent, SessionFormatEventRun, SessionFormatJsonObject, SessionFormatJsonValue, SessionFormatMigrationContext, SessionFormatMigrationStage, SessionFormatMigrationStageInput } from '@deepseek-ai/dsh-session-format'
import { assertReleasedV2Header, RELEASED_V2_EVENT_DISPOSITIONS } from '@deepseek-ai/dsh-session-format-v1-to-v2'
import { ANTON_FORK_V0_EVENT_TYPES } from '@deepseek-ai/dsh-session-format-v0-to-v1'
import { assertEvent, canonicalizeTransformedEvent, record, SURFACE_TYPES } from './payload.ts'
import { remapEvent } from './references.ts'
import { assertReleasedV3Header } from './validation.ts'

/** Promote system prompts, remap audited references, and canonicalize envelopes and PTC vocabulary. */
export const sessionFormatV2ToV3 = defineSessionFormatMigration({
  name: '@deepseek-ai/dsh-session-format-v2-to-v3',
  fromVersion: 2,
  toVersion: 3,
  migrateHeader(header) {
    assertReleasedV2Header(header)
    return { ...header, version: 3, ...(header.agentPreset === 'code' ? { agentPreset: 'ptc' } : {}) }
  },
  createStage(input) { return new ReleasedV2ToV3Stage(input) },
  validateTargetHeader: assertReleasedV3Header,
})

class ReleasedV2ToV3Stage implements SessionFormatMigrationStage {
  readonly headerInheritedEventCount?: number
  private readonly mapping: number[] = []
  private readonly originalIds = new Set<string>()
  private readonly generatedIds = new Set<string>()
  private targetSeq = 0
  private sourceCut: number | undefined
  private targetCut: number | undefined
  private lastForeignDeliverySeq: number | undefined
  private step: { turn: number; step: number } | undefined
  /** The open turn and its last started step, for steps Anton's fork opened late. */
  private openTurn: { turn: number; lastStep: number } | undefined
  /** Whether this log has shown an Anton-fork record, which admits opening a late step early. */
  private forkLineage = false
  /** A step opened early for fork records written before its step/start; that step/start maps onto it. */
  private earlyStep: { turn: number; step: number; seq: number } | undefined
  private head: number | undefined
  private prompt = ''

  constructor(private readonly input: SessionFormatMigrationStageInput) {
    assertReleasedV2Header(input.sourceHeader)
    this.sourceCut = input.sourceHeader.isSeeded ? undefined : 0
    this.targetCut = input.sourceHeader.isSeeded ? undefined : 0
    if (!input.sourceHeader.isSeeded) this.headerInheritedEventCount = 0
  }

  transformEvent(event: SessionFormatEvent, context: SessionFormatMigrationContext): void {
    if (event.seq !== this.mapping.length) throw new SessionFormatError('format v2 source events must be dense')
    // Anton's fork-only records are carried opaque: only their envelope is renumbered.
    if (event.ignorable === true && ANTON_FORK_V0_EVENT_TYPES.has(event.type)
      && RELEASED_V2_EVENT_DISPOSITIONS[event.type] === undefined) {
      this.forkLineage = true
      const opaque = remapEvent(event, this.targetSeq, this.mapping)
      this.mapping.push(this.targetSeq++)
      context.emitEvent(opaque)
      return
    }
    assertEvent(event, 2)
    this.observeMessageIds(event)
    let source = event
    const data = record(event.data, event.type)
    if (event.type === 'step/start' && this.earlyStep !== undefined
      && data['turn'] === this.earlyStep.turn && data['step'] === this.earlyStep.step) {
      // This step was opened early for fork records that preceded it.
      this.mapping.push(this.earlyStep.seq)
      this.earlyStep = undefined
      return
    }
    if (this.forkLineage && this.step === undefined && this.openTurn !== undefined
      && ((SURFACE_TYPES.has(event.type) && this.head === undefined) || event.type === 'request/header')) {
      this.openStepEarly(event, context)
    }
    if (event.type === 'request/header') {
      const { system, ...header } = record(data['header'], 'request header')
      const prompt = typeof system === 'string' ? system : ''
      if (prompt !== this.prompt) this.emitSystem(prompt, event, context)
      source = { ...event, data: { ...data, header } }
    }
    if (SURFACE_TYPES.has(event.type) && this.head === undefined) {
      throw new SessionFormatUnsupportedMigrationError('format v2 surface before first step cannot acquire a system head without changing chronology')
    }
    if (event.type === 'session/end-seed' && data['inherited'] === true) {
      if (!this.input.sourceHeader.isSeeded) throw new SessionFormatError('format v2 unseeded Session contains an inherited end-seed marker')
      this.sourceCut = event.seq
      this.targetCut = this.targetSeq
    }
    if (event.type === 'session-log-deepseek/delivery-accepted') {
      if (data['sessionFormatVersion'] === 3) throw new SessionFormatError('format v2 delivery marker claims target format v3')
      if (data['sessionFormatVersion'] === 2 && data['sessionId'] !== this.input.sourceHeader.id) this.lastForeignDeliverySeq = event.seq
    }
    const target = remapEvent(source, this.targetSeq, this.mapping)
    this.mapping.push(this.targetSeq++)
    context.emitEvent(canonicalizeTransformedEvent(renamePtcEvent(target)))
    if (event.type === 'turn/start') {
      this.openTurn = { turn: data['turn'] as number, lastStep: 0 }
    } else if (event.type === 'turn/end') {
      this.openTurn = undefined
    }
    if (event.type === 'step/start') {
      this.step = { turn: data['turn'] as number, step: data['step'] as number }
      if (this.openTurn !== undefined) this.openTurn = { ...this.openTurn, lastStep: data['step'] as number }
      if (this.head === undefined) this.emitSystem('', event, context)
    } else if (event.type === 'step/end' || event.type === 'turn/end') {
      this.step = undefined
    }
  }

  transformRun(run: SessionFormatEventRun, context: SessionFormatMigrationContext): void {
    for (const event of run.expand()) this.transformEvent(event, context)
  }

  finish(_context: SessionFormatMigrationContext): number {
    const cut = sessionFormatCount(this.sourceCut, 'format v2 inherited end-seed marker')
    if (this.input.sourceInheritedEventCount !== undefined && this.input.sourceInheritedEventCount !== cut) {
      throw new SessionFormatError('format v2 inherited end-seed marker disagrees with its source cut')
    }
    if (this.lastForeignDeliverySeq !== undefined
      && (this.input.sourceHeader.parentSession === undefined || this.lastForeignDeliverySeq >= cut)) {
      throw new SessionFormatError('current-generation delivery marker names the wrong Session')
    }
    return sessionFormatCount(this.targetCut, 'format v3 inherited event count')
  }

  private observeMessageIds(event: SessionFormatEvent): void {
    const data = record(event.data, event.type)
    const messages = event.type === 'user/message' ? [data]
      : event.type === 'assistant/message' || event.type === 'tool/result' ? [record(data['message'], 'message')]
        : event.type === 'agent/inbox/spliced' ? data['inserted']
          : event.type === 'session/title-llm-request' ? data['messages'] : []
    // assertEvent validates every owned message before identity observation.
    for (const message of messages as readonly SessionFormatJsonObject[]) {
      const id = message['id'] as string
      if (this.generatedIds.has(id)) throw new SessionFormatUnsupportedMigrationError('source message id collides with a generated system message id')
      this.originalIds.add(id)
    }
  }

  /**
   * Open the next step of the open turn at a fork record written before its
   * step/start. Anton's 0.1.x fork wrote request headers and the prompt
   * message after turn/start but before step/start; upstream logs never do.
   * The step/start payload is only its coordinate (steps count from 1 within
   * a turn), so emitting it here loses nothing; the source step/start later
   * maps onto this event.
   * @param anchor - the fork record that needs an open step.
   * @param context - migration output.
   */
  private openStepEarly(anchor: SessionFormatEvent, context: SessionFormatMigrationContext): void {
    const turn = this.openTurn
    if (turn === undefined) return
    const coordinate = { turn: turn.turn, step: turn.lastStep + 1 }
    const seq = this.targetSeq++
    context.emitEvent(canonicalizeTransformedEvent({ type: 'step/start', seq, time: anchor.time, data: coordinate }))
    this.step = coordinate
    this.openTurn = { ...turn, lastStep: coordinate.step }
    this.earlyStep = { ...coordinate, seq }
    // A request/header anchor emits its own system message, which becomes the head.
    if (this.head === undefined && anchor.type !== 'request/header') this.emitSystem('', anchor, context)
  }

  private emitSystem(prompt: string, anchor: SessionFormatEvent, context: SessionFormatMigrationContext): void {
    const step = this.step
    if (step === undefined) {
      throw new SessionFormatUnsupportedMigrationError('format v2 changed request prompt outside an open step cannot retain source chronology')
    }
    const identity = JSON.stringify(['session-format-v2-to-v3', this.input.sourceHeader.id, anchor.seq, anchor.type])
    const id = 'v2-to-v3-system-' + createHash('sha256').update(identity).digest('hex')
    if (this.originalIds.has(id) || this.generatedIds.has(id)) {
      throw new SessionFormatUnsupportedMigrationError('generated system message id collides with an existing message id')
    }
    this.generatedIds.add(id)
    const seq = this.targetSeq++
    context.emitEvent(canonicalizeTransformedEvent({
      type: 'system/message', seq, time: anchor.time,
      data: {
        ...step,
        message: {
          id,
          role: 'system', source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt' },
          content: prompt === '' ? [] : [{ type: 'text', text: prompt }],
        },
      },
      ...(this.head === undefined
        ? { surfaceOp: 'append' }
        : { surfaceOp: { op: 'replace', start: this.head, end: this.head }, sourceEventSeqs: [this.head] }),
    }))
    this.head = seq
    this.prompt = prompt
  }
}

/** Source admission precedes renaming, so these payloads have exact audited fields. */
function renamePtcEvent(event: SessionFormatEvent): SessionFormatEvent {
  switch (event.type) {
    case 'agent-preset/selected':
      return (event.data as SessionFormatJsonObject)['agentPreset'] === 'code'
        ? { ...event, data: { ...event.data as SessionFormatJsonObject, agentPreset: 'ptc' } } : event
    case 'tool/code-dispatch-start':
      return { ...event, type: 'tool/ptc-dispatch-start' }
    case 'tool/code-dispatch':
      return { ...event, type: 'tool/ptc-dispatch' }
    case 'user/message': {
      const data = renameMessageSource(event.data as SessionFormatJsonObject)
      return data === event.data ? event : { ...event, data }
    }
    case 'agent/inbox/spliced':
    case 'session/title-llm-request': {
      const data = event.data as SessionFormatJsonObject
      const key = event.type === 'agent/inbox/spliced' ? 'inserted' : 'messages'
      const messages = data[key] as readonly SessionFormatJsonObject[]
      const renamed = messages.map(renameMessageSource)
      return renamed.every((message, index) => message === messages[index])
        ? event
        : { ...event, data: { ...data, [key]: renamed } }
    }
    default:
      // Content, tool arguments, message IDs, and other payloads are not plugin attribution slots.
      return event
  }
}

function renameMessageSource(message: SessionFormatJsonObject): SessionFormatJsonValue {
  const source = message['source'] as SessionFormatJsonObject
  if (source['kind'] !== 'plugin' || source['plugin'] !== 'tools-code-mode') return message
  return { ...message, source: { ...source, plugin: 'tools-ptc' } }
}
