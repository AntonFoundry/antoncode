/** Native and nested PTC queue publications survive Agent Mail reload without waking recipients. */
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { expect, it, onTestFinished } from 'vitest'
import { z } from 'zod'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { prepareSessionSnapshotFixtureForComparison } from '@deepseek-ai/dsh-llm-replay'
import type { Agent } from '@deepseek-ai/dsh-agent'
import {
  fixtureContext, formatSystemPromptSnapshot, formatToolSchemasSnapshot, normalizeSessionSnapshots,
  normalizedSystemPrompts, normalizedToolSchemas, redactSessionSnapshotIds, refreshFixtureReplacements,
  scrubSessionSnapshot, stabilizeFixtureMessageIds, stabilizeRefreshLog, tokenizeSessionFixtureCwd,
} from '@deepseek-ai/dsh-session-snapshot'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-agent-queue'
import type {} from '@deepseek-ai/dsh-tool-executor-ptc'
import type {} from '@deepseek-ai/dsh-workspace'
import {
  fixtureUserPrompts, launchWebScaffold, normalizeWebSessionVolatiles, rawSessionLog, readPersistedEvents,
  webSnapshotMode,
} from './scaffold.ts'
import { newEnglishPage, pinBrowserClock, pinHostClock, REPO_ROOT } from './support.ts'

const DIR = fileURLToPath(new URL('../../../snapshots/web/agent-mail-correspondence', import.meta.url))
const MODE = webSnapshotMode()
const BODIES = ['Native queue correspondence', 'PTC queue correspondence'] as const
const TITLES = ['Native mail sender', 'PTC mail sender'] as const
const receiptSchema = z.object({
  id: z.string(), workspaceId: z.string(), seq: z.number().int().positive(), sender: z.string(),
  recipients: z.array(z.string()), workspaceWide: z.literal(true), body: z.string(), createdAt: z.number(),
}).strict()

/** Replace only queue receipt fields in accepted native or nested tool result text. */
function canonicalReceipts(log: string, sessions: readonly string[], workspaceId: string): string {
  interface ReceiptRow {
    type: string
    data?: {
      name?: string
      callId?: string
      content?: { type: string; text: string }[]
      message?: { source: { callId: string }; content: { type: string; text: string }[] }
    }
  }
  const rows = log.trimEnd().split('\n').map(line => JSON.parse(line) as ReceiptRow)
  const queueCalls = new Set(rows.filter(row => row.type === 'tool/call' && row.data?.name === 'agent_queue_send')
    .map(row => row.data?.callId))
  for (const row of rows) {
    const native = row.type === 'tool/result' && row.data?.message !== undefined
      && queueCalls.has(row.data.message.source.callId)
    const nested = row.type === 'tool/ptc-dispatch' && row.data?.name === 'agent_queue_send'
    if (!native && !nested) continue
    const content = native ? row.data!.message!.content : row.data!.content!
    expect(content).toHaveLength(1)
    const receipt = receiptSchema.parse(JSON.parse(content[0]!.text))
    expect(receipt.workspaceId).toBe(workspaceId)
    const sender = sessions.indexOf(receipt.sender)
    expect(sender).toBeGreaterThanOrEqual(0)
    content[0]!.text = JSON.stringify({ ...receipt, id: `{{id:${receipt.seq + 1}}}`, workspaceId: '{{id:1}}',
      sender: `{{session:${sender + 1}}}`, recipients: receipt.recipients.map((recipient) => {
        const role = sessions.indexOf(recipient)
        expect(role).toBeGreaterThanOrEqual(0)
        return `{{session:${role + 1}}}`
      }), createdAt: 0 })
  }
  return rows.map(row => JSON.stringify(row)).join('\n') + '\n'
}

