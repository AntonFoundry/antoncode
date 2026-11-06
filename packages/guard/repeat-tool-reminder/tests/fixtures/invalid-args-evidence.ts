/** Loader observer for schema rejection, hook composition, and request history. */
import assert from 'node:assert/strict'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-llm'

/** Loader identity for the malformed tool-call scenario. */
export const name = 'invalid-args-evidence'
/** Services inspected by this scenario. */
export const inject = ['agents', 'tools']

/**
 * Observe the shipped guard and hooks without replacing execution behavior.
 * @param ctx - Loader-owned fixture context.
 */
export function apply(ctx: Context): void {
  ctx.on('agent/created', ({ agent }) => {
    agent.ctx.tools.restrict({ allow: ['todo_write'] })
  })
  ctx.on('tools/pre-execute', () => {
    assert.fail('invalid arguments reached pre-execute policy')
  })
  ctx.on('tools/execute', () => {
    assert.fail('invalid arguments reached dispatch')
  })
  let requests = 0
  ctx.on('llm/stream', (request, next) => {
    requests++
    const agent = request.sessionId === undefined ? undefined : ctx.agents.get(request.sessionId)
    assert(agent !== undefined, 'request has no live Agent')
    const events = agent.session.snapshotEvents()
    assert(!new Set<string>(events.map(event => event.type)).has('todo/write'), 'invalid call ran the todo tool')
    const contextKinds = new Set(['repeat-tool-reminder', 'hooks-claude-code'])
    const hookKind: string = 'hooks-claude-code'
    const logged = events.flatMap(event => event.type === 'user/message'
      && contextKinds.has(event.data.source.kind)
      ? [event.data] : [])
    const visible = request.messages.filter(message => message.source !== undefined && contextKinds.has(message.source.kind))
    assert.deepEqual(visible, logged, 'request context differs from logged hook/guard messages')
    assert.equal(logged.filter(message => message.source.kind === hookKind).length, requests - 1)
    const reminders = logged.filter(message => message.source.kind === 'repeat-tool-reminder')
    assert.equal(reminders.length, requests === 4 ? 1 : 0)
    if (requests === 4) {
      assert.equal(reminders[0]!.source.kind, 'repeat-tool-reminder')
      assert(reminders[0]!.content.some(block => block.type === 'text' && block.text.includes('repeating the exact same tool call')))
    }
    return next()
  })
}
