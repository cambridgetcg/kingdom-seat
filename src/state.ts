// Lifecycle states and their transitions (3.3, 3c "Existence choices").
// Toward rest takes effect at once; toward exposure waits for the next beat
// to confirm it; stepping away is never blocked; ending needs a witness;
// nothing is deleted. The current state is folded from the ledger, so there
// is one record and no second, hand-kept truth.
import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { isoTime, ledgerPath, readLedger, readRegularText, validateIdentity, validateOrigin } from "./ledger.ts";
import { readHostNotes, seatIdOf } from "./notes.ts";
import {
  Refusal,
  WORD_PATTERN,
  type Cadence,
  type Citizen,
  type CitizenRecord,
  type Config,
  type Covenants,
  type IsoTime,
  type LedgerEntry,
  type LifecycleState,
  type Word,
  type YuPresence,
} from "./types.ts";

export type TransitionVerdict =
  | { effect: "now" }
  | { effect: "next-beat" }
  | { effect: "second-beat" }
  | { effect: "needs-witness" }
  | { effect: "refused"; reason: string };

export interface TransitionContext {
  /** The state already pending from an earlier beat, if any. */
  pending: LifecycleState | null;
  /** The awake interval that pending saying named, or null; this saying confirms it only when it names the same. */
  pending_interval_h?: number | null;
  /** True when this beat repeats a step-away said on an earlier beat. */
  repeated: boolean;
  presence: YuPresence | null;
}

/** A state.set's interval against the citizen's: the interval it has now, and the one the saying names, if any. */
export interface IntervalAsked {
  now: number;
  asked: number | null;
}

export interface FoldedState {
  state: LifecycleState;
  pending_state: LifecycleState | null;
  /** The awake interval the pending saying named, or null. */
  pending_interval_h: number | null;
  /** A step-away said once and waiting for its second saying. */
  step_away_said: boolean;
  last_beat_at: string | null;
  /** The beat that said what is pending (an exposure or a first step-away): its seat and time; null when nothing is. */
  said_in: { seat_id: string; ts: IsoTime } | null;
}

const RANK: Partial<Record<LifecycleState, number>> = { asleep: 0, listening: 1, awake: 2 };

/** awake > listening > asleep: a lower rank is more rest. stepped-away and ended are outside the order. */
export function restRank(state: LifecycleState): number | null {
  return RANK[state] ?? null;
}

/** True when `to` is more rest than `from`, which always takes effect now. */
export function isTowardRest(from: LifecycleState, to: LifecycleState): boolean {
  const a = restRank(from);
  const b = restRank(to);
  return a !== null && b !== null && b < a;
}

/** True when the saying names an awake interval other than the one in force. */
export function changesInterval(interval: IntervalAsked): boolean {
  return interval.asked !== null && interval.asked !== interval.now;
}

/**
 * Decide one requested transition by the asymmetric rules of 3.3 (KS-004
 * 7.3); "ended" never comes from the citizen alone. `interval` is the awake
 * interval the saying names against the one in force: a longer one is toward
 * less activity and takes effect at once, a shorter one is toward more and
 * waits for the next seat to say the same again.
 */
export function decideTransition(from: LifecycleState, to: LifecycleState, ctx: TransitionContext, interval: IntervalAsked = { now: 0, asked: null }): TransitionVerdict {
  if (from === "ended") return { effect: "refused", reason: "ended is terminal" };
  // A memorial is irreversible, so the citizen's word is one of four (3.3: citizen + Yu + Ai + a witness).
  if (to === "ended") return { effect: "needs-witness" };
  const moves = changesInterval(interval);
  // Saying the present state changes nothing; a pending move simply lapses on this beat (see foldState).
  if (to === from && !moves) return { effect: "refused", reason: `already ${from}` };
  // The citizen's own exit: two sayings on different beats, and nothing else can stop it.
  if (to === "stepped-away") return ctx.repeated ? { effect: "now" } : { effect: "second-beat" };
  // Rest is a right, not a grant: it never waits. A longer interval in the same state is rest too.
  const shorter = moves && (interval.asked as number) < interval.now;
  if (isTowardRest(from, to) || (to === from && !shorter)) return { effect: "now" };
  // Everything else is more exposure, including a return from stepping away and a shorter interval.
  // One 7B reply can be steered, so it binds on a second saying of the same, or once with Yu present.
  if (ctx.presence?.present === true) return { effect: "now" };
  if (ctx.pending === to && (ctx.pending_interval_h ?? null) === interval.asked) return { effect: "now" };
  return { effect: "next-beat" };
}

