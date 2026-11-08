/** Built settings controls share materials and adapt their geometry to the viewport and pointer. */
import { fileURLToPath } from 'node:url'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium, type Locator } from 'playwright'
import { expect, it, onTestFinished, vi } from 'vitest'
import type { AccountView } from '@deepseek-ai/dsh-deepseek-account/types'
import type {} from '@deepseek-ai/dsh-deepseek-account'
import {
  captureStableAria, compareOrRefreshGolden, launchWebScaffold, webSnapshotMode,
} from './scaffold.ts'
import { openSettings, ZH_BROWSER_LOCALE } from './support.ts'

const EXPECTED = fileURLToPath(new URL('./expected/settings-appearance', import.meta.url))

/** @param element - Rendered control or card. @returns Its visible geometry and material. */
function appearance(element: Locator) {
  return element.evaluate((node) => {
    const style = getComputedStyle(node)
    return {
      radius: style.borderRadius, border: style.borderTopWidth, stroke: style.borderTopColor,
      fill: style.backgroundColor, height: Math.round(node.getBoundingClientRect().height),
    }
  })
}

it('keeps font controls within narrow panes and preserves focus while resizing', async () => {
  const scaffold = await launchWebScaffold({ developerTools: false })
  onTestFinished(() => scaffold.close())
  const browser = await chromium.launch()
  onTestFinished(() => browser.close())
  for (const platform of ['web', 'darwin', 'win32'] as const) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: ZH_BROWSER_LOCALE })
    try {
      const page = await context.newPage()
      await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
      await openSettings(page, 'zh')
      const dialog = page.getByRole('dialog', { name: '设置', exact: true })
      await dialog.getByRole('button', { name: '通用设置', exact: true }).click()
      await page.getByRole('button', { name: 'Expand pane', exact: true }).last().click()
      await page.evaluate((platform) => {
        document.documentElement.toggleAttribute('data-windows-titlebar', platform === 'win32')
        if (platform === 'darwin') document.documentElement.setAttribute('data-platform', platform)
      }, platform)
      for (const width of [390, 767, 768]) {
        await page.setViewportSize({ width, height: 1000 })
        const steppers = dialog.getByRole('group', { name: '字号', exact: true })
        expect(await steppers.count()).toBe(4)
        for (const stepper of await steppers.all()) {
          await stepper.scrollIntoViewIfNeeded()
          const bounds = await stepper.boundingBox()
          expect(bounds).not.toBeNull()
          if (bounds === null) throw new Error('missing font-size controls')
          expect(bounds.x).toBeGreaterThanOrEqual(0)
          expect(bounds.x + bounds.width).toBeLessThanOrEqual(width)
          expect(bounds.height).toBe(36)
        }
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width)
      }
      await dialog.getByRole('button', { name: '系统', exact: true }).click()
      const field = page.getByPlaceholder('Filter…', { exact: true })
      await field.fill('Uncommitted font draft')
      expect(await field.inputValue()).toBe('Uncommitted font draft')
      await page.keyboard.press('Escape')
      const button = dialog.getByRole('group', { name: '字号', exact: true }).first().getByRole('button', { name: '+', exact: true })
      await button.focus()
      const original = await button.elementHandle()
      expect(await original!.evaluate(input => input === document.activeElement && input.isConnected), 'focused before resize').toBe(true)
      for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: 1000 })
        const focus = await original!.evaluate(input => ({
          same: input === document.activeElement, connected: input.isConnected,
          active: document.activeElement?.outerHTML.slice(0, 300),
        }))
        expect(focus, `${platform} ${width}px focused control`).toMatchObject({ same: true, connected: true })
      }
    } finally { await context.close() }
  }
})

it('uses 16px text for coarse-pointer font filters and preserves compact fine-pointer filters', async () => {
  const scaffold = await launchWebScaffold({ developerTools: false })
  onTestFinished(() => scaffold.close())
  const browser = await chromium.launch()
  onTestFinished(() => browser.close())
  for (const hasTouch of [true, false]) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: ZH_BROWSER_LOCALE, hasTouch })
    try {
      const page = await context.newPage()
      await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
      await openSettings(page, 'zh')
      const dialog = page.getByRole('dialog', { name: '设置', exact: true })
      await dialog.getByRole('button', { name: '通用设置', exact: true }).click()
      await page.getByRole('button', { name: 'Expand pane', exact: true }).last().click()
      await page.setViewportSize({ width: 390, height: 844 })
      await dialog.getByRole('button', { name: '系统', exact: true }).click()
      expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(hasTouch)
      const field = page.getByPlaceholder('Filter…', { exact: true })
      await field.waitFor()
      expect(await field.evaluate(input => getComputedStyle(input).fontSize)).toBe(hasTouch ? '16px' : '13px')
    } finally { await context.close() }
  }
})

