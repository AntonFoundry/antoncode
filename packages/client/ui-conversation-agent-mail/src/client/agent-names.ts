/**
 * Human-readable display names for agent sessions, Docker-style: an adjective
 * and a surname derived deterministically from the session id. The id remains
 * the address; the name is presentation only, so two agents may collide by
 * name without affecting delivery.
 */

const ADJECTIVES = [
  'amber', 'brave', 'brisk', 'calm', 'clever', 'coral', 'crimson', 'dapper',
  'eager', 'fleet', 'gentle', 'golden', 'jolly', 'keen', 'lively', 'lucid',
  'mellow', 'nimble', 'noble', 'plucky', 'quiet', 'rapid', 'silver', 'steady',
  'sunny', 'swift', 'vivid', 'witty', 'zesty', 'bold', 'cosmic', 'daring',
  'earnest', 'fearless', 'graceful', 'humble', 'inventive', 'jovial', 'kind',
  'merry',
] as const

const SURNAMES = [
  'turing', 'lovelace', 'hopper', 'curie', 'noether', 'shannon', 'lamport',
  'ritchie', 'knuth', 'dijkstra', 'hamilton', 'liskov', 'babbage', 'torvalds',
  'berners', 'cerf', 'kahn', 'thompson', 'mccarthy', 'minsky', 'engelbart',
  'wozniak', 'dragon', 'kay', 'backus', 'naur', 'wirth', 'stroustrup',
  'gosling', 'guido', 'matz', 'wall', 'hickey', 'fowler', 'beck', 'codd',
  'matsumoto', 'russell', 'church', 'gödel',
] as const

/** FNV-1a over UTF-16 code units; stable across processes and reloads. */
function hashOf(id: string): number {
  let hash = 2166136261
  for (let index = 0; index < id.length; index += 1) {
    hash ^= id.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1)
}

/**
 * Deterministic display name for one agent session.
 * @param id - the durable session id used as the address.
 * @returns a human-readable `Adjective Name` label.
 */
export function agentDisplayName(id: string): string {
  const hash = hashOf(id)
  const adjective = ADJECTIVES[hash % ADJECTIVES.length] ?? ADJECTIVES[0]
  const surname = SURNAMES[(hash >>> 8) % SURNAMES.length] ?? SURNAMES[0]
  return `${capitalize(adjective)} ${capitalize(surname)}`
}

/**
 * Two-letter avatar mark derived from the display name.
 * @param id - the durable session id used as the address.
 * @returns uppercase initials of the generated name.
 */
export function agentInitials(id: string): string {
  const [first, second] = agentDisplayName(id).split(' ')
  return `${first?.charAt(0) ?? 'A'}${second?.charAt(0) ?? 'G'}`
}