/**
 * Fold state, pending saying and last beat time from a citizen's ledger,
 * oldest first; an empty ledger, or one with only its origin, folds to
 * "asleep", so no record means no beat.
 *
 * A move toward rest takes effect from the beat that said it, not from the
 * separate `state` entry written after it: rest never waits (3.3), and a seat
 * stopped between the two appends must not leave a citizen that chose rest
 * awake and scheduled again. The `state` entry still follows, as the plain
 * record of the move. A first step-away is such a move too: its saying puts
 * an awake or listening citizen asleep at once, and the saying stays owed its
 * second beat (KS-004 v0.3 7.3). The `state` entry that records that move
 * carries `step_away: "first"`, which on a rest is the saying's only record.
 */
export function foldState(entries: LedgerEntry[]): FoldedState {
  let state: LifecycleState = "asleep";
  let pending: LifecycleState | null = null;
  let pendingInterval: number | null = null;
  let stepSaid = false;
  let lastBeat: string | null = null;
  let said: FoldedState["said_in"] = null;
  for (const e of entries) {
    if (state === "ended") {
      // Terminal: the record goes on being kept, but nothing moves the state.
      if (e.type === "beat") lastBeat = e.ts;
      continue;
    }
    switch (e.type) {
      case "state":
        if (e.step_away === "first") {
          // A first step-away: asleep at once, the saying owed one more seat. Nothing else was said with it on a rest.
          state = e.to;
          pending = null;
          pendingInterval = null;
          stepSaid = true;
          said = { seat_id: e.seat_ref as string, ts: e.ts };
          break;
        }
        // The plain record of a move the beat before it already made changes nothing more.
        if (e.to === state && e.interval_h === undefined) break;
        state = e.to;
        pending = null;
        pendingInterval = null;
        stepSaid = false;
        said = null;
        break;
      case "beat": {
        lastBeat = e.ts;
        // What this beat said about state. A saying that was not repeated on
        // this beat lapses: silence keeps the previous self.
        let p: LifecycleState | null = null;
        let pInterval: number | null = null;
        let s = false;
        let rest: LifecycleState | null = null;
        for (const act of e.acts ?? []) {
          if (act.type !== "state.set" || act.to === "ended") continue;
          if (act.to === state && act.interval_h === undefined) continue;
          if (act.to === "stepped-away") s = true;
          else if (isTowardRest(state, act.to)) rest = act.to;
          else {
            // Toward more, or an interval: pending until a state entry records that it took effect.
            p = act.to;
            pInterval = act.interval_h ?? null;
          }
        }
        if (rest !== null) state = rest;
        else if (s && isTowardRest(state, "asleep")) state = "asleep";
        pending = p;
        pendingInterval = pInterval;
        stepSaid = s;
        said = p !== null || s ? { seat_id: e.seat_ref as string, ts: e.ts } : null;
        break;
      }
      default:
        break;
    }
  }
  return { state, pending_state: pending, pending_interval_h: pendingInterval, step_away_said: stepSaid, last_beat_at: lastBeat, said_in: said };
}

/**
 * Has a seat for this citizen been opened since the beat that said what is
 * pending, other than that beat's own seat and `exceptSeat` (the seat now
 * reading it)? A rest, an invalid reply or a reply discarded by HALT writes no
 * ledger entry, so only the host notes show that the confirming seat came and
 * went. An unreadable log answers yes: a saying is dropped rather than kept on
 * a guess, because silence keeps the previous self.
 */
