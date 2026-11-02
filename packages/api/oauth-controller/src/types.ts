/** Progress fields sent to the Models page; credential and token values stay on the Host. */

/** One workspace offered by OpenCode Zen after device approval. */
export interface OpencodeLoginOrg {
  readonly id: string
  readonly name: string
}

/** Safe OpenCode device-flow progress. */
export interface OpencodeLoginView {
  readonly loginId: string
  readonly status: 'pending' | 'awaiting-org' | 'done' | 'denied' | 'expired' | 'cancelled'
  readonly userCode?: string
  readonly verificationUri?: string
  readonly intervalSeconds?: number
  readonly expiresInSeconds?: number
  readonly orgs?: readonly OpencodeLoginOrg[]
  readonly orgID?: string
  readonly allowedModelCount?: number
  readonly error?: string
}

/** Safe Claude subscription login progress. */
export interface ClaudeLoginView {
  readonly loginId: string
  readonly status: 'pending' | 'done' | 'failed' | 'cancelled'
  readonly verificationUri?: string
  readonly error?: string
}
