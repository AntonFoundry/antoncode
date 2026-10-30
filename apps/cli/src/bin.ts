#!/usr/bin/env node
/**
 * anton — command-line entry (the DeepSeek Harness CLI, forked and renamed).
 * Dynamic imports per mode keep unrelated modes out of each dispatch path; the
 * adapter prints and exits for `--help`/`--version`/a parse error, so only a
 * valid mode reaches the switch.
 * @module @deepseek-ai/dsh/bin
 */

/* v8 ignore file -- built-bin acceptance exercises this self-executing dispatch. */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { loadLayeredEnv } from '@deepseek-ai/dsh-app-boot'
import { parseAntonArgs } from './args.ts'

// Both the source tree (apps/cli/src) and the bundled bin (apps/cli/lib) sit
// one directory under apps/cli, so the checked-in manifest resolves with the
// same relative hop from either artifact.
/** This app's version, read from its checked-in package.json. */
function readVersion(): string {
  const manifest = JSON.parse(
    readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
  ) as { version?: unknown }
  return typeof manifest.version === 'string' ? manifest.version : '0.0.0'
}

const invocation = parseAntonArgs(process.argv.slice(2), readVersion())

switch (invocation.mode) {
  case 'profile': {
    const { runProfile } = await import('./profile-boot.ts')
    await runProfile({
      environment: loadLayeredEnv('dsh'),
      profile: invocation.profile,
      patchFiles: invocation.patches,
      args: invocation.args,
    })
    break
  }
  case 'plugin': {
    const { runPlugin } = await import('./plugin.ts')
    process.exit(runPlugin(invocation.profile, invocation.args))
    break
  }
  case 'dump-config': {
    const { runDumpConfig } = await import('./dump-config.ts')
    runDumpConfig(invocation.profile, invocation.defaultOnly, invocation.patches)
    break
  }
  case 'models': {
    const { runModels } = await import('./models.ts')
    await runModels(invocation.profile)
    break
  }
  case 'opencode-login': {
    const { runOpencodeLogin } = await import('./opencode-login.ts')
    process.exit(await runOpencodeLogin({
      ...(invocation.dshHome === undefined ? {} : { dshHome: invocation.dshHome }),
      ...(invocation.oauthRef === undefined ? {} : { oauthRef: invocation.oauthRef }),
      ...(invocation.consoleBase === undefined ? {} : { consoleBase: invocation.consoleBase }),
      openBrowser: invocation.openBrowser,
      ...(invocation.org === undefined ? {} : { org: invocation.org }),
    }))
    break
  }
  case 'claude-login': {
    const { runClaudeLoginCli } = await import('./claude-login.ts')
    process.exit(await runClaudeLoginCli({
      ...(invocation.dshHome === undefined ? {} : { dshHome: invocation.dshHome }),
      ...(invocation.oauthRef === undefined ? {} : { oauthRef: invocation.oauthRef }),
      ...(invocation.consoleBase === undefined ? {} : { consoleBase: invocation.consoleBase }),
      openBrowser: invocation.openBrowser,
    }))
    break
  }
  case 'anton': {
    const { runAnton } = await import('./anton.ts')
    process.exit(await runAnton(invocation.action))
    break
  }
  case 'anton-rebuild': {
    const { cancelRebuild, rebuildStatus, startRebuild } = await import('./anton-rebuild.ts')
    const result = invocation.action === 'start'
      ? await startRebuild({ timeoutMinutes: invocation.timeoutMinutes, checkout: invocation.checkout })
      : invocation.action === 'status'
        ? await rebuildStatus()
        : await cancelRebuild()
    process.exit(result)
    break
  }
  case 'anton-rebuild-supervise': {
    const { superviseRebuild } = await import('./anton-rebuild.ts')
    process.exit(await superviseRebuild(invocation.jobId))
    break
  }
  default:
    invocation satisfies never
    throw new Error(`anton: unhandled invocation mode ${JSON.stringify(invocation)}`)
}
