// A clock tests can set and advance, so no test depends on wall time.
import type { Clock } from "../../src/types.ts";

export interface TestClock extends Clock {
  set(iso: string): void;
  advance(ms: number): void;
}

export function testClock(iso = "2026-11-05T02:05:00.000Z"): TestClock {
  let t = Date.parse(iso);
  if (Number.isNaN(t)) throw new Error(`testClock: bad time ${iso}`);
  return {
    now: () => new Date(t),
    set(next) {
      const p = Date.parse(next);
      if (Number.isNaN(p)) throw new Error(`testClock: bad time ${next}`);
      t = p;
    },
    advance(ms) {
      t += ms;
    },
  };
}

export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;
