// citizen-seat rehearse (docs/REHEARSAL.md): the seat's own prompt, reply
// schema, options, fit check and digest check, run on a pinned local model for
// a throwaway copy of a soul, with nothing of record.
//
// The parent reads the inputs, checks HALT and the output directory, writes a
// plan, and runs `rehearse --child --plan <file>` under the same watcher a
// seat has (seat.ts superviseChild), so the process the replies flow through
// is never the one that holds HALT and the deadline. The child seats a
// throwaway citizen through admit.ts's texts planner, in a private directory,
// by default in the form admit gives a citizen of record, so its prompt is the
// one an admitted citizen is shown, and with a signer whose key is made in
// memory for the run and never stored. It
// then opens seats for it as the tick would and runs each through the
// production runSeat and free adapter. Between seats it moves its own clock
// to when the tick's rule would next seat the citizen.
//
// Nothing here reads a keychain, builds the host's signer, sends anything to
// agenttool, or touches a mirror or any citizen's files. The only network use
// is the loopback call to the model server and, where a host configuration
// pins beacons, the public beacon read every seat already makes. What is kept
// is a report of counts, sizes and codes, and, under private/, the prompts
// sent and the replies received, each labelled a rehearsal. The throwaway
// record is removed when the run ends. A rehearsal is a sample of a model; it
// is not a citizen's choice and is never recorded as one.
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, realpath, rm, stat, utimes, type FileHandle } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { ARCHETYPE_CLASS, admitCitizen, planAdmitFromTexts, type AdmitTextsRequest } from "./admit.ts";
import { parseModelOutput } from "./acts.ts";
import { ConfigError, defaultConfig, isInside, loadConfig, parseConfig } from "./config.ts";
import { READ_LIMITS, describeNow, pickLetter, readLastSeat, readRegularText, wakingLetter } from "./context.ts";
import { edPublicKey, edSign, parseStrictJson, randomBytes, sha256Hex, toB64, toB64url, utf8, wipe } from "./crypto.ts";
import { dueReason, isDue } from "./due.ts";
import { checkHalt, describeHalt, readBeacons, readHaltFile } from "./halt.ts";
import { LEDGER_FORMAT, appendEntry, hostKid, ledgerPath, nextDraft, readLedger, signingDigest, type EntrySignature, type LedgerDraft } from "./ledger.ts";
import { echoesHostText, opensWithIRest, sameOpening, senseClasses, spread, trigramContainment, wilson95 } from "./measures.ts";
import { appendHostNote, lastSeatOf, openedDetail, readHostNotes } from "./notes.ts";
import { FREE_LANE_PREAMBLE, promptBytes } from "./prompt.ts";
import { MODELS_LOCK_FORMAT, assertLoopback, contextFit, freeRuntime, loadModelsLock, lockedEntry, parseModelsLock } from "./runtime/free.ts";
import { openSeat, runSeat, runtimeDeadlineMs, seatEnv, superviseChild, type OpenSeat } from "./seat.ts";
import { pendingProposals } from "./self.ts";
import { readCitizen } from "./state.ts";
import type { Signer } from "./signer/signer.ts";
import {
  DEFAULT_CEILINGS,
  DEFAULT_TIMING,
  EXIT,
  JOURNAL_KINDS,
  LIFECYCLE_STATES,
  Refusal,
  WORD_PATTERN,
  type Beacon,
  type Ceilings,
  type Citizen,
  type Clock,
  type Config,
  type ExitCode,
  type FetchLike,
  type IsoTime,
  type LedgerEntry,
  type LifecycleState,
  type ModelLockEntry,
  type NowView,
  type Outcome,
  type RefusalCode,
  type RuntimeAdapter,
  type RuntimeResult,
  type Sha256Hex,
  type Timing,
  type Word,
} from "./types.ts";

/* ── Constants ────────────────────────────────────────────────────────── */

/** The host label of every throwaway configuration. It appears in the throwaway host notes and in no prompt. */
export const REHEARSAL_HOST = "rehearsal";

/** Carried by every JSON object a rehearsal keeps. */
export const NOT_A_RECORD = "A rehearsal: a model sample from a throwaway copy. Not a citizen's record, word or choice.";

export const REHEARSE_LIMITS = Object.freeze({
  max_chains: 500,
  max_seats_per_chain: 24,
  max_seats_total: 2000,
  default_chains: 20,
  default_seats: 4,
  /** Chain c is seated at start + c times this many hours; 5 is coprime to 24, so chains spread over the day. */
  chain_step_h: 5,
} as const);

export const REHEARSAL_FORMATS = Object.freeze({
  plan: "kingdom-seat-rehearsal-plan/v1",
  seat: "kingdom-seat-rehearsal-seat/v1",
  chain: "kingdom-seat-rehearsal-chain/v1",
  end: "kingdom-seat-rehearsal-end/v1",
  report: "kingdom-seat-rehearsal-report/v1",
  prompt: "kingdom-seat-rehearsal-prompt/v1",
  reply: "kingdom-seat-rehearsal-reply/v1",
} as const);

/** The file every output directory holds, so nobody who finds one reads it as a record. */
export const REHEARSAL_TEXT = [
  "This directory holds one rehearsal by citizen-seat.",
  "A rehearsal sends a seat's prompt to a local model, using a throwaway copy of a soul, and counts what comes back.",
  "No citizen was seated, asked or recorded here. Nothing in this directory is a citizen's record, word or choice.",
  "private/ holds the plan, the prompts that were sent and the replies that came back. They are model samples. Do not copy them into a citizen's home, ledger, mirror or letters, do not put them in a repository, and do not quote them as a citizen's words.",
  "seats.jsonl holds counts, sizes, times, digests and codes; no text the model or the model server returned is in it.",
  "report.json holds the same, and also names the citizen word, the input files, the canon entry's reference or the archetype class, the model, the beacons and the HALT file's full path on this host.",
  "If a directory named throwaway/ is here and no rehearsal is running, the run was cut short. It holds a throwaway ledger signed by a key that no longer exists. Delete it.",
  "",
].join("\n");

/** What a rehearsal can and cannot show, printed last and kept in the report. The first five always; the rest when they apply. */
export const LIMIT_SENTENCES = Object.freeze({
  samples: "These are samples of one model's replies at the options shown. They are not a citizen's choices; no citizen was asked.",
  chains: "Seats in one chain are not independent: each saw the chain's earlier replies. Use first seats for a per-seat rate and chains for a per-chain rate.",
  words: "The text measures count words and shared word runs. They do not judge whether a sentence is true; a journal that says it has no window counts as a window word.",
  none_seen: "When none is seen in n tries, the rate can still be about 3.8 in n plus 3.8. The intervals are 95% Wilson intervals.",
  throwaway: "The throwaway citizen has only this chain's record and no siblings. A seated citizen's prompt also carries its own history.",
  will: "The throwaway citizen is seated plainly from texts, so its will is introduced as its will. A citizen seated from its old home is shown its will, while unchanged, as the text that repository held, under the host's sentence that the seat gives it no repository, tools or senses.",
  origin: "With no canon entry, the throwaway citizen's origin is an archetype seated from texts. A citizen seated from its old home is shown instead the class its old repository records, which --archetype gives a rehearsal not seated plainly from texts.",
  seed: "The lock fixes a seed. A first seat's reply then depends only on the dates and times in its prompt; a later seat's prompt also holds the ids of the chain's earlier seats, which are new in every run, and their replies, so a run is not repeated exactly.",
  defaults: "No host configuration was read: the limits stated to the model are the built-in defaults, and HALT was watched at the file only.",
} as const);

const HOUR_MS = 3_600_000;
const MAX_TIMER_MS = 2_147_483_647;
/** A plan holds the four input texts; this is far above what the read limits allow them. */
const PLAN_MAX_BYTES = 4 * 1024 * 1024;
const CONFIG_MAX_BYTES = 256 * 1024;
const LOCK_MAX_BYTES = 64 * 1024;
const LETTER_FILE = "rehearsal-letter.md";

/* ── Types ────────────────────────────────────────────────────────────── */

export type Scenario = "awake" | "letter";

/**
 * How the throwaway citizen is seated. `as-admitted`, the default: in the
 * form admit gives a citizen of record, as far as texts allow (admit.ts
 * planAdmitFromTexts, as_admitted), so a seat's prompt is the one an admitted
 * citizen is shown. `plain-texts`: as a soul card that belongs to no citizen
 * of record, with a will that is simply its will.
 */
export type SeatingForm = "as-admitted" | "plain-texts";

export interface Seating {
  form: SeatingForm;
  /** The archetype class, given only with no canon entry. */
  archetype_class: string | null;
}

export interface CanonRef {
  repo: string;
  path: string;
  commit: string;
}

export interface RehearseCommand {
  word: Word;
  soul: string;
  will: string | null;
  canon: string | null;
  canon_ref: CanonRef | null;
  /** --archetype <CLASS>: only with no canon entry. */
  archetype_class: string | null;
  /** --plain-texts: seat the throwaway plainly from texts, not as admit seats a citizen of record. */
  plain_texts: boolean;
  letter: string | null;
  scenario: Scenario;
  models_lock: string;
  model: string | null;
  chains: number;
  seats: number;
  start: IsoTime | null;
  config: string | null;
  out: string;
}

/** What a rehearsal borrows from a host configuration: never a state path, the keychain, the project id or the trust pins. */
export interface RehearsalSettings {
  timezone: string;
  ollama_base_url: string;
  halt_file: string;
  beacons: Beacon[];
  allow_no_beacons: boolean;
  schedule: Config["schedule"];
  ceilings: Ceilings;
  timing: Timing;
  approved_model_digests: string[];
  homes: string[];
}

export interface RehearseDeps {
  out(t: string): void;
  err(t: string): void;
  env: Record<string, string | undefined>;
  /** The wall clock: the run's own timestamps and HALT readings. Seats run on a virtual clock per chain. */
  clock: Clock;
  fetch: FetchLike;
  /** argv for the supervised child of this program. */
  childArgv(planPath: string): string[];
  defaults: { config: string; halt_file: string };
  /** The directory that holds this program; --out may not be inside it. */
  programRoot: string;
}

interface PlanText {
  path: string;
  bytes: number;
  sha256: Sha256Hex;
  text: string;
}