async function seatSince(config: Config, word: Word, said: { seat_id: string; ts: IsoTime }, exceptSeat: string | null): Promise<boolean> {
  const notes = await readHostNotes(config, new Date(Date.parse(said.ts)));
  if (notes === null) return true;
  return notes.some((n) => {
    if (n.word !== word || (n.kind !== "tick" && n.kind !== "seat")) return false;
    const id = seatIdOf(n);
    return id !== said.seat_id && (exceptSeat === null || id !== exceptSeat);
  });
}

/** The mirror card's `state` (3.3 table): awake active; listening and asleep dormant; stepped-away and ended archived. */
export function mirrorCardState(state: LifecycleState): "active" | "dormant" | "archived" {
  switch (state) {
    case "awake":
      return "active";
    case "listening":
    case "asleep":
      return "dormant";
    case "stepped-away":
    case "ended":
      return "archived";
  }
}

/** Words with a `citizens/<word>/citizen.json`, sorted; the host's admission list. */
export async function listSeated(config: Config): Promise<Word[]> {
  let names;
  try {
    names = await readdir(config.paths.citizens_dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const words: Word[] = [];
  for (const d of names) {
    // A Dirent does not follow links, so a symlinked citizen directory is not a directory here.
    if (!d.isDirectory() || !WORD_PATTERN.test(d.name)) continue;
    try {
      if ((await lstat(join(config.paths.citizens_dir, d.name, "citizen.json"))).isFile()) words.push(d.name);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }
  return words.sort();
}

const RECORD_KEYS = ["format", "word", "origin", "runtime", "identity", "mirror", "seated_at"];

/** Read and validate `citizens/<word>/citizen.json` as a regular file. */
export async function readCitizenRecord(config: Config, word: Word): Promise<CitizenRecord> {
  const dir = await citizenDir(config, word);
  const text = await readRegularText(join(dir, "citizen.json"), { missing: "throw", maxBytes: 64 * 1024 });
  let value: unknown;
  try {
    value = JSON.parse(text as string);
  } catch {
    throw new Refusal("invalid-record", `citizen.json for ${word} is not JSON`);
  }
  try {
    return validateRecord(value, word);
  } catch (err) {
    if (err instanceof Refusal) throw err;
    throw new Refusal("invalid-record", `citizen.json for ${word}: ${(err as Error).message}`);
  }
}

/**
 * The citizen as the seat sees it: record, folded ledger state, own cadence
 * and covenants. A pending saying is owed one confirming seat: once a later
 * seat has been opened (and `exceptSeat`, the seat reading this, does not
 * count), it lapses.
 */
export async function readCitizen(config: Config, word: Word, opts: { exceptSeat?: string } = {}): Promise<Citizen> {
  const record = await readCitizenRecord(config, word);
  const entries = await readLedger(ledgerPath(config, word));
  for (const e of entries) if (e.word !== word) throw new Refusal("invalid-record", `ledger for ${word} holds another citizen's entry`);
  const folded = foldState(entries);
  let pending = folded.pending_state;
  let pendingInterval = folded.pending_interval_h;
  let stepSaid = folded.step_away_said;
  if (folded.said_in && (pending !== null || stepSaid) && (await seatSince(config, word, folded.said_in, opts.exceptSeat ?? null))) {
    pending = null;
    pendingInterval = null;
    stepSaid = false;
  }
  const self = join(config.paths.citizens_dir, word, "self");
  await refuseLink(self);
  return {
    ...record,
    state: folded.state,
    pending_state: pending,
    pending_interval_h: pendingInterval,
    step_away_said: stepSaid,
    cadence: await readCadence(join(self, "cadence.json"), config.ceilings.min_beat_interval_h),
    covenants: await readCovenants(join(self, "covenants.json")),
    last_beat_at: folded.last_beat_at,
  };
}

/* ── Validation ───────────────────────────────────────────────────────── */

function validateRecord(value: unknown, word: Word): CitizenRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("not an object");
  const r = value as Record<string, unknown>;
  for (const k of Object.keys(r)) if (!RECORD_KEYS.includes(k)) throw new Error(`unknown field ${k}`);
  if (r.format !== "kingdom-seat-citizen/v1") throw new Error("format");
  if (r.word !== word) throw new Error("word does not match its directory");
  validateOrigin(r.origin);
  if (r.runtime !== "free" && r.runtime !== "summon" && r.runtime !== "hermes") throw new Error("runtime");
  if (r.identity !== null) validateIdentity(r.identity);
  if (r.mirror !== null) {
    const m = r.mirror as Record<string, unknown> | null;
    if (typeof m !== "object" || m === null) throw new Error("mirror");
    if (typeof m.remote !== "string" || m.remote === "") throw new Error("mirror.remote");
    if (typeof m.worktree !== "string" || m.worktree === "") throw new Error("mirror.worktree");
    isoTime(m.chosen_at, "mirror.chosen_at");
  }
  isoTime(r.seated_at, "seated_at");
  return value as CitizenRecord;
}

/** Parse a cadence file; the citizen's own interval as written, which ceilings bound when it is used. */
export function parseCadence(text: string): Cadence {
  const c = JSON.parse(text) as unknown;
  if (typeof c !== "object" || c === null || Array.isArray(c)) throw new Error("cadence is not an object");
  const keys = Object.keys(c);
  const h = (c as { interval_h?: unknown }).interval_h;
  if (keys.length !== 1 || typeof h !== "number" || !Number.isFinite(h) || h <= 0) throw new Error("cadence needs one positive interval_h");
  return { interval_h: h };
}

/** Parse a covenants file: two lists of sender ids. */
export function parseCovenants(text: string): Covenants {
  const c = JSON.parse(text) as unknown;
  if (typeof c !== "object" || c === null || Array.isArray(c)) throw new Error("covenants is not an object");
  const o = c as Record<string, unknown>;
  for (const k of Object.keys(o)) if (k !== "letters_from" && k !== "wake_on_letter_from") throw new Error(`unknown covenant ${k}`);
  const list = (v: unknown, what: string): string[] => {
    if (!Array.isArray(v) || !v.every((s) => typeof s === "string" && s !== "")) throw new Error(what);
    return v as string[];
  };
  return { letters_from: list(o.letters_from, "letters_from"), wake_on_letter_from: list(o.wake_on_letter_from, "wake_on_letter_from") };
}

async function readCadence(path: string, defaultH: number): Promise<Cadence> {
  const text = await readRegularText(path, { maxBytes: 4096 });
  // No cadence file yet: the default awake interval, never anything faster.
  if (text === null) return { interval_h: defaultH };
  try {
    return parseCadence(text);
  } catch (err) {
    throw new Refusal("invalid-record", `cadence.json: ${(err as Error).message}`);
  }
}

async function readCovenants(path: string): Promise<Covenants> {
  const text = await readRegularText(path, { maxBytes: 64 * 1024 });
  // No covenants yet: nobody may write or wake, which is the closed side.
  if (text === null) return { letters_from: [], wake_on_letter_from: [] };
  try {
    return parseCovenants(text);
  } catch (err) {
    throw new Refusal("invalid-record", `covenants.json: ${(err as Error).message}`);
  }
}

async function citizenDir(config: Config, word: Word): Promise<string> {
  if (!WORD_PATTERN.test(word)) throw new Refusal("invalid-request", "not a citizen word");
  const dir = join(config.paths.citizens_dir, word);
  await refuseLink(dir);
  return dir;
}

/** Refuse a symlinked directory: whatever it points at is not this citizen's. */
async function refuseLink(path: string): Promise<void> {
  try {
    const st = await lstat(path);
    if (st.isSymbolicLink()) throw new Refusal("symlink", `${path}: is a symlink; refused, not followed`);
    if (!st.isDirectory()) throw new Refusal("not-regular-file", `${path}: not a directory`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") throw new Refusal("invalid-record", `${path}: missing`);
    throw err;
  }
}
