/**
 * Canonical publication manifest for the documentation website.
 *
 * Markdown stays in its owning repository tier. This manifest maps each
 * canonical English source into the site route tree. The site is
 * English-only: one locale, one route per page.
 */

/** Sidebar collection rendered for the site's top-level module. */
export type DocsSidebar =
  | 'guide'
  | 'develop'
  | 'reference'

/** A page projected into the VitePress source tree. */
export interface DocsPage {
  /** Repository-relative canonical Markdown source. */
  source: string
  /** VitePress route, including the `.md` suffix. */
  route: string
  /** Navigation label shown in the sidebar. */
  label: string
  /** Sidebar collection that owns the page, or null for the home page. */
  sidebar: DocsSidebar | null
  /** Section label within the sidebar. */
  section: string
  /** Stable order within the section. */
  order: number
  /** Heading levels included in this page's VitePress outline. */
  outline?: number | readonly [number, number] | 'deep' | false
  /** Additional repository paths that resolve to this page. */
  sourceAliases?: string[]
}

/** A sidebar group, matched to pages by `section`. */
export interface DocsSection {
  /** Group heading, equal to the `section` field of every page it holds. */
  label: string
  /** Render the group collapsed until it holds the page being read. */
  collapsed?: boolean
}

/**
 * Every sidebar group, in the order the sidebar renders it.
 *
 * The subsystem groups collapse because together they outnumber the rest of the
 * reference sidebar; expanded, they push every other group below the fold.
 */
const sections: readonly DocsSection[] = [
  { label: 'Guide' },
  { label: 'SDK' },
  { label: 'Basics' },
  { label: 'Framework' },
  { label: 'Practice' },
  { label: 'Cordis framework tutorial' },
  { label: 'Concepts' },
  { label: 'Generated reference' },
  { label: 'Cordis Core API' },
  { label: 'Cookbook' },
  { label: 'Overview' },
  { label: 'Core and scopes', collapsed: true },
  { label: 'Sessions and persistence', collapsed: true },
  { label: 'Model and context', collapsed: true },
  { label: 'Execution and tools', collapsed: true },
  { label: 'Policy and interaction', collapsed: true },
  { label: 'Platform and access', collapsed: true },
]

/**
 * Placement and collapse behavior of one sidebar group.
 *
 * @param label - Section label carried by the pages in the group.
 * @returns The declared group, plus its zero-based position in the sidebar.
 * @throws When the sidebar declares no placement for the label. Ranking by list
 *   membership alone would sort an undeclared group silently ahead of every
 *   declared one.
 */
export function sectionSpec(label: string): DocsSection & { index: number } {
  const section = sections.find(candidate => candidate.label === label)
  if (section === undefined) throw new Error(`Sidebar section "${label}" has no placement in the sidebar.`)
  return { ...section, index: sections.indexOf(section) }
}

