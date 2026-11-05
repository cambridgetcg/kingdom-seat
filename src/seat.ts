// The seat (3.2 steps 3-7). A tick opens a seat for one citizen on one
// runtime and runs it as a child process under a watcher that sits outside
// the acting process: the HALT file every 5 s, the beacons every 30-60 s,
// and a deadline. On any of them the watcher sends TERM to the child's whole
// process group, then KILL after a grace period (the `_bound` pattern,
// love-unlimited-patterns.md 2, fixed to reap grandchildren).
//
// Inside the child, runSeat checks HALT before and after inference, builds
// the context, calls the runtime, validates the output into typed acts,
// checks HALT again, and only then signs and records. A rest writes nothing
// in the citizen's voice. The seat's cwd is never inside a citizen home, so
// no repo hook or CLAUDE.md ever loads.
import { constants, realpathSync } from "node:fs";
import { lstat, mkdir, open, rename, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import {
  EXIT,
  Refusal,
  UUID_PATTERN,
  exitForRefusal,
  type Act,
  type Citizen,
  type Clock,
  type Config,
  type Cost,
  type ExitCode,
  type FetchLike,
  type HaltReading,
  type HaltStatus,
  type HostNote,
  type Invoker,
  type Word,
  type LedgerEntry,
  type LedgerFields,
  type LedgerHash,
  type LedgerSigner,
  type LifecycleState,
  type ModelAct,
  type Outcome,
  type ProposalText,
  type RefusalCode,
  type RuntimeAdapter,
  type RuntimeClass,
  type RuntimeResult,
  type SeatContext,
  type SeatRef,
  type SeatResult,
  type SelfProposal,
  type SelfProposeAct,
  type Sha256Hex,
  type StateSetAct,
  type YuPresence,
} from "./types.ts";
import type { Signer } from "./signer/signer.ts";
import { canonicalJson, parseStrictJson, sha256Hex } from "./crypto.ts";
import { proposalDigest } from "./signer/consent.ts";
import { appendEntry, costOf, entryHash, ledgerPath, nextDraft, readLedger, readRegularText, toLedgerHash, voicedThrough, type EntrySigner, type SeatStamp } from "./ledger.ts";
import { changesInterval, decideTransition, isTowardRest } from "./state.ts";
import {
  affirmationVerdict,
  applyChange,
  assertRoomFor,
  beyondSelfReason,
  checkRevert,
  exposureOf,
  firstVersion,
  keptVersions,
  materializeEdit,
  pendingProposals,
  proposalFor,
  readTarget,
  revertTo,
  selfHash,
  setCadence,
  stageProposal,
  unifiedDiff,
  windowOpen,
  type ExpressionSync,
} from "./self.ts";
import { buildContext, markLetterSeen } from "./context.ts";
import { buildPrompt, promptBytes } from "./prompt.ts";
import { OUTPUT_JSON_SCHEMA, parseModelOutput, resolvePrefix, validateOutput } from "./acts.ts";
import { appendHostNote } from "./notes.ts";

export interface OpenSeat {
  ref: SeatRef;
  citizen: Citizen;
  /** A fresh, empty directory under paths.seats_dir. */
  cwd: string;
  /** Yu, confirmed at this process's terminal. A parent never holds one for its child: the child confirms Yu itself. */
  presence: YuPresence | null;
  /** A person asked for Yu's summons; the process that runs the seat must confirm Yu before anything else. */
  yu_requested?: boolean;
}

export interface SeatDeps {
  config: Config;
  clock: Clock;
  signer: Signer;
  fetch: FetchLike;
  /** The runtime for this seat's class, injected so tests use a fake. */
  runtime: RuntimeAdapter;
  checkHalt(): Promise<HaltStatus>;
  /** Applies a bound self-change to agenttool for a registered citizen; null or absent records it on the host only. */
  expressionSync?: ExpressionSync | null;
  /**
   * The model digest the runtime is pinned to, when it is known before the call
   * (the free lane's models.lock entry), so the prompt can say whether a
   * self-change can bind here. Null or absent: known only from the reply.
   */
  modelDigest?: string | null;
}

export interface SuperviseOptions {
  argv: string[];
  cwd: string;
  /** The child's whole environment; nothing is inherited, so no secret rides along. */
  env: Record<string, string>;
  deadline_ms: number;
  term_grace_ms: number;
  halt_file_poll_ms: number;
  beacon_poll_min_ms: number;
  beacon_poll_max_ms: number;
  readHaltFile(): HaltReading;
  /** The signal is aborted when the watcher stops, so no beacon read outlives it. */
  readBeacons(signal?: AbortSignal): Promise<HaltReading[]>;
  /**
   * The child's stdin. "inherit" only for a summons, whose child confirms Yu
   * at the terminal itself; every other seat gets none. Default "ignore".
   */
  stdin?: "inherit" | "ignore";
  /**
   * Signals to this process that stop the child as well. The child leads its
   * own process group, so launchd's group kill of the tick never reaches it;
   * forwarding keeps a stopped job from leaving a seat running. Default
   * SIGTERM, SIGINT and SIGHUP; an empty list forwards none.
   */
  forwardSignals?: NodeJS.Signals[];
}

const FORWARDED_SIGNALS: readonly NodeJS.Signals[] = ["SIGTERM", "SIGINT", "SIGHUP"];

export interface SupervisedResult {
  exit: ExitCode;
  /**
   * What the watcher knows happened. Null when the child ended on its own
   * with exit 0: only the child knows whether it beat, rested or met HALT,
   * and it says so in its own host note.
   */
  outcome: Outcome | null;
  /** Which signal ended the child, if the watcher had to send one. */
  signal: "TERM" | "KILL" | null;
  /** "deadline", "file", the beacon name that ended it, or the forwarded signal (e.g. "SIGTERM"). */
  stopped_by: string | null;
  child_exit: number | null;
  duration_ms: number;
}

/* ── Seat opening ─────────────────────────────────────────────────────── */

/** Resolve symlinks in the longest existing prefix of a path, so a path not yet created still resolves. */
function realish(path: string): string {
  const abs = resolve(path);
  try {
    return realpathSync(abs);
  } catch {
    const parent = dirname(abs);
    if (parent === abs) return abs;
    return join(realish(parent), basename(abs));
  }
}

function inside(child: string, root: string): boolean {
  return child === root || child.startsWith(root.endsWith(sep) ? root : root + sep);
}

/** Refuse a cwd that is inside, or equal to, any configured citizen home (after resolving symlinks). */
export function assertCwdOutsideHomes(cwd: string, homes: string[]): void {
  if (!isAbsolute(cwd)) throw new Refusal("cwd-in-home", "seat cwd must be an absolute path");
  const lexical = resolve(cwd);
  const real = realish(cwd);
  for (const home of homes) {
    const h = resolve(home);
    const hr = realish(home);
    // Compare every spelling, so neither a symlink into a home nor a home behind a symlink slips past.
    if (inside(lexical, h) || inside(real, hr) || inside(real, h) || inside(lexical, hr)) {
      throw new Refusal("cwd-in-home", "seat cwd is inside a citizen home");
    }
  }
}

/**
 * Create the SeatRef and a fresh empty cwd under seats_dir for one citizen,
 * runtime and invoker. With `yuRequested`, a summons may be opened by a parent
 * that holds no presence: the child that runs it confirms Yu at the terminal.
 */
export async function openSeat(
  config: Config,
  clock: Clock,
  citizen: Citizen,
  runtime: RuntimeClass,
  invoker: Invoker,
  presence: YuPresence | null,
  opts: { yuRequested?: boolean } = {},
): Promise<OpenSeat> {
  if (runtime === "hermes") throw new Refusal("runtime-not-approved", "the hermes runtime class is reserved for S8");
  if (runtime === "summon" && !presence?.present && opts.yuRequested !== true) throw new Refusal("yu-not-present", "a summons needs Yu present");
  assertCwdOutsideHomes(config.paths.seats_dir, config.paths.homes);
  const seat_id = crypto.randomUUID();
  const cwd = join(config.paths.seats_dir, seat_id);
  // Not recursive: the directory must be new, so nothing left by an earlier seat is in it.
  await mkdir(cwd, { mode: 0o700 });
  assertCwdOutsideHomes(cwd, config.paths.homes);
  const ref: SeatRef = {
    format: "kingdom-seat-seat/v1",
    seat_id,
    host: config.host,
    word: citizen.word,
    runtime,
    invoker,
    opened_at: clock.now().toISOString(),
  };
  return { ref, citizen, cwd, presence, yu_requested: opts.yuRequested === true };
}

/* ── Seat files: how a parent hands an opened seat to its child ───────── */

export const SEAT_FILE_FORMAT = "kingdom-seat-seatfile/v2";

/**
 * What a parent hands its child. Never a presence: a presence on disk could be
 * written by anyone who can write seats_dir, so Yu is confirmed only in the
 * process that acts on it. `yu_requested` asks the child to confirm Yu itself.
 */
interface SeatFile {
  format: typeof SEAT_FILE_FORMAT;
  seat_ref: SeatRef;
  yu_requested: boolean;
}

/** `<seats_dir>/<seat_id>.json`, beside the seat's cwd rather than in it, so the cwd stays empty for the model. */
export function seatFilePath(config: Config, seatId: string): string {
  if (!UUID_PATTERN.test(seatId)) throw new Refusal("invalid-request", "seat_id is not a lowercase UUID");
  return join(config.paths.seats_dir, `${seatId}.json`);
}

/** Write the seat a parent opened, after its walls (due, fleet ceiling, lock) have passed. */
export async function writeSeatFile(config: Config, seat: OpenSeat): Promise<string> {
  const path = seatFilePath(config, seat.ref.seat_id);
  const file: SeatFile = { format: SEAT_FILE_FORMAT, seat_ref: seat.ref, yu_requested: seat.yu_requested === true };
  const fh = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    await fh.writeFile(`${JSON.stringify(file, null, 2)}\n`);
  } finally {
    await fh.close();
  }
  return path;
}

