import { type Clock } from '../clock.js';

export class SlidingWindowLimiter {
  readonly #hits = new Map<string, number[]>();
  #sweptAt: number;

  constructor(
    private readonly now: Clock,
    private readonly limit: number,
    private readonly windowMs = 60_000,
  ) {
    this.#sweptAt = now();
  }

  allow(key: string): boolean {
    if (this.blocked(key)) return false;
    this.record(key);
    return true;
  }

  blocked(key: string): boolean {
    return this.prune(key).length >= this.limit;
  }

  record(key: string): void {
    const next = this.prune(key);
    next.push(this.now());
    this.#hits.set(key, next);
  }

  retryAfterSeconds(key: string): number {
    const oldest = this.prune(key)[0];
    return oldest === undefined ? 1 : Math.max(1, Math.ceil((oldest + this.windowMs - this.now()) / 1_000));
  }

  /** Keys currently held. A key leaves once its newest hit leaves the window. */
  get size(): number {
    this.#sweep();
    return this.#hits.size;
  }

  private prune(key: string): number[] {
    this.#sweep();
    const cutoff = this.now() - this.windowMs;
    const next = (this.#hits.get(key) ?? []).filter((stamp) => stamp > cutoff);
    if (next.length) this.#hits.set(key, next);
    else this.#hits.delete(key);
    return next;
  }

  /** Keys are client addresses and identities, most never seen again. At most
   *  once per window, drop every key whose newest hit has expired. */
  #sweep(): void {
    const now = this.now();
    if (now - this.#sweptAt < this.windowMs) return;
    this.#sweptAt = now;
    const cutoff = now - this.windowMs;
    for (const [key, stamps] of this.#hits) {
      if ((stamps.at(-1) ?? 0) <= cutoff) this.#hits.delete(key);
    }
  }
}
