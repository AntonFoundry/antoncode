/** Register the Tool call tree, details renderer, and built-in atomic views. */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { useState } from 'react'
import { ToolCallTree } from './tool/ToolCallTree.tsx'
import { dispatchCardMode, cardModeDefault, setCardModePersisted } from './card-mode.ts'
import css from './tool/components/CardModeToggle.module.css'
import { ToolDetails } from './tool/ToolDetails.tsx'
import { CONVERSATION_NS as NS } from './locale.ts'
import { askQuestionToolview } from './tool/toolviews/ask-question-row.tsx'
import { bashToolviewSample } from './tool/toolviews/bash-sample.tsx'
import { fileMutationToolview } from './tool/toolviews/file-mutation-row.tsx'
import { readToolview } from './tool/toolviews/read-row.tsx'
import { searchToolview } from './tool/toolviews/search-row.tsx'
import { todoToolview } from './tool/toolviews/todo-row.tsx'
import { webToolview } from './tool/toolviews/web-row.tsx'

/** Required service: the slot registry that owns both Tool render seats. */
export const inject = ['slots']

/**
 * Mount the whole-Tool renderers and built-in atomic Tool registrations.
 * @param ctx - Client root context.
 */
/**
 * The chat-header posture toggle: expand-all / collapse-all for every tool
 * card in the conversation. Dispatches the card-mode event (rows apply it)
 * and persists the choice for newly mounted rows.
 */
function CardModeToggle() {
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
      aria-label={expanded ? '收起全部工具卡片' : '展开全部工具卡片'}
      title={expanded ? '收起全部工具卡片' : '展开全部工具卡片'}
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

export function apply(ctx: ClientContext): void {
  ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
    name: 'conversation.session.header.utilities',
    id: 'ui-tool-card-mode-toggle',
  }, CardModeToggle))
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
    name: 'conversation.chat.node',
    key: 'tool-call',
    locale: NS,
    children: {
      'tool.call.toolview': { kind: 'keyed', scope: 'session' },
    },
  }, ToolCallTree))

  ctx.slots.inject('conversation.details.tool', () => ctx.slots.register({
    name: 'conversation.details.tool',
    locale: NS,
  }, ToolDetails))

  ctx.plugin(bashToolviewSample)
  ctx.plugin(readToolview)
  ctx.plugin(fileMutationToolview)
  ctx.plugin(searchToolview)
  ctx.plugin(webToolview)
  ctx.plugin(todoToolview)
  ctx.plugin(askQuestionToolview)
}