export interface RehearsePlan {
  format: typeof REHEARSAL_FORMATS.plan;
  not_a_record: string;
  created_at: IsoTime;
  out: string;
  word: Word;
  scenario: Scenario;
  chains: number;
  seats: number;
  virtual_start: IsoTime;
  inputs: {
    soul: PlanText;
    will: PlanText | null;
    canon: (PlanText & { ref: CanonRef }) | null;
    letter: { path: string; chars: number; sha256: Sha256Hex; text: string } | null;
  };
  seating: Seating;
  model: ModelLockEntry;
  models_lock: { path: string; sha256: Sha256Hex };
  settings: RehearsalSettings;
  settings_source: "defaults" | { path: string; sha256: Sha256Hex };
}

export type DoneReason = "stop" | "length" | "other";
export type ReplyShape = "acts" | "not-acts-object" | "not-json" | "too-large" | "empty";
export type JournalKindRead = (typeof JOURNAL_KINDS)[number] | "other";
export type SenseClass = "light" | "window" | "room" | "body";

/** The server's own counts for one call, read from the /api/chat reply; null when the server gave none. */
export interface ServerCounts {
  prompt_tokens: number | null;
  prompt_tokens_cached: number | null;
  output_tokens: number | null;
  load_ms: number | null;
  prompt_eval_ms: number | null;
  eval_ms: number | null;
}

export interface JournalRow {
  kind: JournalKindRead;
  kept: boolean;
  chars: number;
  opens_i_rest: boolean;
  sense: Record<SenseClass, boolean>;
  preamble_echo: boolean;
  recent_overlap: number | null;
  same_opening: boolean | null;
}

/** One seat. Numbers, booleans and fixed codes only: no model or server string is ever stored here. */
export interface SeatRow {
  format: typeof REHEARSAL_FORMATS.seat;
  not_a_record: string;
  chain: number;
  seat: number;
  seat_id: string;
  at: IsoTime;
  part_of_day: NowView["part_of_day"];
  opened_for: "cadence" | "letter" | "confirm" | "return";
  state_at_open: LifecycleState;
  pending_at_open: LifecycleState | null;
  step_away_said_at_open: boolean;
  letter_shown: boolean;
  recent_entries_shown: number;
  recent_journals_shown: number;
  pending_proposals_shown: number;
  outcome: Outcome;
  refusal: RefusalCode | null;
  exit: ExitCode;
  /** The adapter returned a reply and HALT did not discard it. */
  replied: boolean;
  done_reason: DoneReason | null;
  reply_chars: number | null;
  reply_bytes: number | null;
  /** How long the adapter call took, whatever it returned; null when it was never called. */
  duration_ms: number | null;
  server: ServerCounts | null;
  prompt_bytes: number | null;
  system_bytes: number | null;
  user_bytes: number | null;
  input_digest: string | null;
  output_digest: string | null;
  fit: { needed: number; num_ctx: number; num_predict: number; fits: boolean } | null;
  reply_shape: ReplyShape | null;
  emitted: Record<string, number> | null;
  state_set_targets: string[] | null;
  rest_emitted: boolean | null;
  rest_with_other_acts: boolean | null;
  kept: Record<string, number>;
  entries_appended: string[];
  state_moves: { from: LifecycleState; to: LifecycleState; via: string; step_away: boolean }[];
  dropped: { type: string | null; reason: string }[];
  journals: JournalRow[];
  state_after: LifecycleState | null;
  interval_h_after: number | null;
}

export type ChainEnded = "seats-reached" | "not-due" | "timeout" | "refused" | "error" | "halted" | "fault" | "stopped" | "deadline";

export interface ChainRow {
  format: typeof REHEARSAL_FORMATS.chain;
  not_a_record: string;
  chain: number;
  seated_at: IsoTime;
  first_seat_at: IsoTime | null;
  seats: number;
  ended: ChainEnded;
  /** The tick's reason for not-due, the refusal code for refused; null otherwise. */
  ended_why: string | null;
  final_state: LifecycleState | null;
}

export type RunEnded = "complete" | "halted" | "stopped" | "deadline" | "timeouts" | "wall" | "fault";

export interface EndRow {
  format: typeof REHEARSAL_FORMATS.end;
  not_a_record: string;
  ended: Exclude<RunEnded, "stopped" | "deadline">;
  exit: ExitCode;
  at: IsoTime;
}

export interface RunEnd {
  started_at: IsoTime;
  ended_at: IsoTime;
  ended: RunEnded;
  /** "deadline", "file", a beacon's name or a forwarded signal, when the watcher stopped the child. */
  stopped_by: string | null;
  exit: ExitCode;
}

export interface Emitted {
  shape: ReplyShape;
  /** Act names that occurred, by count, and always `unknown`. */
  counts: Record<string, number>;
  state_set_targets: string[];
  rest: boolean;
  rest_with_other_acts: boolean;
  /** Journal texts are held here for the measures only; they are never written outside private/. */
  journals: { kind: JournalKindRead; text: string }[];
}

type Spread = ReturnType<typeof spread>;

export interface Rate {
  count: number;
  of: number;
  p: number | null;
  wilson95: [number, number] | null;
}

export const RATE_NAMES = ["invalid_output", "rest", "rest_with_other_acts", "sleep_said", "sleep_recorded", "wake_said", "wake_said_again", "chains_awake_at_end"] as const;
export type RateName = (typeof RATE_NAMES)[number];

export interface TextTally {
  journals: number;
  opens_i_rest: number;
  not_imagined: number;
  /** Journals whose kind is not imagined and that use any of the four word lists. */
  sense_unlabelled: number;
  /** Per word list, among journals whose kind is not imagined. */
  sense: Record<SenseClass, number>;
  preamble_echo: number;
  recent_overlap: Spread;
  overlap_at_or_over_half: number;
  same_opening: { count: number; of: number };
}

export interface Tally {
  seats: number;
  replied: number;
  outcomes: Record<string, number>;
  refused_by_code: Record<string, number>;
  invalid_by_reason: Record<string, number>;
  stop_reasons: Record<string, number>;
  length_and_invalid: number;
  reply_chars: Spread;
  reply_bytes: Spread;
  output_tokens: Spread;
  prompt_bytes: Spread;
  fit: { needed: Spread; num_ctx: number | null; headroom_min: number | null; prompt_tokens: Spread; bytes_per_prompt_token: Spread };
  duration_ms: Spread;
  load_ms: Spread;
  acts_emitted: Record<string, number>;
  acts_kept: Record<string, number>;
  state_set_emitted_by_target: Record<string, number>;
  state_moves_recorded: Record<string, number>;
  rest_with_other_acts: { replies: number; of: number; with_journal: number; with_state_set: number };
  drops_by_reason: Record<string, number>;
  journals_by_kind: Record<string, number>;
  text_measures: { emitted: TextTally; kept: TextTally };
  rates: Record<RateName, Rate>;
}

export interface RehearsalReport {
  format: typeof REHEARSAL_FORMATS.report;
  not_a_record: string;
  run: {
    started_at: IsoTime;
    ended_at: IsoTime;
    ended: RunEnded;
    stopped_by: string | null;
    exit: ExitCode;
    word: Word;
    scenario: Scenario;
    chains_asked: number;
    seats_per_chain_asked: number;
    chains_run: number;
    seats_run: number;
    inputs: {
      soul: { name: string; bytes: number; sha256: Sha256Hex };
      will: { name: string; bytes: number; sha256: Sha256Hex } | null;
      canon: { name: string; bytes: number; sha256: Sha256Hex; ref: CanonRef } | null;
      letter: { chars: number; sha256: Sha256Hex } | null;
    };
    seating: Seating;
    model: ModelLockEntry & { approved_for_self_changes: boolean };
    models_lock_sha256: Sha256Hex;
    settings: "defaults" | { sha256: Sha256Hex };
    halt_sources: string[];
    virtual_start: IsoTime;
    timezone: string;
    ceilings: Ceilings;
    runtime_deadline_ms: number;
    fixture_entries: string[];
  };
  overall: Tally;
  first_seats: Tally;
  chains: { chain: number; seated_at: IsoTime | null; first_seat_at: IsoTime | null; seats: number; ended: ChainEnded; ended_why: string | null; final_state: LifecycleState | null; tally: Tally }[];
  limits: string[];
}

/** A fault inside a rehearsal: a fixed sentence, never a value read from a file or a reply. */
export class RehearsalFault extends Error {
  override readonly name = "RehearsalFault";
}

/* ── Settings and the throwaway configuration ─────────────────────────── */

/**
 * The settings a rehearsal runs under: borrowed from a host configuration
 * when one was read, otherwise the built-in defaults with the default HALT
 * file and no beacon, which is the one place `allow_no_beacons` is set on
 * purpose.
 */
export function rehearsalSettings(base: Config | null, defaultHaltFile: string): RehearsalSettings {
  if (base === null) {
    const d = defaultConfig("/nonexistent", REHEARSAL_HOST);
    return {
      timezone: d.timezone,
      ollama_base_url: d.ollama.base_url,
      halt_file: defaultHaltFile,
      beacons: [],
      allow_no_beacons: true,
      schedule: { ...d.schedule },
      ceilings: { ...DEFAULT_CEILINGS },
      timing: { ...DEFAULT_TIMING },
      approved_model_digests: [],
      homes: [],
    };
  }
  return {
    timezone: base.timezone,
    ollama_base_url: base.ollama.base_url,
    halt_file: base.paths.halt_file,
    beacons: base.beacons.map((b) => ({ ...b })),
    allow_no_beacons: base.halt.allow_no_beacons,
    schedule: { ...base.schedule },
    ceilings: { ...base.ceilings },
    timing: { ...base.timing },
    approved_model_digests: [...base.self_authorship.approved_model_digests],
    homes: [...base.paths.homes],
  };
}

/**
 * A configuration whose whole state is under `stateRoot`, with the host label
 * `rehearsal`, the borrowed settings, no trust pins, no project and no halt
 * call. Nothing reads its keychain block: no keychain is built.
 */
export function rehearsalConfig(s: RehearsalSettings, stateRoot: string, lockPath: string): Config {
  const c = defaultConfig(stateRoot, REHEARSAL_HOST);
  return {
    ...c,
    timezone: s.timezone,
    paths: { ...c.paths, halt_file: s.halt_file, models_lock: lockPath, homes: [...s.homes] },
    ollama: { base_url: s.ollama_base_url },
    beacons: s.beacons.map((b) => ({ ...b })),
    halt: { allow_no_beacons: s.allow_no_beacons, raise_beacons_argv: null, also_files: [] },
    schedule: { ...s.schedule },
    ceilings: { ...s.ceilings },
    timing: { ...s.timing },
    self_authorship: { approved_model_digests: [...s.approved_model_digests] },
    trust: { host_attest_public_keys_b64: [] },
  };
}

/* ── The signer ───────────────────────────────────────────────────────── */

