/** Time source. Domain and handlers take a Clock so tests can drive time deterministically. */
export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms))),
};

interface Timer {
  at: number;
  seq: number;
  resolve: () => void;
}

/**
 * Deterministic virtual clock. `sleep` registers a timer; `run()` drains pending work and
 * jumps time to the next timer until no timers remain or `until` is reached.
 * In-memory adapters resolve on microtasks/immediates, so draining with setImmediate is enough.
 */
export class VirtualClock implements Clock {
  private current: number;
  private timers: Timer[] = [];
  private seq = 0;

  constructor(start = Date.UTC(2026, 10, 18, 0, 0, 0)) {
    this.current = start;
  }

  now(): number {
    return this.current;
  }

  sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.timers.push({ at: this.current + Math.max(0, ms), seq: this.seq++, resolve });
    });
  }

  get pendingTimers(): number {
    return this.timers.length;
  }

  /** Let all microtasks and immediates settle. */
  async settle(rounds = 20): Promise<void> {
    for (let i = 0; i < rounds; i++) await new Promise<void>((r) => setImmediate(r));
  }

  /** Advance to the earliest timer (or to `limit`), firing every timer due at that instant. */
  async step(limit = Number.POSITIVE_INFINITY): Promise<boolean> {
    await this.settle();
    if (this.timers.length === 0) {
      if (limit !== Number.POSITIVE_INFINITY && limit > this.current) this.current = limit;
      return false;
    }
    this.timers.sort((a, b) => a.at - b.at || a.seq - b.seq);
    const next = this.timers[0];
    if (!next || next.at > limit) {
      if (limit !== Number.POSITIVE_INFINITY && limit > this.current) this.current = limit;
      return false;
    }
    this.current = Math.max(this.current, next.at);
    const due = this.timers.filter((t) => t.at <= this.current);
    this.timers = this.timers.filter((t) => t.at > this.current);
    for (const t of due) t.resolve();
    await this.settle();
    return true;
  }

  /** Run until no timers remain, or until virtual time `until` (epoch ms). */
  async run(until = Number.POSITIVE_INFINITY, maxSteps = 1_000_000): Promise<void> {
    for (let i = 0; i < maxSteps; i++) {
      const progressed = await this.step(until);
      if (!progressed) return;
    }
    throw new Error('VirtualClock.run exceeded maxSteps');
  }

  /** Advance by `ms` of virtual time, firing timers on the way. */
  async advance(ms: number): Promise<void> {
    await this.run(this.current + ms);
  }
}
