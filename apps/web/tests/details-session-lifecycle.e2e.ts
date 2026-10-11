// Keyless browser regression for the details column's default visibility and Session ownership.
// The shipped composition starts closed after selection and reload, retains an explicitly opened width through
// unselected states, and closes it only when a different Session takes ownership.
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import {
  acknowledgeReloadConnectionLoss, assertFixtureInventory, compareOrRefreshGolden,
  fixtureUserPrompts, launchWebScaffold, seedSession, watchConsole, webSnapshotMode,
  type WebScaffold,
} from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('./snapshots/details-session-lifecycle', import.meta.url))
const HANDLES_EXPECTED = join(SNAPSHOT_DIR, 'handles.expected.md')
const FIXTURE = fileURLToPath(new URL('./snapshots/lifecycle-chrome/session.jsonl', import.meta.url))
const SEED_FIXTURE = fileURLToPath(new URL('./snapshots/seeded-history/seed.jsonl', import.meta.url))
const PROMPT = 'Reply with the single word LIGHTHOUSE and stop.'
const MODE = webSnapshotMode()

/** The shell root: present once the assembled frame has mounted. */
function appFrame(page: Page) {
  return page.locator('[data-app-frame]')
}

/** Rendered width (CSS px) of the pinned pane kind; 0 when it is not open. */
function paneWidth(page: Page, kind: 'sidebar' | 'context'): Promise<number> {
  const pane = page.locator(`[data-pane="${kind}"]`)
  // count() resolves immediately: a closed pane must not pay evaluate's
  // element-wait timeout on every poll.
  return pane.count().then(found => found === 0 ? 0 : pane.first().evaluate(element => element.getBoundingClientRect().width))
}

/** The pinned context column takes no space when the details panel is closed. */
function detailsTrack(page: Page): Promise<number> {
  return paneWidth(page, 'context')
}

/** The pinned workspace sidebar column's rendered width. */
function sidebarTrack(page: Page): Promise<number> {
  return paneWidth(page, 'sidebar')
}

/** Root-split sash contract: one row sash per pinned boundary, resize cursor. */
async function handleSnapshot(page: Page): Promise<string> {
  const sashes = await page.locator('[class*="sash"]').evaluateAll(elements =>
    elements.map(element => ({
      cursor: getComputedStyle(element).cursor,
      draggingFlag: element.hasAttribute('data-dragging'),
    })))
  return [
    '# Root split sashes',
    '',
    ...sashes.flatMap((sash, index) => [
      `## sash ${String(index)}`,
      '',
      `- cursor: ${sash.cursor}`,
      `- data-dragging flag present: ${String(sash.draggingFlag)}`,
      '',
    ]),
  ].join('\n').trimEnd()
}

