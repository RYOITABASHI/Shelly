// Deterministic ports for EVENT-001 host tests: an injectable clock and a
// sequential id generator, so every test is reproducible without Date.now or
// Math.random.

import { Clock, IdGen } from '@/lib/event-queue/types';

export class FakeClock implements Clock {
  private t: number;
  constructor(start = 1_000) {
    this.t = start;
  }
  now(): number {
    return this.t;
  }
  advance(ms: number): void {
    this.t += ms;
  }
  set(ms: number): void {
    this.t = ms;
  }
}

export class SeqIdGen implements IdGen {
  private n = 0;
  constructor(private readonly prefix = 'id') {}
  next(): string {
    this.n += 1;
    return `${this.prefix}-${this.n}`;
  }
}
