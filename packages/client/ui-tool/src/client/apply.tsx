/** Register the Tool call tree, details renderer, and built-in atomic views. */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { RemoteHostFacts } from '@deepseek-ai/dsh-api-remotes/client'
import type { HostObservable, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import { useState } from 'react'
import { cardModeDefault, dispatchCardMode, setCardModePersisted } from './card-mode.ts'
import css from './tool/components/CardModeToggle.module.css'
import { ToolCallTree } from './tool/ToolCallTree.tsx'
import { CONVERSATION_NS as NS } from './locale.ts'
import { askQuestionToolview } from './tool/toolviews/ask-question-row.tsx'
import { bashToolviewSample } from './tool/toolviews/bash-sample.tsx'
import { fileMutationToolview } from './tool/toolviews/file-mutation-row.tsx'
import { readToolview } from './tool/toolviews/read-row.tsx'
import { readImageToolview } from './tool/toolviews/read-image-row.tsx'
import { searchToolview } from './tool/toolviews/search-row.tsx'
import { detailsToolview } from './tool/toolviews/details-row.tsx'
import { todoToolview } from './tool/toolviews/todo-row.tsx'
import { planToolview } from './tool/toolviews/plan-row.tsx'
import { webToolview } from './tool/toolviews/web-row.tsx'

/** Required services: the slot registry and the Remote face carrying the Host home used for POSIX `~`. */
export const inject = ['slots', 'remote']

/**
 * The chat-header posture toggle: expand-all / collapse-all for every tool
 * card in the conversation. Dispatches the card-mode event (rows apply it)
 * and persists the choice for newly mounted rows.
 */
function CardModeToggle({ t }: PropsLocale<typeof NS>) {
  const [expanded, setExpanded] = useState(cardModeDefault())
  const toggle = (): void => {
    const next = !expanded
    setExpanded(next)
    setCardModePersisted(next)
    dispatchCardMode(next)
  }
  return (
    <button
      type="button"
      className={css.toggle}
      data-active={expanded || undefined}
      aria-label={t(expanded ? 'toolCard.collapseAll' : 'toolCard.expandAll')}
      title={t(expanded ? 'toolCard.collapseAll' : 'toolCard.expandAll')}
      onClick={toggle}
    >
      <svg width={14} height={14} viewBox="0 0 16 16" fill="none" aria-hidden>
        {expanded ? (
          <path d="M3 6l5 4 5-4" stroke="currentColor" strokeWidth="1.5" />
        ) : (
          <path d="M3 10l5-4 5 4" stroke="currentColor" strokeWidth="1.5" />
        )}
      </svg>
    </button>
  )
}

/**
 * Mount the whole-Tool renderers, the card-mode header toggle, and built-in atomic Tool registrations.
 * @param ctx - Client root context.
 */
export function apply(ctx: ClientContext): void {
  const hostInfo: HostObservable<RemoteHostFacts> = {
    getSnapshot: () => ctx.remote.$host,
    subscribe: listener => ctx.on('connection/reset', listener),
  }
  const toolInject = () => ({ hooks: { hostInfo } })
  ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
    name: 'conversation.session.header.utilities',
    id: 'ui-tool-card-mode-toggle',
    locale: NS,
  }, CardModeToggle))
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
    name: 'conversation.chat.node',
    key: 'tool-call',
    locale: NS,
    children: {
      'tool.call.toolview': { kind: 'keyed', scope: 'session' },
    },
    inject: toolInject,
  }, ToolCallTree))

  ctx.plugin(bashToolviewSample)
  ctx.plugin(readToolview)
  ctx.plugin(readImageToolview)
  ctx.plugin(fileMutationToolview)
  ctx.plugin(searchToolview)
  ctx.plugin(webToolview)
  ctx.plugin(todoToolview)
  ctx.plugin(detailsToolview)
  ctx.plugin(askQuestionToolview)
  ctx.plugin(planToolview)
}
