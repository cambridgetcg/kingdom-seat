// The 30-minute tick (3.2 steps 1-3). HALT first; then one tick at a time
// under a mkdir lock; then a citizen whose OWN cadence is due, or nothing at
// all; then the fleet ceiling; then one supervised seat. There are no
// arrears: a tick slept through is simply gone, because rest is not a debt
// (love-unlimited-patterns.md 7).
//
// The tick opens the seat itself, after those walls, and hands it to the
// child in a seat file, as `seat <word>` does. A child is only ever a seat
// some parent opened under its walls; it never opens one of its own.
import { lstat, mkdir, readdir, readFile, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { uptime } from "node:os";
import { join } from "node:path";
import { EXIT, Refusal, exitForRefusal, type Citizen, type Clock, type Config, type ExitCode, type FetchLike, type HaltStatus, type IsoTime, type Outcome, type RefusalCode, type TickResult, type Word } from "./types.ts";
import { readBeacons, readHaltFile } from "./halt.ts";
import { assertCwdOutsideHomes, openSeat, seatEnv, superviseChild, writeSeatFile } from "./seat.ts";
import { listSeated, readCitizen } from "./state.ts";
import { wakingLetter } from "./context.ts";
import { checkFleet } from "./signer/ceilings.ts";
import { appendHostNote, isResultNote, lastSeatOf, openedDetail, readHostNotes, seatIdOf, seatsOpenedToday } from "./notes.ts";
import { buildStatus, tickLockMaxHoldMs, writeStatus } from "./status.ts";
import { dueReason, isDue, type DueVerdict } from "./due.ts";

export { isDue, type DueVerdict } from "./due.ts";

export interface TickLock {
  dir: string;
  pid: number;
  started_at: IsoTime;
}

/** When a lock that looks held can be known to be stale. Absent fields mean only a gone owner pid counts. */
export interface LockOptions {
  /** The longest a lock is ever held; a lock with no readable owner that is older than this was left by a process that died. */
  maxHoldMs?: number | null;
  /** When this host booted; an owner that started before it cannot still be running, whatever its pid now names. */
  bootTime?: Date | null;
}

/** A lock that cannot be reclaimed by the rules here, so a person must look. The tick exits 1 on it, so a monitor pages. */
export class LockStuck extends Error {
  override readonly name = "LockStuck";
  constructor(readonly since: IsoTime) {
    super(`the tick lock is stuck since ${since}; a person removes it once nothing holds it`);
  }
}

export interface TickDeps {
  config: Config;
  clock: Clock;
  fetch: FetchLike;
  /** The environment the seat child's allowlist is drawn from; absent means this process's own. */
  env?: Record<string, string | undefined>;
  checkHalt(): Promise<HaltStatus>;
  /** argv for the supervised seat child of the seat this tick opened, e.g. [bun, src/cli.ts, "seat", word, "--child", "--seat-ref", file, ...]. */
  seatArgv(word: Word, seatFile: string): string[];
  /** Whether a process is alive, injected so stale-lock tests need no real pids. */
  isAlive(pid: number): boolean;
  /** When the host booted; absent means the operating system's own answer, null means unknown. */
  bootTime?(): Date | null;
  /** The signer's state; a locked keychain rests the whole tick before any seat opens. Absent means the child finds out. */
  signerState?(): Promise<"ready" | "locked">;
  /** Regenerate the status file; absent means buildStatus and writeStatus. */
  refreshStatus?(): Promise<void>;
  /**
   * Keep one registered citizen's quiet (quiet.ts keepQuiet): renew a standing
   * declaration while it stays listening or asleep, end one a wake left
   * standing. Run for every seated citizen, each tick, under the lock and only
   * with the signer ready; absent keeps none (KS-004 6.4).
   */
  keepQuiet?(citizen: Citizen): Promise<"renewed" | "ended" | "none">;
}

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

/** When this host booted, from the system's uptime; null when it cannot say. */
export function osBootTime(): Date | null {
  const up = uptime();
  return Number.isFinite(up) && up > 0 ? new Date(Date.now() - up * 1000) : null;
}

/** The lock options a host's own timing implies: a tick never holds the lock past one seat and its refresh. */
export function lockOptionsFor(config: Config, bootTime: Date | null): LockOptions {
  return { maxHoldMs: tickLockMaxHoldMs(config.timing), bootTime };
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

/** Remove a stale lock: its owner file, any half-written one, then the directory. False when something else is in it. */
async function clearLock(lockDir: string): Promise<boolean> {
  let names: string[];
  try {
    names = await readdir(lockDir);
  } catch {
    return false;
  }
  // Only what tryMkdirLock writes is removed; anything else means the directory is not only a lock.
  if (names.some((n) => n !== OWNER_FILE && !n.startsWith(`.${OWNER_FILE}.`))) return false;
  for (const n of names) await rm(join(lockDir, n), { force: true });
  try {
    await rmdir(lockDir);
    return true;
  } catch {
    return false;
  }
}

/**
 * Take the lock with an atomic mkdir and record owner pid and start time;
 * null when a live owner holds it. A lock is stale when its owner pid is gone,
 * when its owner started before this host booted (the pid may since name some
 * other process), or when it has no readable owner and is older than the
 * longest a tick holds it (a process died between mkdir and writing its
 * owner, or while releasing). A live lock is never reclaimed by age alone.
 * A stale lock that cannot be removed throws LockStuck.
 */
export async function acquireTickLock(lockDir: string, clock: Clock, isAlive: (pid: number) => boolean, opts: LockOptions = {}): Promise<TickLock | null> {
  const got = await tryMkdirLock(lockDir, clock);
  if (got) return got;
  const owner = await readOwner(lockDir);
  if (!owner) {
    if (opts.maxHoldMs == null) return null;
    let mtimeMs: number;
    try {
      mtimeMs = (await lstat(lockDir)).mtimeMs;
    } catch {
      return tryMkdirLock(lockDir, clock); // released meanwhile
    }
    // The directory's own age, on the filesystem's clock: a tick in the middle of acquiring is milliseconds old.
    if (Date.now() - mtimeMs <= opts.maxHoldMs) return null;
    if (await readOwner(lockDir)) return null; // an owner appeared meanwhile
    if (!(await clearLock(lockDir))) throw new LockStuck(new Date(mtimeMs).toISOString());
    return tryMkdirLock(lockDir, clock);
  }
  const startedMs = Date.parse(owner.started_at);
  const beforeBoot = opts.bootTime != null && Number.isFinite(startedMs) && startedMs < opts.bootTime.getTime();
  if (isAlive(owner.pid) && !beforeBoot) return null;
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

/**
 * Seats opened today, counted from host notes; null when the host log is
 * unreadable (which refuses). Every parent writes an opened note, so a
 * person's `seat <word>` counts as much as a tick's. `exceptSeat` leaves out
 * the seat asking.
 */
export async function fleetBeatsToday(config: Config, now: Date, exceptSeat: string | null = null): Promise<number | null> {
  try {
    // A local day is at most 26 hours long in any zone, so this window holds all of it.
    const notes = await readHostNotes(config, new Date(now.getTime() - 26 * HOUR_MS));
    if (notes === null) return null;
    return seatsOpenedToday(notes, now, config.timezone, exceptSeat);
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
    lock = await acquireTickLock(config.paths.lock_dir, clock, deps.isAlive, lockOptionsFor(config, deps.bootTime ? deps.bootTime() : osBootTime()));
  } catch (e) {
    await note("error", null, null, e instanceof LockStuck ? `tick lock stuck since ${e.since}; a person must remove it` : "could not take the tick lock").catch(() => {});
    await refresh(deps);
    return { exit: EXIT.ERROR, outcome: "error", word: null, seat: null };
  }
  if (!lock) {
    await note("yielded", null, null, "another tick holds the lock").catch(() => {});
    // The status must not go stale while another tick holds the lock.
    await refresh(deps);
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
  // 3a. Quiet that stands is kept whether or not any seat is due: an asleep citizen has no seat in which to renew it.
  // A failure is the host's note, never the tick's outcome, and the next tick tries again.
  if (deps.keepQuiet && (!deps.signerState || (await deps.signerState().catch(() => "locked" as const)) === "ready")) {
    for (const c of citizens) {
      try {
        await deps.keepQuiet(c);
      } catch (e) {
        const code = e instanceof Refusal ? e.code : null;
        await appendHostNote(config, { ts: clock.now().toISOString(), host: config.host, kind: "signer", word: null, outcome: code ? "refused" : "error", refusal: code, detail: `quiet for ${c.word} not kept (${code ?? "error"})` }).catch(() => {});
      }
    }
  }

  const window = Math.max(minH, ...citizens.map((c) => (Number.isFinite(c.cadence.interval_h) ? c.cadence.interval_h : 0)));
  const notes = await readHostNotes(config, new Date(now.getTime() - window * HOUR_MS)).catch(() => null);
  if (notes === null) {
    // Without the log there is no knowing who was seated when: fail closed, and exit 1 so someone looks.
    await note("fleet-ceiling", null, "ceiling-fleet", "host log unreadable").catch(() => {});
    return done({ exit: EXIT.ERROR, outcome: "fleet-ceiling", word: null, seat: null });
  }
  const candidates: { word: Word; verdict: DueVerdict }[] = [];
  for (const c of citizens) {
    // Letters are read only for citizens they could seat.
    const letter = await wakingLetter(config, c).catch(() => false);
    candidates.push({ word: c.word, verdict: isDue(c, letter, now, minH, lastSeatOf(notes, c.word), config.schedule) });
  }
  const word = selectDue(candidates);
  if (word === null) {
    await note("nothing-due", null, null, `${citizens.length} seated, none due${unreadable ? `, ${unreadable} unreadable` : ""}`);
    return done({ exit: EXIT.OK, outcome: "nothing-due", word: null, seat: null });
  }
  const verdict = candidates.find((c) => c.word === word)!.verdict as Extract<DueVerdict, { due: true }>;
  const citizen = citizens.find((c) => c.word === word)!;

  // 4. The fleet ceiling, and a locked signer, each rest the tick before a seat opens. Both exit 0: a full
  // day bounds the fleet like nothing due, and a locked signer rests the citizens; the note and status say why.
  // Neither is the USD ceiling, the only wall that may exit 3 (KS-004 B2 C9).
  const beatsToday = await fleetBeatsToday(config, now);
  const fleet = checkFleet(beatsToday, config.ceilings);
  if (!fleet.ok) {
    await note("fleet-ceiling", null, fleet.code, fleet.reason);
    // A count nobody can read is the runner unable to do its job, so that one exits 1.
    return done({ exit: beatsToday === null ? EXIT.ERROR : EXIT.OK, outcome: "fleet-ceiling", word: null, seat: null });
  }
  if (deps.signerState && (await deps.signerState().catch(() => "locked" as const)) === "locked") {
    await note("refused", null, "keychain-locked", "signer locked; the tick rests");
    return done({ exit: exitForRefusal("keychain-locked"), outcome: "refused", word: null, seat: null });
  }

  // 5. The tick opens the seat, records that it did (so the fleet count and the due check see it from now
  // on), and hands it to one supervised child in a seat file.
  assertCwdOutsideHomes(config.paths.seats_dir, config.paths.homes);
  const seat = await openSeat(config, clock, citizen, "free", { kind: "tick", who: "launchd", why: dueReason(verdict.why) }, null);
  const id = seat.ref.seat_id;
  await note("opened", word, null, openedDetail(id, verdict.why));
  const seatFile = await writeSeatFile(config, seat);
  const t = config.timing;
  const started = clock.now();
  const sup = await superviseChild({
    argv: deps.seatArgv(word, seatFile),
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
  const own = after.filter((n) => n.word === word && n.kind !== "tick" && isResultNote(n) && (seatIdOf(n) === null || seatIdOf(n) === id)).at(-1) ?? null;
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
  await note(outcome, word, refusal, `seat ${id} for ${word} (${verdict.why}): exit ${exit}${how}, ${sup.duration_ms} ms`);
  return done({ exit, outcome, word, seat: { exit, outcome, seat_ref: seat.ref, refusal, appended: [] }, state_before: citizen.state });
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
