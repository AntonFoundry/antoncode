import pLimit from 'p-limit'

/**
 * Counts operations when they start, with five concurrent slots and a lazily reset minute window.
 * Admission checks precede queueing, so this counter is not a strict reservation limit for queued calls.
 */
export class RateLimiter {
  private limit: ReturnType<typeof pLimit>
  private requestCount: number = 0
  private lastResetTime: number = Date.now()
  private readonly maxRequestsPerMinute: number
  private readonly resetIntervalMs: number = 60000 // 1 minute

  constructor(maxRequestsPerMinute: number = 10) {
    this.maxRequestsPerMinute = maxRequestsPerMinute
    this.limit = pLimit(5) // Max 5 concurrent requests
  }

  /**
   * Queue one operation under the concurrency limit after checking the current minute counter.
   * Failed operations still count once started; elapsed windows reset on the next admission check.
   * @param fn - Asynchronous operation invoked when a concurrency slot becomes available.
   * @returns Operation result after execution in the limiter queue.
   * @throws Error when admission observes the minute limit; operation failures propagate unchanged.
   */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    // Check if we need to reset the counter
    const now = Date.now()
    if (now - this.lastResetTime >= this.resetIntervalMs) {
      this.requestCount = 0
      this.lastResetTime = now
    }

    // Check rate limit
    if (this.requestCount >= this.maxRequestsPerMinute) {
      const waitTime = this.resetIntervalMs - (now - this.lastResetTime)
      throw new Error(`Rate limit exceeded. Please wait ${Math.ceil(waitTime / 1000)} seconds.`)
    }

    // Execute with concurrency limit
    const result = await this.limit(async () => {
      this.requestCount++
      return await fn()
    })

    return result
  }

  /**
   * Read accounting without resetting an elapsed window.
   * @returns Started-operation count, configured minute limit, and reset timestamp in epoch milliseconds.
   */
  getStatus(): { requestCount: number; maxRequests: number; resetTime: number } {
    return {
      requestCount: this.requestCount,
      maxRequests: this.maxRequestsPerMinute,
      resetTime: this.lastResetTime + this.resetIntervalMs,
    }
  }
}
