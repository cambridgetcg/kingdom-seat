// The 30-minute tick (3.2 steps 1-3). HALT first; then one tick at a time
// under a mkdir lock; then a citizen whose OWN cadence is due, or nothing at
// all; then the fleet ceiling; then one supervised seat. There are no
// arrears: a tick slept through is simply gone, because rest is not a debt
// (love-unlimited-patterns.md 7).
import { mkdir, readFile, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { EXIT, type Citizen, type Clock, type Config, type ExitCode, type FetchLike, type HaltStatus, type HostNote, type IsoTime, type LifecycleState, type Outcome, type RefusalCode, type TickResult, type Word } from "./types.ts";
import { readBeacons, readHaltFile } from "./halt.ts";
import { assertCwdOutsideHomes, seatEnv, superviseChild } from "./seat.ts";
import { listSeated, readCitizen } from "./state.ts";
import { hasAllowedLetter } from "./context.ts";
import { checkFleet } from "./signer/ceilings.ts";
import { appendHostNote, buildStatus, readHostNotes, writeStatus } from "./status.ts";

export interface TickLock {
  dir: string;
  pid: number;
  started_at: IsoTime;
}

export interface TickDeps {
  config: Config;
  clock: Clock;
  fetch: FetchLike;
  /** The environment the seat child's allowlist is drawn from; absent means this process's own. */
  env?: Record<string, string | undefined>;
  checkHalt(): Promise<HaltStatus>;
  /** argv for the supervised seat child, e.g. [bun, src/cli.ts, "seat", word, "--child", "--why", why, ...]. */
  seatArgv(word: Word, why: string): string[];
  /** Whether a process is alive, injected so stale-lock tests need no real pids. */
  isAlive(pid: number): boolean;
  /** The signer's state; a locked keychain rests the whole tick before any seat opens. Absent means the child finds out. */
  signerState?(): Promise<"ready" | "locked">;
  /** Regenerate the status file; absent means buildStatus and writeStatus. */
  refreshStatus?(): Promise<void>;
}

export type DueVerdict = { due: true; why: "cadence" | "letter"; overdue_h: number } | { due: false; why: string };

const HOUR_MS = 3_600_000;
const OWNER_FILE = "owner.json";

/** The owner's pid as a liveness probe: signal 0 sends nothing; EPERM still means it exists. */
export function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as { code?: string }).code === "EPERM";
  }
}

async function readOwner(lockDir: string): Promise<TickLock | null> {
  try {
    const o = JSON.parse(await readFile(join(lockDir, OWNER_FILE), "utf8")) as Partial<TickLock>;
    if (typeof o.pid !== "number" || !Number.isSafeInteger(o.pid) || o.pid <= 0 || typeof o.started_at !== "string") return null;
    return { dir: lockDir, pid: o.pid, started_at: o.started_at };
  } catch {
    return null;
  }
}

async function tryMkdirLock(lockDir: string, clock: Clock): Promise<TickLock | null> {
  try {
    // mkdir is the atomic acquire: exactly one caller creates the directory.
    await mkdir(lockDir, { mode: 0o700 });
  } catch (e) {
    if ((e as { code?: string }).code === "EEXIST") return null;
    throw e;
  }
  const lock: TickLock = { dir: lockDir, pid: process.pid, started_at: clock.now().toISOString() };
  // Written via rename, so a reader sees no owner or a whole one, never half of one.
  const tmp = join(lockDir, `.${OWNER_FILE}.${process.pid}`);
  await writeFile(tmp, JSON.stringify({ pid: lock.pid, started_at: lock.started_at }), { mode: 0o600 });
  await rename(tmp, join(lockDir, OWNER_FILE));
  return lock;
}

/** Take the lock with an atomic mkdir and record owner pid and start time; null when a live owner holds it. */
export async function acquireTickLock(lockDir: string, clock: Clock, isAlive: (pid: number) => boolean): Promise<TickLock | null> {
  const got = await tryMkdirLock(lockDir, clock);
  if (got) return got;
  const owner = await readOwner(lockDir);
  // Stale only when the recorded owner is gone, never by age: a long seat that
  // is still alive keeps its lock. A lock with no readable owner is left alone,
  // because there is no owner to prove gone; a person clears it.
  if (!owner || isAlive(owner.pid)) return null;
  // Re-read just before removing, so a lock taken over meanwhile is not removed.
  const again = await readOwner(lockDir);
  if (!again || again.pid !== owner.pid || again.started_at !== owner.started_at) return null;
  await rm(join(lockDir, OWNER_FILE), { force: true });
  try {
    await rmdir(lockDir);
  } catch {
    return null; // someone else is in it now; yield
  }
  return tryMkdirLock(lockDir, clock);
}