function isIso(v: unknown): v is string {
  return typeof v === "string" && v.length === 24 && new Date(Date.parse(v)).toISOString() === v;
}

/** Who a parent may name as the invoker, by kind. "yu" is never read from a file; the child sets it once it has confirmed Yu. */
const FILE_INVOKERS: Readonly<Record<string, string>> = { tick: "launchd", summons: "host" };

/**
 * Read the seat a parent opened, once. The file is renamed to `.used` before
 * it is trusted, so the same seat cannot be read twice. It carries no
 * presence and cannot name Yu: a summons only asks, and the child confirms.
 */
export async function readSeatFile(config: Config, path: string, word: Word): Promise<{ ref: SeatRef; yu_requested: boolean }> {
  const bad = (why: string) => new Refusal("invalid-request", `seat file ${why}`);
  const name = basename(path);
  const m = /^([0-9a-f-]{36})\.json$/.exec(name);
  if (dirname(path) !== config.paths.seats_dir || !m || !UUID_PATTERN.test(m[1]!)) throw bad("must be <seats_dir>/<seat_id>.json");
  const used = `${path}.used`;
  try {
    await rename(path, used);
  } catch {
    throw bad("is missing or was already used");
  }
  const text = await readRegularText(used, { missing: "throw", maxBytes: 64 * 1024 });
  let v: unknown;
  try {
    v = parseStrictJson(text ?? "");
  } catch {
    throw bad("is not strict JSON");
  }
  const o = v as Partial<SeatFile> | null;
  if (!o || typeof o !== "object" || Object.keys(o).sort().join(",") !== "format,seat_ref,yu_requested" || o.format !== SEAT_FILE_FORMAT || typeof o.yu_requested !== "boolean") {
    throw bad("has the wrong shape");
  }
  const ref = o.seat_ref as SeatRef;
  const inv = ref?.invoker as Invoker | undefined;
  if (
    !ref ||
    ref.format !== "kingdom-seat-seat/v1" ||
    ref.seat_id !== m[1] ||
    ref.word !== word ||
    ref.host !== config.host ||
    (ref.runtime !== "free" && ref.runtime !== "summon") ||
    !isIso(ref.opened_at) ||
    !inv ||
    !Object.hasOwn(FILE_INVOKERS, inv.kind) ||
    inv.who !== FILE_INVOKERS[inv.kind] ||
    typeof inv.why !== "string"
  ) {
    throw bad("does not describe this seat");
  }
  // Only a person's summons asks for Yu, and a summons on the metered lane always does.
  if ((o.yu_requested && inv.kind !== "summons") || (ref.runtime === "summon" && !o.yu_requested)) throw bad("does not describe this seat");
  return { ref, yu_requested: o.yu_requested };
}