it.skipIf(MODE === 'record')('replays native and PTC Agent Mail correspondence through the shipped Web profile', async () => {
  const clock = pinHostClock()
  onTestFinished(() => { clock.mockRestore() })
  const paths = ['session.v4.jsonl', 'session.1.v4.jsonl'].map(file => join(DIR, file))
  let expected = await Promise.all(paths.map(path => readFile(path, 'utf8')))
  const scaffold = await launchWebScaffold({
    replayFixture: paths[0]!, replayChildFixtures: [paths[1]!],
    replayOverride: join(DIR, 'replay.override.json'), compareReplaySession: false, directToolCalls: true,
    extraInstallAnchors: [join(REPO_ROOT, 'packages/interaction/tool-agent-queue/package.json'),
      join(REPO_ROOT, 'packages/core/tool-executor-ptc/package.json')],
    agentPresets: { default: 'mail-native', definitions: [
      { id: 'mail-native', plugins: [{ name: '@deepseek-ai/dsh-tool-agent-queue' }] },
      { id: 'mail-ptc', plugins: [{ name: '@deepseek-ai/dsh-tool-agent-queue' },
        { name: '@deepseek-ai/dsh-tool-executor-ptc' }] },
    ] },
  })
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
  try {
    const workspace = await scaffold.ctx.workspaceRegistry.create(scaffold.workspaceCwd, 'Mail correspondence workspace')
    const agents: Agent[] = []
    for (const preset of ['mail-native', 'mail-ptc', 'mail-native']) {
      const { sessionId } = await scaffold.ctx.sessionController.create({ workspaceId: workspace.id, agentPreset: preset })
      const agent = scaffold.ctx.agents.get(sessionId)
      if (agent === undefined) throw new Error('created mail session has no Agent')
      agents.push(agent)
      // A title makes each otherwise blank Session non-reusable before creating the next role.
      await scaffold.ctx.sessionController.rename({ sessionId, title: TITLES[agents.length - 1] ?? 'Idle mail receiver' })
    }
    const receiver = agents[2]!
    await scaffold.ctx.agentQueue.subscribe(receiver)
    for (const [index, agent] of agents.slice(0, 2).entries()) {
      const prompt = fixtureUserPrompts(expected[index]!)[0]
      if (prompt === undefined) throw new Error('mail fixture has no user input')
      agent.followup(createUserMessage({ content: [{ type: 'text', text: prompt }], source: { kind: 'user' } }))
      await agent.whenIdle()
      await scaffold.ctx.sessionController.rename({ sessionId: agent.id, title: TITLES[index]! })
      await scaffold.ctx.sessions.flush(agent.session)
      const events = agent.session.snapshotEvents()
      expect(events.findLast(event => event.type === 'turn/end'))
        .toMatchObject({ type: 'turn/end', data: { reason: { kind: 'completed' } } })
      const results = events.filter(event => event.type === 'tool/result')
      expect(results).toHaveLength(1)
      expect(results[0]!.data.message.isError).toBe(false)
      const nested = events.filter(event => event.type === 'tool/ptc-dispatch')
      expect(nested).toHaveLength(index)
      if (index === 1) expect(nested[0]).toMatchObject({ data: { name: 'agent_queue_send', isError: false } })
      expect(await readPersistedEvents(scaffold, agent.id)).toEqual(events)
    }
    const before = await scaffold.ctx.agentQueue.read(receiver)
    expect(before).toMatchObject({ cursor: 0, hasMore: false, messages: BODIES.map((body, index) => ({
      seq: index + 1, body, sender: agents[index]!.id, recipients: [receiver.id], workspaceId: workspace.id,
      workspaceWide: true,
    })) })
    for (const message of before.messages) expect(message.createdAt).toBeGreaterThan(0)
    expect(receiver.status).toBe('idle')
    expect(receiver.session.snapshotEvents().some(event => event.type === 'turn/start')).toBe(false)

    const sessions = agents.slice(0, 2).map(agent => agent.session)
    const ids = agents.map(agent => String(agent.id))
    const context = { sessionIds: ids.slice(0, 2), cwd: scaffold.workspaceCwd }
    const raw = sessions.map(session => canonicalReceipts(
      normalizeWebSessionVolatiles(rawSessionLog(session), scaffold.workspaceCwd), ids, workspace.id))
    for (const [index, log] of raw.entries()) {
      const suffix = index === 0 ? '' : '.1'
      const prompts = normalizedSystemPrompts(log, context)
        .map(text => text.split(REPO_ROOT).join('{{sourceRoot}}').split(scaffold.baseUrl).join('{{webUrl}}'))
      const prompt = formatSystemPromptSnapshot(prompts[0]!, prompts.slice(1))
      const schemas = normalizedToolSchemas(log, context)
      const tools = formatToolSchemasSnapshot(schemas[0]!, schemas.slice(1))
      for (const [name, actual] of [[`system-prompt${suffix}.expected.md`, prompt], [`tool-schemas${suffix}.expected.json`, tools]]) {
        const path = join(DIR, name!)
        if (MODE === 'refresh') await writeFile(path, actual!)
        expect(actual).toBe(await readFile(path, 'utf8'))
      }
    }
    if (MODE === 'refresh') {
      const replacements = refreshFixtureReplacements(raw.map((content, index) => ({
        id: sessions[index]!.id, createdAt: sessions[index]!.header.createdAt, content,
      })), expected)
      expected = redactSessionSnapshotIds(stabilizeFixtureMessageIds(raw.map((log, index) =>
        tokenizeSessionFixtureCwd(scrubSessionSnapshot(stabilizeRefreshLog(
          prepareSessionSnapshotFixtureForComparison(log), expected[index]!, replacements, context,
        ))).split(scaffold.harnessHome).join('{{harnessHome}}')), expected))
      await Promise.all(expected.map((log, index) => writeFile(paths[index]!, log)))
    }
    expect(normalizeSessionSnapshots(raw, context))
      .toEqual(normalizeSessionSnapshots(expected, fixtureContext(expected[0]!)))

    browser = await chromium.launch()
    const page = await newEnglishPage(browser)
    const pageErrors: string[] = []
    page.on('pageerror', (error) => { pageErrors.push(error.message) })
    await pinBrowserClock(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    const ui: string[] = ['# Agent Mail correspondence', '']
    for (const [index, title] of TITLES.entries()) {
      for (const phase of ['opened', 'reloaded']) {
        if (phase === 'reloaded') await page.reload({ waitUntil: 'load' })
        const workspaceRow = page.getByRole('treeitem').filter({ has: page.getByText('Mail correspondence workspace', { exact: true }) }).first()
        await workspaceRow.waitFor()
        if (await workspaceRow.getAttribute('aria-expanded') === 'false') {
          await workspaceRow.getByText('Mail correspondence workspace', { exact: true }).click()
        }
        const row = page.getByRole('treeitem').filter({ has: page.getByText(title, { exact: true }) }).last()
        await row.waitFor()
        await row.click()
        await page.getByRole('tab', { name: 'Agent Mail', exact: true }).click()
        const mail = page.locator('[data-agent-mail="authorized"]')
        await mail.waitFor()
        await mail.getByRole('button', { name: 'general', exact: true }).click()
        await expect.poll(() => mail.getByText(BODIES[index]!, { exact: true }).count()).toBe(1)
        expect(await mail.getByText(BODIES[1 - index]!, { exact: true }).count()).toBe(0)
        ui.push(`- ${title}, ${phase}: general contains "${BODIES[index]}" exactly once.`)
        await mail.getByRole('button', { name: 'direct', exact: true }).click()
        for (const body of BODIES) expect(await mail.getByText(body, { exact: true }).count()).toBe(0)
        ui.push(`- ${title}, ${phase}: direct contains no correspondence.`)
      }
    }
    expect(await scaffold.ctx.agentQueue.read(receiver)).toEqual(before)
    expect(receiver.status).toBe('idle')
    expect(receiver.session.snapshotEvents().some(event => event.type === 'turn/start')).toBe(false)
    expect(pageErrors).toEqual([])
    const output = ui.join('\n') + '\n'
    if (MODE === 'refresh') await writeFile(join(DIR, 'ui.expected.md'), output)
    expect(output).toBe(await readFile(join(DIR, 'ui.expected.md'), 'utf8'))
  } finally {
    try { await browser?.close() } finally {
      try { await scaffold.close() } finally { clock.mockRestore() }
    }
  }
})
