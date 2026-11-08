/**
 * Empty-input handling for an opaque API-key draft.
 * @module @deepseek-ai/dsh-client-ui-settings-models/apiKey
 */

/** Copy key for a nonempty draft containing only whitespace. */
export type ApiKeyFailureKey = 'keyBlank'

/**
 * Distinguish an unchanged empty field from an accidentally whitespace-only draft.
 *
 * The form does not infer a provider's key format. Every nonblank value may be
 * submitted; credential storage and the provider own its eventual use.
 * @param draft - the key input's current value, untrimmed.
 * @returns the blank-draft copy key, or `undefined` to allow submit.
 */
export function apiKeyFailure(draft: string): ApiKeyFailureKey | undefined {
  return draft.length > 0 && draft.trim().length === 0 ? 'keyBlank' : undefined
}
