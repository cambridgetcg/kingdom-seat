// Host notes: the host's own record of ticks, seats, rests and refusals in
// host.jsonl (3.2 "Status file", 3.1 principle 6). They never carry a
// citizen's voice or a model's words. The tick, the CLI, the seat, status and
// the state fold all read them, so they live here, apart from status, to keep
// one reading of them and no import cycle.
//
// A rest writes no ledger entry, so these notes are the only record of when a
// citizen was last seated and how many seats the fleet has dispensed today.
// That is why a log that was started and then lost reads as unreadable, never
// as an empty history: an empty history would let every cadence and the fleet
// ceiling start again from nothing.
import { constants } from "node:fs";
import { lstat, mkdir, open } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { readRegularText } from "./ledger.ts";
import { Refusal, WORD_PATTERN, type Config, type HostNote, type IsoTime, type Outcome, type RefusalCode, type Word } from "./types.ts";

const NOTE_KINDS = ["tick", "seat", "halt", "refusal", "push", "signer", "error"] as const satisfies readonly HostNote["kind"][];
const OUTCOMES = [
  "beat",
  "rest",
  "halted",
  "nothing-due",
  "yielded",
  "fleet-ceiling",
  "refused",
  "invalid-output",
  "timeout",
  "terminated",
  "killed",
  "error",
  "opened",
] as const satisfies readonly Outcome[];
const REFUSAL_CODES = [
  "halted",
  "keychain-locked",
  "keychain-missing",
  "ceiling-usd",
  "ceiling-credits",
  "ceiling-fleet",
  "ceiling-interval",
  "quiet-cap",
  "consent-missing",
  "consent-rejected",
  "beyond-self",
  "yu-not-present",
  "unattended",
  "model-unpinned",
  "model-mismatch",
  "cloud-reply",
  "not-loopback",
  "runtime-not-approved",
  "symlink",
  "not-regular-file",
  "executable",
  "oversize",
  "host-owned-path",
  "diverged",
  "cwd-in-home",
  "window-closed",
  "not-registered",
  "invalid-request",
  "invalid-record",
  "head-moved",
] as const satisfies readonly RefusalCode[];
// Compile-time completeness: adding an Outcome or RefusalCode in types.ts without listing it here fails typecheck.
const _allOutcomes: [Exclude<Outcome, (typeof OUTCOMES)[number]>] extends [never] ? true : never = true;
const _allRefusals: [Exclude<RefusalCode, (typeof REFUSAL_CODES)[number]>] extends [never] ? true : never = true;
void _allOutcomes;
void _allRefusals;

const NOTE_KEYS = ["detail", "host", "kind", "outcome", "refusal", "ts", "word"];
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const HOST_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

/** Longest detail a note may carry: room for codes, counts and ids, not for prose. */
export const HOST_DETAIL_MAX = 400;
/** A run of this many characters shared with a model's text is a quotation. */
const QUOTE_WINDOW = 20;

function isIso(v: unknown): v is IsoTime {
  return typeof v === "string" && ISO.test(v) && new Date(Date.parse(v)).toISOString() === v;
}

