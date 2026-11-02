/**
 * Commander adapter for the `anton` command line (the DeepSeek Harness CLI,
 * forked and renamed).
 *
 * The launcher parses only what it owns — which profile to boot, which extra
 * patch overlays to apply, and the config dumps — and hands **everything after
 * its own flags** to the booted tree verbatim, where injected app plugins parse
 * their own flag families and print their own `--help` (see
 * `@deepseek-ai/dsh-cmdline`). Launcher flags therefore come first: the first
 * token this parser does not recognize starts the inner arguments, so
 * `anton --profile tui --resume abc` boots the tui profile with `--resume abc`,
 * and `anton --profile web -h` prints the web app's help, not this one's.
 *
 * `anton <name>` abbreviates `anton --profile <name>`; `plugin` manages a
 * profile's plugin dependencies by forwarding to pnpm. The app-control,
 * rebuild, login, and `models` subcommands claim their first tokens, so those
 * names cannot be booted through the bare-name shorthand.
 * @module @deepseek-ai/dsh/args
 */

import { Command, CommanderError, InvalidArgumentError } from 'commander'

/** Boot a named profile and hand it the invocation's inner arguments. */
interface ProfileInvocation {
  mode: 'profile'
  profile: string
  /** Shipped template that replaces the named profile. */
  fromDefaultProfile?: string | undefined
  /** Extra patch-list overlays applied after the profile's own layer, in argv order. */
  patches: string[]
  /** Everything after the launcher's own flags, verbatim, for injected app plugins. */
  args: string[]
}

/** Print a composed profile tree and exit without booting. */
interface DumpConfigInvocation {
  mode: 'dump-config'
  profile: string
  /** Shipped template that replaces the named profile. */
  fromDefaultProfile?: string | undefined
  /** Omit the profile's user layer and --patch overlays; print bundle layers only. */
  defaultOnly: boolean
  patches: string[]
}

/** Print declared plugin schemas without mounting the profile. */
interface DumpConfigSchemaInvocation {
  mode: 'dump-config-schema'
  profile: string
  /** Shipped template that replaces the named profile. */
  fromDefaultProfile?: string | undefined
  patches: string[]
}

/** Manage a profile's plugins: forward `args` to pnpm inside the profile directory. */
interface PluginInvocation {
  mode: 'plugin'
  profile: string
  /** Raw pnpm arguments, verbatim. */
  args: string[]
}

/** List the providers and models a profile's composition makes available. */
interface ModelsInvocation {
  mode: 'models'
  profile: string
}

/** One-time OpenCode Zen workspace login over the device flow. */
interface OpencodeLoginInvocation {
  mode: 'opencode-login'
  dshHome?: string
  oauthRef?: string
  consoleBase?: string
  openBrowser: boolean
  org?: string
}

/** One-time Claude Code subscription login over the browser code flow. */
interface ClaudeLoginInvocation {
  mode: 'claude-login'
  dshHome?: string
  oauthRef?: string
  consoleBase?: string
  openBrowser: boolean
}

/** Control the local Anton app's harness through its bridge API. */
interface AntonInvocation {
  mode: 'anton'
  action: 'status' | 'start' | 'stop' | 'restart'
}

/** Start, inspect, or cancel the launchd-supervised macOS rebuild. */
interface AntonRebuildInvocation {
  mode: 'anton-rebuild'
  action: 'start' | 'status' | 'cancel'
  timeoutMinutes: number
  checkout: string
}

/** Internal launchd entry: supervise one exact persisted rebuild job. */
interface AntonRebuildSuperviseInvocation {
  mode: 'anton-rebuild-supervise'
  jobId: string
}

/** The resolved `anton` invocation. Help, version, and errors exit inside {@link parseAntonArgs}. */
export type CliInvocation =
  | ProfileInvocation
  | DumpConfigInvocation
  | DumpConfigSchemaInvocation
  | PluginInvocation
  | ModelsInvocation
  | OpencodeLoginInvocation
  | ClaudeLoginInvocation
  | AntonInvocation
  | AntonRebuildInvocation
  | AntonRebuildSuperviseInvocation

