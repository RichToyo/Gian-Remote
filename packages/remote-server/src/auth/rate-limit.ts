import { type Clock } from '../clock.js';

export class SlidingWindowLimiter {
  readonly #hits = new Map<string, number[]>();

  constructor(
    private readonly now: Clock,
    private readonly limit: number,
    private readonly windowMs = 60_000,
  ) {}

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

  private prune(key: string): number[] {
    const cutoff = this.now() - this.windowMs;
    const next = (this.#hits.get(key) ?? []).filter((stamp) => stamp > cutoff);
    this.#hits.set(key, next);
    return next;
  }
}