it('shares settings card materials and control sizes in both palettes', async () => {
  const scaffold = await launchWebScaffold({})
  onTestFinished(() => scaffold.close())
  await scaffold.ctx.settings.mutate('ui-settings-account', [
    { op: 'set', path: ['step'], value: 'done' },
    { op: 'set', path: ['completion'], value: 'completed' },
  ])
  const account = scaffold.ctx.deepseekAccount
  const state: AccountView = {
    status: 'credential-stored', attempt: null,
    links: { usageUrl: 'https://platform.deepseek.com/usage', topUpUrl: 'https://platform.deepseek.com/top_up' },
  }
  // The Platform provider supplies synthetic identity and wallets; renderer, RPC, and settings remain real.
  const mocks = [
    vi.spyOn(account, 'getState').mockResolvedValue(state),
    vi.spyOn(account, 'getProfile').mockResolvedValue({
      status: 'ready', value: { id: null, name: 'Radius example', contact: 'r***@example.com', avatarUrl: null },
    }),
    vi.spyOn(account, 'getBalance').mockResolvedValue({
      status: 'ready', value: [{ currency: 'CNY', balance: '128.50' }],
      bonusWallets: [{ currency: 'CNY', balance: '12.00' }],
    }),
    vi.spyOn(account, 'watch').mockImplementation(async function* (signal) {
      yield state
      if (signal.aborted) return
      await new Promise<void>((resolve) => { signal.addEventListener('abort', () => { resolve() }, { once: true }) })
    }),
  ]
  onTestFinished(() => { mocks.forEach((mock) => { mock.mockRestore() }) })
  const browser = await chromium.launch()
  onTestFinished(() => browser.close())
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, locale: ZH_BROWSER_LOCALE })
  await page.addInitScript(() => { Object.defineProperty(globalThis, 'dshDesktop', { value: { protocolVersion: 1 } }) })
  await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  await openSettings(page, 'zh')
  const dialog = page.getByRole('dialog', { name: '设置', exact: true })

  for (const [palette, label] of [['light', '浅色'], ['dark', '深色']] as const) {
    await dialog.getByRole('button', { name: '通用设置', exact: true }).click()
    await dialog.getByRole('button', { name: label, exact: true }).click()
    await expect.poll(() => page.evaluate(() => document.body.hasAttribute('data-ds-dark-theme'))).toBe(palette === 'dark')
    const selector = await appearance(dialog.getByRole('button', { name: '工作区内修改', exact: true }))
    expect(selector.radius).toBe('12px')
    expect((await appearance(dialog)).radius).toBe('0px')

    await dialog.getByRole('button', { name: '账号与余额', exact: true }).click()
    const section = dialog.getByRole('region', { name: '账号与余额', exact: true })
    await expect.poll(() => section.innerText()).toContain('¥128.50')
    const cards = section.locator(':scope > div')
    expect(await cards.count()).toBe(2)
    const profile = await appearance(cards.nth(0))
    const balance = await appearance(cards.nth(1))
    const material = { radius: profile.radius, border: profile.border, stroke: profile.stroke, fill: profile.fill }
    expect(material.radius).toBe('20px')
    expect(material.fill).not.toBe('rgba(0, 0, 0, 0)')
    expect(balance).toMatchObject(material)
    const usage = await appearance(section.getByRole('link', { name: '查询用量', exact: true }))
    const topUp = await appearance(section.getByRole('link', { name: '充值', exact: true }))
    expect(usage).toMatchObject({ radius: '12px', height: 36 })
    expect(topUp).toMatchObject({ radius: '12px', height: 36 })
    await compareOrRefreshGolden(join(EXPECTED, 'account.expected.md'),
      await captureStableAria(page, 'section[aria-label="账号与余额"]', scaffold.workspaceCwd), webSnapshotMode())

    await dialog.getByRole('button', { name: '内置插件', exact: true }).click()
    await dialog.getByRole('button', { name: /^全局/ }).click()
    const plugin = dialog.locator('[data-plugin-scope="global"] [data-plugin-entry]').first()
    await plugin.waitFor()
    expect(await appearance(plugin)).toMatchObject(material)

    await dialog.getByRole('button', { name: 'Agent', exact: true }).click()
    const preset = dialog.locator('li').first()
    await preset.waitFor()
    expect((await appearance(preset)).radius).toBe('20px')

    await dialog.getByRole('button', { name: '模型', exact: true }).click()
    await dialog.getByRole('button', { name: '添加模型提供商', exact: true }).click()
    const field = dialog.getByLabel('提供商', { exact: true })
    await field.waitFor()
    expect(await appearance(field)).toMatchObject({ radius: '12px', height: 32 })
    const save = await appearance(dialog.getByRole('button', { name: '保存', exact: true }))
    expect(save).toMatchObject({ radius: '12px', height: 36 })
    await compareOrRefreshGolden(join(EXPECTED, `${palette}.expected.md`),
      JSON.stringify({ card: material, selector, usage, topUp, save }, null, 2), webSnapshotMode())
    await dialog.getByRole('button', { name: '取消', exact: true }).click()
  }
})