describe.skipIf(MODE === 'record')('web e2e: details panel follows the current Session lifecycle', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    const fixture = await readFile(FIXTURE, 'utf8')
    expect(fixtureUserPrompts(fixture)).toEqual([PROMPT])
    scaffold = await launchWebScaffold({ replayFixture: FIXTURE, paceMs: 5 })
    await seedSession(scaffold, await readFile(SEED_FIXTURE, 'utf8'), 'details-session-lifecycle-seed')
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await appFrame(page).waitFor({ timeout: 30_000 })
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('starts and reloads closed, then stays closed across Session ownership changes', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-details-session-lifecycle'))
    const settled = scaffold.whenTurnSettled()
    const input = page.locator('textarea').first()
    await input.fill(PROMPT)
    await input.press('Enter')
    await settled
    await page.getByText('LIGHTHOUSE', { exact: true }).waitFor({ timeout: 15_000 })

    await expect.poll(() => detailsTrack(page), { timeout: 5_000 }).toBe(0)
    expect(await page.getByText('Details', { exact: true }).isVisible()).toBe(false)
    await compareOrRefreshGolden(HANDLES_EXPECTED, await handleSnapshot(page), MODE)

    const sidebarBefore = await sidebarTrack(page)
    expect(sidebarBefore).toBeGreaterThan(0)
    // The first row sash is the pinned-sidebar boundary: dragging it right
    // pins a wider sidebar preference (re-clamped to a fifth of the frame by
    // the product, so assert growth and persistence rather than the raw +70).
    const sidebarSash = page.locator('[class*="sash"]').first()
    const sashBox = await sidebarSash.boundingBox()
    expect(sashBox).not.toBeNull()
    const dragStartX = sashBox!.x + sashBox!.width / 2
    await page.mouse.move(dragStartX, sashBox!.y + 200)
    await page.mouse.down()
    await page.mouse.move(dragStartX + 70, sashBox!.y + 200, { steps: 6 })
    await page.mouse.up()
    const sidebarDragged = await sidebarTrack(page)
    expect(sidebarDragged).toBeGreaterThan(sidebarBefore)
    const shareCap = Math.round((page.viewportSize()?.width ?? 1280) * 0.2)
    expect(Math.abs(sidebarDragged - Math.min(sidebarBefore + 70, shareCap))).toBeLessThanOrEqual(2)

    const warningStart = tripwire.warnings.length
    await page.reload({ waitUntil: 'load' })
    acknowledgeReloadConnectionLoss(tripwire, warningStart)
    await appFrame(page).waitFor({ timeout: 30_000 })
    await page.getByText('LIGHTHOUSE', { exact: true }).waitFor({ timeout: 15_000 })
    await expect.poll(() => detailsTrack(page), { timeout: 5_000 }).toBe(0)
    expect(await page.getByText('Details', { exact: true }).isVisible()).toBe(false)
    // Panel geometry does not survive reloads by design (layout-store spec:
    // 'does not persist panel geometry'); the sidebar reopens at the
    // untouched share default, NOT the dragged preference.
    await expect.poll(() => sidebarTrack(page), { timeout: 5_000 }).toBe(sidebarBefore)

    // New session now rides the workspace row's + affordance ("New session in
    // {name}"); the row actions surface on hover only.
    await page.locator('[role="treeitem"]').filter({ hasText: 'workspace' }).first().hover()
    await page.getByRole('button', { name: /^New session in / }).last().click()
    await page.getByText('Into the Unknown', { exact: false }).waitFor({ timeout: 15_000 })
    await expect.poll(() => detailsTrack(page), { timeout: 5_000 }).toBe(0)
    expect(await page.getByText('Details', { exact: true }).isVisible()).toBe(false)

    const original = page.locator('[role=treeitem]').filter({ hasText: 'Reply with the single word' }).first()
    await original.click()
    await page.getByText('LIGHTHOUSE', { exact: true }).waitFor({ timeout: 15_000 })
    await expect.poll(() => detailsTrack(page), { timeout: 5_000 }).toBe(0)
    expect(await page.getByText('Details', { exact: true }).isVisible()).toBe(false)

    const ungrouped = page.getByText('Ungrouped', { exact: true })
    const ungroupedRow = ungrouped.locator('..').locator('..')
    const ungroupedSection = ungroupedRow.locator('..')
    await expect.poll(async () => {
      if (await ungroupedRow.getAttribute('aria-expanded') !== 'true') {
        await ungrouped.click()
        await page.waitForTimeout(50)
      }
      return await ungroupedRow.getAttribute('aria-expanded')
    }, { timeout: 5_000 }).toBe('true')
    const seeded = ungroupedSection.locator('[role="treeitem"]').nth(1)
    await seeded.click()
    await page.getByText('DONE', { exact: true }).waitFor({ timeout: 15_000 })
    await expect.poll(() => detailsTrack(page), { timeout: 5_000 }).toBe(0)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
    await assertFixtureInventory(SNAPSHOT_DIR, ['handles.expected.md'])
  }, 90_000)
})
