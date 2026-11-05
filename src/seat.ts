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
import type {
  Citizen,
  Clock,
  Config,
  ExitCode,
  FetchLike,
  HaltReading,
  HaltStatus,
  Invoker,
  Outcome,
  RuntimeAdapter,
  RuntimeClass,
  SeatRef,
  SeatResult,
  YuPresence,
} from "./types.ts";
import type { Signer } from "./signer/signer.ts";

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
  readBeacons(): Promise<HaltReading[]>;
}

export interface SupervisedResult {
  exit: ExitCode;
  outcome: Outcome;
  /** Which signal ended the child, if the watcher had to send one. */
  signal: "TERM" | "KILL" | null;
  /** "deadline", "file", or the beacon name that ended it. */
  stopped_by: string | null;
  child_exit: number | null;
  duration_ms: number;
}

/** Refuse a cwd that is inside, or equal to, any configured citizen home (after resolving symlinks). */
export function assertCwdOutsideHomes(cwd: string, homes: string[]): void {
  throw new Error("unimplemented");
}

/** Create the SeatRef and a fresh empty cwd under seats_dir for one citizen, runtime and invoker. */
export async function openSeat(config: Config, clock: Clock, citizen: Citizen, runtime: RuntimeClass, invoker: Invoker, presence: YuPresence | null): Promise<OpenSeat> {
  throw new Error("unimplemented");
}

/** Run argv in its own process group under the watcher; TERM the group on HALT or deadline, KILL after the grace. */
export async function superviseChild(opts: SuperviseOptions): Promise<SupervisedResult> {
  throw new Error("unimplemented");
}

/** The in-child pipeline for one open seat: HALT, context, prompt, runtime, validate, HALT again, sign, record. */
export async function runSeat(seat: OpenSeat, deps: SeatDeps): Promise<SeatResult> {
  throw new Error("unimplemented");
}

/** The child's environment: an explicit allowlist (PATH, HOME, LANG, TZ), never the parent's whole env. */
export function seatEnv(config: Config, parent: Record<string, string | undefined>): Record<string, string> {
  throw new Error("unimplemented");
}

/** Map a supervised child's end to the KS-003 exit registry: 0 for HALT rest, 124 deadline, 143 TERM, 137 KILL. */
export function exitFor(result: Pick<SupervisedResult, "signal" | "stopped_by" | "child_exit">): ExitCode {
  throw new Error("unimplemented");
}