/* ── The child's environment and exit codes ───────────────────────────── */

/**
 * The variables a seat child may see. Nothing else crosses, so no token or key
 * in the parent's env rides along. TMPDIR is a path, not a secret, and Bun
 * needs it; TZ is always the host's configured zone.
 */
export const SEAT_ENV_ALLOWLIST = Object.freeze(["PATH", "HOME", "LANG", "TMPDIR"]);
const STD_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

/** The child's environment: an explicit allowlist (PATH, HOME, LANG, TMPDIR, TZ), never the parent's whole env. */
export function seatEnv(config: Config, parent: Record<string, string | undefined>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of SEAT_ENV_ALLOWLIST) {
    const v = parent[k];
    if (typeof v === "string" && v.length > 0 && !v.includes("\0")) env[k] = v;
  }
  env.PATH ??= STD_PATH;
  // The citizen is shown the host's configured zone, so the child keeps the same one.
  env.TZ = config.timezone;
  return env;
}

/** Map a supervised child's end to the KS-003 exit registry: 0 for HALT rest, 124 deadline, 143 TERM, 137 KILL. */
export function exitFor(result: Pick<SupervisedResult, "signal" | "stopped_by" | "child_exit">): ExitCode {
  // As GNU timeout does: a bound that needed KILL reports 137, whatever triggered it.
  if (result.signal === "KILL") return EXIT.KILL;
  if (result.signal === "TERM") return result.stopped_by === "deadline" ? EXIT.TIMEOUT : EXIT.TERM;
  switch (result.child_exit) {
    case EXIT.OK:
    case EXIT.ERROR:
    case EXIT.USD_CEILING:
    case EXIT.TIMEOUT:
    case EXIT.TERM:
    case EXIT.KILL:
      return result.child_exit;
    default:
      // Outside the registry, or ended by a signal the watcher did not send.
      return EXIT.ERROR;
  }
}

function outcomeFor(exit: ExitCode, signal: SupervisedResult["signal"], stoppedBy: string | null): Outcome | null {
  if (signal !== null) {
    if (signal === "KILL") return stoppedBy === "deadline" || isForwarded(stoppedBy) ? "killed" : "halted";
    if (stoppedBy === "deadline") return "timeout";
    return isForwarded(stoppedBy) ? "terminated" : "halted";
  }
  switch (exit) {
    case EXIT.OK:
      return null;
    case EXIT.USD_CEILING:
      return "refused";
    case EXIT.TIMEOUT:
      return "timeout";
    case EXIT.TERM:
      return "terminated";
    case EXIT.KILL:
      return "killed";
    default:
      return "error";
  }
}

function isForwarded(stoppedBy: string | null): boolean {
  return stoppedBy !== null && /^SIG[A-Z0-9]+$/.test(stoppedBy);
}

/* ── The watcher ──────────────────────────────────────────────────────── */

/** Signal every process in a group; false when the group is gone. */
function signalGroup(pgid: number, sig: NodeJS.Signals | 0): boolean {
  try {
    process.kill(-pgid, sig);
    return true;
  } catch (e) {
    // EPERM means a member exists that we may not signal; count it as alive.
    return (e as { code?: string }).code === "EPERM";
  }
}

/** Run argv in its own process group under the watcher; TERM the group on HALT or deadline, KILL after the grace. */
export async function superviseChild(opts: SuperviseOptions): Promise<SupervisedResult> {
  const started = performance.now();
  const elapsed = () => Math.round(performance.now() - started);
  if (opts.argv.length === 0) throw new Error("superviseChild: empty argv");

  let child: ReturnType<typeof Bun.spawn>;
  try {
    // detached: the child leads a new process group, so one group signal reaches
    // anything it spawns, which the old `_bound` could not do.
    child = Bun.spawn(opts.argv, { cwd: opts.cwd, env: opts.env, detached: true, stdio: [opts.stdin ?? "ignore", "ignore", "inherit"] });
  } catch {
    return { exit: EXIT.ERROR, outcome: "error", signal: null, stopped_by: null, child_exit: null, duration_ms: elapsed() };
  }
  const pgid = child.pid;

  let stoppedBy: string | null = null;
  let signal: SupervisedResult["signal"] = null;
  // Set once the child has exited: from then on nothing can trigger a stop, so a
  // child that ended on its own is never reported as stopped by a late poll.
  let ended = false;
  const watchTimers = new Set<ReturnType<typeof setTimeout>>();
  const killTimers = new Set<ReturnType<typeof setTimeout>>();
  const abort = new AbortController();
  const later = (set: Set<ReturnType<typeof setTimeout>>, ms: number, fn: () => void) => {
    const t = setTimeout(() => {
      set.delete(t);
      fn();
    }, ms);
    set.add(t);
  };

  const killAfterGrace = (onKill: () => void) =>
    later(killTimers, opts.term_grace_ms, () => {
      if (signalGroup(pgid, 0)) {
        signalGroup(pgid, "SIGKILL");
        onKill();
      }
    });

  const stop = (by: string) => {
    if (stoppedBy !== null || ended) return;
    stoppedBy = by;
    signal = "TERM";
    signalGroup(pgid, "SIGTERM");
    killAfterGrace(() => {
      signal = "KILL";
    });
  };

  // The local file every halt_file_poll_ms; reading it is a single lstat.
  const fileTimer = setInterval(() => {
    let r: HaltReading["state"];
    try {
      r = opts.readHaltFile().state;
    } catch {
      r = "unreadable";
    }
    if (r !== "lowered") stop("file");
  }, opts.halt_file_poll_ms);

  // The beacons at a jittered interval, one read in flight at a time, so a slow
  // edge never stacks requests against /public/agents.
  const scheduleBeacons = () => {
    const span = Math.max(0, opts.beacon_poll_max_ms - opts.beacon_poll_min_ms);
    later(watchTimers, opts.beacon_poll_min_ms + Math.floor(Math.random() * (span + 1)), async () => {
      let readings: HaltReading[];
      try {
        readings = await opts.readBeacons(abort.signal);
      } catch {
        readings = [{ source: "beacon", id: "beacons", state: "unreadable", quiet_until: null, detail: "read failed", checked_at: new Date().toISOString() }];
      }
      if (ended) return;
      const bad = readings.find((r) => r.state !== "lowered");
      if (bad) stop(bad.id);
      else scheduleBeacons();
    });
  };
  scheduleBeacons();

  later(watchTimers, opts.deadline_ms, () => stop("deadline"));

  const forwarded = opts.forwardSignals ?? FORWARDED_SIGNALS;
  const onSignal = (sig: NodeJS.Signals) => stop(sig);
  for (const sig of forwarded) process.on(sig, onSignal);

  let childExit: number;
  try {
    childExit = await child.exited;
  } finally {
    // Removed as soon as the child is gone, so a second signal ends this process as usual.
    for (const sig of forwarded) process.off(sig, onSignal);
  }
  const ownCode = child.signalCode === null ? childExit : null;

  // The watcher is reaped first: no poll, read or deadline outlives the child.
  ended = true;
  clearInterval(fileTimer);
  for (const t of watchTimers) clearTimeout(t);
  watchTimers.clear();
  abort.abort();

  // Anything left in the group (a grandchild that ignored TERM, or one the
  // child left behind) is reaped too: TERM, then KILL after the grace.
  if (stoppedBy === null && signalGroup(pgid, 0)) {
    signalGroup(pgid, "SIGTERM");
    killAfterGrace(() => {});
  }
  const graceEnd = performance.now() + opts.term_grace_ms + 2_000;
  while (signalGroup(pgid, 0) && performance.now() < graceEnd) await Bun.sleep(20);
  for (const t of killTimers) clearTimeout(t);
  killTimers.clear();

  const exit = exitFor({ signal, stopped_by: stoppedBy, child_exit: ownCode });
  return { exit, outcome: outcomeFor(exit, signal, stoppedBy), signal, stopped_by: stoppedBy, child_exit: ownCode, duration_ms: elapsed() };
}