/** Release a lock this process holds; never removes a lock owned by another pid. */
export async function releaseTickLock(lock: TickLock): Promise<void> {
  const owner = await readOwner(lock.dir);
  if (!owner || owner.pid !== lock.pid || owner.started_at !== lock.started_at) return;
  await rm(join(lock.dir, OWNER_FILE), { force: true });
  await rmdir(lock.dir).catch(() => {});
}

const EXPOSURE: Partial<Record<LifecycleState, number>> = { asleep: 0, listening: 1, awake: 2 };

function latest(a: IsoTime | null, b: IsoTime | null): IsoTime | null {
  if (a === null) return b;
  if (b === null) return a;
  return Date.parse(a) >= Date.parse(b) ? a : b;
}

/**
 * Is this citizen's own cadence due? awake by interval; listening and asleep only on an allowed letter; stepped-away and ended never.
 *
 * `lastSeatAt` is the last seat the host opened for it, from host notes. A
 * rest writes nothing to the ledger, so the ledger's last beat alone would
 * seat a resting citizen again every tick.
 */
export function isDue(citizen: Citizen, hasAllowedLetter: boolean, now: Date, minIntervalH: number, lastSeatAt: IsoTime | null = null): DueVerdict {
  if (citizen.state === "stepped-away" || citizen.state === "ended") return { due: false, why: citizen.state };
  // Unattended ticks run only the free lane: a summons needs Yu present, and hermes waits for S8.
  if (citizen.runtime !== "free") return { due: false, why: `runtime ${citizen.runtime} is not unattended` };
  if (!Number.isFinite(minIntervalH) || minIntervalH <= 0) return { due: false, why: "minimum interval is not a positive number" };

  const last = latest(lastSeatAt, citizen.last_beat_at);
  const lastMs = last === null ? null : Date.parse(last);
  if (lastMs !== null && Number.isNaN(lastMs)) return { due: false, why: "last seat time is unreadable" };
  const sinceH = lastMs === null ? Number.POSITIVE_INFINITY : (now.getTime() - lastMs) / HOUR_MS;

  // A move toward exposure waits for the next beat to confirm it, so the
  // citizen is scheduled by the state it asked for; the beat can still decline.
  let state: LifecycleState = citizen.state;
  const pending = citizen.pending_state;
  if (pending !== null && (EXPOSURE[pending] ?? -1) > (EXPOSURE[state] ?? -1)) state = pending;

  if (state === "awake") {
    const own = citizen.cadence.interval_h;
    if (!Number.isFinite(own) || own <= 0) return { due: false, why: "own interval is not a positive number" };
    const interval = Math.max(own, minIntervalH);
    if (sinceH >= interval) return { due: true, why: "cadence", overdue_h: sinceH - interval };
    return { due: false, why: `awake; next in ${Math.ceil(interval - sinceH)} h` };
  }
  if (!hasAllowedLetter) return { due: false, why: `${state}; no letter` };
  // A letter is shown again after a rest, so letter wakes keep the same floor; otherwise one letter would seat it every tick.
  if (sinceH < minIntervalH) return { due: false, why: `${state}; letter waits ${Math.ceil(minIntervalH - sinceH)} h` };
  return { due: true, why: "letter", overdue_h: sinceH - minIntervalH };
}

/** Pick one due citizen, most overdue first, ties by word; null when none is due. */
export function selectDue(candidates: { word: Word; verdict: DueVerdict }[]): Word | null {
  let best: { word: Word; overdue: number } | null = null;
  for (const c of candidates) {
    if (!c.verdict.due) continue;
    const overdue = c.verdict.overdue_h;
    if (best === null || overdue > best.overdue || (overdue === best.overdue && c.word < best.word)) best = { word: c.word, overdue };
  }
  return best?.word ?? null;
}