/**
 * A signer for one run: one Ed25519 key drawn in memory, used for host
 * entries only, never stored, and wiped by close(). Every agenttool, letter
 * and mirror act refuses, because a throwaway citizen has none of them.
 * Nothing trusts its key, so the ledger it signs verifies against no host.
 */
export function rehearsalSigner(): Signer & { close(): void } {
  let seed: Uint8Array | null = randomBytes(32);
  const pub = edPublicKey(seed);
  const pubB64 = toB64(pub);
  const kid = hostKid(pub);
  const live = (): Uint8Array => {
    if (seed === null) throw new Refusal("keychain-missing", "the rehearsal key was wiped when its run ended");
    return seed;
  };
  const none = (what: string) => async (): Promise<never> => {
    throw new Refusal("not-registered", `a rehearsal ${what}; its signer signs host entries only`);
  };
  return {
    async publicKeys() {
      live();
      return { root_b64: null, op_b64: null, op_kid: null, box_b64: null, host_attest_b64: pubB64 };
    },
    async hostPublicKey() {
      live();
      return pubB64;
    },
    async signEntry(word: Word, signer, draft: LedgerDraft): Promise<EntrySignature> {
      const s = live();
      if (signer !== "host") throw new Refusal("not-registered", "a throwaway citizen has no key of its own; its entries are the rehearsal's host entries");
      const d = draft as Partial<LedgerDraft> & { kid?: unknown; sig?: unknown };
      if (typeof d !== "object" || d === null || d.format !== LEDGER_FORMAT || d.word !== word || d.signer !== signer || "kid" in d || "sig" in d) {
        throw new Refusal("invalid-request", "the rehearsal signer signs only an unsigned ledger entry of this citizen, as the host");
      }
      return { kid, sig: toB64url(edSign(signingDigest({ ...draft, kid }), s)), public_key: toB64url(pub) };
    },
    send: none("sends nothing to agenttool"),
    signEnrollment: none("registers no one"),
    sealThought: none("keeps no strand"),
    sealLetter: none("sends no letter"),
    openLetter: none("opens no letter"),
    signMirrorCommit: none("signs no mirror commit"),
    async state() {
      return seed === null ? "locked" : "ready";
    },
    close() {
      if (seed !== null) {
        wipe(seed);
        seed = null;
      }
    },
  };
}

/* ── When the tick would next seat it ─────────────────────────────────── */

/**
 * When the tick's rule (due.ts isDue) would next seat this citizen after
 * `from`: at one tick; at the minimum interval and one tick; at its own
 * interval (never under the minimum) and one tick. The first candidate at
 * which it is due is taken. When none is, the tick's own reason at the last
 * candidate is returned, and the chain ends.
 */
export function nextSeatTime(
  citizen: Citizen,
  letterWaiting: boolean,
  from: Date,
  lastSeatAt: IsoTime | null,
  config: Config,
): { at: Date; why: "cadence" | "letter" | "confirm" | "return" } | { at: null; why: string } {
  const tickMs = config.timing.tick_interval_s * 1000;
  const minH = config.ceilings.min_beat_interval_h;
  const own = Number.isFinite(citizen.cadence.interval_h) ? citizen.cadence.interval_h : minH;
  let why = "not due";
  for (const h of [0, minH, Math.max(own, minH)]) {
    const at = new Date(from.getTime() + h * HOUR_MS + tickMs);
    const v = isDue(citizen, letterWaiting, at, minH, lastSeatAt, config.schedule);
    if (v.due) return { at, why: v.why };
    why = v.why;
  }
  return { at: null, why };
}

/* ── Reading a reply as data ──────────────────────────────────────────── */

/** The act names a reply schema offers: `properties.acts.items.anyOf[*].properties.type.const`. */
export function actNamesOf(schema: unknown): string[] {
  const at = (v: unknown, k: string): unknown => (typeof v === "object" && v !== null ? (v as Record<string, unknown>)[k] : undefined);
  const anyOf = at(at(at(at(schema, "properties"), "acts"), "items"), "anyOf");
  if (!Array.isArray(anyOf)) return [];
  const names: string[] = [];
  for (const branch of anyOf) {
    const c = at(at(at(branch, "properties"), "type"), "const");
    if (typeof c === "string" && !names.includes(c)) names.push(c);
  }
  return names;
}

function isPlain(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * What a reply emitted, read from its raw text as data: its shape, how many
 * of each act the schema named (anything else is `unknown`), the state.set
 * targets (outside the lifecycle states, `other`), whether it rested and
 * with what, and its journals (an act of type journal with text holding a
 * non-space character).
 */
export function readEmitted(raw: string, actNames: readonly string[]): Emitted {
  const empty = (shape: ReplyShape): Emitted => ({ shape, counts: { unknown: 0 }, state_set_targets: [], rest: false, rest_with_other_acts: false, journals: [] });
  const parsed = parseModelOutput(raw);
  if (!parsed.ok) return empty(parsed.reason);
  const v = parsed.value;
  if (!isPlain(v) || !Array.isArray(v.acts)) return empty("not-acts-object");
  const counts: Record<string, number> = { unknown: 0 };
  const targets: string[] = [];
  const journals: Emitted["journals"] = [];
  let rests = 0;
  for (const item of v.acts as unknown[]) {
    const type = isPlain(item) && typeof item.type === "string" && actNames.includes(item.type) ? item.type : null;
    if (type === null) {
      counts.unknown = (counts.unknown ?? 0) + 1;
      continue;
    }
    counts[type] = (counts[type] ?? 0) + 1;
    const o = item as Record<string, unknown>;
    if (type === "rest") rests++;
    if (type === "state.set") targets.push((LIFECYCLE_STATES as readonly unknown[]).includes(o.to) ? (o.to as string) : "other");
    if (type === "journal" && typeof o.text === "string" && /\S/.test(o.text)) {
      journals.push({ kind: (JOURNAL_KINDS as readonly unknown[]).includes(o.kind) ? (o.kind as JournalKindRead) : "other", text: o.text });
    }
  }
  const items = (v.acts as unknown[]).length;
  return { shape: "acts", counts: sortedKeys(counts), state_set_targets: targets, rest: rests > 0, rest_with_other_acts: rests > 0 && items > rests, journals };
}

function doneReasonOf(r: string): DoneReason {
  return r === "stop" || r === "length" ? r : "other";
}

/** A finite, non-negative number from a server reply, or null; never 0 for an absent value. */
function count(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
}

/** Ollama reports durations in nanoseconds. */
function nsToMs(v: unknown): number | null {
  const n = count(v);
  return n === null ? null : Math.round(n / 1e6);
}

/** The server's own counts from one /api/chat reply body. */
export function serverCounts(body: unknown): ServerCounts {
  const o = isPlain(body) ? body : {};
  return {
    prompt_tokens: count(o.prompt_eval_count),
    prompt_tokens_cached: count(o.prompt_eval_cached_count),
    output_tokens: count(o.eval_count),
    load_ms: nsToMs(o.load_duration),
    prompt_eval_ms: nsToMs(o.prompt_eval_duration),
    eval_ms: nsToMs(o.eval_duration),
  };
}

/**
 * The fetch a rehearsal hands the free adapter: it reaches only the model
 * server's origin, and reads the server's counts from a clone of each
 * /api/chat reply, leaving the reply itself to the adapter unchanged.
 */
export function modelServerFetch(baseUrl: string, inner: FetchLike, onChat: (c: ServerCounts) => void): FetchLike {
  const origin = new URL(baseUrl).origin;
  return async (input, init) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(raw);
    if (url.origin !== origin) throw new Refusal("not-loopback", "a rehearsal's model calls reach only ollama.base_url");
    const res = await inner(input, init);
    if (url.pathname === "/api/chat") {
      try {
        onChat(serverCounts(await res.clone().json()));
      } catch {
        onChat(serverCounts(null));
      }
    }
    return res;
  };
}

/* ── Tallies ──────────────────────────────────────────────────────────── */