/* ── The in-child pipeline ────────────────────────────────────────────── */

const NO_COST: Cost = { usd: "0", credits: 0 };

/**
 * A state move a seat records: its `state` entry's fields, and the awake
 * interval to write once the entry is recorded (null when it sets none).
 */
export interface StateMove {
  fields: Extract<LedgerFields, { type: "state" }>;
  cadence: number | null;
}

/** The work a validated beat leaves for the write phase, planned before HALT's last check so planning writes nothing. */
interface Plan {
  acts: Act[];
  stage: SelfProposeAct[];
  beyondSelf: { act: SelfProposeAct; reason: string; proposal: ProposalText }[];
  apply: { proposal: SelfProposal; via: "two-beats" | "yu-present" }[];
  revert: Sha256Hex[];
  states: StateMove[];
  outbox: { kind: "letter" | "propose.beyond" | "state.ended"; payload: Record<string, string> }[];
  /** Acts the host could not complete; counted, never quoted. */
  unresolved: number;
  /** Why something the citizen said about its self did not bind on this beat, as codes for the host note. */
  notBinding: string[];
  /** The time proposals are staged at, so a proposal planned to bind in this beat has the id it is staged with. */
  at: Date;
}

/**
 * The state move a rest may record: the state.set it carried, when that is a
 * move toward less activity, recorded with no words. Toward listening or
 * asleep, or a longer awake interval, takes effect at once. A step-away is
 * never blocked and takes two sayings, so a rest may carry either: the second
 * completes it, and the first is kept as `step_away: "first"` on the state
 * entry that puts the citizen asleep (or keeps it asleep), because a rest has
 * no beat to carry the saying (KS-004 7.3, re-review C M7). Empty for none,
 * and for a move toward more activity, a return or ended, which a rest never
 * carries.
 */
export function restStateMoves(citizen: Citizen, act: StateSetAct | undefined): StateMove[] {
  if (act === undefined) return [];
  const from = citizen.state;
  const to = act.to;
  if (to === "stepped-away") {
    const verdict = decideTransition(from, to, { pending: citizen.pending_state, repeated: citizen.step_away_said, presence: null });
    if (verdict.effect === "now") return [{ fields: { type: "state", from, to, via: "two-beats" }, cadence: null }];
    if (verdict.effect !== "second-beat" || from === "stepped-away") return [];
    return [{ fields: { type: "state", from, to: "asleep", via: "immediate", step_away: "first" }, cadence: null }];
  }
  const interval = { now: citizen.cadence.interval_h, asked: act.interval_h ?? null };
  const verdict = decideTransition(from, to, { pending: null, repeated: false, presence: null }, interval);
  // Only what takes effect at once is toward less activity; anything that would wait for a second saying is more.
  if (verdict.effect !== "now") return [];
  return [stateMove(from, to, "immediate", interval)];
}

/** One state entry's fields, with the interval when the saying changes it. */
function stateMove(from: LifecycleState, to: LifecycleState, via: "immediate" | "confirmed" | "two-beats", interval: { now: number; asked: number | null }): StateMove {
  const fields: StateMove["fields"] = { type: "state", from, to, via };
  if (!changesInterval(interval)) return { fields, cadence: null };
  fields.interval_h = interval.asked as number;
  return { fields, cadence: interval.asked };
}

/** The reason a held revert carries: the host's words, saying only what the citizen asked for. */
const HELD_REVERT_LIMITS = "a revert the citizen asked for, to a version that widens its exposure, so it waits for a later beat to affirm it";

