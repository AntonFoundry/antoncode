/** Explicit, profile-local cleanup of two dormant pi-ai provider directory routes. */
export const name = 'provider-route-cleanup'
export const inject = ['tools', 'configEditor']

const targets = ['anthropic', 'openai-codex']
const packageName = '@deepseek-ai/dsh-llm-pi-ai'

function record(value, field) {
  if (value === undefined || value === null) return {}
  if (typeof value !== 'object' || Array.isArray(value) || Object.hasOwn(value, '__jsExpr')) {
    throw new Error(`${field} must be a literal object; inspect it in Settings before cleanup.`)
  }
  return value
}

function summarize(current, inherited = {}) {
  const providers = record(current.providers, 'providers')
  const reserved = current.reservedProviders ?? inherited.reservedProviders ?? []
  if (!Array.isArray(reserved) || reserved.some(id => typeof id !== 'string')) {
    throw new Error('reservedProviders must be a literal string array; inspect it in Settings before cleanup.')
  }
  return {
    reservedProviders: [...reserved],
    configuredDuplicates: targets.filter(id => Object.hasOwn(providers, id)),
    preservedProviderCount: Object.keys(providers).length,
  }
}

/** Register the explicit action; activation performs no configuration edits.
 * @param ctx Host context with the declared tools and configEditor dependencies.
 * @returns Nothing; the context owns the tool disposer.
 */
export function apply(ctx) {
  ctx.effect(() => ctx.tools.register({
    name: 'provider_route_cleanup',
    description: 'Inspect or apply the confirmed duplicate-route cleanup in the current profile. Apply reserves only dormant pi-ai anthropic and openai-codex directory routes, keeping Claude Code subscription and native Codex console-login routes. Refuses configured duplicates; preserves credentials, model selections, all provider maps and other settings.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['inspect', 'apply'],
          description: 'inspect reads only; apply persists the user-authorized two-route reservation through ConfigEditor.',
        },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['inspect', 'apply'] },
          changed: { type: 'boolean' },
          reservedProviders: { type: 'array', items: { type: 'string' } },
          configuredDuplicates: { type: 'array', items: { type: 'string', enum: targets } },
          preservedProviderCount: { type: 'integer' },
        },
        required: ['action', 'changed', 'reservedProviders', 'configuredDuplicates', 'preservedProviderCount'],
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    isConcurrencySafe: () => false,
    presentCall: args => ({ card: 'generic', title: 'Provider route cleanup', kind: args?.action === 'inspect' ? 'read' : 'edit' }),
    async execute(args) {
      if (!args || typeof args !== 'object' || Array.isArray(args)
        || !['inspect', 'apply'].includes(args.action)
        || Object.keys(args).some(key => key !== 'action')) {
        throw new Error('Use exactly { action: "inspect" } or { action: "apply" }.')
      }
      const entries = ctx.configEditor.entries().filter(entry => entry.options.id === 'llm-pi-ai' && entry.options.name === packageName)
      if (entries.length !== 1) throw new Error('Expected one addressable llm-pi-ai configuration entry; inspect plugin settings before cleanup.')
      const entry = entries[0]
      if (args.action === 'inspect') {
        return { action: 'inspect', changed: false, ...summarize(record(entry.options.config, 'config')) }
      }
      let result
      await ctx.configEditor.edit(entry, (current, inherited) => {
        const before = summarize(record(current, 'config'), inherited)
        if (before.configuredDuplicates.length) {
          throw new Error(`Cleanup refused: ${before.configuredDuplicates.join(', ')} is configured. Ask the user before removing its configuration in Settings; retain credentials.`)
        }
        const reservedProviders = [...before.reservedProviders]
        for (const id of targets) if (!reservedProviders.includes(id)) reservedProviders.push(id)
        result = { action: 'apply', changed: reservedProviders.length !== before.reservedProviders.length, ...before, reservedProviders }
        return { ...current, reservedProviders }
      })
      return result
    },
  }))
}