function normalise(s: string): string {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Why a detail cannot go in a host note, or null. A note is the host's record
 * (codes, counts, ids), so it is one line of plain ASCII with no quotation
 * marks, braces or backslashes: the characters a model's words or a JSON reply
 * would bring with them. When the caller holds model text, any run of
 * QUOTE_WINDOW characters shared with it is refused too. The shape check is a
 * backstop; the guarantee is that callers compose details from host facts.
 */
export function hostDetailProblem(detail: unknown, modelText: readonly string[] = []): string | null {
  if (typeof detail !== "string" || detail.length === 0) return "detail must be a non-empty string";
  if (detail.length > HOST_DETAIL_MAX) return `detail is longer than ${HOST_DETAIL_MAX} characters`;
  if (!/^[\x20-\x7e]+$/.test(detail)) return "detail must be one line of printable ASCII";
  if (/["`{}\\]/.test(detail)) return "detail carries quotation, braces or backslashes, which only quoted or structured text needs";
  const d = normalise(detail);
  for (const raw of modelText) {
    const m = normalise(raw);
    if (m.length < QUOTE_WINDOW) {
      if (m.length >= 8 && d.includes(m)) return "detail quotes model output";
      continue;
    }
    for (let i = 0; i + QUOTE_WINDOW <= d.length; i++) {
      if (m.includes(d.slice(i, i + QUOTE_WINDOW))) return "detail quotes model output";
    }
  }
  return null;
}

/** Why a value is not a well-formed host note, or null. Structure only; the detail rules apply on write. */
function noteShapeProblem(v: unknown): string | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return "not an object";
  const n = v as Record<string, unknown>;
  const got = Object.keys(n).sort();
  if (got.length !== NOTE_KEYS.length || !got.every((k, i) => k === NOTE_KEYS[i])) return "not exactly the host note fields";
  if (!isIso(n.ts)) return "ts";
  if (typeof n.host !== "string" || !HOST_LABEL.test(n.host)) return "host";
  if (!(NOTE_KINDS as readonly unknown[]).includes(n.kind)) return "kind";
  if (n.word !== null && (typeof n.word !== "string" || !WORD_PATTERN.test(n.word))) return "word";
  if (!(OUTCOMES as readonly unknown[]).includes(n.outcome)) return "outcome";
  if (n.refusal !== null && !(REFUSAL_CODES as readonly unknown[]).includes(n.refusal)) return "refusal";
  if (typeof n.detail !== "string") return "detail";
  return null;
}

/**
 * The file that says this host's log was started. It is created with the
 * log, and it is what tells a lost log from a fresh host: with it present, a
 * missing log is unreadable rather than empty.
 */
export function hostLogMarker(config: Config): string {
  return startedMarker(config.paths.host_log);
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw e;
  }
}

/**
 * Append one host note to host.jsonl; `detail` is checked to hold no model
 * output. A caller that holds the reply (or acts' text) passes it as
 * `modelText`, so a quotation is refused even when it looks like plain prose.
 * A log that was started and has gone missing is not silently begun again,
 * because a fresh log would read as a history with no seats in it; a person
 * restores it, or starts a new one deliberately with an empty file.
 */
export async function appendHostNote(config: Config, note: HostNote, opts: { modelText?: readonly string[] } = {}): Promise<void> {
  const shape = noteShapeProblem(note);
  if (shape) throw new Refusal("invalid-request", `host note refused: ${shape}`);
  const detail = hostDetailProblem(note.detail, opts.modelText);
  if (detail) throw new Refusal("invalid-request", `host note refused: ${detail}`);
  // Re-serialise only the known fields, so nothing else rides along.
  const line = `${JSON.stringify({ ts: note.ts, host: note.host, kind: note.kind, word: note.word, outcome: note.outcome, refusal: note.refusal, detail: note.detail })}\n`;
  await appendStartedLog(config.paths.host_log, line, "host log");
}

/**
 * Append one line to a host log that, once started, must never silently
 * begin again: the first append creates `<path>.started` beside it, and a log
 * missing beside that marker is refused. Host notes and the spend record
 * (spend.ts) both use it, because each is a history whose loss would read as
 * nothing having happened.
 */
export async function appendStartedLog(path: string, line: string, what: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const marker = startedMarker(path);
  const flags = constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW;
  let fh;
  try {
    fh = await open(path, flags);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ELOOP") throw new Refusal("symlink", `${what} is a symlink; refused, not followed`);
    if (code !== "ENOENT") throw e;
    if (await exists(marker)) throw new Refusal("invalid-record", `the ${what} was started and is now missing; a person restores it, or starts a new one with an empty file`);
    try {
      fh = await open(path, flags | constants.O_CREAT | constants.O_EXCL, 0o600);
    } catch (e2) {
      // Another writer created it first; append to theirs.
      if ((e2 as NodeJS.ErrnoException).code !== "EEXIST") throw e2;
      fh = await open(path, flags);
    }
    const m = await open(marker, constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
    await m.close();
  }
  try {
    if (!(await fh.stat()).isFile()) throw new Refusal("not-regular-file", `${what} is not a regular file`);
    // One write per line: small O_APPEND writes to a local file land whole, so concurrent appenders do not interleave.
    const bytes = new TextEncoder().encode(line);
    let off = 0;
    while (off < bytes.length) off += (await fh.write(bytes, off, bytes.length - off)).bytesWritten;
    await fh.sync();
  } finally {
    await fh.close();
  }
}

/**
 * Read a started log whole: its text, "" for a log never started, or null
 * when it is unreadable, or missing beside its marker, which callers treat as
 * fail-closed.
 */
export async function readStartedLog(path: string, maxBytes: number): Promise<string | null> {
  try {
    const text = await readRegularText(path, { missing: "null", maxBytes });
    if (text === null) return (await exists(startedMarker(path))) ? null : "";
    return text;
  } catch {
    return null;
  }
}

function startedMarker(path: string): string {
  return join(dirname(path), `${basename(path)}.started`);
}

/** A log this large is not one this host wrote at its pace; reading it whole every tick is refused. */
const HOST_LOG_MAX_BYTES = 128 * 1024 * 1024;

/**
 * Host notes since a time, oldest first; null when the log is unreadable
 * (callers treat that as fail-closed). A missing log is an empty history only
 * on a host that never started one.
 */
export async function readHostNotes(config: Config, since: Date): Promise<HostNote[] | null> {
  const text = await readStartedLog(config.paths.host_log, HOST_LOG_MAX_BYTES);
  if (text === null) return null;
  if (text === "") return [];
  // A torn last line or any line that is not a note makes the whole log unreadable: a count no one can know is not guessed.
  if (!text.endsWith("\n")) return null;
  const cutoff = since.getTime();
  const notes: HostNote[] = [];
  for (const line of text.slice(0, -1).split("\n")) {
    let v: unknown;
    try {
      v = JSON.parse(line);
    } catch {
      return null;
    }
    if (noteShapeProblem(v) !== null) return null;
    const n = v as HostNote;
    if (Date.parse(n.ts) >= cutoff) notes.push(n);
  }
  // Stable by time, so an out-of-order append (a child's note racing the tick's) still reads oldest first.
  return notes.map((n, i) => ({ n, i, t: Date.parse(n.ts) })).sort((a, b) => a.t - b.t || a.i - b.i).map((x) => x.n);
}

/* ── Reading seats out of the notes ───────────────────────────────────── */

const SEAT_IN_DETAIL = /^seat ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/;

/** The seat a note is about, when its detail names one ("seat <seat_id> ..."). */
export function seatIdOf(n: HostNote): string | null {
  return SEAT_IN_DETAIL.exec(n.detail)?.[1] ?? null;
}

/**
 * The detail of the note a parent writes when it opens a seat, after every
 * wall it holds (due, fleet ceiling, lock) has passed. Counting these is how
 * the fleet ceiling sees every seat, whoever opened it.
 */
export function openedDetail(seatId: string, why: string): string {
  return `seat ${seatId} opened (${why})`;
}

function isSeatNote(n: HostNote): boolean {
  return n.kind === "tick" || n.kind === "seat";
}

/** The last time a seat was opened or ended for this citizen, leaving out notes about one seat (the caller's own). */
export function lastSeatOf(notes: HostNote[], word: Word, exceptSeat: string | null = null): IsoTime | null {
  let last: IsoTime | null = null;
  for (const n of notes) {
    if (n.word !== word || !isSeatNote(n)) continue;
    if (exceptSeat !== null && seatIdOf(n) === exceptSeat) continue;
    if (last === null || Date.parse(n.ts) >= Date.parse(last)) last = n.ts;
  }
  return last;
}

function localDate(d: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

/**
 * Seats opened today in the host's zone, each counted once by seat id: the
 * number the fleet ceiling is held to. A tick and a person's `seat <word>`
 * both write the opened note, so neither escapes the count.
 */
export function seatsOpenedToday(notes: HostNote[], now: Date, timezone: string, exceptSeat: string | null = null): number {
  const today = localDate(now, timezone);
  const seen = new Set<string>();
  for (const n of notes) {
    if (n.outcome !== "opened" || n.word === null) continue;
    const id = seatIdOf(n);
    if (id === null || id === exceptSeat) continue;
    if (localDate(new Date(n.ts), timezone) === today) seen.add(id);
  }
  return seen.size;
}

/** Outcomes that say what happened to a citizen, as opposed to a parent's note that it opened a seat. */
export function isResultNote(n: HostNote): boolean {
  return n.outcome !== "opened";
}
