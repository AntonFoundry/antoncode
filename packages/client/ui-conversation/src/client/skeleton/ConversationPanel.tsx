/** Root-scoped main occupant; Session binding belongs to its Conversation child. */
import type { PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '../contract/slots.ts'

/**
 * Render the Conversation with optional current-Session binding.
 * @param props - main-slot inputs and the declared Conversation renderer.
 * @returns the Conversation subtree.
 */
export function ConversationPanel(props: PropsRuntime<'main'> & PropsRenderSlots<'main.conversation'>) {
  // The layout owner may state how many conversation panes are on screen.
  // Read structurally: the `main` slot declares no owner share, so this
  // package stays independent of the layout owner's type surface.
  const { layoutSpan } = props as typeof props & { layoutSpan?: 'single' | 'multi' }
  return props.renderSlot('main.conversation', layoutSpan === undefined ? {} : { layoutSpan })
}