it('restores the OpenCode palettes across desktop and narrow settings views', async () => {
  const scaffold = await launchWebScaffold({ developerTools: false })
  onTestFinished(() => scaffold.close())
  const browser = await chromium.launch()
  onTestFinished(() => browser.close())
  const artifacts = fileURLToPath(new URL('../../../.artifacts/opencode-theme/visual', import.meta.url))
  await mkdir(artifacts, { recursive: true })
  const states = []

  for (const [theme, scheme, background, keyword] of [
    ['opencode', 'light', '#ffffff', '#aa3576'],
    ['opencode-dark', 'dark', '#161616', '#f799c6'],
  ] as const) {
    for (const width of [1440, 390]) {
      const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'en-US' })
      try {
        await context.addInitScript((id) => { localStorage.setItem('dsh.layout.theme', id) }, theme)
        const page = await context.newPage()
        const errors: string[] = []
        page.on('pageerror', error => errors.push(error.message))
        await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
        await expect.poll(() => page.locator('body').getAttribute('data-ds-theme')).toBe(theme)
        await openSettings(page, 'en')
        const dialog = page.getByRole('dialog', { name: 'Settings', exact: true })
        await dialog.getByRole('button', { name: 'General', exact: true }).click()
        await page.getByRole('button', { name: 'Expand pane', exact: true }).last().click()
        await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 })
        const light = dialog.getByRole('button', { name: 'Light', exact: true })
        await light.waitFor({ state: 'visible' })
        await expect.poll(async () => (await dialog.boundingBox())?.width).toBe(width)
        const bounds = await light.boundingBox()
        expect(bounds).not.toBeNull()
        const state = await page.evaluate((bounds) => {
          const body = document.body
          const style = getComputedStyle(body)
          const root = document.documentElement
          return {
            theme: body.getAttribute('data-ds-theme'), scheme: getComputedStyle(root).colorScheme,
            background: style.getPropertyValue('--dsw-alias-bg-base').trim(),
            keyword: style.getPropertyValue('--shiki-token-keyword').trim(),
            primary: style.getPropertyValue('--dsw-alias-brand-primary').trim(),
            horizontalOverflow: root.scrollWidth > innerWidth,
            primaryControlWithinViewport: bounds !== null
              && bounds.x >= 0 && bounds.x + bounds.width <= innerWidth
              && bounds.y >= 0 && bounds.y + bounds.height <= innerHeight,
          }
        }, bounds)
        await page.screenshot({ path: join(artifacts, `${theme}-${width}.png`), fullPage: true })
        expect(state).toMatchObject({ theme, scheme, background, keyword, primary: '#3b5cf6', horizontalOverflow: false, primaryControlWithinViewport: true })
        if (width === 390) {
          const steppers = dialog.getByRole('group', { name: 'Font size', exact: true })
          expect(await steppers.count()).toBe(4)
          for (const stepper of await steppers.all()) {
            const control = stepper.getByRole('button', { name: '+', exact: true })
            await control.scrollIntoViewIfNeeded()
            const box = await control.boundingBox()
            expect(box).not.toBeNull()
            if (box === null) throw new Error('missing font-size control')
            expect(box.x).toBeGreaterThanOrEqual(0)
            expect(box.x + box.width).toBeLessThanOrEqual(width)
            expect(await control.evaluate((node) => {
              let current: Element | null = node
              while (current !== null) {
                if (getComputedStyle(current).overflowY === 'auto') return current.scrollWidth <= current.clientWidth
                current = current.parentElement
              }
              return false
            })).toBe(true)
          }
        }
        states.push({ width, ...state })
        await page.reload({ waitUntil: 'load' })
        await expect.poll(() => page.locator('body').getAttribute('data-ds-theme')).toBe(theme)
        expect(errors).toEqual([])
      } finally { await context.close() }
    }
  }
  await compareOrRefreshGolden(join(EXPECTED, 'opencode.expected.md'), JSON.stringify(states, null, 2), webSnapshotMode())
})
