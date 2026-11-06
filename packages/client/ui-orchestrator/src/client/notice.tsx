/** Application-owned cancellation feedback survives changing conversation tabs. */
import type { HostObservable, PropsHooks } from '@deepseek-ai/dsh-client-ui-slots'
import { Toast } from '@deepseek-ai/dsh-client-ui-primitives'

interface NoticeInjected {
  hooks: { notice: HostObservable<{ text: string; tone: 'success' | 'error' } | null> }
  dismiss: () => void
}

/**
 * Render the completed cancellation outcome without changing board data.
 * @param props - Bound notice selector and dismissal callback.
 * @returns A transient application toast, or nothing before an outcome.
 */
export function CancellationNotice({ useNotice, dismiss }: Omit<NoticeInjected, 'hooks'> & PropsHooks<NoticeInjected['hooks']>) {
  const notice = useNotice(value => value)
  return notice === null ? null : <Toast text={notice.text} {...(notice.tone === 'success' ? { tone: 'success' as const } : {})} onDone={dismiss} />
}
