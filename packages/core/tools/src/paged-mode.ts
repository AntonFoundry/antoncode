/**
 * Paged Mode `tool_search` transport, matcher seam, and catalog renderer.
 * The model receives a name-and-summary catalog instead of every full schema;
 * searching with an intent grants the matching tools into the calling scope,
 * and granted tools join the wire set from the next turn.
 * @module @deepseek-ai/dsh-tools/src/paged-mode
 */

import type { ToolSchema } from '@deepseek-ai/dsh-llm'
import type { ScopeKey } from '@deepseek-ai/dsh-scope'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import { defineTool } from './schema.ts'
import type { ToolDefinition, ToolRunContext } from './index.ts'

/** The model-facing name of the Paged Mode tool. */
export const TOOL_SEARCH_NAME = 'tool_search'

/**
 * The `tools:catalog` section order: inside the 100–199 tool-guidance band,
 * immediately after {@link SDK_SECTION_ORDER}'s generated SDK — the catalog is
 * the paged analogue of that section (the scope's discovery surface in place
 * of full schemas), so it sits where a reader of the code-mode layout expects
 * the tool inventory.
 */
export const CATALOG_SECTION_ORDER = 151

/**
 * The intent-to-tools matcher a deployment may mount as the `toolMatcher`
 * service. Consumed opportunistically (`ctx.get('toolMatcher')`, no static
 * inject — the same idiom as the approval seam): a deployment without one
 * falls back to {@link defaultToolMatcher}, and the registry stays active
 * either way. Implementations must be deterministic for a stable catalog —
 * the returned names ride the prefix-cached prompt the next turn.
 */
export interface ToolMatcher {
  /**
   * Rank the catalog against one intent.
   * @param intent - the model's free-text need, exactly as passed to `tool_search`.
   * @param candidates - the calling scope's full pre-paging catalog (restrictions applied, transports excluded).
   * @param limit - the clamped maximum number of names to return.
   * @returns the matched tool names, best first; unknown names are dropped by the transport.
   */
  match(intent: string, candidates: readonly ToolSchema[], limit: number): string[] | Promise<string[]>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    toolMatcher: ToolMatcher
  }
}

/** Lowercase alphanumeric tokens of one catalog or intent string. */
function tokenize(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter(token => token.length > 0))
}

/**
 * The built-in matcher: case-insensitive keyword overlap between the intent
 * tokens and each candidate's name and description tokens, name hits weighted
 * above description hits, ties broken by catalog order (the sort is stable and
 * candidates arrive in registration order). Deterministic and dependency-free
 * by design — it is the fallback every deployment gets, not the recommended
 * retrieval quality bar.
 */
export const defaultToolMatcher: ToolMatcher = {
  match(intent, candidates, limit) {
    const intentTokens = tokenize(intent)
    const scored: { name: string; score: number }[] = []
    for (const candidate of candidates) {
      const nameTokens = tokenize(candidate.name)
      const descriptionTokens = tokenize(candidate.description)
      let score = 0
      for (const token of intentTokens) {
        if (nameTokens.has(token)) score += 2
        else if (descriptionTokens.has(token)) score += 1
      }
      if (score > 0) scored.push({ name: candidate.name, score })
    }
    scored.sort((a, b) => b.score - a.score)
    return scored.slice(0, limit).map(entry => entry.name)
  },
}

/** Default result cap, documented in the `limit` parameter's description. */
const DEFAULT_SEARCH_LIMIT = 5

/** Hard result cap: one search must not re-page the whole catalog back in. */
const MAX_SEARCH_LIMIT = 10

/** How many catalog names a no-match result lists as hints. */
const HINT_COUNT = 5

/** The `limit` argument clamped into 1..10, defaulting to 5. */
function clampLimit(limit: number | undefined): number {
  return Math.min(MAX_SEARCH_LIMIT, Math.max(1, Math.trunc(limit ?? DEFAULT_SEARCH_LIMIT)))
}

/**
 * The description's first line or sentence, truncated to roughly one hundred
 * characters: enough to discriminate tools in the catalog, short enough that
 * paging an entire registry costs a line per tool.
 */
function oneLineSummary(description: string): string {
  /* v8 ignore next -- String.split always yields at least one element. */
  const firstLine = description.split('\n', 1)[0] ?? ''
  const sentenceEnd = firstLine.indexOf('. ')
  const summary = sentenceEnd === -1 ? firstLine : firstLine.slice(0, sentenceEnd + 1)
  return summary.length <= 100 ? summary : `${summary.slice(0, 99)}…`
}

/**
 * Render the paged catalog section body: a header stating how tools are
 * unlocked, then one `- {name} — {one-liner}` line per tool. The input is the
 * scope's FULL pre-paging capability set — the catalog is the discovery
 * surface, so a never-granted tool must appear here to be found.
 * @param schemas - the calling scope's catalog (restrictions applied, transports excluded).
 * @returns the section text.
 */