/** Every canonical page published by the documentation website. */
export const docsPages: DocsPage[] = [
  {
    source: 'docs/user/index.md',
    route: 'index.md',
    label: 'DeepSeek Harness',
    sidebar: null,
    section: 'Home',
    order: 0,
    sourceAliases: [],
  },
  {
    source: 'docs/user/guide/index.md',
    route: 'guide/quickstart.md',
    label: 'Use the Web UI',
    sidebar: 'guide',
    section: 'Guide',
    order: 1,
    sourceAliases: ['docs/user/guide'],
  },
  {
    source: 'docs/user/guide/providers.md',
    route: 'guide/providers.md',
    label: 'Configure models',
    sidebar: 'guide',
    section: 'Guide',
    order: 2,
    sourceAliases: [],
  },
  {
    source: 'docs/user/guide/python-sdk.md',
    route: 'guide/python-sdk.md',
    label: 'Python',
    sidebar: 'guide',
    section: 'SDK',
    order: 1,
    sourceAliases: [],
  },
  {
    source: 'docs/user/develop/basic/index.md',
    route: 'develop/basic/index.md',
    label: 'Your first Harness plugin',
    sidebar: 'develop',
    section: 'Basics',
    order: 1,
    sourceAliases: ['docs/user/develop/basic'],
  },
  {
    source: 'docs/user/develop/basic/tool.md',
    route: 'develop/basic/tool.md',
    label: 'Build a tool',
    sidebar: 'develop',
    section: 'Basics',
    order: 2,
    sourceAliases: [],
  },
  {
    source: 'docs/user/develop/basic/config.md',
    route: 'develop/basic/config.md',
    label: 'Plugin configuration',
    sidebar: 'develop',
    section: 'Basics',
    order: 3,
    sourceAliases: [],
  },
  {
    source: 'docs/user/develop/basic/publish.md',
    route: 'develop/basic/publish.md',
    label: 'Package and install',
    sidebar: 'develop',
    section: 'Basics',
    order: 4,
    sourceAliases: [],
  },
  {
    source: 'docs/user/develop/framework/index.md',
    route: 'develop/framework/index.md',
    label: 'Plugin lifecycle',
    sidebar: 'develop',
    section: 'Framework',
    order: 1,
    sourceAliases: ['docs/user/develop/framework'],
  },
  {
    source: 'docs/user/develop/framework/service.md',
    route: 'develop/framework/service.md',
    label: 'Services and dependencies',
    sidebar: 'develop',
    section: 'Framework',
    order: 2,
    sourceAliases: [],
  },
  {
    source: 'docs/user/develop/framework/events.md',
    route: 'develop/framework/events.md',
    label: 'Event system',
    sidebar: 'develop',
    section: 'Framework',
    order: 3,
    sourceAliases: [],
  },
  {
    source: 'docs/user/develop/practice/index.md',
    route: 'develop/practice/index.md',
    label: 'Capability layering',
    sidebar: 'develop',
    section: 'Practice',
    order: 1,
    sourceAliases: ['docs/user/develop/practice'],
  },
  {
    source: 'docs/user/develop/practice/llm-adapter.md',
    route: 'develop/practice/llm-adapter.md',
    label: 'LLM adapter',
    sidebar: 'develop',
    section: 'Practice',
    order: 2,
    sourceAliases: [],
  },
  {
    source: 'docs/cordis-tutorial/index.md',
    route: 'develop/cordis-tutorial/index.md',
    label: 'Overview',
    sidebar: 'develop',
    section: 'Cordis framework tutorial',
    order: 0,
    sourceAliases: ['docs/cordis-tutorial'],
  },
  {
    source: 'docs/cordis-tutorial/01-first-plugin.md',
    route: 'develop/cordis-tutorial/01-first-plugin.md',
    label: '1. Your first plugin',
    sidebar: 'develop',
    section: 'Cordis framework tutorial',
    order: 1,
    sourceAliases: [],
  },
  {
    source: 'docs/cordis-tutorial/02-lifecycle-and-effects.md',
    route: 'develop/cordis-tutorial/02-lifecycle-and-effects.md',
    label: '2. Lifecycle and effects',
    sidebar: 'develop',
    section: 'Cordis framework tutorial',
    order: 2,
    sourceAliases: [],
  },
  {
    source: 'docs/cordis-tutorial/03-services.md',
    route: 'develop/cordis-tutorial/03-services.md',
    label: '3. Services',
    sidebar: 'develop',
    section: 'Cordis framework tutorial',
    order: 3,
    sourceAliases: [],
  },
  {
    source: 'docs/cordis-tutorial/04-events.md',
    route: 'develop/cordis-tutorial/04-events.md',
    label: '4. Events',
    sidebar: 'develop',
    section: 'Cordis framework tutorial',
    order: 4,
    sourceAliases: [],
  },
  {
    source: 'docs/cordis-tutorial/05-config.md',
    route: 'develop/cordis-tutorial/05-config.md',
    label: '5. Configuration',
    sidebar: 'develop',
    section: 'Cordis framework tutorial',
    order: 5,
    sourceAliases: [],
  },
  {
    source: 'docs/cordis-tutorial/06-composition-and-hmr.md',
    route: 'develop/cordis-tutorial/06-composition-and-hmr.md',
    label: '6. Composition and HMR',
    sidebar: 'develop',
    section: 'Cordis framework tutorial',
    order: 6,
    sourceAliases: [],
  },
  {
    source: 'docs/cordis-tutorial/07-into-the-harness.md',
    route: 'develop/cordis-tutorial/07-into-the-harness.md',
    label: '7. Into the harness',
    sidebar: 'develop',
    section: 'Cordis framework tutorial',
    order: 7,
    sourceAliases: [],
  },
  {
    source: 'docs/cordis-primer.md',
    route: 'reference/cordis-primer.md',
    label: 'Cordis primer',
    sidebar: 'reference',
    section: 'Concepts',
    order: 1,
    sourceAliases: [],
  },
  {
    source: 'docs/subsystems/README.md',
    route: 'reference/subsystems/index.md',
    label: 'Subsystems',
    sidebar: 'reference',
    section: 'Overview',
    order: 0,
    outline: [2,3],
    sourceAliases: ['docs/subsystems'],
  },
  {
    source: 'docs/subsystems/core.md',
    route: 'reference/subsystems/core.md',
    label: 'Core',
    sidebar: 'reference',
    section: 'Core and scopes',
    order: 0,
    outline: [2,3],
    sourceAliases: [],
  },
  {
    source: 'docs/subsystems/scope.md',
    route: 'reference/subsystems/scope.md',
    label: 'Scopes',
    sidebar: 'reference',
    section: 'Core and scopes',
    order: 1,
    outline: [2,3],
    sourceAliases: [],
  },
  {
    source: 'docs/subsystems/invariants.md',
    route: 'reference/subsystems/invariants.md',
    label: 'Runtime invariants',
    sidebar: 'reference',
    section: 'Core and scopes',
    order: 2,
    outline: [2,3],
    sourceAliases: [],
  },
  {
    source: 'docs/subsystems/session.md',
    route: 'reference/subsystems/session.md',
    label: 'Sessions',
    sidebar: 'reference',
    section: 'Sessions and persistence',
    order: 0,
    outline: [2,3],
    sourceAliases: [],
  },
  {
    source: 'docs/subsystems/session-query.md',
    route: 'reference/subsystems/session-query.md',
    label: 'Session query',
    sidebar: 'reference',
    section: 'Sessions and persistence',
    order: 1,
    outline: [2,3],
    sourceAliases: [],
  },
  {
    source: 'docs/subsystems/session-reference.md',
    route: 'reference/subsystems/session-reference.md',
    label: 'Session references',
    sidebar: 'reference',
    section: 'Sessions and persistence',
    order: 2,
    outline: [2,3],
    sourceAliases: [],
  },
  {
    source: 'docs/subsystems/session-title.md',
    route: 'reference/subsystems/session-title.md',
    label: 'Session titles',
    sidebar: 'reference',
    section: 'Sessions and persistence',
    order: 3,
    outline: [2,3],
    sourceAliases: [],
  },
  {
    source: 'docs/subsystems/session-projection.md',
    route: 'reference/subsystems/session-projection.md',
    label: 'Session projections',
    sidebar: 'reference',
    section: 'Sessions and persistence',
    order: 4,
    outline: [2,3],
    sourceAliases: [],
  },
  {
    source: 'docs/subsystems/persistence.md',
    route: 'reference/subsystems/persistence.md',
    label: 'Session persistence',
    sidebar: 'reference',
    section: 'Sessions and persistence',
    order: 5,
    outline: [2,3],
    sourceAliases: [],
  },
  {
    source: 'docs/subsystems/spill.md',
    route: 'reference/subsystems/spill.md',
    label: 'Spill storage',
    sidebar: 'reference',
    section: 'Sessions and persistence',
    order: 6,
    outline: [2,3],
    sourceAliases: [],
  },
  {
    source: 'docs/subsystems/session-telemetry.md',
    route: 'reference/subsystems/session-telemetry.md',
    label: 'SessionTelemetryBackend',
    sidebar: 'reference',
    section: 'Sessions and persistence',
    order: 7,
    outline: [2,3],
    sourceAliases: [],
  },
  {
    source: 'docs/subsystems/llm-streaming.md',
    route: 'reference/subsystems/llm-streaming.md',
    label: 'LLM streaming',
    sidebar: 'reference',
    section: 'Model and context',
    order: 0,
    outline: [2,3],
    sourceAliases: [],
  },
  {
    source: 'docs/subsystems/token-meter.md',
    route: 'reference/subsystems/token-meter.md',
    label: 'Token metering',
    sidebar: 'reference',
    section: 'Model and context',
    order: 1,
    outline: [2,3],
    sourceAliases: [],
  },
  {
    source: 'docs/subsystems/system-prompt.md',
    route: 'reference/subsystems/system-prompt.md',
    label: 'System prompts',
    sidebar: 'reference',
    section: 'Model and context',
    order: 2,
    outline: [2,3],
    sourceAliases: [],
  },
  {
    source: 'docs/subsystems/compaction.md',
    route: 'reference/subsystems/compaction.md',
    label: 'Compaction',
    sidebar: 'reference',
    section: 'Model and context',
    order: 3,
    outline: [2,3],
    sourceAliases: [],
  },
  {
    source: 'docs/subsystems/tools.md',
    route: 'reference/subsystems/tools.md',
    label: 'Tools',
    sidebar: 'reference',
    section: 'Execution and tools',
    order: 0,
    outline: [2,3],
    sourceAliases: [],
  },
  {
    source: 'docs/subsystems/shell.md',
    route: 'reference/subsystems/shell.md',
    label: 'Bash execution',
    sidebar: 'reference',
    section: 'Execution and tools',
    order: 1,
    outline: [2,3],
    sourceAliases: [],
  },
  {
    source: 'docs/subsystems/subprocess.md',
    route: 'reference/subsystems/subprocess.md',
    label: 'Subprocesses',
    sidebar: 'reference',
    section: 'Execution and tools',
    order: 2,
    outline: [2,3],
    sourceAliases: [],
  },
  {
    source: 'docs/subsystems/terminal.md',
    route: 'reference/subsystems/terminal.md',
    label: 'PTY sessions',
    sidebar: 'reference',
    section: 'Execution and tools',
    order: 3,
    outline: [2,3],
    sourceAliases: [],
  },
  {
    source: 'docs/subsystems/jobs.md',
    route: 'reference/subsystems/jobs.md',
    label: 'Background jobs',
    sidebar: 'reference',
    section: 'Execution and tools',
    order: 4,
    outline: [2,3],
    sourceAliases: [],
  },
  {
    source: 'docs/subsystems/filesystem.md',
    route: 'reference/subsystems/filesystem.md',
    label: 'Filesystem',
    sidebar: 'reference',
    section: 'Execution and tools',
    order: 5,
    outline: [2,3],
    sourceAliases: [],
  },
  {
    source: 'docs/subsystems/lsp.md',
    route: 'reference/subsystems/lsp.md',
    label: 'LSP navigation',
    sidebar: 'reference',
    section: 'Execution and tools',
    order: 6,
    outline: [2,3],
    sourceAliases: [],
  },
  {
    source: 'docs/subsystems/code-runtime.md',
    route: 'reference/subsystems/code-runtime.md',
    label: 'Code runtime',
    sidebar: 'reference',
    section: 'Execution and tools',
    order: 7,
    outline: [2,3],
    sourceAliases: [],
  },
  {
    source: 'docs/subsystems/web.md',
    route: 'reference/subsystems/web.md',
    label: 'Web access',
    sidebar: 'reference',
    section: 'Execution and tools',
    order: 8,
    outline: [2,3],
    sourceAliases: [],
  },
  {
    source: 'docs/subsystems/skills.md',
    route: 'reference/subsystems/skills.md',
    label: 'Skills',
    sidebar: 'reference',
    section: 'Execution and tools',
    order: 9,
    outline: [2,3],
    sourceAliases: [],
  },
  {
    source: 'docs/subsystems/workflow.md',
    route: 'reference/subsystems/workflow.md',
    label: 'Workflows',
    sidebar: 'reference',
    section: 'Execution and tools',
    order: 10,
    outline: [2,3],
    sourceAliases: [],
  },
  {
    source: 'docs/subsystems/subagent.md',
    route: 'reference/subsystems/subagent.md',
    label: 'Subagents',
    sidebar: 'reference',
    section: 'Execution and tools',
    order: 11,
    outline: [2,3],
    sourceAliases: [],
  },
  {
    source: 'docs/subsystems/approval.md',
    route: 'reference/subsystems/approval.md',
    label: 'Approvals',
    sidebar: 'reference',
    section: 'Policy and interaction',
    order: 0,
    outline: [2,3],
    sourceAliases: [],
  },
  {
    source: 'docs/subsystems/permission-presets.md',
    route: 'reference/subsystems/permission-presets.md',
    label: 'Permission presets',
    sidebar: 'reference',
    section: 'Policy and interaction',
    order: 1,
    outline: [2,3],
    sourceAliases: [],
  },
  {
    source: 'docs/subsystems/sandbox.md',
    route: 'reference/subsystems/sandbox.md',
    label: 'Sandboxing',
    sidebar: 'reference',
    section: 'Policy and interaction',
    order: 2,
    outline: [2,3],
    sourceAliases: [],
  },
  {
    source: 'docs/subsystems/plan.md',
    route: 'reference/subsystems/plan.md',
    label: 'Plan mode',
    sidebar: 'reference',
    section: 'Policy and interaction',
    order: 3,
    outline: [2,3],
    sourceAliases: [],
  },
  {
    source: 'docs/subsystems/user-questions.md',
    route: 'reference/subsystems/user-questions.md',
    label: 'User interaction',
    sidebar: 'reference',
    section: 'Policy and interaction',
    order: 4,
    outline: [2,3],
    sourceAliases: [],
  },
  {
    source: 'docs/subsystems/commands.md',
    route: 'reference/subsystems/commands.md',
    label: 'Human commands',
    sidebar: 'reference',
    section: 'Policy and interaction',
    order: 5,
    outline: [2,3],
    sourceAliases: [],
  },
  {
    source: 'docs/subsystems/goal.md',
    route: 'reference/subsystems/goal.md',
    label: 'Goals',
    sidebar: 'reference',
    section: 'Policy and interaction',
    order: 6,
    outline: [2,3],
    sourceAliases: [],
  },
  {
    source: 'docs/subsystems/schedule.md',
    route: 'reference/subsystems/schedule.md',
    label: 'Scheduled reminders',
    sidebar: 'reference',
    section: 'Policy and interaction',
    order: 7,
    outline: [2,3],
    sourceAliases: [],
  },
  {
    source: 'docs/subsystems/web-server.md',
    route: 'reference/subsystems/web-server.md',
    label: 'HTTP server',
    sidebar: 'reference',
    section: 'Platform and access',
    order: 0,
    outline: [2,3],
    sourceAliases: [],
  },
  {
    source: 'docs/subsystems/typert.md',
    route: 'reference/subsystems/typert.md',
    label: 'Typert',
    sidebar: 'reference',
    section: 'Platform and access',
    order: 1,
    outline: [2,3],
    sourceAliases: [],
  },
  {
    source: 'docs/subsystems/client-modules.md',
    route: 'reference/subsystems/client-modules.md',
    label: 'Client modules',
    sidebar: 'reference',
    section: 'Platform and access',
    order: 2,
    outline: [2,3],
    sourceAliases: [],
  },
  {
    source: 'docs/subsystems/storage.md',
    route: 'reference/subsystems/storage.md',
    label: 'Storage',
    sidebar: 'reference',
    section: 'Platform and access',
    order: 3,
    outline: [2,3],
    sourceAliases: [],
  },
  {
    source: 'docs/subsystems/workspace.md',
    route: 'reference/subsystems/workspace.md',
    label: 'Workspaces',
    sidebar: 'reference',
    section: 'Platform and access',
    order: 4,
    outline: [2,3],
    sourceAliases: [],
  },
  {
    source: 'docs/subsystems/settings.md',
    route: 'reference/subsystems/settings.md',
    label: 'User settings',
    sidebar: 'reference',
    section: 'Platform and access',
    order: 5,
    outline: [2,3],
    sourceAliases: [],
  },
  {
    source: 'docs/subsystems/credentials.md',
    route: 'reference/subsystems/credentials.md',
    label: 'User credentials',
    sidebar: 'reference',
    section: 'Platform and access',
    order: 6,
    outline: [2,3],
    sourceAliases: [],
  },
  {
    source: 'docs/architecture.md',
    route: 'reference/index.md',
    label: 'Architecture',
    sidebar: 'reference',
    section: 'Concepts',
    order: 0,
    sourceAliases: [],
  },
  {
    source: 'docs/capability-seams.md',
    route: 'reference/capability-seams.md',
    label: 'Capability services',
    sidebar: 'reference',
    section: 'Concepts',
    order: 2,
    sourceAliases: [],
  },
  {
    source: 'docs/agent-lifecycle.md',
    route: 'reference/agent-lifecycle.md',
    label: 'Agent lifecycle',
    sidebar: 'reference',
    section: 'Concepts',
    order: 3,
    sourceAliases: [],
  },
  {
    source: 'docs/tool-execution-pipeline.md',
    route: 'reference/tool-execution-pipeline.md',
    label: 'Tool execution',
    sidebar: 'reference',
    section: 'Concepts',
    order: 4,
    sourceAliases: [],
  },
  {
    source: 'docs/config-catalog.md',
    route: 'reference/config-catalog.md',
    label: 'Plugin configuration',
    sidebar: 'reference',
    section: 'Generated reference',
    order: 0,
    sourceAliases: [],
  },
  {
    source: 'docs/tool-catalog.md',
    route: 'reference/tool-catalog.md',
    label: 'Tool schemas',
    sidebar: 'reference',
    section: 'Generated reference',
    order: 1,
    sourceAliases: [],
  },
  {
    source: 'docs/persistence-catalog.md',
    route: 'reference/persistence-catalog.md',
    label: 'Persistence events',
    sidebar: 'reference',
    section: 'Generated reference',
    order: 2,
    outline: 'deep',
    sourceAliases: [],
  },
  {
    source: 'docs/cordis-api/context.md',
    route: 'reference/cordis-api/context.md',
    label: 'Context',
    sidebar: 'reference',
    section: 'Cordis Core API',
    order: 0,
    sourceAliases: [],
  },
  {
    source: 'docs/cordis-api/events.md',
    route: 'reference/cordis-api/events.md',
    label: 'Events',
    sidebar: 'reference',
    section: 'Cordis Core API',
    order: 1,
    sourceAliases: [],
  },
  {
    source: 'docs/cordis-api/fiber.md',
    route: 'reference/cordis-api/fiber.md',
    label: 'Fiber',
    sidebar: 'reference',
    section: 'Cordis Core API',
    order: 2,
    sourceAliases: [],
  },
  {
    source: 'docs/cordis-api/registry.md',
    route: 'reference/cordis-api/registry.md',
    label: 'Plugin Registry',
    sidebar: 'reference',
    section: 'Cordis Core API',
    order: 3,
    sourceAliases: [],
  },
  {
    source: 'docs/cordis-api/service.md',
    route: 'reference/cordis-api/service.md',
    label: 'Service',
    sidebar: 'reference',
    section: 'Cordis Core API',
    order: 4,
    sourceAliases: [],
  },
  {
    source: 'docs/cordis-api/inherited.md',
    route: 'reference/cordis-api/inherited.md',
    label: 'Inherited surface',
    sidebar: 'reference',
    section: 'Cordis Core API',
    order: 5,
  },
  {
    source: 'docs/cookbook/adding-a-package.md',
    route: 'reference/cookbook/adding-a-package.md',
    label: 'Adding a package',
    sidebar: 'reference',
    section: 'Cookbook',
    order: 0,
    sourceAliases: [],
  },
  {
    source: 'docs/cookbook/adding-a-tool.md',
    route: 'reference/cookbook/adding-a-tool.md',
    label: 'Adding a tool',
    sidebar: 'reference',
    section: 'Cookbook',
    order: 1,
    sourceAliases: [],
  },
  {
    source: 'docs/cookbook/adding-an-llm-adapter.md',
    route: 'reference/cookbook/adding-an-llm-adapter.md',
    label: 'Adding an LLM adapter',
    sidebar: 'reference',
    section: 'Cookbook',
    order: 2,
    sourceAliases: [],
  },
  {
    source: 'docs/cookbook/adding-a-settings-card.md',
    route: 'reference/cookbook/adding-a-settings-card.md',
    label: 'Adding a settings card',
    sidebar: 'reference',
    section: 'Cookbook',
    order: 3,
    sourceAliases: [],
  },
  {
    source: 'docs/cookbook/extension-cookbook.md',
    route: 'reference/cookbook/extension-cookbook.md',
    label: 'Extension patterns',
    sidebar: 'reference',
    section: 'Cookbook',
    order: 4,
    sourceAliases: [],
  },
  {
    source: 'docs/cookbook/adding-a-conversation-node.md',
    route: 'reference/cookbook/adding-a-conversation-node.md',
    label: 'Adding a Conversation Node',
    sidebar: 'reference',
    section: 'Cookbook',
    order: 5,
    sourceAliases: [],
  },
]

