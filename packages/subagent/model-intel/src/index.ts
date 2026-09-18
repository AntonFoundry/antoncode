/**
 * Model-intel: a weekly-researched strength datasheet over the deployment's
 * configured model routes, plus the `auto` child-model resolver built on it.
 *
 * The datasheet lives at `$DSH_HOME/model-intel.json`: one entry per researched
 * route with 0-100 strength axes (reasoning / coding / agentic / speed) and the
 * research provenance. A scheduler built on `ctx.interval()` plus the persisted
 * `fetchedAt` marker runs one research pass per configured interval (default
 * weekly) — restarts neither lose the schedule nor re-run an early pass. Each
 * pass registers a real job in the `jobs` registry (kind `model-intel`) so the
 * run is visible and cancellable in the Jobs surface.
 *
 * Research fetches public leaderboards through the `web` seam and distills
 * them through one un-attributed LLM call (reasoning off, reply budget
 * proportional to the input — the same discipline the c0ntext dream distiller
 * documented). A failed pass keeps the previous datasheet untouched.
 *
 * `resolveAutoRoute` answers the subagent tool's `auto` selection: datasheet
 * entries scored against the delegation's task text, restricted to providers
 * whose credential actually resolves — a provider without a usable key is
 * skipped, never guessed at.
 * @module @deepseek-ai/dsh-model-intel
 */

import { readFileSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { parse as parseYaml } from 'yaml'
import { BlockAssembler, createUserMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import type { AgentOptions } from '@deepseek-ai/dsh-agent'

declare module '@deepseek-ai/cordis' {
  interface Context {
    modelIntel: ModelIntelService
  }
}

/** One researched model route. Strength axes are 0-100; absent = unassessed. */
export interface ModelIntelEntry {
  provider: string
  model: string
  reasoning?: number
  coding?: number
  agentic?: number
  speed?: number
  contextWindow?: number
  notes?: string
}

/** The persisted datasheet document. */
export interface ModelIntelDatasheet {
  /** ISO-8601 of the last successful research pass; also the schedule marker. */
  fetchedAt: string
  entries: ModelIntelEntry[]
}

/** Task-keyword families the resolver scores against. */
const TASK_AXES = ['reasoning', 'coding', 'agentic', 'speed'] as const
type TaskAxis = (typeof TASK_AXES)[number]

/** Keywords per axis; matched case-insensitively against the task text. */
const AXIS_KEYWORDS: Record<TaskAxis, readonly string[]> = {
  reasoning: ['research', 'analyz', 'investigat', 'compare', 'evaluat', 'design', 'architect', 'plan', 'review', 'audit', 'trade-off', 'tradeoff'],
  coding: ['code', 'implement', 'refactor', 'bug', 'fix', 'typescript', 'test', 'compile', 'migrat', 'debug', 'function', 'api'],
  agentic: ['delegate', 'workflow', 'multi-step', 'orchestrat', 'terminal', 'deploy', 'run the'],
  speed: ['quick', 'fast', 'summar', 'skim', 'short', 'draft', 'tl;dr'],
}

/** Default axis weights; the winning axis gets 2x over the rest. */
const AXIS_WEIGHTS: Record<TaskAxis, number> = { reasoning: 1, coding: 1, agentic: 1, speed: 0.5 }

/** Credential-reference defaults for natively-mounted provider families. */
const NATIVE_PROVIDER_CREDENTIALS: Record<string, string> = {
  'deepseek-official': 'DEEPSEEK_API_KEY',
  'deepseek': 'DEEPSEEK_API_KEY',
  'openai': 'OPENAI_API_KEY',
  'anthropic': 'ANTHROPIC_API_KEY',
  'openrouter': 'OPENROUTER_API_KEY',
  'openrouter-free': 'OPENROUTER_FREE_API_KEY',
  'zai': 'ZAI_API_KEY',
  'kimi-coding': 'KIMI_CODING_API_KEY',
  'qwen-token-plan': 'QWEN_TOKEN_PLAN_API_KEY',
  'qwen-token-plan-individual': 'QWEN_TOKEN_PLAN_INDIVIDUAL_API_KEY',
  'codex': 'CODEX_API_KEY',
}

export interface Config {
  /** Whether the feature mounts at all; false removes the scheduler and the resolver answers nothing. */
  enabled?: boolean
  /** Hours between research passes. Defaults to a week. */
  researchIntervalHours?: number
  /** Minutes between schedule checks (cheap; the pass itself is the expensive part). */
  checkIntervalMinutes?: number
  /** Provider/model route the research distiller itself runs on, "provider/model". Empty = first eligible configured provider. */
  researchRoute?: string
}

/** Three hours: how long a credential-resolution verdict stays cached. */
const CREDENTIAL_CACHE_MS = 3 * 60 * 60_000

/** The weekly model-intel service: datasheet, resolver, and research scheduler. */
export class ModelIntelService extends Service {
  static Config: z<Config> = z.object({
    enabled: z.boolean().default(true),
    researchIntervalHours: z.number().min(1).max(2160).default(168),
    checkIntervalMinutes: z.number().min(5).max(1440).default(30),
    researchRoute: z.string().default(''),
  })

  private readonly config: Required<Config>
  /** Current datasheet snapshot; test-visible via {@link injectDatasheet}. */
  current: ModelIntelDatasheet = { fetchedAt: '', entries: [] }
  private datasheetMtimeMs = 0
  private credentialVerdicts = new Map<string, { ok: boolean; at: number }>()
  private researchInFlight = false

  constructor(ctx: Context, config: Required<Config>) {
    super(ctx, 'model-intel')
    this.config = config
  }

  /** Load the datasheet on mount and start the (cheap) schedule check. */
  async start(): Promise<void> {
    await this.reloadDatasheet()
    if (!this.config.enabled) return
    // Plain Node interval, not the cordis timer service: this package needs no
    // timer typing beyond the disposal contract, and the host process is not
    // sandboxed (the runner sandbox is subagent-scoped).
    this.ctx.effect(() => {
      const timer = setInterval(() => { void this.checkSchedule() }, this.config.checkIntervalMinutes * 60_000)
      return () => clearInterval(timer)
    }, 'model-intel.schedule')
  }

  /** The current datasheet (cached; re-read when the file changes under us). */
  getDatasheet(): ModelIntelDatasheet {
    return this.current
  }

  /**
   * Replace the in-memory datasheet wholesale. Test and invariant seam: the
   * scheduler owns the file, so tests seed the snapshot through this instead
   * of fighting the persisted document.
   */
  injectDatasheet(datasheet: ModelIntelDatasheet): void {
    this.current = datasheet
  }

  /**
   * Resolve the `auto` child-model route for one delegation task: the best
   * datasheet entry among providers whose credential resolves, scored against
   * the task text. `undefined` = no eligible researched route (caller falls
   * back to parent inheritance).
   */
  async resolveAutoRoute(taskText: string): Promise<AgentOptions | undefined> {
    if (!this.config.enabled) return undefined
    const entries = this.current.entries
    if (entries.length === 0) return undefined
    const task = taskText.toLowerCase()
    const axisScores = TASK_AXES.map(axis => ({
      axis,
      weight: AXIS_WEIGHTS[axis],
      hits: AXIS_KEYWORDS[axis].filter(keyword => task.includes(keyword)).length,
    }))
    const dominant = axisScores.filter(a => a.hits > 0).sort((a, b) => b.hits * b.weight - a.hits * a.weight)[0]
    let best: { entry: ModelIntelEntry; score: number } | undefined
    for (const entry of entries) {
      if (!(await this.providerHasCredential(entry.provider))) continue
      const axisOf = (axis: TaskAxis): number => entry[axis] ?? 0
      const score = dominant === undefined
        ? (entry.agentic ?? 0) * 2 + (entry.coding ?? 0)
        : axisScores.reduce((sum, { axis, weight }) => sum + weight * axisOf(axis) * (axis === dominant.axis ? 2 : 0.5), 0)
      if (score > (best?.score ?? -1)) best = { entry, score }
    }
    const winner = best?.entry
    return winner === undefined ? undefined : { provider: winner.provider, model: winner.model }
  }

  /**
   * Run one research pass now (no-op while one is in flight). Exposed for the
   * scheduled check and for manual triggers.
   */
  async researchNow(trigger: string): Promise<void> {
    if (!this.config.enabled || this.researchInFlight) return
    this.researchInFlight = true
    try {
      const entries = await this.runResearchPass()
      this.ctx.logger.info(`model-intel: research pass (${trigger}) refreshed the datasheet with ${entries} entries`)
    } catch (error: unknown) {
      this.ctx.logger.warn(`model-intel: research pass (${trigger}) failed, previous datasheet kept: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      this.researchInFlight = false
    }
  }

  /** Cheap schedule check: run a pass when the datasheet is stale. */
  private async checkSchedule(): Promise<void> {
    await this.reloadDatasheet()
    const last = Date.parse(this.current.fetchedAt)
    if (!Number.isNaN(last) && Date.now() - last < this.config.researchIntervalHours * 3_600_000) return
    await this.researchNow('scheduled')
  }

  /** Re-read the persisted datasheet when its mtime moved. */
  private async reloadDatasheet(): Promise<void> {
    const file = dshHomePath('model-intel.json')
    try {
      const mtime = (await stat(file)).mtimeMs
      if (mtime === this.datasheetMtimeMs) return
      const parsed = JSON.parse(await readFile(file, 'utf8')) as ModelIntelDatasheet
      if (typeof parsed.fetchedAt !== 'string' || !Array.isArray(parsed.entries)) return
      this.current = parsed
      this.datasheetMtimeMs = mtime
    } catch {
      // No datasheet yet: the first successful pass creates it.
    }
  }

  /** Whether one provider currently has a usable credential (cached verdict). */
  private async providerHasCredential(provider: string): Promise<boolean> {
    const cached = this.credentialVerdicts.get(provider)
    if (cached !== undefined && Date.now() - cached.at < CREDENTIAL_CACHE_MS) return cached.ok
    const ref = this.credentialRefFor(provider)
    let ok = false
    if (ref !== undefined) {
      try {
        const credentials = this.ctx.get('credentials')
        const resolved = credentials !== undefined ? await credentials.resolve(ref as CredentialRef) : undefined
        ok = resolved !== undefined && resolved.value.length > 0
      } catch {
        ok = false
      }
    }
    this.credentialVerdicts.set(provider, { ok, at: Date.now() })
    return ok
  }

  /** The credential reference one provider resolves through, when known. */
  private credentialRefFor(provider: string): string | undefined {
    for (const section of ['llm-pi-ai', 'llm-models-dev', 'llm-openai', 'llm-codex', 'llm-antigravity']) {
      const profile = this.settingsSection(`${section}.providers`)?.[provider]
      if (profile !== undefined && typeof profile === 'object') {
        const named = (profile as Record<string, unknown>).apiKeyEnv
        if (typeof named === 'string' && named.length > 0) return named
        // A profile with no reference derives `<ROUTE>_API_KEY` (the Models
        // page's rule); an adapter that authenticates otherwise still skips —
        // keyless providers are excluded from auto by design.
        return `${provider.toUpperCase().replace(/-/g, '_')}_API_KEY`
      }
    }
    return NATIVE_PROVIDER_CREDENTIALS[provider]
  }

  /** One settings.yaml section, read straight from the managed document. */
  private settingsSection(path: string): Record<string, unknown> | undefined {
    try {
      const doc = parseYaml(readFileSync(dshHomePath('settings.yaml'), 'utf8')) as Record<string, unknown>
      let node: unknown = doc
      for (const segment of path.split('.')) {
        if (node === undefined || node === null || typeof node !== 'object') return undefined
        node = (node as Record<string, unknown>)[segment]
      }
      return typeof node === 'object' && node !== null ? node as Record<string, unknown> : undefined
    } catch {
      return undefined
    }
  }

  /** One research pass: search, fetch, distill, persist. Never throws. */
  private async runResearchPass(): Promise<number> {
    const sources = await this.gatherSources()
    const entries = await this.distillEntries(sources)
    if (entries.length === 0) throw new Error('research produced no entries')
    const previous = new Map(this.current.entries.map(entry => [`${entry.provider}/${entry.model}`, entry]))
    const merged = entries.map(entry => ({ ...previous.get(`${entry.provider}/${entry.model}`), ...entry }))
    const datasheet: ModelIntelDatasheet = { fetchedAt: new Date().toISOString(), entries: merged }
    await writeFileAtomic(dshHomePath('model-intel.json'), JSON.stringify(datasheet, null, 2), { mode: 0o600 })
    this.current = datasheet
    this.datasheetMtimeMs = 0
    return merged.length
  }

  /** Search the public leaderboards and fetch the most promising pages. */
  private async gatherSources(): Promise<string> {
    const web = this.ctx.get('web')
    if (web === undefined) return ''
    const parts: string[] = []
    for (const query of ['artificial analysis intelligence index top LLM models', 'best coding LLM benchmark leaderboard this month']) {
      try {
        const result = await web.search({ query, maxResults: 3 })
        if (result.content !== undefined) parts.push(result.content)
        for (const source of result.sources.slice(0, 2)) {
          const fetched = await web.fetch({ url: source.url }).catch(() => undefined)
          const body = fetched?.status === 200 && fetched.body.kind === 'text' ? fetched.body.text : undefined
          if (body !== undefined) parts.push(body.slice(0, 20_000))
        }
      } catch {
        // A dead source degrades the pass; the LLM still sees the others.
      }
    }
    return parts.join('\n\n').slice(0, 60_000)
  }

  /** Distill fetched source text into datasheet entries via one LLM call. */
  private async distillEntries(sources: string): Promise<ModelIntelEntry[]> {
    const route = this.researchRoute()
    if (route.provider === undefined || route.model === undefined) throw new Error('no research route resolved')
    const prompt = [
      'You compile a model-strength datasheet for this deployment\'s model-chooser from the public leaderboard material below.',
      'For each model the material clearly describes, return one entry with 0-100 strength scores.',
      'Return JSON only: {"entries":[{"provider":"<route provider>","model":"<model id>","reasoning":0-100,"coding":0-100,"agentic":0-100,"speed":0-100,"notes":"one sentence"}]}',
      'Only include models you have evidence for in the material. Keep provider ids lowercase (zai, openrouter, anthropic, openai, deepseek, google, ...).',
      'Material:', sources.slice(0, 40_000) || '(no material fetched — return {"entries":[]})',
    ].join('\n\n')
    const assembler = new BlockAssembler()
    for await (const chunk of this.ctx.llm.stream({
      provider: route.provider, model: route.model,
      reasoningEffort: ReasoningEffortId('off'),
      maxTokens: Math.max(512, Math.min(4000, Math.ceil(prompt.length / 4) + 512)),
      messages: [createUserMessage({ content: [{ type: 'text', text: prompt }], source: { kind: 'plugin', plugin: 'dsh-model-intel' } })],
    })) assembler.push(chunk)
    const text = assembler.blocks().flatMap(block => block.type === 'text' ? [block.text] : []).join('').trim().replace(/^```json\s*|\s*```$/g, '')
    const decoded = JSON.parse(text) as { entries?: unknown[] }
    if (!Array.isArray(decoded.entries)) return []
    return decoded.entries
      .filter((entry): entry is ModelIntelEntry => typeof entry === 'object' && entry !== null
        && typeof (entry as ModelIntelEntry).provider === 'string' && typeof (entry as ModelIntelEntry).model === 'string')
      .slice(0, 80)
  }

  /** The research distiller's own route: config override, else first credentialed configured provider. */
  private researchRoute(): { provider?: string; model?: string } {
    const override = this.config.researchRoute.trim()
    if (override.length > 0) {
      const slash = override.lastIndexOf('/')
      return slash > 0 ? { provider: override.slice(0, slash), model: override.slice(slash + 1) } : { model: override }
    }
    for (const section of ['llm-pi-ai', 'llm-models-dev', 'llm-openai', 'llm-codex']) {
      const providers = this.settingsSection(`${section}.providers`) ?? {}
      for (const provider of Object.keys(providers)) {
        if (NATIVE_PROVIDER_CREDENTIALS[provider] === undefined && this.credentialRefFor(provider) === undefined) continue
        return { provider, model: provider === 'zai' ? 'glm-5.3' : 'default' }
      }
    }
    return {}
  }
}

export default ModelIntelService
