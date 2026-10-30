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
 * `web` is a hardcoded alias for `--profile web`; `plugin` manages a profile's
 * plugin dependencies by forwarding to pnpm.
 * @module @deepseek-ai/dsh/args
 */

import { Command, CommanderError } from 'commander'

/** Boot a named profile and hand it the invocation's inner arguments. */
interface ProfileInvocation {
  mode: 'profile'
  profile: string
  /** Extra patch-list overlays applied after the profile's own layer, in argv order. */
  patches: string[]
  /** Everything after the launcher's own flags, verbatim, for injected app plugins. */
  args: string[]
}

/** Print a composed profile tree and exit without booting. */
interface DumpConfigInvocation {
  mode: 'dump-config'
  profile: string
  /** Omit the profile's user layer and --patch overlays; print bundle layers only. */
  defaultOnly: boolean
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

/** The resolved command-line invocation. Help, version, and errors exit inside {@link parseAntonArgs}. */
export type CliInvocation =
  | ProfileInvocation
  | DumpConfigInvocation
  | PluginInvocation
  | ModelsInvocation
  | OpencodeLoginInvocation
  | ClaudeLoginInvocation
  | AntonInvocation
  | AntonRebuildInvocation
  | AntonRebuildSuperviseInvocation

/** Launcher flags shared by the default command and the `web` alias. */
interface BootOptions {
  patch?: string[]
  dumpConfig?: boolean
  dumpDefaultConfig?: boolean
}

/**
 * Repeatable single-value collector: `--patch a.yml --patch b.yml`. Never
 * variadic — a variadic `--patch` would swallow the inner arguments.
 */
const collect = (value: string, previous: string[] = []): string[] => [...previous, value]

/** The launcher's own help text; each app prints its own. */
const HELP_EXAMPLES = `
Help:
  anton -h | --help                            print this help
  anton --profile <name> --help                the booted app's own flags and help

Examples:
  anton --profile web                          boot the web profile (same as: anton web)
  anton --profile headless "run the tests"     answer one task, print the result, and exit
  anton --profile tui --patch ./extra.yml      boot a custom profile with one extra overlay
  anton --profile tui --resume <session>       arguments after the launcher flags reach the app
  anton models                                 list the profile's providers and models
  anton plugin --profile tui add <package>     install a plugin into the tui profile
  anton status | start | stop | restart        control the local Anton app's Harness
  anton rebuild start | status | cancel        rebuild and reinstall the Anton app
`

/**
 * Resolve a boot or dump invocation from the launcher flags and the leftover
 * inner arguments.
 * @param program - the command whose options were parsed (the root, or the `web` alias).
 * @param profile - the profile these flags boot.
 * @param options - the launcher flags commander collected.
 * @param args - the leftover arguments, in argv order.
 * @returns the resolved invocation.
 */
function resolveBoot(program: Command, profile: string, options: BootOptions, args: string[]): CliInvocation {
  const patches = options.patch ?? []
  if (patches.includes('')) program.error('error: --patch needs a path')
  if (options.dumpConfig !== true && options.dumpDefaultConfig !== true) {
    return { mode: 'profile', profile, patches, args }
  }
  if (options.dumpConfig === true && options.dumpDefaultConfig === true) {
    program.error('error: --dump-config and --dump-default-config are mutually exclusive')
  }
  // The dump is boot-free: it never runs app command-line providers, so it
  // cannot show what those flags would decide, and printing a tree that differs
  // from the same invocation's boot would mislead.
  if (args.length > 0) {
    program.error(`error: config dumps take no app arguments, got ${args.map(argument => JSON.stringify(argument)).join(' ')}`)
  }
  const defaultOnly = options.dumpDefaultConfig === true
  if (defaultOnly && patches.length > 0) {
    program.error('error: --dump-default-config prints the bundle layers and takes no --patch')
  }
  return { mode: 'dump-config', profile, defaultOnly, patches }
}

/**
 * Resolve argv into one invocation, or print and exit for help, version, or an
 * error.
 * @param argv - arguments after the Node binary and script.
 * @param version - version string printed by `--version`.
 * @returns the resolved invocation.
 */
export function parseAntonArgs(argv: readonly string[], version: string): CliInvocation {
  let resolved: CliInvocation | undefined
  // Annotated, not inferred: the actions below call back into `program`, and an
  // inferred type would be circular through its own chain.
  const program: Command = new Command()
  program
    .name('anton')
    .version(version, '-V, --version', 'output the version number')
    .description('anton: boot an Anton (DeepSeek Harness) profile — an ordered stack of plugin-bundle patch layers under your own overrides.')
    .addHelpText('after', HELP_EXAMPLES)
    .exitOverride()
    // The launcher's flags come first and end at the first token it does not
    // know; everything from there on belongs to the booted app, including
    // its -h. A bare `anton -h` with no profile still prints this help, below.
    .helpOption(false)
    .allowUnknownOption()
    .passThroughOptions()
    .enablePositionalOptions()
    .argument('[args...]', 'arguments for the booted profile\'s app (see: anton --profile <name> --help)')
    .option('--profile <name>', 'the profile under $DSH_HOME/profiles to boot')
    .option('--patch <path>', 'extra patch-list overlay applied after the profile layer (repeatable)', collect)
    .option('--dump-config', 'print the composed profile tree and exit')
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
      resolved = resolveBoot(program, profile, options, args)
    })

  /** Reject parent options supplied before a subcommand. */
  const rejectParentOptions = (command: string): void => {
    const parent = program.opts<BootOptions & { profile?: string }>()
    if (parent.profile !== undefined || parent.patch !== undefined
      || parent.dumpConfig !== undefined || parent.dumpDefaultConfig !== undefined) {
      program.error(`error: ${command} takes none of parent --profile, --patch, --dump-config, or --dump-default-config`)
    }
  }

  const web = program.command('web').description('boot the web profile (alias of --profile web); the web app\'s own flags follow')
  web
    .helpOption(false)
    .allowUnknownOption()
    .passThroughOptions()
    .enablePositionalOptions()
    .argument('[args...]', 'arguments for the web app (see: anton web --help)')
    .option('--patch <path>', 'extra patch-list overlay applied after the profile layer (repeatable)', collect)
    .option('--dump-config', 'print the composed web-profile tree (with the user layer and any --patch) and exit')
    .option('--dump-default-config', 'print the web profile\'s bundle layers (no user layer) and exit')
    .action((args: string[], options: BootOptions) => {
      rejectParentOptions('web')
      resolved = resolveBoot(web, 'web', options, args)
    })

  const plugin = program.command('plugin').description('manage a profile\'s plugins by forwarding the remaining arguments to pnpm in the profile directory')
  plugin
    .helpOption('-h, --help', 'show this help')
    .requiredOption('--profile <name>', 'the profile whose plugins to manage (initialized on first use)')
    .allowUnknownOption()
    // After the first positional (`add`, `remove`, `why`), the rest belongs to
    // pnpm verbatim, including its own --help.
    .passThroughOptions()
    .argument('[args...]', 'pnpm arguments, forwarded verbatim (add <pkg>, remove <pkg>, why <pkg>, ...)')
    .action((args: string[], options: { profile: string }) => {
      rejectParentOptions('plugin')
      if (options.profile === '') program.error('error: --profile needs a name')
      if (args.length === 0) program.error('error: plugin needs pnpm arguments to forward (e.g. add <package>)')
      resolved = { mode: 'plugin', profile: options.profile, args }
    })

  const models = program.command('models').description('list the LLM providers and models a profile makes available, then exit')
  models
    .helpOption('-h, --help', 'show this help')
    .option('--profile <name>', 'the profile whose composition to inspect (default: web)')
    .action((options: { profile?: string }) => {
      rejectParentOptions('models')
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
      rejectParentOptions('opencode-login')
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
      rejectParentOptions('claude-login')
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
        rejectParentOptions(action)
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
      rejectParentOptions('rebuild')
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

  try {
    program.parse(argv, { from: 'user' })
  } catch (error) {
    return process.exit(error instanceof CommanderError ? error.exitCode : 1)
  }
  /* v8 ignore next -- an action resolves or Commander throws */
  if (resolved === undefined) throw new Error('anton: no invocation resolved')
  return resolved
}
