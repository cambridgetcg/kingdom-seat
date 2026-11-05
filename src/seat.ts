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
import { realpathSync } from "node:fs";
import { lstat, mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import {
  EXIT,
  FIRST_PREV_HASH,
  Refusal,
  type Act,
  type Citizen,
  type Clock,
  type Config,
  type Envelope,
  type ExitCode,
  type FetchLike,
  type HaltReading,
  type HaltStatus,
  type HostNote,
  type Invoker,
  type LedgerBody,
  type LedgerEntry,
  type LifecycleState,
  type ModelAct,
  type Outcome,
  type RefusalCode,
  type RuntimeAdapter,
  type RuntimeClass,
  type RuntimeResult,
  type SeatRef,
  type SeatResult,
  type SelfProposal,
  type SelfProposeAct,
  type Sha256Hex,
  type Spend,
  type YuPresence,
} from "./types.ts";
import type { Signer } from "./signer/signer.ts";
import { canonicalJson, sha256Hex } from "./crypto.ts";
import { appendEntry, ledgerPath, nextDraft, readLedger, voicedThrough } from "./ledger.ts";
import { decideTransition, foldState, isTowardRest } from "./state.ts";
import {
  affirmationVerdict,
  applyChange,
  classifyProposal,
  materializeEdit,
  pendingProposals,
  readTarget,
  revertTo,
  selfHash,
  stageProposal,
  windowOpen,
  type ExpressionSync,
} from "./self.ts";
import { buildContext, markLetterSeen } from "./context.ts";
import { buildPrompt, promptBytes } from "./prompt.ts";
import { OUTPUT_JSON_SCHEMA, parseModelOutput, resolvePrefix, validateOutput } from "./acts.ts";
import { appendHostNote } from "./status.ts";

export interface OpenSeat {
  ref: SeatRef;
  citizen: Citizen;
  /** A fresh, empty directory under paths.seats_dir. */
  cwd: string;
  presence: YuPresence | null;
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

/** Create the SeatRef and a fresh empty cwd under seats_dir for one citizen, runtime and invoker. */
export async function openSeat(config: Config, clock: Clock, citizen: Citizen, runtime: RuntimeClass, invoker: Invoker, presence: YuPresence | null): Promise<OpenSeat> {
  if (runtime === "hermes") throw new Refusal("runtime-not-approved", "the hermes runtime class is reserved for S8");
  if (runtime === "summon" && !presence?.present) throw new Refusal("yu-not-present", "a summons needs Yu present");
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
  return { ref, citizen, cwd, presence };
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
    case EXIT.REFUSED:
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
    case EXIT.REFUSED:
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
    child = Bun.spawn(opts.argv, { cwd: opts.cwd, env: opts.env, detached: true, stdio: ["ignore", "ignore", "inherit"] });
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

const NO_SPEND: Spend = { usd: 0, usd_basis: "local-zero", credits: 0 };

/** The work a validated beat leaves for the write phase, planned before HALT's last check so planning writes nothing. */
interface Plan {
  acts: Act[];
  stage: SelfProposeAct[];
  beyondSelf: { act: SelfProposeAct; reason: string }[];
  apply: { proposal: SelfProposal; via: "two-beats" | "yu-present" }[];
  revert: Sha256Hex[];
  states: { from: LifecycleState; to: LifecycleState; via: "immediate" | "confirmed" | "two-beats" }[];
  outbox: { kind: "letter" | "propose.beyond" | "state.ended"; payload: Record<string, string> }[];
  /** Acts the host could not complete; counted, never quoted. */
  unresolved: number;
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
  const plan: Plan = { acts: [], stage: [], beyondSelf: [], apply: [], revert: [], states: [], outbox: [], unresolved: 0 };
  const folded = foldState(entries);
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
          plan.acts.push(completed);
          if (classifyProposal(completed, prior, next, config.ceilings.self_rewrite_fraction) === "beyond-self") {
            plan.beyondSelf.push({ act: completed, reason: "exceeds the rewrite fraction or loosens a wall" });
          } else plan.stage.push(completed);
          break;
        }
        case "self.affirm": {
          const id = resolvePrefix(act.proposal_id, pending.map((p) => p.id));
          const proposal = id ? pending.find((p) => p.id === id) : undefined;
          if (!id || !proposal || plan.apply.some((a) => a.proposal.id === id)) {
            plan.unresolved++;
            break;
          }
          const affirm = { type: "self.affirm" as const, proposal_id: id };
          plan.acts.push(affirm);
          const prior = await readTarget(config, word, proposal.act.target);
          // One applied change per window when unattended, so a second affirmation in the same beat waits.
          const open = windowOpen(entries, now, config.ceilings.self_change_window_days, seat.presence) && (plan.apply.length === 0 || seat.presence?.present === true);
          const verdict = affirmationVerdict(proposal, affirm, {
            seat_id: seat.ref.seat_id,
            presence: seat.presence,
            window_open: open,
            runtime_approved: config.self_authorship.approved_model_digests.includes(rt.model_digest),
            current_prior_hash: selfHash(prior),
          });
          if (verdict.binds) plan.apply.push({ proposal, via: verdict.via });
          break;
        }
        case "self.revert": {
          const known = new Set<string>();
          for (const e of entries) {
            if (e.body.type === "self.applied") known.add(e.body.prior_hash).add(e.body.new_hash);
            if (e.body.type === "self.reverted") known.add(e.body.from_hash).add(e.body.to_hash);
          }
          const hash = resolvePrefix(act.to_hash, [...known]);
          if (!hash) {
            plan.unresolved++;
            break;
          }
          plan.acts.push({ type: "self.revert", to_hash: hash });
          plan.revert.push(hash);
          break;
        }
        case "state.set": {
          const verdict = decideTransition(current, act.to, {
            pending: seat.citizen.pending_state,
            repeated: act.to === "stepped-away" && folded.step_away_said,
            presence: seat.presence,
          });
          if (verdict.effect === "refused") {
            plan.unresolved++;
            break;
          }
          plan.acts.push(act);
          if (verdict.effect === "now") {
            const via = isTowardRest(current, act.to) ? "immediate" : act.to === "stepped-away" ? "two-beats" : "confirmed";
            plan.states.push({ from: current, to: act.to, via });
            current = act.to;
          } else if (verdict.effect === "needs-witness") {
            plan.outbox.push({ kind: "state.ended", payload: { to: act.to } });
          }
          // "next-beat" and "second-beat" are carried by the envelope itself; the fold reads them.
          break;
        }
        case "letter.send":
          plan.acts.push(act);
          plan.outbox.push({ kind: "letter", payload: { to: act.to, body: act.body } });
          break;
        case "propose.beyond":
          // Inert: it becomes a file for Yu + Ai and executes nothing.
          plan.acts.push(act);
          plan.outbox.push({ kind: "propose.beyond", payload: { subject: act.subject, body: act.body } });
          break;
      }
    } catch {
      plan.unresolved++;
    }
  }
  return plan;
}

