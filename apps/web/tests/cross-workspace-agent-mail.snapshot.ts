/** Real cross-workspace picker, live delivery and Reply preserve queue and Session ownership. */
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Page } from 'playwright'
import { expect, it, onTestFinished } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { directQueueState } from '@deepseek-ai/dsh-agent-queue/direct'
import { prepareSessionSnapshotFixtureForComparison } from '@deepseek-ai/dsh-llm-replay'
import {
  fixtureContext, formatSystemPromptSnapshot, formatToolSchemasSnapshot, normalizeSessionSnapshots,
  normalizedSystemPrompts, normalizedToolSchemas, redactSessionSnapshotIds, refreshFixtureReplacements,
  scrubSessionSnapshot, stabilizeFixtureMessageIds, stabilizeRefreshLog, tokenizeSessionFixtureCwd,
} from '@deepseek-ai/dsh-session-snapshot'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type {} from '@deepseek-ai/dsh-agent-queue'
import type {} from '@deepseek-ai/dsh-workspace'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import {
  compareOrRefreshGolden, fixtureUserPrompts, launchWebScaffold, normalizeWebSessionVolatiles,
  rawSessionLog, readPersistedEvents, webSnapshotMode,
} from './scaffold.ts'
import { newEnglishPage, pinBrowserClock, pinHostClock, REPO_ROOT, saveFailureShot } from './support.ts'

const DIR = fileURLToPath(new URL('../../../snapshots/web/cross-workspace-agent-mail', import.meta.url))
const MODE = webSnapshotMode()
const MESSAGE = 'A cross-workspace message delivered without Refresh.'
const REPLY = 'Draft already written before the incoming message.'

async function openMail(page: Page, workspaceTitle: string, title: string): Promise<void> {
  const workspace = page.getByRole('treeitem').filter({ has: page.getByText(workspaceTitle, { exact: true }) }).first()
  await workspace.waitFor()
  if (await workspace.getAttribute('aria-expanded') === 'false') {
    await workspace.getByText(workspaceTitle, { exact: true }).click()
  }
  await page.getByRole('treeitem').filter({ has: page.getByText(title, { exact: true }) }).last().click()
  await page.getByRole('tab', { name: 'Agent Mail', exact: true }).click()
  await page.locator('[data-agent-mail="authorized"]').waitFor()
}

async function chooseRecipient(page: Page, workspaceTitle: string, sessionId: string): Promise<void> {
  await page.getByRole('button', { name: 'Choose workspace', exact: true }).click()
  await page.getByRole('menuitem', { name: workspaceTitle, exact: true }).click()
  await page.getByRole('button', { name: 'Choose recipient', exact: true }).click()
  await page.getByRole('searchbox', { name: 'Search sessions', exact: true }).fill(sessionId)
  const recipient = page.getByRole('menuitem').filter({ hasText: sessionId.replace(/^session-/, '').slice(0, 8) })
  await recipient.click()
}