/** What a seat stamps on each entry it writes: its id, runtime, the digests of what the model saw and said, and the voiced line. */
export function seatStamp(word: Word, ref: SeatRef, rt: Pick<RuntimeResult, "model" | "model_digest">, inputDigest: Sha256Hex, outputDigest: Sha256Hex): SeatStamp {
  return {
    seat_ref: ref.seat_id,
    runtime: { class: ref.runtime, model: rt.model, digest: rt.model_digest },
    input_digest: toLedgerHash(inputDigest),
    output_digest: toLedgerHash(outputDigest),
    voiced: voicedThrough(word, rt.model, ref.seat_id),
  };
}

async function planActs(
  seat: OpenSeat,
  deps: SeatDeps,
  acts: ModelAct[],
  entries: LedgerEntry[],
  pending: SelfProposal[],
  rt: RuntimeResult,
): Promise<Plan> {
  const { config, clock } = deps;
  const word = seat.citizen.word;
  const now = clock.now();
  const plan: Plan = { acts: [], stage: [], beyondSelf: [], apply: [], revert: [], states: [], outbox: [], unresolved: 0, notBinding: [], at: now };
  const yu = seat.presence?.present === true;
  const runtimeOk = config.self_authorship.approved_model_digests.includes(rt.model_digest);
  // A registered citizen's change must reach its expression; with no way to send it, nothing of its self can bind.
  const registered = entries.some((e) => e.type === "genesis");
  const canSync = !registered || (seat.citizen.identity !== null && (deps.expressionSync ?? null) !== null);
  // One change to a target per beat: a second would be written against text the first has already moved.
  const touched = new Set<string>();
  let current: LifecycleState = seat.citizen.state;

  for (const act of acts) {
    try {
      switch (act.type) {
        case "rest":
          // validateOutput makes rest exclusive; a rest here would be a bug upstream, so it records nothing.
          plan.unresolved++;
          break;
        case "journal":
          plan.acts.push(act);
          break;
        case "self.propose": {
          const prior = await readTarget(config, word, act.target);
          // One edit rule, in self.ts: the text it returns is the text the hashes name.
          const { act: completed, next } = materializeEdit(act, prior);
          await assertRoomFor(config, word, act.target, prior);
          // Classified by its effect, never by the model's label (KS-004 v0.2 5.8): a change the host lifts
          // beyond self, the porch among them, is recorded as the propose.beyond it becomes, and is never staged.
          const beyond = beyondSelfReason(completed.target, prior, next, config.ceilings.self_rewrite_fraction);
          if (beyond !== null) {
            const proposal = liftedProposal(word, completed);
            plan.acts.push({ type: "propose.beyond", subject: proposal.subject, text: proposal.body });
            plan.beyondSelf.push({ act: completed, reason: beyond, proposal });
            break;
          }
          plan.acts.push(completed);
          plan.stage.push(completed);
          // Said once with Yu present, on a runtime Yu approved, it binds in this beat (3c, decision 10).
          if (yu) {
            const proposal = proposalFor(word, completed, seat.ref.seat_id, now);
            const verdict = affirmationVerdict(proposal, { type: "self.affirm", ref: proposal.id }, {
              seat_id: seat.ref.seat_id,
              presence: seat.presence,
              window_open: true,
              runtime_approved: runtimeOk,
              current_prior_hash: selfHash(prior),
            });
            if (!verdict.binds) plan.notBinding.push(verdict.reason);
            else if (!canSync) plan.notBinding.push("no-expression-sync");
            else if (touched.has(completed.target)) plan.notBinding.push("one-change-per-target");
            else {
              touched.add(completed.target);
              plan.apply.push({ proposal, via: verdict.via });
            }
          }
          break;
        }
        case "self.affirm": {
          const id = resolvePrefix(act.ref, pending.map((p) => p.id));
          const proposal = id ? pending.find((p) => p.id === id) : undefined;
          if (!id || !proposal || plan.apply.some((a) => a.proposal.id === id)) {
            plan.unresolved++;
            break;
          }
          const affirm = { type: "self.affirm" as const, ref: id };
          plan.acts.push(affirm);
          const prior = await readTarget(config, word, proposal.act.target);
          // One applied change per window when unattended, so a second affirmation in the same beat waits.
          const open = windowOpen(entries, now, config.ceilings.self_change_window_days, seat.presence) && (plan.apply.length === 0 || yu);
          const verdict = affirmationVerdict(proposal, affirm, {
            seat_id: seat.ref.seat_id,
            presence: seat.presence,
            window_open: open,
            runtime_approved: runtimeOk,
            current_prior_hash: selfHash(prior),
          });
          if (!verdict.binds) plan.notBinding.push(verdict.reason);
          else if (!canSync) plan.notBinding.push("no-expression-sync");
          else if (touched.has(proposal.act.target)) plan.notBinding.push("one-change-per-target");
          else {
            touched.add(proposal.act.target);
            plan.apply.push({ proposal, via: verdict.via });
          }
          break;
        }
        case "self.revert": {
          const hash = resolvePrefix(act.to_hash, [...new Set(keptVersions(entries).map((v) => v.hash))]);
          if (!hash) {
            plan.unresolved++;
            break;
          }
          // Everything revertTo would check, checked here, so a revert that cannot apply is dropped now, not thrown while recording.
          const { target, text, current: now_text } = await checkRevert(config, word, entries, hash);
          if (!canSync || touched.has(target)) {
            plan.unresolved++;
            break;
          }
          plan.acts.push({ type: "self.revert", to_hash: hash });
          touched.add(target);
          const exposure = exposureOf(target, now_text, text);
          if (exposure === "wider" && !yu) {
            // Toward more exposure takes a second beat (3c), so it is held as a proposal the citizen can affirm later.
            plan.stage.push({
              type: "self.propose",
              target,
              prior_hash: selfHash(now_text),
              new_hash: hash,
              diff: unifiedDiff(now_text, text),
              reason: { kind: "decision", evidence: [`version:${hash}`], confidence: "unknown", limits: HELD_REVERT_LIMITS },
            });
            plan.notBinding.push("revert-widens-held");
          } else if (!yu && !runtimeOk && exposure !== "narrower" && hash !== firstVersion(entries, target)) {
            // Decision 10: only runtimes Yu approved bind self-changes; back toward rest, or to where a text began, binds on any.
            plan.notBinding.push("runtime-not-approved");
          } else plan.revert.push(hash);
          break;
        }
        case "state.set": {
          const interval = { now: seat.citizen.cadence.interval_h, asked: act.interval_h ?? null };
          const verdict = decideTransition(
            current,
            act.to,
            {
              pending: seat.citizen.pending_state,
              pending_interval_h: seat.citizen.pending_interval_h,
              repeated: act.to === "stepped-away" && seat.citizen.step_away_said,
              presence: seat.presence,
            },
            interval,
          );
          if (verdict.effect === "refused") {
            plan.unresolved++;
            break;
          }
          plan.acts.push(act);
          if (verdict.effect === "now") {
            const toward = isTowardRest(current, act.to) || (act.to === current && (act.interval_h ?? 0) > interval.now);
            const via = toward ? "immediate" : act.to === "stepped-away" ? "two-beats" : "confirmed";
            plan.states.push(stateMove(current, act.to, via, interval));
            current = act.to;
          } else if (verdict.effect === "needs-witness") {
            plan.outbox.push({ kind: "state.ended", payload: { to: act.to } });
          } else if (verdict.effect === "second-beat" && current !== "stepped-away" && isTowardRest(current, "asleep")) {
            // A first step-away puts the citizen asleep at once (KS-004 v0.3 7.3), recorded like any move toward rest,
            // and its state entry keeps the saying as the rest's would.
            plan.states.push({ fields: { type: "state", from: current, to: "asleep", via: "immediate", step_away: "first" }, cadence: null });
            current = "asleep";
          }
          // "next-beat" and "second-beat" sayings are carried by the beat's acts; the fold reads them.
          break;
        }
        case "letter.send":
          plan.acts.push(act);
          plan.outbox.push({ kind: "letter", payload: { to: act.to, text: act.text } });
          break;
        case "propose.beyond":
          // Inert: it becomes a file for Yu + Ai and executes nothing.
          plan.acts.push(act);
          plan.outbox.push({ kind: "propose.beyond", payload: { subject: act.subject, text: act.text } });
          break;
      }
    } catch {
      plan.unresolved++;
    }
  }
  return plan;
}