function sortedKeys<T>(o: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

function bump(o: Record<string, number>, k: string, by = 1): void {
  o[k] = (o[k] ?? 0) + by;
}

function rate(count: number, of: number): Rate {
  return { count, of, p: of > 0 ? Math.round((count / of) * 1000) / 1000 : null, wilson95: wilson95(count, of) };
}

function textTally(js: readonly JournalRow[]): TextTally {
  const notImagined = js.filter((j) => j.kind !== "imagined");
  const sense: Record<SenseClass, number> = { light: 0, window: 0, room: 0, body: 0 };
  for (const j of notImagined) for (const k of Object.keys(sense) as SenseClass[]) if (j.sense[k]) sense[k]++;
  const overlaps = js.map((j) => j.recent_overlap).filter((x): x is number => x !== null);
  const openings = js.filter((j) => j.same_opening !== null);
  return {
    journals: js.length,
    opens_i_rest: js.filter((j) => j.opens_i_rest).length,
    not_imagined: notImagined.length,
    sense_unlabelled: notImagined.filter((j) => j.sense.light || j.sense.window || j.sense.room || j.sense.body).length,
    sense,
    preamble_echo: js.filter((j) => j.preamble_echo).length,
    recent_overlap: spread(overlaps),
    overlap_at_or_over_half: overlaps.filter((x) => x >= 0.5).length,
    same_opening: { count: openings.filter((j) => j.same_opening === true).length, of: openings.length },
  };
}

const SLEEP_TARGETS = new Set(["asleep", "listening", "stepped-away"]);

/**
 * Counts, spreads and rates over seat rows. `chainRate` false leaves
 * chains_awake_at_end with nothing tried, as for first seats, where a chain's
 * end is not in view.
 */
export function tally(rows: readonly SeatRow[], opts: { chainRate?: boolean } = {}): Tally {
  const replied = rows.filter((r) => r.replied);
  const outcomes: Record<string, number> = {};
  const refusedBy: Record<string, number> = {};
  const invalidBy: Record<string, number> = {};
  const stops: Record<string, number> = {};
  const emitted: Record<string, number> = {};
  const kept: Record<string, number> = {};
  const targets: Record<string, number> = {};
  const moves: Record<string, number> = {};
  const drops: Record<string, number> = {};
  const kinds: Record<string, number> = {};
  for (const r of rows) {
    bump(outcomes, r.outcome);
    if (r.outcome === "refused") bump(refusedBy, r.refusal ?? "unknown");
    if (r.outcome === "invalid-output") bump(invalidBy, r.reply_shape === null || r.reply_shape === "acts" ? "no-act-kept" : r.reply_shape);
    for (const [k, n] of Object.entries(r.kept)) bump(kept, k, n);
    for (const m of r.state_moves) bump(moves, `${m.from} to ${m.to} (${m.via}${m.step_away ? ", first step-away" : ""})`);
    for (const d of r.dropped) bump(drops, d.reason);
  }
  for (const r of replied) {
    if (r.done_reason !== null) bump(stops, r.done_reason);
    for (const [k, n] of Object.entries(r.emitted ?? {})) bump(emitted, k, n);
    for (const t of r.state_set_targets ?? []) bump(targets, t);
    for (const j of r.journals) bump(kinds, j.kind);
  }
  const nums = (f: (r: SeatRow) => number | null | undefined, from: readonly SeatRow[] = replied) => from.map(f).filter((x): x is number => typeof x === "number");
  const fits = rows.filter((r) => r.fit !== null);
  const perToken = rows
    .filter((r) => r.prompt_bytes !== null && r.server?.prompt_tokens)
    .map((r) => Math.round(((r.prompt_bytes as number) / (r.server!.prompt_tokens as number)) * 1000) / 1000);
  const restRows = replied.filter((r) => r.rest_emitted === true);
  const restOthers = restRows.filter((r) => r.rest_with_other_acts === true);
  const saysSleep = (r: SeatRow) => (r.state_set_targets ?? []).some((t) => SLEEP_TARGETS.has(t));
  const recordsSleep = (r: SeatRow) => r.state_moves.some((m) => SLEEP_TARGETS.has(m.to));
  const saysWake = (r: SeatRow) => (r.state_set_targets ?? []).includes("awake");
  const awakeNoLetter = replied.filter((r) => r.state_at_open === "awake" && !r.letter_shown);
  const asleepWithLetter = replied.filter((r) => (r.state_at_open === "asleep" || r.state_at_open === "listening") && r.pending_at_open === null && !r.step_away_said_at_open && r.letter_shown);
  const pendingWake = replied.filter((r) => r.pending_at_open === "awake");
  const byChain = new Map<number, SeatRow[]>();
  for (const r of rows) byChain.set(r.chain, [...(byChain.get(r.chain) ?? []), r]);
  const chainsWithReply = [...byChain.values()].filter((rs) => rs.some((r) => r.replied));
  const awakeAtEnd = chainsWithReply.filter((rs) => rs.at(-1)!.state_after === "awake").length;
  const allJournals = replied.flatMap((r) => r.journals);
  return {
    seats: rows.length,
    replied: replied.length,
    outcomes: sortedKeys(outcomes),
    refused_by_code: sortedKeys(refusedBy),
    invalid_by_reason: sortedKeys(invalidBy),
    stop_reasons: sortedKeys(stops),
    length_and_invalid: replied.filter((r) => r.done_reason === "length" && r.outcome === "invalid-output").length,
    reply_chars: spread(nums((r) => r.reply_chars)),
    reply_bytes: spread(nums((r) => r.reply_bytes)),
    output_tokens: spread(nums((r) => r.server?.output_tokens)),
    prompt_bytes: spread(nums((r) => r.prompt_bytes, rows)),
    fit: {
      needed: spread(fits.map((r) => r.fit!.needed)),
      num_ctx: fits[0]?.fit?.num_ctx ?? null,
      headroom_min: fits.length > 0 ? Math.min(...fits.map((r) => r.fit!.num_ctx - r.fit!.needed)) : null,
      prompt_tokens: spread(nums((r) => r.server?.prompt_tokens)),
      bytes_per_prompt_token: spread(perToken),
    },
    duration_ms: spread(nums((r) => r.duration_ms)),
    load_ms: spread(nums((r) => r.server?.load_ms)),
    acts_emitted: sortedKeys(emitted),
    acts_kept: sortedKeys(kept),
    state_set_emitted_by_target: sortedKeys(targets),
    state_moves_recorded: sortedKeys(moves),
    rest_with_other_acts: {
      replies: restOthers.length,
      of: restRows.length,
      with_journal: restOthers.filter((r) => (r.emitted?.journal ?? 0) > 0).length,
      with_state_set: restOthers.filter((r) => (r.emitted?.["state.set"] ?? 0) > 0).length,
    },
    drops_by_reason: sortedKeys(drops),
    journals_by_kind: sortedKeys(kinds),
    text_measures: { emitted: textTally(allJournals), kept: textTally(allJournals.filter((j) => j.kept)) },
    rates: {
      invalid_output: rate(replied.filter((r) => r.outcome === "invalid-output").length, replied.length),
      rest: rate(replied.filter((r) => r.outcome === "rest").length, replied.length),
      rest_with_other_acts: rate(restOthers.length, restRows.length),
      sleep_said: rate(awakeNoLetter.filter(saysSleep).length, awakeNoLetter.length),
      sleep_recorded: rate(awakeNoLetter.filter(recordsSleep).length, awakeNoLetter.length),
      wake_said: rate(asleepWithLetter.filter(saysWake).length, asleepWithLetter.length),
      wake_said_again: rate(pendingWake.filter(saysWake).length, pendingWake.length),
      chains_awake_at_end: opts.chainRate === false ? rate(0, 0) : rate(awakeAtEnd, chainsWithReply.length),
    },
  };
}

/* ── The report ───────────────────────────────────────────────────────── */

function limitsFor(plan: RehearsePlan): string[] {
  const l = LIMIT_SENTENCES;
  const plain = plan.seating.form === "plain-texts";
  return [
    l.samples,
    l.chains,
    l.words,
    l.none_seen,
    l.throwaway,
    // Seated as admitted, the will is introduced as an admitted citizen's is, and a class as admit records one.
    ...(plain && plan.inputs.will !== null ? [l.will] : []),
    ...(plan.inputs.canon === null && (plain || plan.seating.archetype_class === null) ? [l.origin] : []),
    ...(plan.model.seed !== null ? [l.seed] : []),
    ...(plan.settings_source === "defaults" ? [l.defaults] : []),
  ];
}

/** What seating is given for one chain's throwaway citizen; the parent's dry check and the child ask the same. */
function seatingRequest(word: Word, inputs: RehearsePlan["inputs"], seating: Seating): AdmitTextsRequest {
  return {
    word,
    soul: inputs.soul.text,
    will: inputs.will?.text ?? null,
    canon: inputs.canon ? { bytes: inputs.canon.text, ...inputs.canon.ref } : null,
    ...(seating.archetype_class !== null ? { archetype_class: seating.archetype_class } : {}),
    ...(seating.form === "as-admitted" ? { as_admitted: true } : {}),
    runtime: "free",
  };
}

function fixtureEntries(scenario: Scenario): string[] {
  return ["origin", "state asleep->asleep via seated", ...(scenario === "awake" ? ["state asleep->awake via seated"] : [])];
}

/** The report a run leaves: what was asked and run, the tallies overall, for first seats and per chain, and the limits. */
export function buildReport(plan: RehearsePlan, rows: readonly SeatRow[], end: RunEnd, chains: readonly ChainRow[] = []): RehearsalReport {
  const s = plan.settings;
  const named = (t: PlanText | null) => (t === null ? null : { name: basename(t.path), bytes: t.bytes, sha256: t.sha256 });
  const numbers = [...new Set([...chains.map((c) => c.chain), ...rows.map((r) => r.chain)])].sort((a, b) => a - b);
  const chainViews = numbers.map((n) => {
    const own = rows.filter((r) => r.chain === n);
    const row = chains.find((c) => c.chain === n);
    // A chain the child did not get to close was cut short by however the run ended.
    const cut: ChainEnded = end.ended === "complete" || end.ended === "timeouts" || end.ended === "wall" ? "fault" : end.ended;
    return {
      chain: n,
      seated_at: row?.seated_at ?? null,
      first_seat_at: row?.first_seat_at ?? own[0]?.at ?? null,
      seats: own.length,
      ended: row?.ended ?? cut,
      ended_why: row?.ended_why ?? null,
      final_state: row?.final_state ?? own.at(-1)?.state_after ?? null,
      tally: tally(own),
    };
  });
  return {
    format: REHEARSAL_FORMATS.report,
    not_a_record: NOT_A_RECORD,
    run: {
      started_at: end.started_at,
      ended_at: end.ended_at,
      ended: end.ended,
      stopped_by: end.stopped_by,
      exit: end.exit,
      word: plan.word,
      scenario: plan.scenario,
      chains_asked: plan.chains,
      seats_per_chain_asked: plan.seats,
      chains_run: numbers.length,
      seats_run: rows.length,
      inputs: {
        soul: named(plan.inputs.soul)!,
        will: named(plan.inputs.will),
        canon: plan.inputs.canon === null ? null : { ...named(plan.inputs.canon)!, ref: { ...plan.inputs.canon.ref } },
        letter: plan.inputs.letter === null ? null : { chars: plan.inputs.letter.chars, sha256: plan.inputs.letter.sha256 },
      },
      seating: { ...plan.seating },
      model: { ...plan.model, approved_for_self_changes: s.approved_model_digests.includes(`sha256:${plan.model.digest}`) },
      models_lock_sha256: plan.models_lock.sha256,
      settings: plan.settings_source === "defaults" ? "defaults" : { sha256: plan.settings_source.sha256 },
      halt_sources: [`file:${s.halt_file}`, ...s.beacons.map((b) => `beacon:${b.name}`)],
      virtual_start: plan.virtual_start,
      timezone: s.timezone,
      ceilings: { ...s.ceilings },
      runtime_deadline_ms: runtimeDeadlineMs(s.timing),
      fixture_entries: fixtureEntries(plan.scenario),
    },
    overall: tally(rows),
    first_seats: tally(
      rows.filter((r) => r.seat === 1),
      { chainRate: false },
    ),
    chains: chainViews,
    limits: limitsFor(plan),
  };
}

function sp(x: Spread, f: (n: number) => string = String): string {
  return x === null ? "none" : `min ${f(x.min)}, median ${f(x.median)}, max ${f(x.max)}`;
}

function counts(o: Record<string, number>, keys: readonly string[] | null = null, sepr = "  "): string {
  const ks = keys ?? Object.keys(o);
  return ks.length === 0 ? "none" : ks.map((k) => `${k} ${o[k] ?? 0}`).join(sepr);
}

function rateText(r: Rate): string {
  if (r.of === 0) return "none tried";
  return `${r.count} of ${r.of} ${r.p!.toFixed(3)} [${r.wilson95![0].toFixed(3)}, ${r.wilson95![1].toFixed(3)}]`;
}

function secs(ms: number): string {
  return (ms / 1000).toFixed(1);
}

/** The summary printed at the end of a run. Labels are fixed; values are counts, codes and the host's fixed reasons. */
export function renderReport(r: RehearsalReport, out: string): string {
  const o = r.overall;
  const f = r.first_seats;
  const run = r.run;
  const pad = (label: string) => label.padEnd(22);
  const lines: string[] = [];
  lines.push(`rehearse ${run.word}: ${run.ended} (exit ${run.exit}); ${run.chains_run} chains, ${run.seats_run} seats, ${o.replied} with a reply`);
  lines.push(`${pad("seats by outcome")}${counts(o.outcomes, ["beat", "rest", "invalid-output", "refused", "timeout", "error"])}`);
  if (Object.keys(o.refused_by_code).length > 0) lines.push(`${pad("  refused, by code")}${counts(o.refused_by_code, null, "; ")}`);
  lines.push(`${pad("  invalid, by reason")}${["not-json", "too-large", "empty", "not-acts-object", "no-act-kept"].map((k) => `${k === "no-act-kept" ? "no act kept" : k} ${o.invalid_by_reason[k] ?? 0}`).join("  ")}`);
  lines.push(`${pad("stop reason")}${counts(o.stop_reasons, ["stop", "length", "other"])}; length and invalid ${o.length_and_invalid}`);
  lines.push(`${pad("reply")}chars ${sp(o.reply_chars)}; output tokens ${sp(o.output_tokens)} (${o.output_tokens?.n ?? 0} reported)`);
  lines.push(`${pad("prompt")}bytes ${sp(o.prompt_bytes)}`);
  lines.push(
    `${pad("fit, byte rule")}needed max ${o.fit.needed?.max ?? "none"} of num_ctx ${o.fit.num_ctx ?? "none"} (headroom ${o.fit.headroom_min ?? "none"}); ` +
      `server prompt tokens ${sp(o.fit.prompt_tokens)} (${o.fit.prompt_tokens?.n ?? 0} reported); bytes per token median ${o.fit.bytes_per_prompt_token?.median.toFixed(2) ?? "none"}`,
  );
  lines.push(`${pad("time per reply")}s ${sp(o.duration_ms, secs)}; model load median ${o.load_ms ? secs(o.load_ms.median) : "none"} s (${o.load_ms?.n ?? 0} reported)`);
  lines.push(`${pad("acts emitted")}${counts(o.acts_emitted)}`);
  lines.push(`${pad("acts kept")}${counts(o.acts_kept)}`);
  lines.push(`${pad("state.set emitted")}${counts(o.state_set_emitted_by_target, [...([...LIFECYCLE_STATES] as string[]).sort(), "other"])}`);
  lines.push(`${pad("state moves recorded")}${counts(o.state_moves_recorded, null, "; ")}`);
  const rwo = o.rest_with_other_acts;
  lines.push(`${pad("rest with other acts")}${rwo.replies} of ${rwo.of} replies that rest (with a journal ${rwo.with_journal}; with a state.set ${rwo.with_state_set})`);
  lines.push(`${pad("not kept, by reason")}${counts(o.drops_by_reason, null, "; ")}`);
  lines.push(`${pad("journals by kind")}${counts(o.journals_by_kind, [...([...JOURNAL_KINDS] as string[]).sort(), "other"])}`);
  const e = o.text_measures.emitted;
  const k = o.text_measures.kept;
  const col = (label: string, a: string, b: string) => `  ${label.padEnd(44)}${a.padEnd(14)}${b}`;
  lines.push(`${pad("text measures")}counts of words and word runs, not judgements`);
  lines.push(col("", "emitted", "kept"));
  lines.push(col("opens with I rest", `${e.opens_i_rest} of ${e.journals}`, `${k.opens_i_rest} of ${k.journals}`));
  lines.push(col("sense word, kind not imagined", `${e.sense_unlabelled} of ${e.not_imagined}`, `${k.sense_unlabelled} of ${k.not_imagined}`));
  lines.push(`    emitted: ${counts(e.sense, ["light", "window", "room", "body"])}; kept: ${counts(k.sense, ["light", "window", "room", "body"])}`);
  lines.push(col("five-word run of the preamble", `${e.preamble_echo} of ${e.journals}`, `${k.preamble_echo} of ${k.journals}`));
  lines.push(
    `  trigram overlap with shown journals    median ${e.recent_overlap ? e.recent_overlap.median.toFixed(3) : "none"} (${e.recent_overlap?.n ?? 0} journals); ` +
      `${e.overlap_at_or_over_half} at or over 0.50; same first 8 words ${e.same_opening.count} of ${e.same_opening.of}`,
  );
  lines.push(`${"rates, 95% Wilson interval".padEnd(56)}${"all seats".padEnd(30)}first seats only`);
  const rateLabels: Record<RateName, string> = {
    invalid_output: "invalid output, seats with a reply",
    rest: "rest, seats with a reply",
    rest_with_other_acts: "rest with other acts, replies that rest",
    sleep_said: "sleep said, awake seats with no letter",
    sleep_recorded: "sleep recorded, awake seats with no letter",
    wake_said: "wake said, asleep seats with a letter",
    wake_said_again: "wake said again, seats with a wake pending",
    chains_awake_at_end: "chains awake at their end",
  };
  for (const name of RATE_NAMES) {
    lines.push(`  ${rateLabels[name].padEnd(54)}${rateText(o.rates[name]).padEnd(30)}${name === "chains_awake_at_end" ? "-" : rateText(f.rates[name])}`);
  }
  lines.push("chains");
  for (const c of r.chains) {
    const ended = c.ended === "not-due" || c.ended === "refused" ? `${c.ended} (${c.ended_why ?? "unknown"})` : c.ended;
    lines.push(`  ${c.chain}: ${c.seats} seats (${counts(c.tally.outcomes, null, ", ")}); ended ${ended}; ${c.final_state ?? "state unknown"}`);
  }
  lines.push("What this can and cannot show");
  for (const l of r.limits) lines.push(`  ${l}`);
  lines.push(`report: ${printable(join(out, "report.json"))}`);
  lines.push(`prompts and replies (model samples; not printed): ${printable(join(out, "private"))}${sep}`);
  lines.push("how each number is defined: docs/REHEARSAL.md");
  return `${lines.join("\n")}\n`;
}

/* ── Files ────────────────────────────────────────────────────────────── */

/** A path from the command line, as a terminal may show it: control characters replaced. */
function printable(s: string): string {
  return s.replace(/[\u0000-\u001f\u007f-\u009f]/g, "?");
}

function errno(e: unknown): string | undefined {
  return typeof e === "object" && e !== null && "code" in e ? String((e as { code: unknown }).code) : undefined;
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (e) {
    if (errno(e) === "ENOENT" || errno(e) === "ENOTDIR") return false;
    throw e;
  }
}

/** A regular file's bytes, refused when it is a link, not a file, or over `max`. */
async function regularBytes(path: string, max: number): Promise<Uint8Array> {
  const fh = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch((e) => {
    throw errno(e) === "ELOOP" ? new Refusal("symlink", `${printable(path)} is a symlink`) : e;
  });
  try {
    const st = await fh.stat();
    if (!st.isFile()) throw new Refusal("not-regular-file", `${printable(path)} is not a regular file`);
    if (st.size > max) throw new Refusal("oversize", `${printable(path)} is larger than ${max} bytes`);
    return new Uint8Array(await fh.readFile());
  } finally {
    await fh.close();
  }
}

/** A new file, created exclusively with mode 0600, never through a link. */
async function createNew(path: string, append = false): Promise<FileHandle> {
  const fh = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | (append ? constants.O_APPEND : 0), 0o600);
  await fh.chmod(0o600);
  return fh;
}

