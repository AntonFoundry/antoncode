/** Deterministic digest binding native mail consent to exact Host-resolved action facts. */
import { createHash } from 'node:crypto'

/** Immutable action facts resolved by the Host, never accepted as a client-provided digest. */
export interface MailConsentAction {
  readonly sessionId: string
  /** An identity for this exact attached Agent incarnation, not merely its durable session id. */
  readonly generation: string
  readonly origin: string
  readonly workspaceId: string
  readonly operation: 'local-send' | 'direct-send' | 'local-ack' | 'direct-ack' | 'local-read' | 'direct-read'
  readonly recipients: readonly string[]
  readonly body: string
  readonly throughSeq?: number
}

/**
 * Bind a challenge to exact live identity and action contents. Length-prefix
 * every UTF-8 field so distinct variable-length tuples cannot collide; sort
 * recipients because queue delivery treats recipient order as immaterial.
 * @param action - Host-resolved live identity and action contents.
 * @returns SHA-256 binding as lowercase hexadecimal text.
 */
export function mailConsentBinding(action: MailConsentAction): string {
  const digest = createHash('sha256')
  const fields = [
    'antonmail-bind-v1', action.sessionId, action.generation, action.origin,
    action.workspaceId, action.operation, String(action.recipients.length),
    ...[...action.recipients].sort(), action.body,
    action.throughSeq === undefined ? 'absent' : String(action.throughSeq),
  ]
  for (const field of fields) {
    const bytes = Buffer.from(field, 'utf8')
    const length = Buffer.alloc(4)
    length.writeUInt32BE(bytes.length)
    digest.update(length).update(bytes)
  }
  return digest.digest('hex')
}