export function renderToolsCatalog(schemas: readonly ToolSchema[]): string {
  const lines = schemas.map(schema => `- ${schema.name} — ${oneLineSummary(schema.description)}`)
  return [
    `Available tools (names and summaries only — call \`${TOOL_SEARCH_NAME}\` with your intent to grant a tool's full schema and make it callable):`,
    ...lines,
  ].join('\n')
}

/**
 * Registry-private capabilities the transport receives at construction — the
 * `requireRuntime` idiom: operations only the owning registry can mint stay
 * off its public service API and flow here as closures instead.
 */
export interface ToolSearchBridgeOptions {
  /** The calling scope's full pre-paging catalog as model-facing schemas (restrictions applied, transports excluded). */
  catalog: (scope: ScopeKey | undefined) => ToolSchema[]
  /** Grant names into the calling scope's own layer, then emit the registry change notification. */
  grant: (scope: ScopeKey | undefined, names: readonly string[]) => void
  /**
   * Reads `ctx.toolMatcher` without throwing: `undefined` when no matcher
   * service is mounted, in which case the body falls back to
   * {@link defaultToolMatcher}.
   */
  peekMatcher: () => ToolMatcher | undefined
}

/** One granted tool's full model-facing schema inside the canonical value. */
interface ToolSearchGranted {
  readonly name: string
  readonly description: string
  readonly parameters: JsonValue
}

/** Canonical value returned by the Paged Mode transport. */
interface ToolSearchOutput {
  /** The granted tools with their full schemas; empty when nothing matched. */
  tools: ToolSearchGranted[]
  /** Catalog names offered when nothing matched (ignored otherwise). */
  hints: string[]
}

/**
 * Build the `tool_search` {@link ToolDefinition}: a required `intent` string
 * and an optional clamped `limit`, executed against the calling scope's
 * pre-paging catalog through the mounted (or default) matcher. Matched names
 * are granted into the CALLING scope's own layer, so they appear with full
 * schemas from the next turn. The registry reserves the name as presentation
 * infrastructure under `paged`, outside the filterable global/scoped
 * capability layers.
 * @param options - the registry-private capabilities described above.
 * @returns the registry-ready definition.
 */
export function createToolSearchTool(options: ToolSearchBridgeOptions): ToolDefinition {
  const { catalog, grant, peekMatcher } = options
  return defineTool({
    name: TOOL_SEARCH_NAME,
    description:
      'Search the available tool catalog for tools matching your intent and grant them. '
      + 'Granted tools appear with their full schemas and become directly callable from your next turn.',
    parameters: {
      intent: {
        type: 'string',
        required: true,
        description: 'What you want to accomplish, in a few keywords (e.g. "read a file", "run the tests").',
      },
      limit: {
        type: 'integer',
        description: 'Maximum number of tools to grant (default 5, at most 10).',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          tools: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string', required: true },
                description: { type: 'string', required: true },
                parameters: { type: 'json', required: true },
              },
            },
          },
          hints: { type: 'array', required: true, items: { type: 'string' } },
        },
      },
      render: (_args, value) => {
        if (value.tools.length === 0) {
          const hints = value.hints.length > 0 ? ` Available tools include: ${value.hints.join(', ')}.` : ''
          return [{ type: 'text', text: `No tools matched the given intent.${hints}` }]
        }
        return [
          ...value.tools.map(tool => ({
            type: 'text' as const,
            text: `## ${tool.name}\n\n${tool.description}\n\nParameters:\n${JSON.stringify(tool.parameters, null, 2)}`,
          })),
          { type: 'text' as const, text: 'The tools above are now granted — call them directly from your next turn.' },
        ]
      },
    },
    async execute(args, exec: ToolRunContext): Promise<ToolSearchOutput> {
      const candidates = catalog(exec.agent)
      const limit = clampLimit(args.limit)
      const matcher = peekMatcher() ?? defaultToolMatcher
      const matched = await matcher.match(args.intent, candidates, limit)
      const byName = new Map(candidates.map(candidate => [candidate.name, candidate]))
      // A custom matcher is not trusted: names outside the catalog, repeats,
      // and anything past the clamped limit are dropped before granting.
      const granted: ToolSearchGranted[] = []
      for (const name of matched) {
        const candidate = byName.get(name)
        if (candidate === undefined || granted.some(tool => tool.name === name)) continue
        granted.push({ name: candidate.name, description: candidate.description, parameters: candidate.parameters as JsonValue })
        if (granted.length >= limit) break
      }
      grant(exec.agent, granted.map(tool => tool.name))
      return {
        tools: granted,
        hints: candidates.slice(0, HINT_COUNT).map(candidate => candidate.name),
      }
    },
  })
}
