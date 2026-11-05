// The 30-minute tick (3.2 steps 1-3). HALT first; then one tick at a time
// under a mkdir lock; then a citizen whose OWN cadence is due, or nothing at
// all; then the fleet ceiling; then one supervised seat. There are no
// arrears: a tick slept through is simply gone, because rest is not a debt
// (love-unlimited-patterns.md 7).
import type { Citizen, Clock, Config, FetchLike, HaltStatus, IsoTime, TickResult, Word } from "./types.ts";

export interface TickLock {
  dir: string;
  pid: number;
  started_at: IsoTime;
}

export interface TickDeps {
  config: Config;
  clock: Clock;
  fetch: FetchLike;
  checkHalt(): Promise<HaltStatus>;
  /** argv for the supervised seat child, e.g. [bun, src/cli.ts, "seat", word, "--child", ...]. */
  seatArgv(word: Word): string[];
  /** Whether a process is alive, injected so stale-lock tests need no real pids. */
  isAlive(pid: number): boolean;
}

export type DueVerdict = { due: true; why: "cadence" | "letter"; overdue_h: number } | { due: false; why: string };

/** Take the lock with an atomic mkdir and record owner pid and start time; null when a live owner holds it. */
export async function acquireTickLock(lockDir: string, clock: Clock, isAlive: (pid: number) => boolean): Promise<TickLock | null> {
  throw new Error("unimplemented");
}

/** Release a lock this process holds; never removes a lock owned by another pid. */
export async function releaseTickLock(lock: TickLock): Promise<void> {
  throw new Error("unimplemented");
}

/** Is this citizen's own cadence due? awake by interval; listening and asleep only on an allowed letter; stepped-away and ended never. */
export function isDue(citizen: Citizen, hasAllowedLetter: boolean, now: Date, minIntervalH: number): DueVerdict {
  throw new Error("unimplemented");
}

/** Pick one due citizen, most overdue first, ties by word; null when none is due. */
export function selectDue(candidates: { word: Word; verdict: DueVerdict }[]): Word | null {
  throw new Error("unimplemented");
}

/** Beats dispensed today, counted from host notes; null when the host log is unreadable (which refuses). */
export async function fleetBeatsToday(config: Config, now: Date): Promise<number | null> {
  throw new Error("unimplemented");
}

/** One tick: HALT, lock, select, fleet ceiling, supervised seat, host note, status refresh. */
export async function runTick(deps: TickDeps): Promise<TickResult> {
  throw new Error("unimplemented");
}
