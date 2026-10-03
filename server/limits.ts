/** Fixed-window counter per key, with a bounded number of tracked keys. */
export class WindowLimiter {
  private readonly windows = new Map<string, { count: number; until: number }>()
  constructor(
    readonly limit: number,
    readonly windowMs: number,
    readonly maxKeys = 10_000,
  ) {}

  /** Records one use for the key and reports whether it was within the limit. */
  take(key: string, time: number): boolean {
    let window = this.windows.get(key)
    if (!window || window.until <= time) {
      this.windows.delete(key)
      this.prune(time)
      window = { count: 0, until: time + this.windowMs }
      this.windows.set(key, window)
    }
    if (window.count >= this.limit) return false
    window.count++
    return true
  }

  private prune(time: number) {
    if (this.windows.size < this.maxKeys) return
    for (const [key, window] of this.windows) if (window.until <= time) this.windows.delete(key)
    // Map order is window start order, so the oldest windows are evicted first.
    for (const key of this.windows.keys()) {
      if (this.windows.size < this.maxKeys) break
      this.windows.delete(key)
    }
  }
}
