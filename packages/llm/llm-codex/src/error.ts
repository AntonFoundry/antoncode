/** Structured Codex wire failures shared by HTTP and Responses SSE delivery. */
import { CONTEXT_WINDOW_EXCEEDED_CODE, QUOTA_EXCEEDED_CODE } from '@deepseek-ai/dsh-llm'

/**
 * Normalize explicit provider error codes without interpreting display text.
 * Authentication and context facts take precedence; otherwise code precedes type.
 * @param error - wire code and type, or absent when the provider omitted both.
 * @returns a stable failure code, or undefined for an unrecognized wire failure.
 */
export function codexErrorCode(error?: { code?: string; type?: string }): string | undefined {
  const facts = [error?.code, error?.type]
  if (facts.some(code => code === 'authentication_error' || code === 'invalid_api_key')) return 'AUTH'
  if (facts.includes('context_length_exceeded')) return CONTEXT_WINDOW_EXCEEDED_CODE
  for (const code of facts) {
    switch (code) {
      case 'invalid_request_error': return 'INVALID_REQUEST'
      case 'insufficient_quota':
      case 'billing_not_active':
      case 'usage_limit_reached': return QUOTA_EXCEEDED_CODE
      case 'rate_limit_exceeded': return 'RATE_LIMIT'
      case 'overloaded_error':
      case 'server_overloaded': return 'OVERLOADED'
      case 'model_unavailable':
      case 'model_not_found': return 'MODEL_UNAVAILABLE'
      default: break
    }
  }
  return undefined
}