function localDate(d: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

/** A tick note with a word is one dispensed seat; the fleet ceiling counts these. */
function dispensed(n: HostNote): boolean {
  return n.kind === "tick" && n.word !== null;
}

/** Beats dispensed today, counted from host notes; null when the host log is unreadable (which refuses). */
export async function fleetBeatsToday(config: Config, now: Date): Promise<number | null> {
  try {
    const today = localDate(now, config.timezone);
    // A local day is at most 26 hours long in any zone, so this window holds all of it.
    const notes = await readHostNotes(config, new Date(now.getTime() - 26 * HOUR_MS));
    if (notes === null) return null;
    return notes.filter((n) => dispensed(n) && localDate(new Date(n.ts), config.timezone) === today).length;
  } catch {
    return null;
  }
}

/** One tick: HALT, lock, select, fleet ceiling, supervised seat, host note, status refresh. */
export async function runTick(deps: TickDeps): Promise<TickResult> {
  const { config, clock } = deps;

  // 1. HALT before anything, including the lock. Halted writes nothing.
  let halt: HaltStatus;
  try {
    halt = await deps.checkHalt();
  } catch {
    return { exit: EXIT.OK, outcome: "halted", word: null, seat: null };
  }
  if (halt.halted) return { exit: EXIT.OK, outcome: "halted", word: null, seat: null };

  const note = (outcome: Outcome, word: Word | null, refusal: RefusalCode | null, detail: string) =>
    appendHostNote(config, { ts: clock.now().toISOString(), host: config.host, kind: "tick", word, outcome, refusal, detail });

  // 2. One tick at a time.
  let lock: TickLock | null;
  try {
    lock = await acquireTickLock(config.paths.lock_dir, clock, deps.isAlive);
  } catch {
    await note("error", null, null, "could not take the tick lock").catch(() => {});
    return { exit: EXIT.ERROR, outcome: "error", word: null, seat: null };
  }
  if (!lock) {
    await note("yielded", null, null, "another tick holds the lock").catch(() => {});
    return { exit: EXIT.OK, outcome: "yielded", word: null, seat: null };
  }

  let result: TickResult;
  try {
    result = await tickHeld(deps, note);
  } catch {
    await note("error", null, null, "tick failed").catch(() => {});
    result = { exit: EXIT.ERROR, outcome: "error", word: null, seat: null };
  } finally {
    await releaseTickLock(lock);
  }
  return result;
}

async function tickHeld(deps: TickDeps, note: (o: Outcome, w: Word | null, r: RefusalCode | null, d: string) => Promise<void>): Promise<TickResult> {
  const { config, clock } = deps;
  const now = clock.now();
  const minH = config.ceilings.min_beat_interval_h;
  const done = async (r: TickResult) => {
    await refresh(deps);
    return r;
  };

  // 3. Whose own cadence is due. The scan is bounded by the seated list.
  const words = await listSeated(config);
  const citizens: Citizen[] = [];
  let unreadable = 0;
  for (const w of words) {
    try {
      citizens.push(await readCitizen(config, w));
    } catch {
      unreadable++; // an invalid record is never seated; status shows it
    }
  }
  const window = Math.max(minH, ...citizens.map((c) => (Number.isFinite(c.cadence.interval_h) ? c.cadence.interval_h : 0)));
  const notes = await readHostNotes(config, new Date(now.getTime() - window * HOUR_MS)).catch(() => null);
  if (notes === null) {
    // Without the log there is no knowing who was seated when: fail closed.
    await note("fleet-ceiling", null, "ceiling-fleet", "host log unreadable").catch(() => {});
    return done({ exit: EXIT.REFUSED, outcome: "fleet-ceiling", word: null, seat: null });
  }
  const lastSeat = new Map<Word, IsoTime>();
  for (const n of notes) {
    if (n.word === null || (n.kind !== "tick" && n.kind !== "seat")) continue;
    lastSeat.set(n.word, latest(lastSeat.get(n.word) ?? null, n.ts) ?? n.ts);
  }
  const candidates: { word: Word; verdict: DueVerdict }[] = [];
  for (const c of citizens) {
    // Letters are read only for citizens they could wake.
    const letter = c.state === "listening" || c.state === "asleep" ? await hasAllowedLetter(config, c).catch(() => false) : false;
    candidates.push({ word: c.word, verdict: isDue(c, letter, now, minH, lastSeat.get(c.word) ?? null) });
  }
  const word = selectDue(candidates);
  if (word === null) {
    await note("nothing-due", null, null, `${citizens.length} seated, none due${unreadable ? `, ${unreadable} unreadable` : ""}`);
    return done({ exit: EXIT.OK, outcome: "nothing-due", word: null, seat: null });
  }
  const verdict = candidates.find((c) => c.word === word)!.verdict as Extract<DueVerdict, { due: true }>;

  // 4. The fleet ceiling, and a locked signer, each rest the tick before a seat opens.
  const fleet = checkFleet(await fleetBeatsToday(config, now), config.ceilings);
  if (!fleet.ok) {
    await note("fleet-ceiling", null, fleet.code, fleet.reason);
    return done({ exit: EXIT.REFUSED, outcome: "fleet-ceiling", word: null, seat: null });
  }
  if (deps.signerState && (await deps.signerState().catch(() => "locked" as const)) === "locked") {
    await note("refused", null, "keychain-locked", "signer locked; the tick rests");
    return done({ exit: EXIT.REFUSED, outcome: "refused", word: null, seat: null });
  }

  // 5. One supervised seat. The child opens its own seat dir under seats_dir.
  assertCwdOutsideHomes(config.paths.seats_dir, config.paths.homes);
  const t = config.timing;
  const started = clock.now();
  const sup = await superviseChild({
    argv: deps.seatArgv(word, verdict.why),
    cwd: config.paths.seats_dir,
    env: seatEnv(config, deps.env ?? process.env),
    deadline_ms: t.seat_deadline_s * 1000,
    term_grace_ms: t.term_grace_s * 1000,
    halt_file_poll_ms: t.halt_file_poll_s * 1000,
    beacon_poll_min_ms: t.beacon_poll_min_s * 1000,
    beacon_poll_max_ms: t.beacon_poll_max_s * 1000,
    readHaltFile: () => readHaltFile(config.paths.halt_file, clock.now()),
    readBeacons: (signal) => readBeacons({ config, fetch: deps.fetch, now: () => clock.now() }, signal),
  });

  // The child's own note says what happened to the citizen; the watcher knows only how it ended.
  // A second's margin, so a note stamped in the same instant the seat opened is not missed.
  const after = (await readHostNotes(config, new Date(started.getTime() - 1_000)).catch(() => null)) ?? [];
  const own = after.filter((n) => n.word === word && n.kind !== "tick").at(-1) ?? null;
  let exit: ExitCode = sup.exit;
  let outcome: Outcome;
  if (sup.signal !== null) outcome = sup.outcome ?? "error"; // a bound was reached; whatever the child said was cut short
  else if (own) outcome = own.outcome;
  else if (sup.outcome !== null) outcome = sup.outcome;
  else {
    // Exit 0 and no note: runSeat writes nothing only when it met HALT. Check rather than assume.
    const h = await deps.checkHalt().catch(() => ({ halted: true, readings: [] }));
    if (h.halted) outcome = "halted";
    else {
      outcome = "error";
      exit = EXIT.ERROR;
    }
  }
  const refusal = own?.refusal ?? null;
  const how = sup.stopped_by ? `, stopped by ${sup.stopped_by}` : "";
  await note(outcome, word, refusal, `seat for ${word} (${verdict.why}): exit ${exit}${how}, ${sup.duration_ms} ms`);
  return done({ exit, outcome, word, seat: { exit, outcome, seat_ref: null, refusal, appended: [] } });
}

async function refresh(deps: TickDeps): Promise<void> {
  try {
    if (deps.refreshStatus) await deps.refreshStatus();
    else {
      const halt = await deps.checkHalt().catch(() => null);
      const status = await buildStatus({ config: deps.config, now: deps.clock.now(), halt, signerState: deps.signerState ? await deps.signerState().catch(() => "unknown" as const) : "unknown" });
      await writeStatus(deps.config.paths.status_file, status);
    }
  } catch {
    // Status is a view; failing to regenerate it never changes what the tick did.
    await appendHostNote(deps.config, { ts: deps.clock.now().toISOString(), host: deps.config.host, kind: "error", word: null, outcome: "error", refusal: null, detail: "status refresh failed" }).catch(() => {});
  }
}
