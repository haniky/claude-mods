export type CacheSnap = {
  /** when the request that last wrote/read the cache was sent ($.clock.now ms) */
  at: number
  /** cache lifetime in ms (1h = 3_600_000) */
  ttlMs: number
  /** prompt tokens of that request (what a rewrite would re-write) */
  tokens: number
}
export type Limits = { five: number | null; week: number | null }

declare module 'claude-code' {
  interface PluginState {
    'cache-keeper': {
      cache: { shape: string; value: CacheSnap | null }
      tick: number
      limits: Limits
      name: string
    }
  }
}