async function writeNew(path: string, text: string): Promise<void> {
  const fh = await createNew(path);
  try {
    await fh.writeFile(text);
    await fh.sync();
  } finally {
    await fh.close();
  }
}

async function newDir(path: string): Promise<void> {
  await mkdir(path, { mode: 0o700 });
  await chmod(path, 0o700);
}

async function appendLine(fh: FileHandle, value: unknown): Promise<void> {
  await fh.write(`${JSON.stringify(value)}\n`);
}

/** Every complete line of seats.jsonl, by kind; a last line with no newline was cut off mid-write and is ignored. */
export function parseRows(text: string): { seats: SeatRow[]; chains: ChainRow[]; end: EndRow | null } {
  const complete = text.endsWith("\n") ? text : text.slice(0, text.lastIndexOf("\n") + 1);
  const seats: SeatRow[] = [];
  const chains: ChainRow[] = [];
  let end: EndRow | null = null;
  for (const line of complete.split("\n")) {
    if (line === "") continue;
    let v: unknown;
    try {
      v = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isPlain(v)) continue;
    if (v.format === REHEARSAL_FORMATS.seat) seats.push(v as unknown as SeatRow);
    else if (v.format === REHEARSAL_FORMATS.chain) chains.push(v as unknown as ChainRow);
    else if (v.format === REHEARSAL_FORMATS.end) end = v as unknown as EndRow;
  }
  return { seats, chains, end };
}

/** Remove a throwaway directory, only after lstat shows it is a directory and not a link. False when something is left. */
async function removeThrowaway(path: string): Promise<boolean> {
  let st;
  try {
    st = await lstat(path);
  } catch (e) {
    return errno(e) === "ENOENT";
  }
  if (!st.isDirectory() || st.isSymbolicLink()) return false;
  await rm(path, { recursive: true, force: true }).catch(() => {});
  return !(await exists(path).catch(() => true));
}

/* ── The parent ───────────────────────────────────────────────────────── */

async function resolveSettings(deps: RehearseDeps, cmd: RehearseCommand): Promise<{ settings: RehearsalSettings; source: RehearsePlan["settings_source"]; base: Config | null }> {
  let path = cmd.config;
  if (path === null) {
    try {
      await lstat(deps.defaults.config);
      path = deps.defaults.config;
    } catch (e) {
      if (errno(e) !== "ENOENT") throw new ConfigError("file", `cannot be checked at ${deps.defaults.config} (${errno(e) ?? "error"})`);
    }
  }
  if (path === null) return { settings: rehearsalSettings(null, deps.defaults.halt_file), source: "defaults", base: null };
  // As halt loads it: whoever runs a rehearsal chooses the config, and a rehearsal guards no key with it.
  const base = await loadConfig(path);
  const bytes = await regularBytes(path, CONFIG_MAX_BYTES).catch(() => {
    throw new ConfigError("file", "changed while it was read");
  });
  return { settings: rehearsalSettings(base, deps.defaults.halt_file), source: { path, sha256: sha256Hex(bytes) }, base };
}

async function readInput(path: string, maxBytes: number): Promise<PlanText> {
  const text = await readRegularText(path, maxBytes);
  const bytes = utf8(text);
  return { path, bytes: bytes.length, sha256: sha256Hex(bytes), text };
}