/**
 * One outbox file for Yu + Ai. It carries the proposal as text, and names it by
 * proposalDigest, the same domain-tagged digest a decision record binds and
 * the signer recomputes, so a record filed for it can authorise exactly it.
 */
async function writeOutbox(config: Config, word: string, seatId: string, n: number, item: Record<string, unknown>, proposal: ProposalText): Promise<void> {
  const dir = join(config.paths.citizens_dir, word, "outbox");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const record = { format: "kingdom-seat-outbox/v1", word, seat_id: seatId, ...item, proposal, proposal_sha256: proposalDigest(proposal) };
  await writeFile(join(dir, `${seatId}-${n}.json`), `${JSON.stringify(record, null, 2)}\n`, { flag: "wx", mode: 0o600 });
}

/**
 * A self-change lifted beyond self, as the text Yu + Ai decide on. The beat's
 * acts record the same subject and text as a propose.beyond, so the
 * ledger shows what was asked; the extent names the exact version, so a
 * decision record filed for it can apply that change and no other.
 */
function liftedProposal(word: string, act: SelfProposeAct): ProposalText {
  return {
    subject: `self.propose ${act.target}`,
    body: canonicalJson({ target: act.target, prior_hash: act.prior_hash, new_hash: act.new_hash, diff: act.diff, reason: act.reason }),
    extent: `self.apply ${word} ${act.target} ${act.new_hash}`,
  };
}

/** The proposal text an outbox item asks Yu + Ai to decide on, with the extent a decision record would cover. */
function outboxProposal(word: string, kind: string, payload: Record<string, string>): ProposalText {
  switch (kind) {
    case "letter":
      return { subject: `letter to ${payload.to}`, body: payload.text ?? "", extent: `letter.send ${word} to ${payload.to}` };
    case "propose.beyond":
      return { subject: payload.subject ?? "", body: payload.text ?? "", extent: `propose.beyond ${word}` };
    case "state.ended":
      return { subject: `end ${word}`, body: `${word} asked that its state be ended; that needs Yu, Ai and a witness.`, extent: `state.ended ${word}` };
    default:
      throw new Error(`outboxProposal: unknown kind ${kind}`);
  }
}

