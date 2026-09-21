import { appendFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Phase 5a — the journal collector: the always-on bridge periodically
 * samples desktop context (frontmost app, window title, browser URL,
 * clipboard-on-change, screenshot-on-change) and appends Arivu-style
 * entries to one markdown file per day under the Blueant journal
 * directory. Append-only and fail-soft: any capture failure yields a
 * thinner entry or none, never a thrown error — the journal must not be
 * able to take the bridge down.
 *
 * Signals come from spawned macOS utilities (osascript, pbpaste,
 * screencapture) rather than native APIs: the bridge is a Bun process,
 * and child processes of the app inherit its TCC attribution, so the
 * Accessibility/Screen Recording/Automation grants the user already gave
 * Anton cover these probes. A denied probe degrades the entry silently.
 */

export interface JournalCollectorOptions {
  /** Milliseconds between samples; default 60s, override for tests. */
  intervalMs?: number
  /** Where journals land; defaults to the Blueant support directory. */
  journalDir?: string
}

interface DesktopSample {
  app: string
  windowTitle: string
  browserUrl: string
  clipboard: string
}

const BROWSERS = new Set(['Safari', 'Google Chrome', 'Arc', 'Microsoft Edge', 'Brave Browser', 'Firefox'])
const SCREENSHOT_MIN_GAP_MS = 120_000

export function journalDirectory(): string {
  return process.env.ANTON_JOURNAL_DIR ?? join(homedir(), 'Library', 'Application Support', 'Anton', 'blueant', 'journal')
}

export function startJournalCollector(options: JournalCollectorOptions = {}): void {
  const intervalMs = options.intervalMs ?? 60_000
  const dir = options.journalDir ?? journalDirectory()
  const screenshotsDir = join(dir, 'screenshots')
  mkdirSync(screenshotsDir, { recursive: true })

  let lastKey = ''
  let lastClipboard = ''
  let lastScreenshotAt = 0
  let ticking = false

  const tick = async (): Promise<void> => {
    if (ticking) return
    ticking = true
    try {
      const sample = await sampleDesktop()
      if (sample === undefined) return
      const changedKey = `${sample.app}|${sample.windowTitle}|${sample.browserUrl}`
      const clipboardChanged = sample.clipboard !== '' && sample.clipboard !== lastClipboard
      const visibleChange = changedKey !== lastKey || clipboardChanged
      if (!visibleChange) return
      lastKey = changedKey
      lastClipboard = sample.clipboard

      const lines = [`## ${timestamp()}`, `- app: ${sample.app}`]
      if (sample.windowTitle !== '') lines.push(`- window: ${sample.windowTitle}`)
      if (sample.browserUrl !== '') lines.push(`- url: ${sample.browserUrl}`)
      if (clipboardChanged) lines.push(`- clipboard: ${sample.clipboard.slice(0, 500)}`)
      if (sample.app !== '' && Date.now() - lastScreenshotAt > SCREENSHOT_MIN_GAP_MS) {
        const path = captureScreenshot(screenshotsDir)
        if (path !== undefined) {
          lastScreenshotAt = Date.now()
          lines.push(`- screenshot: screenshots/${path}`)
        }
      }
      appendEntry(dir, `${lines.join('\n')}\n\n`)
    } catch (error) {
      // A collector failure must never surface, but it must not be
      // invisible either — bridge.log is the only place to diagnose why
      // journals stopped growing.
      console.warn('[journal] tick failed:', error)
    } finally {
      ticking = false
    }
  }

  void tick()
  const timer = setInterval(() => { void tick() }, intervalMs)
  // The bridge owns the process lifetime; an unref'd timer would let the
  // collector starve while Bun stays alive for the server anyway.
  timer.unref?.()
}

/** Local timestamp for the entry heading: HH:MM:SS on the user's clock. */
function timestamp(): string {
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`
}

async function sampleDesktop(): Promise<DesktopSample | undefined> {
  const script = `
    tell application "System Events"
      set frontApp to name of first application process whose frontmost is true
    end tell
    set windowTitle to ""
    try
      tell application "System Events" to tell frontApp
        set windowTitle to name of front window
      end tell
    end try
    return frontApp & "\u{241F}" & windowTitle
  `
  const probe = Bun.spawn(['osascript', '-e', script], { stdout: 'pipe', stderr: 'ignore' })
  const probeOut = await new Response(probe.stdout).text()
  const [app = '', windowTitle = ''] = probeOut.trim().split('\u{241F}')
  if (app === '' || app === 'missing value') return undefined

  let browserUrl = ''
  if (BROWSERS.has(app)) {
    const urlScript = `tell application "${app}" to get URL of active tab of front window`
    const urlProbe = Bun.spawn(['osascript', '-e', urlScript], { stdout: 'pipe', stderr: 'ignore' })
    browserUrl = (await new Response(urlProbe.stdout).text()).trim()
    if (urlProbe.exitCode !== 0) browserUrl = ''
  }

  const clipProbe = Bun.spawn(['pbpaste'], { stdout: 'pipe', stderr: 'ignore' })
  const clipboard = (await new Response(clipProbe.stdout).text()).trim()

  return { app, windowTitle, browserUrl, clipboard }
}

/** Full-screen silent capture as JPEG; returns the file name, or undefined on denial. */
function captureScreenshot(screenshotsDir: string): string | undefined {
  const name = `shot-${new Date().toISOString().replace(/[:.]/g, '-')}.jpg`
  const target = join(screenshotsDir, name)
  const proc = Bun.spawnSync(['screencapture', '-x', '-t', 'jpg', target], { stdout: 'ignore', stderr: 'ignore' })
  if (proc.exitCode !== 0) return undefined
  return name
}

/** Append to today's journal, creating the file with a dated header on first write. */
function appendEntry(dir: string, entry: string): void {
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  const day = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
  const file = join(dir, `${day}.md`)
  try {
    appendFileSync(file, entry, 'utf8')
  } catch {
    try {
      mkdirSync(dir, { recursive: true })
      appendFileSync(file, `# Journal ${day}\n\n${entry}`, 'utf8')
    } catch {
      // Disk-level failure: skip this entry; the collector is best-effort.
    }
  }
}