/** First tokens that select an Anton subcommand instead of naming a profile to boot. */
const ANTON_COMMANDS: ReadonlySet<string> = new Set([
  'models',
  'opencode-login',
  'claude-login',
  'status',
  'start',
  'stop',
  'restart',
  'rebuild',
  'anton-rebuild-supervise',
])

/** Launcher flags for profile boot and configuration dumps. */
interface BootOptions {
  patch?: string[]
  dumpConfig?: boolean
  dumpDefaultConfig?: boolean
  dumpConfigSchema?: boolean
  fromDefaultProfile?: string
}

/**
 * Repeatable single-value collector: `--patch a.yml --patch b.yml`. Never
 * variadic — a variadic `--patch` would swallow the inner arguments.
 */
const collect = (value: string, previous: string[] = []): string[] => [...previous, value]

function selectProfile(value: string, previous?: string): string {
  if (previous !== undefined) throw new InvalidArgumentError('select a profile only once')
  return value
}

function rejectElectronProfile(program: Command, profile: string): void {
  if (profile.toLowerCase() === 'desktop') {
    program.error('error: profile "desktop" is managed exclusively by the Electron application')
  }
}

/** The launcher's own help text; each app prints its own. */
const HELP_EXAMPLES = `
Help:
  anton -h | --help                            print this help
  anton --profile <name> --help                the booted app's own flags and help

Examples:
  anton web                                    boot the web profile (same as: anton --profile web)
  anton rescue --from-default-profile web
                                               recreate rescue from the shipped web template, then boot it
  anton headless "run the tests"               answer one task, print the result, and exit
  anton tui --patch ./extra.yml                boot a custom profile with one extra overlay
  anton tui --resume <session>                 arguments after the launcher flags reach the app
  anton web --help                             the web app's own flags and help
  anton models                                 list the profile's providers and models
  anton plugin --profile tui add <package>     install a plugin into the tui profile
  anton status | start | stop | restart        control the local Anton app's Harness
  anton rebuild start | status | cancel        rebuild and reinstall the Anton app
`

/**
 * Resolve a boot or dump invocation from the launcher flags and the leftover
 * inner arguments.
 * @param program - the command whose options were parsed.
 * @param profile - the profile these flags boot.
 * @param options - the launcher flags commander collected.
 * @param args - the leftover arguments, in argv order.
 * @returns the resolved invocation.
 */
function resolveBoot(program: Command, profile: string, options: BootOptions, args: string[]): CliInvocation {
  const patches = options.patch ?? []
  if (patches.includes('')) program.error('error: --patch needs a path')
  if (options.fromDefaultProfile === '') program.error('error: --from-default-profile needs a name')
  const dumps = [options.dumpConfig, options.dumpDefaultConfig, options.dumpConfigSchema].filter(Boolean)
  if (dumps.length === 0) {
    return { mode: 'profile', profile, fromDefaultProfile: options.fromDefaultProfile, patches, args }
  }
  if (dumps.length > 1) {
    program.error('error: --dump-config, --dump-default-config, and --dump-config-schema are mutually exclusive')
  }
  // The dump is boot-free: it never runs app command-line providers, so it
  // cannot show what those flags would decide, and printing a tree that differs
  // from the same invocation's boot would mislead.
  if (args.length > 0) {
    program.error(`error: config dumps take no app arguments, got ${args.map(argument => JSON.stringify(argument)).join(' ')}`)
  }
  if (options.dumpConfigSchema === true) {
    return { mode: 'dump-config-schema', profile, fromDefaultProfile: options.fromDefaultProfile, patches }
  }
  const defaultOnly = options.dumpDefaultConfig === true
  if (defaultOnly && patches.length > 0) {
    program.error('error: --dump-default-config prints the bundle layers and takes no --patch')
  }
  return { mode: 'dump-config', profile, fromDefaultProfile: options.fromDefaultProfile, defaultOnly, patches }
}

/**
 * Resolve argv into one invocation, or print and exit for help, version, or an
 * error.
 * @param argv - arguments after the Node binary and script.
 * @param version - version string printed by `--version`.
 * @param manageDesktopProfile - permit Desktop's installed carrier to manage its reserved profile's plugins.
 * @returns the resolved invocation.
 */
