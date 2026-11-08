/** Explicit deploy-gate shell-command scope correction through ConfigEditor. */
export const name = 'gate-command-scope-fix'
export const inject = ['tools', 'configEditor']

const desiredPatterns = ['(?:deploy|release|publish)\\b', '(?:npm|pnpm|yarn)\\s+(?:run\\s+)?(?:deploy|release|publish)\\b']
const originalPatterns = ['(pnpm\\s+run\\s+)?(deploy|release|publish)\\b', 'npm\\s+publish\\b']
const equals = (left, right) => JSON.stringify(left) === JSON.stringify(right)

function literalRecord(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.hasOwn(value, '__jsExpr')) {
    throw new Error(`${field} must be a literal object; inspect gate-policy Settings before applying.`)
  }
  return value
}

function targetOf(config) {
  literalRecord(config, 'config')
  if (!Array.isArray(config.rules)) throw new Error('rules must be a literal array; inspect gate-policy Settings before applying.')
  for (const rule of config.rules) literalRecord(rule, 'rule')
  const matches = config.rules.filter(rule => rule.name === 'deploy-gate')
  if (matches.length !== 1) throw new Error('Expected exactly one deploy-gate rule; inspect gate-policy Settings before applying.')
  const target = matches[0]
  if (!equals(target.tools, ['bash'])) throw new Error('deploy-gate tools differ from the authorized bash-only rule; ask the user before changing it.')
  if (!equals(target.commandPatterns, originalPatterns) && !equals(target.commandPatterns, desiredPatterns)) {
    throw new Error('deploy-gate patterns differ from the authorized original or corrected patterns; ask the user before changing them.')
  }
  if (target.commandScope !== undefined && target.commandScope !== 'raw' && target.commandScope !== 'shellCommands') {
    throw new Error('deploy-gate commandScope is not a supported literal value; inspect Settings before applying.')
  }
  return target
}

function summary(config) {
  const target = targetOf(config)
  return {
    commandScope: target.commandScope ?? 'raw',
    commandPatterns: [...target.commandPatterns],
    preservedRuleCount: config.rules.length - 1,
    changed: target.commandScope !== 'shellCommands' || !equals(target.commandPatterns, desiredPatterns),
  }
}

/** Register a fixed correction; activation never edits configuration.
 * @param ctx Host context with tools and configEditor dependencies.
 * @returns Nothing; the plugin context owns registration disposal.
 */
export function apply(ctx) {
  ctx.effect(() => ctx.tools.register({
    name: 'gate_command_scope_fix',
    description: 'Inspect or apply the user-authorized deploy-gate correction in the current profile. Apply scopes only the existing bash deploy-gate to executable shell commands and fixed deploy/release/publish roots, preserving every other rule, checklist, confirmation and setting. Refuses unexpected configuration or an unsupported runtime.',
    parameters: {
      type: 'object',
      properties: { action: { type: 'string', enum: ['inspect', 'apply'], description: 'inspect reads only; apply persists the fixed deploy-gate correction through ConfigEditor after explicit user authorization.' } },
      required: ['action'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['inspect', 'apply'] },
          changed: { type: 'boolean' },
          commandScope: { type: 'string', enum: ['raw', 'shellCommands'] },
          commandPatterns: { type: 'array', items: { type: 'string' } },
          preservedRuleCount: { type: 'integer' },
        },
        required: ['action', 'changed', 'commandScope', 'commandPatterns', 'preservedRuleCount'],
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    isConcurrencySafe: () => false,
    presentCall: args => ({ card: 'generic', title: 'Deploy gate scope correction', kind: args?.action === 'inspect' ? 'read' : 'edit' }),
    async execute(args) {
      if (!args || typeof args !== 'object' || Array.isArray(args) || !['inspect', 'apply'].includes(args.action) || Object.keys(args).some(key => key !== 'action')) {
        throw new Error('Use exactly { action: "inspect" } or { action: "apply" }.')
      }
      const entries = ctx.configEditor.entries().filter(entry => entry.options.id === 'gate-policy' && entry.options.name === '@deepseek-ai/dsh-gate-policy')
      if (entries.length !== 1) throw new Error('Expected one addressable gate-policy configuration entry; inspect Settings before applying.')
      const entry = entries[0]
      if (args.action === 'inspect') return { action: 'inspect', ...summary(entry.options.config), changed: false }
      let result
      await ctx.configEditor.edit(entry, current => {
        const before = summary(current)
        const target = targetOf(current)
        const next = { ...current, rules: current.rules.map(rule => rule === target ? { ...rule, commandScope: 'shellCommands', commandPatterns: [...desiredPatterns] } : rule) }
        const resolved = entry.fiber.resolveConfig(next)
        if (resolved?.rules?.filter(rule => rule.name === 'deploy-gate').length !== 1 || resolved.rules.find(rule => rule.name === 'deploy-gate').commandScope !== 'shellCommands') {
          throw new Error('The active gate-policy runtime does not support shellCommands. Deploy the updated gate-policy runtime before applying this correction.')
        }
        result = { action: 'apply', ...summary(next), changed: before.changed }
        return next
      })
      return result
    },
  }))
}