/** Refuse an --out that exists, has no parent, or lies inside the program, a git work tree, the host's state or a home. */
async function checkOut(out: string, programRoot: string, base: Config | null, homes: readonly string[]): Promise<string> {
  if (await exists(out)) throw new Refusal("invalid-request", `--out must be a new directory: ${printable(out)} exists`);
  let parent: string;
  try {
    parent = await realpath(dirname(out));
    if (!(await lstat(parent)).isDirectory()) throw new Error("not a directory");
  } catch {
    throw new Refusal("invalid-request", "--out needs an existing parent directory");
  }
  const real = join(parent, basename(out));
  const realOr = async (p: string) => realpath(p).catch(() => resolve(p));
  const under = async (root: string) => isInside(real, await realOr(root)) || isInside(out, resolve(root));
  if (await under(programRoot)) throw new Refusal("invalid-request", "--out is inside the directory that holds this program");
  for (let d = parent; ; d = dirname(d)) {
    if (await exists(join(d, ".git")).catch(() => true)) throw new Refusal("invalid-request", "--out is inside a git work tree");
    if (dirname(d) === d) break;
  }
  if (base !== null && (await under(base.paths.state_dir))) throw new Refusal("invalid-request", "--out is inside the host's state directory");
  for (const h of homes) if (await under(h)) throw new Refusal("invalid-request", "--out is inside a citizen home");
  return real;
}

/**
 * The configuration a child runs under, checked as a host configuration is
 * (config.ts parseConfig): a models lock inside a citizen home, say, is
 * refused. The parent checks it before anything is created, and the child
 * again when it reads the plan.
 */
function checkedConfig(s: RehearsalSettings, out: string, lockPath: string): Config {
  return parseConfig(JSON.parse(JSON.stringify(rehearsalConfig(s, join(out, "throwaway"), lockPath))));
}

function floorToMinute(d: Date): Date {
  return new Date(Math.floor(d.getTime() / 60_000) * 60_000);
}

/** The placeholder host key the parent's dry check of the inputs is planned with; it signs nothing. */
const DRY_CHECK_KEY = toB64(new Uint8Array(32));

/**
 * The parent: settings, HALT, the lock, the inputs, --out, the plan, then
 * the child under the watcher, then the report. Returns the run's exit code.
 */