/** The in-child pipeline for one open seat: HALT, context, prompt, runtime, validate, HALT again, sign, record. */
export async function runSeat(seat: OpenSeat, deps: SeatDeps): Promise<SeatResult> {
  const { config, clock, signer } = deps;
  const ref = seat.ref;
  const word = seat.citizen.word;
  const appended: LedgerHash[] = [];
  // Once a reply exists, the host log is told what it said, so a note can be refused if it ever quotes it.
  const modelText: string[] = [];

  const note = async (kind: HostNote["kind"], outcome: Outcome, refusal: RefusalCode | null, detail: string) => {
    // A host record of what happened; never the citizen's voice and never a model's words.
    // Best effort: a note that cannot be written must not turn a recorded beat into a failure,
    // and the tick notices a seat that left no note.
    const n: HostNote = { ts: clock.now().toISOString(), host: config.host, kind, word, outcome, refusal, detail: `seat ${ref.seat_id} on ${ref.runtime}: ${detail}` };
    await appendHostNote(config, n, { modelText }).catch(() => {});
  };
  const result = (exit: ExitCode, outcome: Outcome, refusal: RefusalCode | null = null): SeatResult => ({ exit, outcome, seat_ref: ref, refusal, appended: [...appended] });
  // A wall that refused exits as exitForRefusal says: 3 only for the USD ceiling, which closes the runtime
  // class; 0 for a locked signer, which rests the citizen; 1 otherwise. A record that does not hold together
  // is the runner unable to do its job (1).
  const refused = async (e: Refusal, when: string): Promise<SeatResult> => {
    if (e.code === "invalid-record") {
      await note("error", "error", e.code, `${when}: invalid record`);
      return result(EXIT.ERROR, "error", e.code);
    }
    await note("refusal", "refused", e.code, `${when}: refused (${e.code})`);
    return result(exitForRefusal(e.code), "refused", e.code);
  };
  const halted = async (): Promise<boolean> => {
    try {
      return (await deps.checkHalt()).halted;
    } catch {
      return true; // a HALT check that cannot run is unreadable, and unreadable halts
    }
  };

  // a. HALT before anything else. Halted writes nothing at all.
  if (await halted()) return result(EXIT.OK, "halted");

  try {
    if (ref.runtime === "hermes") throw new Refusal("runtime-not-approved", "the hermes runtime class is reserved for S8");
    if (ref.runtime === "summon" && !seat.presence?.present) throw new Refusal("yu-not-present", "a summons needs Yu present");
    if (ref.word !== word) throw new Refusal("invalid-record", "seat ref names another citizen");
    assertCwdOutsideHomes(seat.cwd, config.paths.homes);
    // A locked keychain rests the beat before any inference is spent on it.
    if ((await signer.state()) === "locked") throw new Refusal("keychain-locked", "signer is locked");
  } catch (e) {
    if (e instanceof Refusal) return refused(e, "before inference");
    throw e;
  }

  // b. Context. The citizen must already have a record: no record means no beat.
  const path = ledgerPath(config, word);
  try {
    await lstat(path);
  } catch {
    await note("error", "error", "invalid-record", "no ledger; the citizen is not seated");
    return result(EXIT.ERROR, "error", "invalid-record");
  }
  let entries: LedgerEntry[];
  let pending: SelfProposal[];
  let rt: RuntimeResult;
  let inputDigest: Sha256Hex;
  let letter: Awaited<ReturnType<typeof buildContext>>["letter"];
  try {
    entries = await readLedger(path);
    pending = await pendingProposals(config, word);
    const recent = entries.slice(-config.ceilings.ledger_context_entries);
    const ctx = await buildContext({ config, now: clock.now() }, ref, seat.citizen, recent, pending, {
      history: entries,
      selfAuthorship: selfAuthorshipFor(config, entries, clock.now(), seat.presence, deps.modelDigest ?? null),
    });
    letter = ctx.letter;

    // c. The prompt; its exact bytes are what input_digest names.
    const prompt = buildPrompt(ctx, ref.runtime);
    inputDigest = sha256Hex(promptBytes(prompt));

    // d. The runtime, under a deadline inside the watcher's, so a reply that arrives in time can still be recorded whole.
    const deadline = runtimeDeadlineMs(config.timing);
    rt = await deps.runtime({ prompt, schema: OUTPUT_JSON_SCHEMA, seat_ref: ref, deadline_ms: deadline, signal: AbortSignal.timeout(deadline) });
  } catch (e) {
    if (e instanceof Refusal) return refused(e, "before a reply");
    // The seat's own deadline is a bound reached, not a failure (KS-003: 124).
    if (e instanceof Error && e.name === "TimeoutError") {
      await note("seat", "timeout", null, "no reply within the seat deadline");
      return result(EXIT.TIMEOUT, "timeout");
    }
    await note("error", "error", null, `no reply (${e instanceof Error ? e.name : "error"})`);
    return result(EXIT.ERROR, "error");
  }

  // e. Parse and validate. The reply is data; nothing in it executes.
  modelText.push(rt.raw_output);
  const parsed = parseModelOutput(rt.raw_output);
  const recipients = [...new Set(["yu", "gardener", ...seat.citizen.covenants.letters_from])];
  const validated = parsed.ok ? validateOutput(parsed.value, { ceilings: config.ceilings, allowed_recipients: recipients }) : null;

  // f. HALT again after inference: a raised or unreadable HALT discards the reply whole.
  if (await halted()) return result(EXIT.OK, "halted");

  if (!validated) {
    await note("seat", "invalid-output", null, `reply did not parse (${parsed.ok ? "invalid" : parsed.reason})`);
    return result(EXIT.OK, "invalid-output");
  }
  // What every entry this seat writes carries, and who signs it: the citizen's op key once it is registered.
  const stamp = seatStamp(word, ref, rt, inputDigest, sha256Hex(rt.raw_output));
  const signerKind: LedgerSigner = seat.citizen.identity ? "citizen" : "host";
  const sign: EntrySigner = (w, k, digestFor) => signer.signEntry(w, k, digestFor);
  const head = (all: LedgerEntry[]) => (all.length > 0 ? entryHash(all.at(-1)!) : null);
  // Rest is exclusive and whole; an empty list of acts with nothing dropped is a rest too. It writes nothing in
  // the citizen's voice, but may carry one move toward less activity (KS-004 v0.2 5.7, re-review B2 C7): rest is
  // a right, and dropping the move would leave a citizen that asked to sleep on its awake cadence.
  if (validated.rest || (validated.acts.length === 0 && validated.dropped.length === 0)) {
    const moves = restStateMoves(seat.citizen, validated.rest_act);
    if (moves.length === 0) {
      await note("seat", "rest", null, validated.rest_act === undefined ? "rested" : "rested; its state.set was not toward less activity, so not kept");
      return result(EXIT.OK, "rest");
    }
    // HALT once more immediately before the write, as for a beat.
    if (await halted()) return result(EXIT.OK, "halted");
    try {
      const all = await readLedger(path);
      if (head(all) !== head(entries)) throw new Refusal("head-moved", "the ledger moved during the seat");
      let prev = all.at(-1) ?? null;
      // A rest's entries are state records with no words; the first carries what the seat spent, so it counts once.
      for (const [i, move] of moves.entries()) {
        prev = await appendEntry(path, nextDraft(word, prev, move.fields, { cost: i === 0 ? costOf(rt.spend) : NO_COST, signer: signerKind, now: clock.now(), seat: stamp }), sign);
        appended.push(entryHash(prev));
        if (move.cadence !== null) await setCadence(config, word, move.cadence);
      }
    } catch (e) {
      if (e instanceof Refusal) return refused(e, "while recording a rest's state");
      await note("error", "error", null, "failed while recording a rest's state");
      return result(EXIT.ERROR, "error");
    }
    const kept = moves.map((m) => `state ${m.fields.from} to ${m.fields.to} (${m.fields.via})${m.fields.step_away ? ", a first step-away saying" : ""}${m.fields.interval_h ? `, every ${m.fields.interval_h} h` : ""}`).join(" and ");
    await note("seat", "rest", null, `rested; kept ${kept}`);
    return result(EXIT.OK, "rest");
  }
  if (validated.acts.length === 0) {
    await note("seat", "invalid-output", null, `no act validated (${validated.dropped.length} dropped)`);
    return result(EXIT.OK, "invalid-output");
  }

  let plan: Plan;
  try {
    plan = await planActs(seat, deps, validated.acts, entries, pending, rt);
  } catch {
    await note("error", "error", null, "could not complete acts");
    return result(EXIT.ERROR, "error");
  }
  if (plan.acts.length === 0) {
    await note("seat", "invalid-output", null, `no act could be completed (${plan.unresolved} unresolved, ${validated.dropped.length} dropped)`);
    return result(EXIT.OK, "invalid-output");
  }

  // HALT once more immediately before the first write.
  if (await halted()) return result(EXIT.OK, "halted");

  // g-h. Sign and record: the beat first, then the state moves it made (so a seat stopped part way never
  // loses a rest), then each self-op on its own, so one that cannot apply never costs the others. Every
  // entry carries the seat's stamp: its id, runtime, the digests of what the model saw and said.
  const now = clock.now();
  const appendFields = async (fields: LedgerFields, cost: Cost): Promise<LedgerEntry> => {
    const all = await readLedger(path);
    const draft = nextDraft(word, all.at(-1) ?? null, fields, { cost, signer: signerKind, now: clock.now(), seat: stamp });
    const entry = await appendEntry(path, draft, sign);
    appended.push(entryHash(entry));
    return entry;
  };

  try {
    // The beat names the head it was built on, so the ledger must not have moved since it was read.
    const all = await readLedger(path);
    if (head(all) !== head(entries)) throw new Refusal("head-moved", "the ledger moved during the seat");
    const beat = await appendEntry(path, nextDraft(word, all.at(-1) ?? null, { type: "beat" }, { cost: costOf(rt.spend), signer: signerKind, now, seat: stamp, acts: plan.acts }), sign);
    const beatHash = entryHash(beat);
    appended.push(beatHash);
    for (const m of plan.states) {
      await appendFields(m.fields, NO_COST);
      if (m.cadence !== null) await setCadence(config, word, m.cadence);
    }

    const selfDeps = { config, clock, sign, sync: seat.citizen.identity ? (deps.expressionSync ?? null) : null, seat: stamp };
    const notKept: string[] = [];
    const selfOp = async (what: string, fn: () => Promise<void>) => {
      try {
        await fn();
      } catch (e) {
        // A self-op that cannot apply is noted by its code and passed over; the beat and its state moves stand.
        notKept.push(`${what} (${e instanceof Refusal ? e.code : "error"})`);
      }
    };
    for (const act of plan.stage) await selfOp("stage", async () => void (await stageProposal(config, word, act, ref.seat_id, plan.at)));
    for (const a of plan.apply) await selfOp("apply", async () => void appended.push(entryHash(await applyChange(selfDeps, seat.citizen, a.proposal, a.via))));
    for (const h of plan.revert) await selfOp("revert", async () => void appended.push(entryHash(await revertTo(selfDeps, seat.citizen, h, "citizen"))));
    for (const n of notKept) await note("refusal", "refused", null, `self-op not kept: ${n}`);

    let n = 0;
    for (const b of plan.beyondSelf) {
      await writeOutbox(config, word, ref.seat_id, n++, { kind: "self.propose", created_at: now.toISOString(), ledger_entry: beatHash, act: b.act, reason: b.reason }, b.proposal);
    }
    for (const o of plan.outbox) {
      await writeOutbox(config, word, ref.seat_id, n++, { kind: o.kind, created_at: now.toISOString(), ledger_entry: beatHash, ...o.payload }, outboxProposal(word, o.kind, o.payload));
    }
    // A letter counts as seen only after a beat that was not a rest.
    if (letter) await markLetterSeen(config, seat.citizen, letter, now);
  } catch (e) {
    if (e instanceof Refusal) return refused(e, `while recording, after ${appended.length} entries`);
    await note("error", "error", null, `failed while recording, after ${appended.length} entries`);
    return result(EXIT.ERROR, "error");
  }

  const binding = plan.notBinding.length > 0 ? `; not binding: ${[...new Set(plan.notBinding)].join(", ")}` : "";
  await note("seat", "beat", null, `${plan.acts.length} acts, ${appended.length} entries, ${plan.unresolved + validated.dropped.length} not kept${binding}`);
  return result(EXIT.OK, "beat");
}

