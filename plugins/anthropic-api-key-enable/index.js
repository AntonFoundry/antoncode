/** Explicit profile-local enablement of the independent Anthropic API-key route. */
export const name = 'anthropic-api-key-enable'
export const inject = ['tools', 'commands', 'configEditor']

const packageName = '@deepseek-ai/dsh-llm-pi-ai'
const displayName = 'Anthropic (API key)'
const apiKeyEnv = 'ANTHROPIC_API_KEY'

function record(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.hasOwn(value, '__jsExpr')) {
    throw new Error(`${field} must be a literal object; inspect provider Settings before enabling Anthropic.`)
  }
  return value
}

function fields(current, inherited = {}) {
  record(current, 'config')
  record(inherited, 'inherited config')
  const reserved = current.reservedProviders === undefined ? inherited.reservedProviders ?? [] : current.reservedProviders
  if (!Array.isArray(reserved) || reserved.some(id => typeof id !== 'string')) {
    throw new Error('reservedProviders must be a literal string array; inspect provider Settings before enabling Anthropic.')
  }
  const providers = record(current.providers === undefined ? inherited.providers ?? {} : current.providers, 'providers')
  const present = Object.hasOwn(providers, 'anthropic')
  const anthropic = present ? record(providers.anthropic, 'Anthropic profile') : {}
  if (present && anthropic.apiKeyEnv !== apiKeyEnv) {
    throw new Error('Anthropic uses a different or opaque credential reference; review it in Settings rather than replacing it.')
  }
  if (anthropic.api !== undefined && anthropic.api !== 'anthropic-messages') {
    throw new Error('Anthropic uses a different or opaque API protocol; review it in Settings before enabling it.')
  }
  const authFields = ['apiKey', 'oauth', 'oauthToken', 'accessToken', 'refreshToken', 'auth', 'authType', 'authentication']
  if (authFields.some(key => Object.hasOwn(anthropic, key))) {
    throw new Error('Anthropic contains alternate authentication settings; review them in Settings rather than replacing them.')
  }
  if (anthropic.headers !== undefined) {
    const headers = record(anthropic.headers, 'Anthropic headers')
    if (Object.keys(headers).some(key => ['authorization', 'x-api-key', 'proxy-authorization'].includes(key.toLowerCase()))) {
      throw new Error('Anthropic contains authentication headers; review them in Settings rather than replacing them.')
    }
  }
  return { reserved, providers, anthropic, present }
}

function summary(state, action, changed) {
  return {
    action, changed, provider: 'anthropic', displayName, apiKeyEnv,
    anthropicReserved: state.reserved.includes('anthropic'),
    anthropicConfigured: state.present,
    explicitApiKeyConfigured: state.anthropic.apiKeyEnv === apiKeyEnv,
    providerCount: Object.keys(state.providers).length,
    reservedProviderCount: state.reserved.length,
  }
}

/** Register the explicit tool without editing configuration on activation.
 * @param ctx Host context providing tools, commands and ConfigEditor.
 * @returns Nothing; the context owns the registration disposer.
 */
export function apply(ctx) {
  async function executeAction(args) {
    if (!args || typeof args !== 'object' || Array.isArray(args) || !['inspect', 'apply'].includes(args.action) || Object.keys(args).some(key => key !== 'action')) {
      throw new Error('Use exactly { action: "inspect" } or { action: "apply" }.')
    }
    const entries = ctx.configEditor.entries().filter(entry => entry.options.id === 'llm-pi-ai' && entry.options.name === packageName)
    if (entries.length !== 1) throw new Error('Expected one addressable llm-pi-ai entry; inspect plugin Settings before enabling Anthropic.')
    const entry = entries[0]
    if (args.action === 'inspect') {
      const layer = ctx.configEditor.configuration().find(value => value.entry === entry)
      if (layer === undefined) throw new Error('Provider configuration changed; inspect it again before enabling Anthropic.')
      return summary(fields(entry.options.config ?? {}, layer.inherited), 'inspect', false)
    }
    let result
    await ctx.configEditor.edit(entry, (current, inherited) => {
      const before = fields(current, inherited)
      const reservedProviders = before.reserved.filter(id => id !== 'anthropic')
      const anthropic = { ...before.anthropic, displayName, apiKeyEnv }
      const next = { ...current, reservedProviders, providers: { ...before.providers, anthropic } }
      const changed = reservedProviders.length !== before.reserved.length || !before.present || before.anthropic.displayName !== displayName || before.anthropic.apiKeyEnv !== apiKeyEnv
      result = summary(fields(next), 'apply', changed)
      return next
    })
    return result
  }
  ctx.effect(() => ctx.tools.register({
    name: 'anthropic_api_key_enable',
    description: 'Inspect or apply the authorized Anthropic API-key enablement in this profile. Apply removes only the anthropic reservation, adds the explicit ANTHROPIC_API_KEY profile and its Anthropic (API key) display label, and preserves Claude Code login, other providers and all unrelated configuration. Refuses ambiguous authentication; never reads credentials.',
    parameters: {
      type: 'object', properties: { action: { type: 'string', enum: ['inspect', 'apply'], description: 'inspect reads configuration metadata only; apply persists the user-authorized fixed correction through ConfigEditor.' } },
      required: ['action'], additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object', properties: {
          action: { type: 'string', enum: ['inspect', 'apply'] }, changed: { type: 'boolean' },
          provider: { type: 'string', const: 'anthropic' }, displayName: { type: 'string', const: displayName }, apiKeyEnv: { type: 'string', const: apiKeyEnv },
          anthropicReserved: { type: 'boolean' }, anthropicConfigured: { type: 'boolean' }, explicitApiKeyConfigured: { type: 'boolean' },
          providerCount: { type: 'integer' }, reservedProviderCount: { type: 'integer' },
        }, required: ['action', 'changed', 'provider', 'displayName', 'apiKeyEnv', 'anthropicReserved', 'anthropicConfigured', 'explicitApiKeyConfigured', 'providerCount', 'reservedProviderCount'], additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    isConcurrencySafe: () => false,
    presentCall: args => ({ card: 'generic', title: 'Anthropic API-key enablement', kind: args?.action === 'inspect' ? 'read' : 'edit' }),
    execute: executeAction,
  }))
  ctx.effect(() => ctx.commands.register({
    name: 'anthropic-api-key-enable',
    description: 'Inspect or apply the authorized Anthropic API-key profile correction. Use inspect or apply; no API key is accepted.',
    input: { hint: 'inspect | apply' },
    recordInput: false,
    async handler(invocation) {
      const action = invocation.rawInput.trim() || 'inspect'
      if (!['inspect', 'apply'].includes(action)) return { kind: 'error', text: 'Use /anthropic-api-key-enable inspect or /anthropic-api-key-enable apply. Do not include an API key.' }
      const result = await executeAction({ action })
      return { kind: 'success', text: JSON.stringify(result) }
    },
  }))
}
