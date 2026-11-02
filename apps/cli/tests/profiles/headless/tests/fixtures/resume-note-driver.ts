#!/usr/bin/env node
/** Test driver: one completed turn, a crash-open tail, then a resume that
 * repairs it and runs the note-carrying turn — through the real Loader app. */

import { boot, resolveConfigPath } from '@deepseek-ai/dsh-app-boot'
import { runFixtureTurn } from '@deepseek-ai/dsh-loader-smoke'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

const configPath = process.argv[2]
if (configPath === undefined) throw new Error('resume-note driver requires a config path')

// Boot 1: a normal completed turn, then leave a second turn open exactly as a
// killed harness would — events appended and flushed, no turn/end.
let sessionId: string
{
  const ctx = await boot('resume-note-e2e', resolveConfigPath(configPath, undefined))
  try {
    const first = await runFixtureTurn(ctx, { task: 'first' })
    sessionId = first.sessionId
    const sessions = ctx.get('sessions')
    if (sessions === undefined) throw new Error('resume-note driver: no sessions service')
    const session = sessions.get(SessionId(sessionId))
    if (session === undefined) throw new Error(`resume-note driver: session ${sessionId} not found`)
    session.append('turn/start', { turn: 2 })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'interrupted task' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    await sessions.flush(session)
  } finally {
    await ctx.fiber.dispose()
  }
}

// Boot 2: agents.resume loads the persisted log — the persistence repair
// closes the open tail with an interrupted turn/end — and the turn driven on
// the resumed agent carries the resume note.
{
  const ctx = await boot('resume-note-e2e', resolveConfigPath(configPath, undefined))
  try {
    const agents = ctx.get('agents')
    if (agents === undefined) throw new Error('resume-note driver: no agents service')
    const handle = await agents.resume({
      resumeSessionId: SessionId(sessionId),
      agentOptions: { provider: 'resume-note-mock', model: 'resume-note-mock' },
    })
    try {
      const agent = handle.agent
      await agent.whenIdle()
      agent.followup(createUserMessage({
        content: [{ type: 'text', text: 'second' }],
        source: { kind: 'user' },
      }))
      await agent.whenIdle()
      const sessions = ctx.get('sessions')
      if (sessions !== undefined) await sessions.flush(agent.session)
    } finally {
      await handle.dispose()
    }
  } finally {
    await ctx.fiber.dispose()
  }
}