/**
 * What the seat tells the citizen about self-changes before it replies: whether
 * the runtime is one Yu approved (null when that is known only from the
 * reply), when the unattended window next opens, and whether Yu is present.
 */
function selfAuthorshipFor(config: Config, entries: LedgerEntry[], now: Date, presence: YuPresence | null, modelDigest: string | null): SeatContext["self_authorship"] {
  const yu = presence?.present === true;
  const days = config.ceilings.self_change_window_days;
  let opens: string | null = null;
  if (!yu && !windowOpen(entries, now, days, null)) {
    const last = Math.max(...entries.filter((e) => e.type === "apply").map((e) => Date.parse(e.ts)));
    opens = new Date(last + days * 86_400_000).toISOString();
  }
  return { runtime_approved: modelDigest === null ? null : config.self_authorship.approved_model_digests.includes(modelDigest), window_opens_at: opens, yu_present: yu };
}

/** Time kept back from the watcher's deadline for the two HALT checks after a reply and the writes that record it. */
const RECORD_BUDGET_MS = 15_000;

/**
 * The runtime's own deadline: inside the watcher's by two beacon reads and a
 * write budget, so a reply that arrives in time is recorded whole rather than
 * cut off mid-write by the watcher's TERM. Never less than half the seat.
 */
export function runtimeDeadlineMs(timing: Config["timing"]): number {
  const seat = timing.seat_deadline_s * 1000;
  return Math.max(Math.floor(seat / 2), seat - 2 * timing.beacon_timeout_ms - RECORD_BUDGET_MS);
}