export function parseAntonArgs(argv: readonly string[], version: string, manageDesktopProfile = false): CliInvocation {
  const first = argv[0]
  let resolved: CliInvocation | undefined
  // Annotated, not inferred: the actions below call back into `program`, and an
  // inferred type would be circular through its own chain.
  const program: Command = new Command()
  program
    .name('anton')
    .version(version, '-V, --version', 'output the version number')
    .usage('[--profile] <name> [options] [app-args...]\n       anton plugin --profile <name> <pnpm-args...>')
    .description('anton: boot an Anton (DeepSeek Harness) profile — an ordered stack of plugin-bundle patch layers under your own overrides.')
    .addHelpText('after', HELP_EXAMPLES)
    .exitOverride()
    // The launcher's flags come first and end at the first token it does not
    // know; everything from there on belongs to the booted app, including
    // its -h. A bare `anton -h` with no profile still prints this help, below.
    .helpOption(false)
    .helpCommand(false)
    .allowUnknownOption()
    .passThroughOptions()
    .enablePositionalOptions()
    .argument('[args...]', 'arguments for the booted profile\'s app (see: anton --profile <name> --help)')
    .option('--profile <name>', 'the profile under $DSH_HOME/profiles to boot', selectProfile)
    .option('--from-default-profile <name>', 'replace a custom profile with a fresh copy of a shipped profile template')
    .option('--patch <path>', 'extra patch-list overlay applied after the profile layer (repeatable)', collect)
    .option('--dump-config', 'print the composed profile tree and exit')
    .option('--dump-config-schema', 'print JSON Schema for profile entries and patches without mounting')
    .option('--dump-default-config', 'print the profile tree without its user layer or --patch overlays and exit')
    .action((args: string[], options: BootOptions & { profile?: string }) => {
      // With the app owning -h, the launcher's own help is what a bare
      // `anton -h` (no profile to hand it to) must print.
      if (options.profile === undefined) {
        if (argv.length === 0 || args.some(argument => argument === '-h' || argument === '--help')) program.help()
        program.error('error: --profile <name> is required')
      }
      const profile = options.profile
      if (profile === '') program.error('error: --profile needs a name')
      rejectElectronProfile(program, profile)
      resolved = resolveBoot(program, profile, options, args)
    })

  if (first === 'plugin') {
    const plugin = program.command('plugin').description('manage a profile\'s plugins by forwarding the remaining arguments to pnpm in the profile directory')
    plugin
      // Commander copies the launcher's disabled help option into subcommands. The
      // forwarder restores its own help and stops reading options at forwarded pnpm input.
      .helpOption('-h, --help', 'show this help')
      .passThroughOptions()
      .requiredOption('--profile <name>', 'the profile whose plugins to manage (initialized on first use)', selectProfile)
      .allowUnknownOption()
      .argument('[args...]', 'pnpm arguments, forwarded verbatim (add <pkg>, remove <pkg>, why <pkg>, ...)')
      .action((args: string[], options: { profile: string }) => {
        if (options.profile === '') program.error('error: --profile needs a name')
        if (!manageDesktopProfile) rejectElectronProfile(plugin, options.profile)
        if (args.length === 0) program.error('error: plugin needs pnpm arguments to forward (e.g. add <package>)')
        resolved = { mode: 'plugin', profile: options.profile.toLowerCase() === 'desktop' ? 'desktop' : options.profile, args }
      })
  }

  // Anton subcommands register only when the first token selects one, so a
  // profile's inner arguments never dispatch into them.
  if (first !== undefined && ANTON_COMMANDS.has(first)) {
    const models = program.command('models').description('list the LLM providers and models a profile makes available, then exit')
    models
      .helpOption('-h, --help', 'show this help')
      .option('--profile <name>', 'the profile whose composition to inspect (default: web)')
      .action((options: { profile?: string }) => {
        const profile = options.profile !== undefined && options.profile !== '' ? options.profile : 'web'
        resolved = { mode: 'models', profile }
      })

    const opencodeLogin = program.command('opencode-login').description('log the opencode-free route into an OpenCode Zen workspace over the device flow, then exit')
    opencodeLogin
      .helpOption('-h, --help', 'show this help')
      .option('--home <path>', 'harness home holding .credentials.yaml (defaults to $DSH_HOME or ~/.dsh)')
      .option('--oauth-ref <name>', 'credential reference holding the workspace session')
      .option('--org <id-or-name>', 'workspace to bill against (prompts when ambiguous)')
      .option('--no-browser', 'print the verification link without opening it')
      .option('--console-base <url>', 'console root override (advanced; default production)')
      .action((options: { home?: string; oauthRef?: string; org?: string; browser?: boolean; consoleBase?: string }) => {
        resolved = {
          mode: 'opencode-login',
          ...(options.home === undefined ? {} : { dshHome: options.home }),
          ...(options.oauthRef === undefined ? {} : { oauthRef: options.oauthRef }),
          ...(options.consoleBase === undefined ? {} : { consoleBase: options.consoleBase }),
          openBrowser: options.browser !== false,
          ...(options.org === undefined ? {} : { org: options.org }),
        }
      })

    const claudeLogin = program.command('claude-login').description('log the claude-code route into a Claude subscription over the browser code flow, then exit')
    claudeLogin
      .helpOption('-h, --help', 'show this help')
      .option('--home <path>', 'harness home holding .credentials.yaml (defaults to $DSH_HOME or ~/.dsh)')
      .option('--oauth-ref <name>', 'credential reference holding the subscription session')
      .option('--no-browser', 'print the approval link without opening it')
      .option('--console-base <url>', 'console root override (advanced; default production)')
      .action((options: { home?: string; oauthRef?: string; browser?: boolean; consoleBase?: string }) => {
        resolved = {
          mode: 'claude-login',
          ...(options.home === undefined ? {} : { dshHome: options.home }),
          ...(options.oauthRef === undefined ? {} : { oauthRef: options.oauthRef }),
          ...(options.consoleBase === undefined ? {} : { consoleBase: options.consoleBase }),
          openBrowser: options.browser !== false,
        }
      })

    // App control is rooted at the CLI name: `anton status`, with `anton
    // rebuild` as the only nested action family.
    for (const action of ['status', 'start', 'stop', 'restart'] as const) {
      program.command(action)
        .description(`${action} the local Anton app's managed Harness`)
        .helpOption('-h, --help', 'show this help')
        .action(() => {
          resolved = { mode: 'anton', action }
        })
    }

    const rebuild = program.command('rebuild').description('rebuild and reinstall the Anton app through the launchd-supervised job')
    rebuild
      .helpOption('-h, --help', 'show this help')
      .argument('<action>', 'start | status | cancel')
      .option('--timeout <minutes>', 'managed rebuild timeout in minutes', '20')
      .option('--checkout <path>', 'DeepSeek Harness checkout to rebuild', process.cwd())
      .action((action: string, options: { timeout: string; checkout: string }) => {
        if (action !== 'start' && action !== 'status' && action !== 'cancel') {
          rebuild.error('error: rebuild action must be start, status, or cancel')
        }
        const timeoutMinutes = Number(options.timeout)
        if (!Number.isFinite(timeoutMinutes)) rebuild.error('error: --timeout must be a number of minutes')
        resolved = {
          mode: 'anton-rebuild',
          action: action as AntonRebuildInvocation['action'],
          timeoutMinutes,
          checkout: options.checkout,
        }
      })

    const supervise = program.command('anton-rebuild-supervise', { hidden: true }).description('internal managed rebuild supervisor')
    supervise
      .requiredOption('--job <id>')
      .action((options: { job: string }) => {
        resolved = { mode: 'anton-rebuild-supervise', jobId: options.job }
      })
  }
  try {
    const expanded = first !== undefined && !first.startsWith('-') && first !== 'plugin' && !ANTON_COMMANDS.has(first)
      ? ['--profile', ...argv]
      : argv
    program.parse(expanded, { from: 'user' })
  } catch (error) {
    return process.exit(error instanceof CommanderError ? error.exitCode : 1)
  }
  /* v8 ignore next -- an action resolves or Commander throws */
  if (resolved === undefined) throw new Error('anton: no invocation resolved')
  return resolved
}
