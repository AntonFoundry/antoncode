import { appendFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { journalEnabled } from './blueant-settings.ts'
import { cheapChat } from './cheap-model.ts'

/**
 * Phase 5c — scheduled consolidation ("power nap"): on a bridge timer,
 * trigger the c0ntext engine's two-phase dream over the journal-evidence
 * project, distill each mined candidate into one durable lesson through the
 * same cheap-model route the triage uses, and commit the enriched candidates
 * back (promotion stays engine-gated). Complements the engine's own
 * idle-based scheduler: this one fires on wall-clock cadence even when the
 * harness never sits idle, and the enrichment names the journal explicitly.
 * Fail-soft like every journal loop: a failed cycle logs one warning and
 * waits for the next tick.
 */

export interface ConsolidationOptions {
  intervalMs?: number
  contextEndpoint: string
  contextApiKey: string
  project?: string
}

const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000
const FIRST_PASS_DELAY_MS = 5 * 60 * 1000

const CONSOLIDATION_SYSTEM_PROMPT = 'You distill memory-mining candidates into durable lessons about one person\'s working life. For each candidate you receive, write ONE sentence in third person, present tense, naming the concrete subject (project, tool, document). End the sentence with a tag [importance: high|medium|low]. No preamble, no numbering — one sentence per line, same order as the candidates.'

export function startJournalConsolidation(options: ConsolidationOptions): () => void {
  const intervalMs = options.intervalMs
    ?? (process.env.ANTON_CONSOLIDATE_INTERVAL_MS ? Number(process.env.ANTON_CONSOLIDATE_INTERVAL_MS) : DEFAULT_INTERVAL_MS)
  let running = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const schedule = (delay: number): void => {
    timer = setTimeout(() => {
      void run()
      schedule(intervalMs)
    }, delay)
  }
  const run = async (): Promise<void> => {
    if (running || !journalEnabled()) return
    running = true
    try {
      const result = await consolidateOnce(options.contextEndpoint, options.contextApiKey, options.project ?? 'global')
      if (result.candidates > 0 || result.committed > 0) {
        appendLog(`${stamp()} — dreamed ${result.candidates} candidates, committed ${result.committed}${result.model ? ` via ${result.model}` : ''}`)
        console.log(`[consolidate] ${result.candidates} candidates mined, ${result.committed} committed`)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      appendLog(`${stamp()} — failed: ${message}`)
      console.warn('[consolidate] cycle failed:', message.slice(0, 160))
    } finally {
      running = false
    }
  }
  schedule(FIRST_PASS_DELAY_MS)
  return () => {
    if (timer !== undefined) clearTimeout(timer)
  }
}

interface DreamCandidate {
  entity_id?: unknown
  summary?: unknown
  content?: unknown
}

interface ConsolidationResult {
  candidates: number
  committed: number
  model?: string
}

async function consolidateOnce(endpoint: string, apiKey: string, project: string): Promise<ConsolidationResult> {
  const proposed = await postJson(`${endpoint}/dream/propose`, apiKey, { project_id: project })
  const candidates = Array.isArray(proposed.candidates) ? proposed.candidates as DreamCandidate[] : []
  const minable = candidates.filter(c => typeof c.entity_id === 'string' && typeof c.summary === 'string' && c.summary !== '')
  if (minable.length === 0) return { candidates: 0, committed: 0 }

  const listing = minable.map((candidate, index) => `${index}. ${candidate.summary}`).join('\n')
  const distilled = await cheapChat({
    system: CONSOLIDATION_SYSTEM_PROMPT,
    user: `Candidates mined from the journal-evidence memory:\n${listing}`,
    maxTokens: 800,
  })
  const lines = distilled.split('\n').map(line => line.trim()).filter(line => line !== '')
  const enriched = minable.map((candidate, index) => ({
    ...candidate,
    summary: lines[index] ?? candidate.summary,
    enriched_by: 'anton-bridge/consolidate',
  }))
  const committed = await postJson(`${endpoint}/dream/commit`, apiKey, { project_id: project, candidates: enriched })
  const count = typeof committed.committed === 'number' ? committed.committed : enriched.length
  return { candidates: minable.length, committed: count, model: process.env.ANTON_TRIAGE_MODEL ?? 'kimi-for-coding-highspeed' }
}

async function postJson(url: string, apiKey: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(180_000),
  })
  if (!response.ok) throw new Error(`engine HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`)
  return await response.json() as Record<string, unknown>
}

function consolidationLogPath(): string {
  return join(homedir(), 'Library', 'Application Support', 'Anton', 'blueant', 'journal', '.consolidation-log.md')
}

function appendLog(line: string): void {
  try {
    const path = consolidationLogPath()
    mkdirSync(join(path, '..'), { recursive: true })
    appendFileSync(path, `- ${line}\n`, 'utf8')
  } catch {
    // Observability only — a failed log append never fails the cycle.
  }
}

function stamp(): string {
  return new Date().toISOString().replace('T', ' ').slice(0, 16)
}