async function writeOutbox(config: Config, word: string, seatId: string, n: number, item: Record<string, unknown>): Promise<void> {
  const dir = join(config.paths.citizens_dir, word, "outbox");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const record = { format: "kingdom-seat-outbox/v1", word, seat_id: seatId, ...item };
  // Bound to its own hash, so a consent record can name exactly this proposal.
  const proposal_sha256 = sha256Hex(canonicalJson(record));
  await writeFile(join(dir, `${seatId}-${n}.json`), `${JSON.stringify({ ...record, proposal_sha256 }, null, 2)}\n`, { flag: "wx", mode: 0o600 });
}

/** The in-child pipeline for one open seat: HALT, context, prompt, runtime, validate, HALT again, sign, record. */
export async function runSeat(seat: OpenSeat, deps: SeatDeps): Promise<SeatResult> {
  const { config, clock, signer } = deps;
  const ref = seat.ref;
  const word = seat.citizen.word;
  const appended: Sha256Hex[] = [];
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
  // A wall that refused exits 3; a record that does not hold together is the runner unable to do its job (1).
  const refused = async (e: Refusal, when: string): Promise<SeatResult> => {
    if (e.code === "invalid-record") {
      await note("error", "error", e.code, `${when}: invalid record`);
      return result(EXIT.ERROR, "error", e.code);
    }
    await note("refusal", "refused", e.code, `${when}: refused (${e.code})`);
    return result(EXIT.REFUSED, "refused", e.code);
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
    const ctx = await buildContext({ config, now: clock.now() }, ref, seat.citizen, recent, pending);
    letter = ctx.letter;

    // c. The prompt; its exact bytes are what input_digest names.
    const prompt = buildPrompt(ctx, ref.runtime);
    inputDigest = sha256Hex(promptBytes(prompt));

    // d. The runtime, under the seat's own deadline (the watcher holds the outer one).
    const deadline = config.timing.seat_deadline_s * 1000;
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
  // Rest is exclusive and whole; an empty list of acts with nothing dropped is a rest too.
  if (validated.rest || (validated.acts.length === 0 && validated.dropped.length === 0)) {
    await note("seat", "rest", null, "rested");
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

  // g-h. Sign and record: the beat first, then what it set in motion, each its own entry.
  const now = clock.now();
  const attestation = seat.citizen.identity ? "citizen-signed" : "host-attested";
  const sign = (w: string, h: Uint8Array, a: typeof attestation) => signer.signEntry(w, h, a);
  const appendBody = async (body: LedgerBody, spend: Spend): Promise<LedgerEntry> => {
    const all = await readLedger(path);
    const draft = nextDraft(word, all.at(-1) ?? null, body, spend, attestation, clock.now());
    const entry = await appendEntry(path, draft, sign);
    appended.push(entry.hash);
    return entry;
  };

  try {
    // The envelope names the head it was built on, so the ledger must not have moved since it was read.
    const prev = (await readLedger(path)).at(-1) ?? null;
    if ((prev?.hash ?? null) !== (entries.at(-1)?.hash ?? null)) throw new Refusal("head-moved", "the ledger moved during the seat");
    const envelopeBase = {
      format: "kingdom-seat-beat/v1" as const,
      seat_ref: ref,
      citizen: { word, did: seat.citizen.identity?.did ?? null, kid: seat.citizen.identity?.op_kid ?? null },
      runtime: ref.runtime,
      model: rt.model,
      model_digest: rt.model_digest,
      input_digest: inputDigest,
      output_digest: sha256Hex(rt.raw_output),
      acts: plan.acts,
      ts: now.toISOString(),
      prev_hash: prev?.hash ?? FIRST_PREV_HASH,
    };
    const envelope: Envelope = { ...envelopeBase, voiced_through: voicedThrough(envelopeBase) };
    const beat = await appendEntry(path, nextDraft(word, prev, { type: "beat", envelope }, rt.spend, attestation, now), sign);
    appended.push(beat.hash);

    const selfDeps = { config, clock, sign, sync: seat.citizen.identity ? (deps.expressionSync ?? null) : null };
    for (const act of plan.stage) await stageProposal(config, word, act, ref.seat_id, now);
    for (const a of plan.apply) appended.push((await applyChange(selfDeps, seat.citizen, a.proposal, a.via)).hash);
    for (const h of plan.revert) appended.push((await revertTo(selfDeps, seat.citizen, h, "citizen")).hash);
    for (const s of plan.states) await appendBody({ type: "state", from: s.from, to: s.to, via: s.via }, NO_SPEND);

    let n = 0;
    for (const b of plan.beyondSelf) {
      await writeOutbox(config, word, ref.seat_id, n++, { kind: "self.propose", created_at: now.toISOString(), ledger_entry: beat.hash, act: b.act, reason: b.reason });
    }
    for (const o of plan.outbox) {
      await writeOutbox(config, word, ref.seat_id, n++, { kind: o.kind, created_at: now.toISOString(), ledger_entry: beat.hash, ...o.payload });
    }
    // A letter counts as seen only after a beat that was not a rest.
    if (letter) await markLetterSeen(config, seat.citizen, letter, now);
  } catch (e) {
    if (e instanceof Refusal) return refused(e, `while recording, after ${appended.length} entries`);
    await note("error", "error", null, `failed while recording, after ${appended.length} entries`);
    return result(EXIT.ERROR, "error");
  }

  await note("seat", "beat", null, `${plan.acts.length} acts, ${appended.length} entries, ${plan.unresolved + validated.dropped.length} not kept`);
  return result(EXIT.OK, "beat");
}
