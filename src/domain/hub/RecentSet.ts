/**
 * A set that keeps only its `capacity` most recent members, so per-session
 * bookkeeping (taps routed, files routed) stays bounded however long the
 * session runs.
 */
export class RecentSet {
  readonly #items = new Set<string>()

  constructor(private readonly capacity: number) {}

  add(item: string): void {
    this.#items.delete(item)
    this.#items.add(item)
    while (this.#items.size > this.capacity) {
      const oldest = this.#items.values().next().value
      if (oldest === undefined) break
      this.#items.delete(oldest)
    }
  }

  has(item: string): boolean {
    return this.#items.has(item)
  }

  delete(item: string): boolean {
    return this.#items.delete(item)
  }

  get size(): number {
    return this.#items.size
  }
}