/**
 * Pages of one sidebar collection, in the order the sidebar lists them.
 *
 * @param collection - Sidebar collection to read.
 * @returns The collection's pages, ordered by section placement then by `order`.
 */
export function orderedPages(collection: DocsSidebar): DocsPage[] {
  return docsPages
    .filter(page => page.sidebar === collection)
    .sort((left, right) => (
      sectionSpec(left.section).index - sectionSpec(right.section).index
      || left.order - right.order
    ))
}

/**
 * Site-relative link for a published route.
 *
 * @param route - Manifest route, including its `.md` suffix.
 * @returns The link VitePress serves the route at.
 */
export function routeLink(route: string): string {
  return `/${route.replace(/(?:index)?\.md$/, '')}`
}

/**
 * Where a top-level navigation item lands.
 *
 * The target is derived rather than written down: a collection whose first page
 * is renamed or reordered would otherwise leave the navigation bar pointing at
 * a route the manifest no longer publishes.
 *
 * @param collection - Sidebar collection the navigation item opens.
 * @returns Site-relative link of the collection's first page.
 * @throws When the collection publishes no page.
 */
export function landingLink(collection: DocsSidebar): string {
  const first = orderedPages(collection)[0]
  if (first === undefined) throw new Error(`Sidebar collection "${collection}" publishes no page.`)
  return routeLink(first.route)
}