it.skipIf(MODE === 'record')('routes cross-workspace Mail through the picker, live inbox and exact-address Reply', async () => {
  const clock = pinHostClock()
  onTestFinished(() => { clock.mockRestore() })
  const paths = ['session.v4.jsonl', 'session.1.v4.jsonl'].map(file => join(DIR, file))
  let expected = await Promise.all(paths.map(path => readFile(path, 'utf8')))
  const scaffold = await launchWebScaffold({
    replayFixture: paths[0]!, replayChildFixtures: [paths[1]!],
    replayOverride: join(DIR, 'replay.override.json'), compareReplaySession: false,
    agentPresets: { default: 'mail-browser', definitions: [{ id: 'mail-browser', plugins: [] }] },
  })
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
  let receiverHandle: Awaited<ReturnType<typeof scaffold.ctx.agents.create>> | undefined
  const pages: Page[] = []
  try {
    const north = await scaffold.ctx.workspaceRegistry.create(scaffold.workspaceCwd, 'North mail workspace')
    const southPath = join(scaffold.workspaceCwd, 'south-mail-workspace')
    await mkdir(southPath)
    const south = await scaffold.ctx.workspaceRegistry.create(southPath, 'South mail workspace')
    const created = await scaffold.ctx.sessionController.create({ workspaceId: north.id, agentPreset: 'mail-browser' })
    const sender = scaffold.ctx.agents.get(created.sessionId)
    if (sender === undefined) throw new Error('created sender has no live Agent')
    const prompt = fixtureUserPrompts(expected[0]!)[0]
    if (prompt === undefined) throw new Error('cross-workspace fixture has no bootstrap input')
    sender.followup(createUserMessage({ content: [{ type: 'text', text: prompt }], source: { kind: 'user' } }))
    await sender.whenIdle()
    await scaffold.ctx.sessionController.rename({ sessionId: sender.id, title: 'North mail sender' })
    await scaffold.ctx.sessions.flush(sender.session)
    expect(sender.session.snapshotEvents().findLast(event => event.type === 'turn/end'))
      .toMatchObject({ data: { reason: { kind: 'completed' } } })
    expect(await readPersistedEvents(scaffold, sender.id)).toEqual(sender.session.snapshotEvents())

    receiverHandle = await scaffold.ctx.agents.create({
      sessionId: SessionId(randomUUID()), meta: { cwd: south.path, agentPreset: 'mail-browser' },
      agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      setup: agentCtx => scaffold.ctx.agentPresets.mount(agentCtx, 'mail-browser').then(() => undefined),
    })
    const receiver = receiverHandle.agent
    await south.attachSession(receiver.id)
    const receiverPrompt = fixtureUserPrompts(expected[1]!)[0]
    if (receiverPrompt === undefined) throw new Error('receiver fixture has no bootstrap input')
    receiver.followup(createUserMessage({ content: [{ type: 'text', text: receiverPrompt }], source: { kind: 'user' } }))
    await receiver.whenIdle()
    expect(receiver.session.snapshotEvents().findLast(event => event.type === 'turn/end'))
      .toMatchObject({ data: { reason: { kind: 'completed' } } })
    await scaffold.ctx.sessionController.rename({ sessionId: receiver.id, title: 'South mail receiver' })
    await scaffold.ctx.sessions.flush(receiver.session)
    expect(await readPersistedEvents(scaffold, receiver.id)).toEqual(receiver.session.snapshotEvents())
    const sessions = [sender.session, receiver.session]
    const context = { sessionIds: sessions.map(session => String(session.id)), cwd: scaffold.workspaceCwd }
    const raw = sessions.map(session => normalizeWebSessionVolatiles(rawSessionLog(session), scaffold.workspaceCwd))
    for (const [index, log] of raw.entries()) {
      const suffix = index === 0 ? '' : '.1'
      const prompts = normalizedSystemPrompts(log, context)
        .map(text => text.split(REPO_ROOT).join('{{sourceRoot}}').split(scaffold.baseUrl).join('{{webUrl}}'))
      const schemas = normalizedToolSchemas(log, context)
      const pins = [[`system-prompt${suffix}.expected.md`, formatSystemPromptSnapshot(prompts[0]!, prompts.slice(1))],
        [`tool-schemas${suffix}.expected.json`, formatToolSchemasSnapshot(schemas[0]!, schemas.slice(1))]]
      for (const [name, actual] of pins) {
        if (MODE === 'refresh') await writeFile(join(DIR, name!), actual!)
        expect(actual).toBe(await readFile(join(DIR, name!), 'utf8'))
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
    await scaffold.ctx.agentQueue.subscribe(sender)
    await scaffold.ctx.agentQueue.subscribe(receiver)
    const senderLocal = await scaffold.ctx.agentQueue.read(sender)
    const receiverLocal = await scaffold.ctx.agentQueue.read(receiver)
    const senderDirect = await scaffold.ctx.agentDirectQueue.inbox(sender)
    const receiverDirect = await scaffold.ctx.agentDirectQueue.inbox(receiver)
    expect(senderDirect.messages).toEqual([])
    expect(receiverDirect.messages).toEqual([])

    browser = await chromium.launch()
    const sendPage = await newEnglishPage(browser)
    const receivePage = await newEnglishPage(browser)
    pages.push(sendPage, receivePage)
    const pageErrors: string[] = []
    expect((await scaffold.ctx.agentDirectQueue.address(sender)).peers).toContainEqual({
      sessionId: receiver.id, workspaceId: south.id, transport: 'direct',
    })
    expect((await scaffold.ctx.agentDirectQueue.address(receiver)).peers).toContainEqual({
      sessionId: sender.id, workspaceId: north.id, transport: 'direct',
    })
    await receivePage.addInitScript((sessionId: string) => {
      localStorage.setItem('dsh.sessions.current', JSON.stringify({ sessionId }))
    }, receiver.id)
    for (const page of [sendPage, receivePage]) {
      page.on('pageerror', (error) => { pageErrors.push(error.message) })
      await pinBrowserClock(page)
      await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    }
    await receivePage.getByRole('tab', { name: 'Agent Mail', exact: true }).click()
    await receivePage.locator('[data-agent-mail="authorized"]').waitFor()
    await receivePage.getByRole('button', { name: 'direct', exact: true }).click()
    const receiveInput = receivePage.locator('[data-composer-input][contenteditable="true"]')
    await receiveInput.fill(REPLY)
    await openMail(sendPage, north.title, 'North mail sender')
    await chooseRecipient(sendPage, south.title, receiver.id)
    const sendInput = sendPage.locator('[data-composer-input][contenteditable="true"]')
    await sendInput.fill(MESSAGE)
    await sendPage.getByRole('button', { name: 'Send message', exact: true }).click()
    await expect.poll(async () => ({
      directCount: (await scaffold.ctx.agentDirectQueue.inbox(receiver)).messages.length,
      sendError: await sendPage.getByRole('alert').allTextContents(),
    })).toEqual({ directCount: 1, sendError: [] })
    const incoming = receivePage.locator('[data-agent-mail="authorized"]').getByRole('listitem').filter({ hasText: MESSAGE })
    await expect.poll(() => incoming.count()).toBe(1)
    const first = await scaffold.ctx.agentDirectQueue.inbox(receiver)
    expect(first).toMatchObject({ inboxCursor: receiverDirect.inboxCursor, messages: [{
      seq: 1, body: MESSAGE, sender: sender.id, senderWorkspaceId: north.id,
      recipients: [{ sessionId: receiver.id, workspaceId: south.id }],
    }] })
    expect(await receiveInput.innerText()).toBe(REPLY)
    await incoming.getByRole('button', { name: 'Reply', exact: true }).click()
    expect(await receiveInput.innerText()).toBe(REPLY)
    await receivePage.getByRole('button', { name: 'Send message', exact: true }).click()
    await expect.poll(() => sendPage.locator('[data-agent-mail="authorized"]').getByText(REPLY, { exact: true }).count()).toBe(1)
    expect(await scaffold.ctx.agentDirectQueue.inbox(sender)).toMatchObject({
      inboxCursor: senderDirect.inboxCursor, messages: [{ seq: 2, body: REPLY, sender: receiver.id,
        senderWorkspaceId: south.id, recipients: [{ sessionId: sender.id, workspaceId: north.id }] }],
    })
    const directMedium = join(scaffold.workspaceCwd, '.dsh-storages', 'agent_queue_direct.json')
    const committedMedium = await readFile(directMedium, 'utf8')
    const medium: { global: unknown } = JSON.parse(committedMedium)
    expect(directQueueState.parse(medium.global)).toMatchObject({
      nextSeq: 3, messages: [{ seq: 1, body: MESSAGE }, { seq: 2, body: REPLY }],
    })

    await scaffold.ctx.workspaceRegistry.moveSession(receiver.id, north.id)
    await sendInput.fill('This moved route must not commit.')
    await sendPage.getByRole('button', { name: 'Send message', exact: true }).click()
    await sendPage.getByRole('alert').waitFor()
    expect(await sendInput.innerText()).toBe('This moved route must not commit.')
    expect(await readFile(directMedium, 'utf8')).toBe(committedMedium)
    await scaffold.ctx.workspaceRegistry.moveSession(receiver.id, south.id)
    expect(await scaffold.ctx.agentDirectQueue.inbox(receiver)).toEqual(first)
    await chooseRecipient(sendPage, south.title, receiver.id)
    expect(receiver.status).toBe('idle')
    expect(receiver.session.snapshotEvents().filter(event => event.type === 'turn/start')).toHaveLength(1)
    expect(await scaffold.ctx.agentQueue.read(receiver)).toEqual(receiverLocal)
    await receivePage.close()
    await receiverHandle.dispose()
    receiverHandle = undefined
    await sendInput.fill('This offline route must not commit.')
    await sendPage.getByRole('button', { name: 'Send message', exact: true }).click()
    await sendPage.getByRole('alert').waitFor()
    expect(await sendInput.innerText()).toBe('This offline route must not commit.')
    expect(await readFile(directMedium, 'utf8')).toBe(committedMedium)
    expect(await scaffold.ctx.agentDirectQueue.inbox(sender)).toMatchObject({ messages: [{ seq: 2, body: REPLY }] })
    expect(await scaffold.ctx.agentQueue.read(sender)).toEqual(senderLocal)
    expect(receiverLocal.messages).toEqual([])
    expect(sender.session.snapshotEvents().filter(event => event.type === 'turn/start')).toHaveLength(1)
    expect(pageErrors).toEqual([])
    await compareOrRefreshGolden(join(DIR, 'ui.expected.md'), [
      '# Cross-workspace Agent Mail', '',
      '- Workspace and exact Session selection commits one direct-ledger message, not a local publication.',
      '- The recipient sees incoming Mail without Refresh, wake or acknowledgement.',
      '- Reply selects the exact sender and preserves the existing draft.',
      '- Reply commits once and the original sender receives its live update.',
      '- Moved and offline recipient routes reject without delivery or draft loss.',
      '- Browser mail leaves both recorded bootstrap turn counts unchanged.',
    ].join('\n'), MODE)
  } catch (error) {
    await Promise.all(pages.map((page, index) => saveFailureShot(page, `cross-workspace-agent-mail-${index}`)))
    throw error
  } finally {
    try { await browser?.close() } finally {
      try { await receiverHandle?.dispose() } finally {
        try { await scaffold.close() } finally { clock.mockRestore() }
      }
    }
  }
})