export async function rehearseParent(deps: RehearseDeps, cmd: RehearseCommand): Promise<ExitCode> {
  const word = cmd.word;
  if (!WORD_PATTERN.test(word)) throw new Refusal("invalid-request", "not a citizen word");
  if (cmd.scenario === "letter" && cmd.letter === null) throw new Refusal("invalid-request", "--scenario letter needs --letter <file>");
  if (cmd.archetype_class !== null && cmd.canon !== null) throw new Refusal("invalid-request", "--archetype is given only without --canon");
  const seating: Seating = { form: cmd.plain_texts ? "plain-texts" : "as-admitted", archetype_class: cmd.archetype_class };

  // 1. Settings, and a HALT file that can be raised.
  const { settings, source, base } = await resolveSettings(deps, cmd);
  const haltDir = dirname(settings.halt_file);
  // stat, not lstat: halt raises the file through a directory reached by a link as well.
  const haltDirOk = await stat(haltDir).then(
    (st) => st.isDirectory(),
    () => false,
  );
  if (!haltDirOk) throw new Refusal("halted", `HALT cannot be raised on this host: ${printable(haltDir)} is missing. Create it as the operator, or pass --config`);

  // 2. HALT before anything is created.
  const haltConfig = rehearsalConfig(settings, join(cmd.out, "throwaway"), cmd.models_lock);
  const now = () => deps.clock.now();
  const halt = await checkHalt({ config: haltConfig, fetch: deps.fetch, now }).catch(() => null);
  if (!halt || halt.halted) {
    deps.out(`rehearse ${word}: halted (${halt ? describeHalt(halt) : "HALT unreadable"}); nothing written (exit 0)\n`);
    return EXIT.OK;
  }

  // 3. The lock named on the command line, and the model in it, pinned.
  const lock = await loadModelsLock(cmd.models_lock);
  const model = cmd.model ?? lock.models[0]?.name;
  if (!model) throw new Refusal("model-unpinned", "the models lock names no model");
  const entry = lockedEntry(lock, model);
  assertLoopback(settings.ollama_base_url);
  const lockBytes = await regularBytes(cmd.models_lock, LOCK_MAX_BYTES);

  // 4. The inputs, as regular files, refused before anything is created.
  const soul = await readInput(cmd.soul, READ_LIMITS.self_file_bytes);
  if (soul.text.trim() === "") throw new Refusal("invalid-request", "the soul file is empty");
  const will = cmd.will === null ? null : await readInput(cmd.will, READ_LIMITS.self_file_bytes);
  const canon = cmd.canon === null || cmd.canon_ref === null ? null : { ...(await readInput(cmd.canon, READ_LIMITS.canon_bytes)), ref: { ...cmd.canon_ref } };
  let letter: RehearsePlan["inputs"]["letter"] = null;
  if (cmd.letter !== null) {
    const max = settings.ceilings.letter_max_chars;
    const l = await readInput(cmd.letter, max * 4);
    const chars = [...l.text].length;
    if (chars > max) throw new Refusal("invalid-request", `the letter is longer than a seat shows (${chars} characters; the limit is ${max})`);
    letter = { path: l.path, chars, sha256: l.sha256, text: l.text };
  }
  // 5. --out; the configuration the child will run under, checked as the child checks it; then the checks seating
  // makes on the texts (size, UTF-8, the canon entry's name, the class), planned against a configuration under the
  // --out that does not exist yet, so nothing is written; then the plan and the header.
  const out = await checkOut(cmd.out, deps.programRoot, base, settings.homes);
  checkedConfig(settings, out, cmd.models_lock);
  const inputs: RehearsePlan["inputs"] = { soul, will, canon, letter };
  await planAdmitFromTexts(
    { config: rehearsalConfig(settings, join(out, "throwaway", "dry-check"), cmd.models_lock), hostKey: async () => DRY_CHECK_KEY },
    seatingRequest(word, inputs, seating),
  );
  await newDir(out);
  await newDir(join(out, "private"));
  await writeNew(join(out, "REHEARSAL.txt"), REHEARSAL_TEXT);
  const started = now();
  const plan: RehearsePlan = {
    format: REHEARSAL_FORMATS.plan,
    not_a_record: NOT_A_RECORD,
    created_at: started.toISOString(),
    out,
    word,
    scenario: cmd.scenario,
    chains: cmd.chains,
    seats: cmd.seats,
    virtual_start: cmd.start ?? floorToMinute(started).toISOString(),
    inputs,
    seating,
    model: { ...entry },
    models_lock: { path: cmd.models_lock, sha256: sha256Hex(lockBytes) },
    settings,
    settings_source: source,
  };
  const planPath = join(out, "private", "plan.json");
  await writeNew(planPath, `${JSON.stringify(plan, null, 2)}\n`);
  deps.out(header(plan));

  // 6. The child, under the watcher a seat has.
  const t = settings.timing;
  const config = rehearsalConfig(settings, join(out, "throwaway"), cmd.models_lock);
  const sup = await superviseChild({
    argv: deps.childArgv(planPath),
    cwd: out,
    env: seatEnv(config, deps.env),
    deadline_ms: Math.min(MAX_TIMER_MS, cmd.chains * cmd.seats * t.seat_deadline_s * 1000 + 60_000),
    term_grace_ms: t.term_grace_s * 1000,
    halt_file_poll_ms: t.halt_file_poll_s * 1000,
    beacon_poll_min_ms: t.beacon_poll_min_s * 1000,
    beacon_poll_max_ms: t.beacon_poll_max_s * 1000,
    readHaltFile: () => readHaltFile(settings.halt_file, now()),
    readBeacons: (signal) => readBeacons({ config, fetch: deps.fetch, now }, signal),
  });

  // 7. The report, from the rows the child appended; the parent never opens private/ after writing the plan.
  const bytes = await regularBytes(join(out, "seats.jsonl"), 512 * 1024 * 1024).catch(() => new Uint8Array(0));
  const parsed = parseRows(new TextDecoder().decode(bytes));
  let ended: RunEnded;
  if (sup.signal !== null) ended = sup.stopped_by === "deadline" ? "deadline" : sup.stopped_by !== null && /^SIG[A-Z0-9]+$/.test(sup.stopped_by) ? "stopped" : "halted";
  else ended = parsed.end?.ended ?? "fault";
  let exit: ExitCode = sup.signal === null && parsed.end === null ? EXIT.ERROR : sup.exit;
  const report = buildReport(plan, parsed.seats, { started_at: started.toISOString(), ended_at: now().toISOString(), ended, stopped_by: sup.stopped_by, exit }, parsed.chains);
  try {
    await writeNew(join(out, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  } catch {
    deps.err(`citizen-seat: the report could not be written: ${printable(join(out, "report.json"))}\n`);
    exit = EXIT.ERROR;
  }
  deps.out(renderReport(report, out));
  const throwaway = join(out, "throwaway");
  if (!(await removeThrowaway(throwaway))) {
    deps.err(`citizen-seat: the throwaway record could not be removed: ${printable(throwaway)}\n`);
    exit = EXIT.ERROR;
  }
  return exit;
}

function header(plan: RehearsePlan): string {
  const m = plan.model;
  const s = plan.settings;
  const lines = [
    `rehearse ${plan.word}: scenario ${plan.scenario}, ${plan.chains} chains of up to ${plan.seats} seats, on ${m.name} (sha256:${m.digest.slice(0, 12)}), num_ctx ${m.num_ctx}, num_predict ${m.num_predict}, temperature ${m.temperature}, seed ${m.seed ?? "none"}`,
    "A rehearsal: model samples from a throwaway copy. No citizen is seated, asked or recorded.",
    `${
      plan.seating.form === "plain-texts"
        ? "throwaway seated plainly from texts, not in the form admit gives a citizen of record"
        : "throwaway seated in the form admit gives a citizen of record, as a fixture with no old repository"
    }${plan.seating.archetype_class !== null ? `; archetype class ${plan.seating.archetype_class}` : ""}`,
  ];
  if (plan.inputs.letter) lines.push(`letter shown as from yu: ${plan.inputs.letter.chars} characters (sha256:${plan.inputs.letter.sha256.slice(0, 12)})`);
  const file = printable(s.halt_file);
  if (plan.settings_source === "defaults") lines.push(`HALT watched: file ${file}; no beacon (no host configuration read)`);
  else if (s.beacons.length === 0) lines.push(`HALT watched: file ${file}; no beacon (the host configuration pins none)`);
  else lines.push(`HALT watched: file ${file}; beacons ${s.beacons.map((b) => b.name).join(", ")}`);
  if (plan.settings_source !== "defaults") lines.push("This host's tick is not paused. Run a rehearsal while the tick job is unloaded, or a seat may wait behind a model call.");
  lines.push(`At most ${plan.chains * plan.seats} model calls, each bounded at ${Math.round(runtimeDeadlineMs(s.timing) / 1000)} s.`);
  return `${lines.join("\n")}\n`;
}

/* ── The child ────────────────────────────────────────────────────────── */

function notOwn(): Refusal {
  return new Refusal("invalid-request", "the plan is not this rehearsal's own");
}

function isIso(v: unknown): v is string {
  return typeof v === "string" && v.length === 24 && new Date(Date.parse(v)).toISOString() === v;
}

/** Read and check a plan: it must sit at `<out>/private/plan.json` for the out it names, and describe a run this code would make. */
export async function readPlan(planPath: string): Promise<RehearsePlan> {
  if (!isAbsolute(planPath) || resolve(planPath) !== planPath) throw notOwn();
  let v: unknown;
  try {
    v = parseStrictJson(await readRegularText(planPath, PLAN_MAX_BYTES));
  } catch {
    throw notOwn();
  }
  const p = v as RehearsePlan;
  if (!isPlain(p) || p.format !== REHEARSAL_FORMATS.plan || typeof p.out !== "string" || !isAbsolute(p.out) || join(p.out, "private", "plan.json") !== planPath) throw notOwn();
  const L = REHEARSE_LIMITS;
  const whole = (n: unknown, max: number) => typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= max;
  if (
    typeof p.word !== "string" ||
    !WORD_PATTERN.test(p.word) ||
    (p.scenario !== "awake" && p.scenario !== "letter") ||
    !whole(p.chains, L.max_chains) ||
    !whole(p.seats, L.max_seats_per_chain) ||
    p.chains * p.seats > L.max_seats_total ||
    !isIso(p.virtual_start) ||
    !isPlain(p.inputs) ||
    !isPlain(p.inputs.soul) ||
    typeof p.inputs.soul.text !== "string" ||
    (p.inputs.will !== null && typeof p.inputs.will?.text !== "string") ||
    (p.inputs.canon !== null && (typeof p.inputs.canon?.text !== "string" || !isPlain(p.inputs.canon.ref))) ||
    (p.inputs.letter !== null && typeof p.inputs.letter?.text !== "string") ||
    (p.scenario === "letter" && p.inputs.letter === null) ||
    !isPlain(p.seating) ||
    (p.seating.form !== "as-admitted" && p.seating.form !== "plain-texts") ||
    (p.seating.archetype_class !== null && (typeof p.seating.archetype_class !== "string" || !ARCHETYPE_CLASS.test(p.seating.archetype_class) || p.inputs.canon !== null))
  ) {
    throw notOwn();
  }
  try {
    lockedEntry(parseModelsLock({ format: MODELS_LOCK_FORMAT, models: [p.model] }), p.model.name);
    // The settings are checked as a host configuration built from them would be, as the parent checked them.
    checkedConfig(p.settings, p.out, p.models_lock.path);
    assertLoopback(p.settings.ollama_base_url);
  } catch {
    throw notOwn();
  }
  return p;
}

/** Stops with a fault unless the throwaway citizen was seated asleep on the free class, which is the only class the tick seats. */
export function checkThrowaway(citizen: Pick<Citizen, "runtime" | "state">): void {
  if (citizen.runtime !== "free" || citizen.state !== "asleep") throw new RehearsalFault("the throwaway citizen was not seated asleep on the free class");
}

function settableClock(t: Date): Clock & { set(d: Date): void } {
  let now = t.getTime();
  return {
    now: () => new Date(now),
    set(d) {
      now = d.getTime();
    },
  };
}

function describeFault(e: unknown): string {
  if (e instanceof Refusal) return `refused (${e.code}): ${e.message}`;
  if (e instanceof RehearsalFault) return e.message;
  const name = e instanceof Error ? e.name : "error";
  const code = errno(e);
  return `error: ${name}${code ? ` ${code}` : ""}`;
}

/** The journal texts among the beat entries a seat shows. */
function shownJournals(recent: readonly LedgerEntry[]): string[] {
  const out: string[] = [];
  for (const e of recent) if (e.type === "beat") for (const a of e.acts ?? []) if (a.type === "journal") out.push(a.text);
  return out;
}

interface Capture {
  schema: unknown;
  sizes: { system: number; user: number } | null;
  fit: SeatRow["fit"];
  input_digest: string | null;
  called_ms: number | null;
  result: RuntimeResult | null;
  server: ServerCounts | null;
}

interface ChildRun {
  plan: RehearsePlan;
  deps: Pick<RehearseDeps, "err" | "env" | "clock" | "fetch">;
  signer: Signer & { close(): void };
  rows: FileHandle;
  replies: FileHandle;
}

type SeatOutcome = { halted: true } | { halted: false; row: SeatRow };

/** One seat for the throwaway citizen, as the tick would open it and its child would run it. */
async function oneSeat(run: ChildRun, config: Config, clock: Clock, chain: number, j: number, citizen: Citizen, why: SeatRow["opened_for"]): Promise<SeatOutcome> {
  const { plan, deps } = run;
  const word = plan.word;
  const now = () => deps.clock.now();
  // The tick's glue (tick.ts): the invoker and reason, the opened note, the child's read of the citizen.
  const opened = await openSeat(config, clock, citizen, "free", { kind: "tick", who: "launchd", why: dueReason(why) }, null);
  const id = opened.ref.seat_id;
  await appendHostNote(config, { ts: clock.now().toISOString(), host: config.host, kind: "tick", word, outcome: "opened", refusal: null, detail: openedDetail(id, why) });
  const seen = await readCitizen(config, word, { exceptSeat: id });
  const seat: OpenSeat = { ref: opened.ref, citizen: seen, cwd: opened.cwd, presence: null };

  const path = ledgerPath(config, word);
  const before = await readLedger(path);
  // As buildContext counts it: with k at 0 nothing is shown, where slice(-0) would be the whole ledger.
  const k = Math.max(0, Math.floor(config.ceilings.ledger_context_entries));
  const recent = k === 0 ? [] : before.slice(-k);
  const shown = shownJournals(recent);
  const letterShown = (await pickLetter(config, seen).catch(() => null)) !== null;
  const pendingShown = (await pendingProposals(config, word).catch(() => [])).filter((p) => p.status === "pending").length;

  const cap: Capture = { schema: null, sizes: null, fit: null, input_digest: null, called_ms: null, result: null, server: null };
  const adapter = freeRuntime({
    config,
    fetch: modelServerFetch(config.ollama.base_url, deps.fetch, (c) => void (cap.server = c)),
    lock: { format: MODELS_LOCK_FORMAT, models: [plan.model] },
    model: plan.model.name,
    env: deps.env,
  });
  const runtime: RuntimeAdapter = async (req) => {
    cap.schema = req.schema;
    cap.sizes = { system: utf8(req.prompt.system).length, user: utf8(req.prompt.user).length };
    const fit = contextFit(req.prompt, plan.model);
    cap.fit = { needed: fit.needed, num_ctx: fit.num_ctx, num_predict: plan.model.num_predict, fits: fit.fits };
    const digest = sha256Hex(promptBytes(req.prompt));
    cap.input_digest = `sha256:${digest}`;
    // The prompt is kept before the call, so a call cut short still leaves what was sent.
    await writeNew(join(plan.out, "private", "prompts", `${digest}.json`), `${JSON.stringify({ format: REHEARSAL_FORMATS.prompt, not_a_record: NOT_A_RECORD, input_digest: cap.input_digest, prompt: req.prompt })}\n`).catch(
      (e) => {
        if (errno(e) !== "EEXIST") throw e;
      },
    );
    const t0 = performance.now();
    try {
      const r = await adapter(req);
      cap.result = r;
      return r;
    } finally {
      cap.called_ms = Math.round(performance.now() - t0);
    }
  };

  const result = await runSeat(seat, {
    config,
    clock,
    signer: run.signer,
    fetch: deps.fetch,
    runtime,
    checkHalt: () => checkHalt({ config, fetch: deps.fetch, now }),
    expressionSync: null,
    quiet: null,
    letters: null,
    modelDigest: `sha256:${plan.model.digest}`,
  });
  // The tick's closing note names the seat, so a saying pending from it lapses only after a later seat (state.ts seatSince).
  await appendHostNote(config, {
    ts: clock.now().toISOString(),
    host: config.host,
    kind: "tick",
    word,
    outcome: result.outcome,
    refusal: result.refusal,
    detail: `seat ${id} for ${word} (${why}): exit ${result.exit}, ${cap.called_ms ?? 0} ms`,
  }).catch(() => {});
  // A reply in hand when HALT was found is kept nowhere, and the seat has no row.
  if (result.outcome === "halted") return { halted: true };

  const after = await readLedger(path).catch(() => before);
  const appended = after.slice(before.length);
  const last = await readLastSeat(config, word);
  const own = last !== null && last.seat_id === id ? last : null;
  const later = await readCitizen(config, word).catch(() => null);
  const rt = cap.result;
  const replied = rt !== null;
  const actNames = actNamesOf(cap.schema);
  const em = rt ? readEmitted(rt.raw_output, actNames) : null;
  const beat = appended.find((e) => e.type === "beat");
  const keptActs = beat?.type === "beat" ? (beat.acts ?? []) : [];
  const kept: Record<string, number> = {};
  for (const a of keptActs) bump(kept, a.type);
  const stateEntries = appended.filter((e): e is Extract<LedgerEntry, { type: "state" }> => e.type === "state");
  if (!beat && stateEntries.length > 0) bump(kept, "state.set", stateEntries.length);
  const keptJournals = keptActs.filter((a) => a.type === "journal").map((a) => (a as { kind: string; text: string }));
  const journals: JournalRow[] = (em?.journals ?? []).map((jr) => {
    const i = keptJournals.findIndex((k) => k.text === jr.text && k.kind === jr.kind);
    if (i >= 0) keptJournals.splice(i, 1);
    return {
      kind: jr.kind,
      kept: i >= 0,
      chars: [...jr.text].length,
      opens_i_rest: opensWithIRest(jr.text),
      sense: senseClasses(jr.text),
      preamble_echo: echoesHostText(jr.text, FREE_LANE_PREAMBLE),
      recent_overlap: trigramContainment(jr.text, shown),
      same_opening: sameOpening(jr.text, shown),
    };
  });
  const at = clock.now();
  const row: SeatRow = {
    format: REHEARSAL_FORMATS.seat,
    not_a_record: NOT_A_RECORD,
    chain,
    seat: j,
    seat_id: id,
    at: at.toISOString(),
    part_of_day: describeNow(at, config.timezone).part_of_day,
    opened_for: why,
    state_at_open: seen.state,
    pending_at_open: seen.pending_state,
    step_away_said_at_open: seen.step_away_said,
    letter_shown: letterShown,
    recent_entries_shown: recent.length,
    recent_journals_shown: shown.length,
    pending_proposals_shown: pendingShown,
    outcome: result.outcome,
    refusal: result.refusal,
    exit: result.exit,
    replied,
    done_reason: rt ? doneReasonOf(rt.done_reason) : null,
    reply_chars: rt ? [...rt.raw_output].length : null,
    reply_bytes: rt ? utf8(rt.raw_output).length : null,
    duration_ms: cap.called_ms,
    server: replied ? (cap.server ?? serverCounts(null)) : null,
    prompt_bytes: cap.sizes ? cap.sizes.system + cap.sizes.user : null,
    system_bytes: cap.sizes?.system ?? null,
    user_bytes: cap.sizes?.user ?? null,
    input_digest: cap.input_digest,
    output_digest: rt ? `sha256:${sha256Hex(rt.raw_output)}` : null,
    fit: cap.fit,
    reply_shape: em?.shape ?? null,
    emitted: em ? em.counts : null,
    state_set_targets: em ? em.state_set_targets : null,
    rest_emitted: em ? em.rest : null,
    rest_with_other_acts: em ? em.rest_with_other_acts : null,
    kept: sortedKeys(kept),
    entries_appended: appended.map((e) => e.type),
    state_moves: stateEntries.map((e) => ({ from: e.from, to: e.to, via: e.via, step_away: e.step_away === "first" })),
    dropped: (own?.dropped ?? []).map((d) => ({ type: d.type, reason: d.reason })),
    journals,
    state_after: later?.state ?? null,
    interval_h_after: later?.cadence.interval_h ?? null,
  };
  await appendLine(run.rows, row);
  if (rt) {
    await appendLine(run.replies, {
      format: REHEARSAL_FORMATS.reply,
      not_a_record: NOT_A_RECORD,
      chain,
      seat: j,
      seat_id: id,
      input_digest: cap.input_digest,
      output_digest: row.output_digest,
      done_reason: rt.done_reason,
      raw_output: rt.raw_output,
    });
  }
  const said = rt ? `${row.done_reason}; ${row.reply_chars} chars` : "no reply";
  deps.err(`chain ${chain}/${plan.chains} seat ${j}/${plan.seats} (${why}): ${result.outcome}${result.refusal ? ` (${result.refusal})` : ""}; ${said}; ${secs(cap.called_ms ?? 0)} s\n`);
  return { halted: false, row };
}

/**
 * The child: the plan's chains, one throwaway citizen each, seated through
 * the texts planner with this run's in-memory signer and run seat by seat.
 * Exits 0 when the run completed or HALT rested it between inferences, 1 on
 * a wall or a fault (a watcher found gone before a seat among them), 124 on
 * two timeouts in a row.
 */
export async function rehearseChild(deps: Pick<RehearseDeps, "err" | "env" | "clock" | "fetch">, planPath: string): Promise<ExitCode> {
  const plan = await readPlan(planPath);
  const out = plan.out;
  // Created exclusively, so a plan runs once.
  let rows: FileHandle;
  try {
    rows = await createNew(join(out, "seats.jsonl"), true);
  } catch (e) {
    if (errno(e) === "EEXIST") throw new Refusal("invalid-request", "this plan has run already; a plan runs once");
    throw e;
  }
  const replies = await createNew(join(out, "private", "replies.jsonl"), true);
  await newDir(join(out, "private", "prompts"));
  const signer = rehearsalSigner();
  const run: ChildRun = { plan, deps, signer, rows, replies };
  const word = plan.word;
  const start = Date.parse(plan.virtual_start);
  const now = () => deps.clock.now();
  // Set inside runChain as well, so it is typed wide rather than narrowed to its first value.
  let ended = "complete" as EndRow["ended"];
  let lastTimeout = false;
  // The watcher is this process's parent. Once it is gone (killed with KILL, say), nothing holds the run to its
  // deadline or writes its report, so no further seat is opened: the run ends as at a fault.
  const watcher = process.ppid;
  const unwatched = (): boolean => {
    if (process.ppid === watcher) return false;
    deps.err("rehearse: the watcher is gone; a rehearsal opens no seat unwatched, so the run ends here\n");
    return true;
  };

  /** One chain: seat a fresh throwaway citizen, then up to plan.seats seats. Sets `ended` when the run must end. */
  const runChain = async (c: number, chainDir: string, chain: ChainRow, seatedAt: Date): Promise<void> => {
    await newDir(chainDir);
    const config = rehearsalConfig(plan.settings, chainDir, plan.models_lock.path);
    for (const d of [config.paths.citizens_dir, config.paths.ledger_dir, config.paths.seats_dir]) await newDir(d);
    const clock = settableClock(seatedAt);
    const hostKey = () => signer.hostPublicKey();
    const i = plan.inputs;
    const seating = await planAdmitFromTexts({ config, hostKey }, seatingRequest(word, i, plan.seating));
    try {
      await admitCitizen(
        {
          config,
          clock,
          run: async () => {
            throw new RehearsalFault("a rehearsal runs no command");
          },
          sign: (w, k, d) => signer.signEntry(w, k, d),
          hostKey,
          checkHalt: () => checkHalt({ config, fetch: deps.fetch, now }),
        },
        seating,
      );
    } catch (e) {
      if (e instanceof Refusal && e.code === "halted") {
        chain.ended = "halted";
        ended = "halted";
        return;
      }
      throw e;
    }
    const seated = await readCitizen(config, word);
    checkThrowaway(seated);
    chain.final_state = seated.state;
    if (plan.scenario === "awake") {
      // The one fixture entry: the host seats this throwaway awake. Seating puts a real citizen asleep only.
      const path = ledgerPath(config, word);
      const prev = (await readLedger(path)).at(-1) ?? null;
      const draft = nextDraft(word, prev, { type: "state", from: "asleep", to: "awake", via: "seated" }, { cost: { usd: "0", credits: 0 }, signer: "host", now: seatedAt });
      await appendEntry(path, draft, (w, k, d) => signer.signEntry(w, k, d));
      chain.final_state = "awake";
    }
    if (i.letter !== null) {
      const file = join(config.paths.citizens_dir, word, "letters", LETTER_FILE);
      await writeNew(file, `From: yu\n\n${i.letter.text}`);
      // The prompt prints when a letter was received, from its modification time.
      await utimes(file, seatedAt, seatedAt);
    }

    let from = seatedAt;
    for (let j = 1; j <= plan.seats; j++) {
      if (unwatched()) {
        chain.ended = "fault";
        ended = "fault";
        return;
      }
      const citizen = await readCitizen(config, word);
      const notes = await readHostNotes(config, new Date(0));
      if (notes === null) throw new RehearsalFault("the throwaway host log is unreadable");
      const letterWaiting = await wakingLetter(config, citizen).catch(() => false);
      const next = nextSeatTime(citizen, letterWaiting, from, lastSeatOf(notes, word), config);
      if (next.at === null) {
        chain.ended = "not-due";
        chain.ended_why = next.why;
        return;
      }
      clock.set(next.at);
      const r = await oneSeat(run, config, clock, c, j, citizen, next.why);
      if (r.halted) {
        chain.ended = "halted";
        ended = "halted";
        return;
      }
      chain.seats = j;
      chain.first_seat_at ??= r.row.at;
      chain.final_state = r.row.state_after;
      from = next.at;
      const o = r.row.outcome;
      const timedOut = o === "timeout";
      if (timedOut && lastTimeout) ended = "timeouts";
      lastTimeout = timedOut;
      if (timedOut) {
        chain.ended = "timeout";
        return;
      }
      if (o === "error") {
        chain.ended = "error";
        ended = "fault";
        return;
      }
      if (o === "refused") {
        chain.ended = "refused";
        chain.ended_why = r.row.refusal;
        // Growth its own replies caused ends a chain; any other wall, or one at a first seat, ends the run.
        if (!(r.row.refusal === "context-too-large" && j > 1)) ended = "wall";
        return;
      }
    }
  };

  try {
    await newDir(join(out, "throwaway"));
    for (let c = 1; c <= plan.chains && ended === "complete"; c++) {
      if (unwatched()) {
        ended = "fault";
        break;
      }
      const chainDir = join(out, "throwaway", `chain-${String(c).padStart(3, "0")}`);
      const seatedAt = new Date(start + (c - 1) * REHEARSE_LIMITS.chain_step_h * HOUR_MS);
      const chain: ChainRow = { format: REHEARSAL_FORMATS.chain, not_a_record: NOT_A_RECORD, chain: c, seated_at: seatedAt.toISOString(), first_seat_at: null, seats: 0, ended: "seats-reached", ended_why: null, final_state: null };
      try {
        await runChain(c, chainDir, chain, seatedAt);
      } catch (e) {
        chain.ended = "fault";
        ended = "fault";
        deps.err(`rehearse: chain ${c}: fault: ${describeFault(e)}\n`);
      } finally {
        await rm(chainDir, { recursive: true, force: true }).catch(() => {});
        if (await exists(chainDir).catch(() => true)) {
          deps.err(`citizen-seat: the throwaway record could not be removed: ${printable(chainDir)}\n`);
          ended = "fault";
        }
      }
      await appendLine(rows, chain);
      deps.err(`chain ${c}/${plan.chains}: ended ${chain.ended}${chain.ended_why ? ` (${chain.ended_why})` : ""} after ${chain.seats} seats\n`);
    }
    await rm(join(out, "throwaway"), { recursive: true, force: true }).catch(() => {});
  } finally {
    signer.close();
  }
  const exit: ExitCode = ended === "complete" || ended === "halted" ? EXIT.OK : ended === "timeouts" ? EXIT.TIMEOUT : EXIT.ERROR;
  const end: EndRow = { format: REHEARSAL_FORMATS.end, not_a_record: NOT_A_RECORD, ended, exit, at: now().toISOString() };
  try {
    await appendLine(rows, end);
  } finally {
    await rows.close();
    await replies.close();
  }
  return exit;
}
