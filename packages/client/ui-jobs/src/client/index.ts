/**
 * Background-job plugin, browser half: contributes one session-header action
 * that renders this session's `ctx.jobs` records. The data arrives entirely
 * through the `jobsBySession` list mirror; the only RPC the plugin issues is
 * `jobs.kill` (via the sessions service) behind the stop controls, and no
 * state of its own beyond popover visibility and per-row stop requests.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { JobView } from '@deepseek-ai/dsh-client-runtime/client'
import { JobListAction, type JobActionsInjected, type JobStopResult } from './JobListAction.tsx'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { en, NS, zh, type JobKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Background-job list copy. */
    'job': JobKey
  }
}

export type { JobListActionProps } from './JobListAction.tsx'

/** Required services for locale registration and header-slot contribution. */
export const inject = ['sessions', 'slots', 'locale']

/**
 * Client plugin body: register the dictionaries and the header action.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-job: dictionaries')
  // Stop face: the request result feeds the row's pending/error state; the
  // row itself settles through the next `session/jobs` change push.
  const jobActions = (): JobActionsInjected => ({
    async killJob(jobId: JobView['id']): Promise<JobStopResult> {
      const result = await ctx.sessions.killJob(jobId)
      return result.ok ? { ok: true } : { ok: false, message: result.error.message }
    },
  })
  ctx.slots.inject(
    'conversation.session.header.actions',
    () => ctx.slots.register({
      name: 'conversation.session.header.actions',
      id: 'job-list',
      // After the subagent catalog: session lineage reads before process work.
      order: 20,
      locale: NS,
      inject: jobActions,
    }, JobListAction),
  )
}
