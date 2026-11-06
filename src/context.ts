// What a seat shows the model (3.2 step 4). Its own expression and soul
// whole, its last k ledger entries, its state, the date, time and zone, at
// most one letter read only as a regular file, its canon path@commit, and who
// invoked it and why. It deliberately excludes GET /v1/wake, whose
// project-wide sections would mix siblings into a persona (3.2). A sibling's
// words reach a citizen only as a letter. Nothing secret is ever included.
//
// Everything here reads under `citizens/<word>/` in the host's state dir and
// nowhere else: never a citizen home, never the network. Files are read as
// regular files only (lstat, then O_NOFOLLOW and fstat), because a symlinked
// letter once carried a host file into a prompt (love-unlimited-patterns.md
// 12.4).
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes, sha256Hex, toHex } from "./crypto.ts";
import { ACT_LIMITS } from "./acts.ts";
import { MAX_SKILLS, SELF_FILE_MAX_BYTES, keptVersions, originSoulHash, targetRelPath } from "./self.ts";
import { HOST_RECIPIENTS } from "./letters.ts";
import {
  Refusal,
  UUID_PATTERN,
  WORD_PATTERN,
  type ActType,
  type Citizen,
  type Config,
  type DroppedRecord,
  type IsoTime,
  type Letter,
  type LedgerEntry,
  type NowView,
  type RegistrationView,
  type SeatContext,
  type SeatLimits,
  type SeatRef,
  type SelfProposal,
} from "./types.ts";

// Strict, and keeping a byte-order mark: the text shown is exactly the bytes
// read, so a hash checked on the bytes is a hash of what the citizen sees.
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const fromUtf8 = (bytes: Uint8Array): string => decoder.decode(bytes);

export interface ContextDeps {
  config: Config;
  now: Date;
}

/**
 * Caps on what is read, so one oversize file refuses instead of filling the
 * model's window. The self limits are self.ts's own, so no change within self
 * can leave a text or a skill count the next seat would refuse.
 */
export const READ_LIMITS = Object.freeze({
  self_file_bytes: SELF_FILE_MAX_BYTES,
  canon_bytes: 256 * 1024,
  max_skills: MAX_SKILLS,
  /** The citizen's own `file:` texts shown per seat, and how deep under self/ they are looked for. */
  max_files: 32,
  max_file_depth: 4,
  /** Directory entries looked at per scan of letters/, so a flooded inbox cannot stall a tick. */
  max_letters_scanned: 512,
  /** A letter's header line, on top of the body limit. */
  letter_header_bytes: 512,
});

/** Read a file only if it is a regular file (lstat, then open with O_NOFOLLOW and fstat); refuse symlinks and oversize. */
export async function readRegularText(path: string, maxBytes: number): Promise<string> {
  const bytes = await readRegularBytes(path, maxBytes);
  try {
    return fromUtf8(bytes);
  } catch {
    throw new Refusal("invalid-record", "a file is not valid UTF-8");
  }
}

/**
 * The oldest unseen letter from an allowed sender, read as a regular file;
 * symlinks and others are set aside, never counted as mail. A citizen that
 * stepped away is shown only Yu's letter, because that is the offer of a
 * return its seat opened for. `inbox` is what a registered citizen's
 * agenttool inbox holds for it (letters.ts, already admitted by its
 * covenants and unseen); the oldest of all is shown, still only one.
 */
export async function pickLetter(config: Config, citizen: Citizen, inbox: readonly Letter[] = []): Promise<Letter | null> {
  const allowed = new Set(citizen.covenants.letters_from);
  const away = citizen.state === "stepped-away";
  const file = await scanLetters(config, citizen, (from) => allowed.has(from) && (!away || from === "yu"));
  const all = [...(file ? [file] : []), ...inbox.filter((l) => allowed.has(l.from) && (!away || l.from === "yu"))];
  all.sort((a, b) => (a.received_at < b.received_at ? -1 : a.received_at > b.received_at ? 1 : 0));
  return all[0] ?? null;
}

/** Whether a letter was already shown: a host receipt under its id, for a file letter and an inbox letter alike. */
export async function letterSeen(config: Config, citizen: Pick<Citizen, "word">, id: string): Promise<boolean> {
  if (!isPlainFileName(id)) return true;
  return exists(join(citizenDir(config, citizen.word), "receipts", id));
}

/**
 * True when a letter that may wake the citizen is waiting: unseen, a regular
 * file, and from a sender in both `letters_from` and `wake_on_letter_from`
 * (a sender who may wake it but not write to it would wake it for nothing).
 * The tick uses this to wake a listening or asleep citizen.
 */
export async function hasAllowedLetter(config: Config, citizen: Citizen): Promise<boolean> {
  const allowed = new Set(citizen.covenants.letters_from);
  const wakers = new Set(citizen.covenants.wake_on_letter_from);
  return (await scanLetters(config, citizen, (from) => allowed.has(from) && wakers.has(from))) !== null;
}

/**
 * The letter that can seat this citizen in its present state: an allowed
 * waking letter while it listens or sleeps, and Yu's letter (one it allows)
 * once it has stepped away, which is how Yu offers a return. An awake or
 * ended citizen is never woken by a letter.
 */
export async function wakingLetter(config: Config, citizen: Citizen): Promise<boolean> {
  switch (citizen.state) {
    case "listening":
    case "asleep":
      return hasAllowedLetter(config, citizen);
    case "stepped-away":
      return citizen.covenants.letters_from.includes("yu") && (await scanLetters(config, citizen, (from) => from === "yu")) !== null;
    default:
      return false;
  }
}

/**
 * Record that a letter was shown, as a host receipt outside the citizen's
 * voice. The seat calls this only after a non-rest beat, so a rest or a HALT
 * shows the same letter again next time. A receipt is never overwritten.
 */
export async function markLetterSeen(config: Config, citizen: Citizen, letter: Letter, now: Date): Promise<void> {
  if (!isPlainFileName(letter.id)) throw new Refusal("invalid-request", "a letter id is not a plain file name");
  const dir = citizenDir(config, citizen.word);
  await assertRealDir(dir, "the citizen directory");
  const receipts = join(dir, "receipts");
  await mkdir(receipts, { recursive: true });
  await assertRealDir(receipts, "receipts/");
  const body = `${JSON.stringify({ format: "kingdom-seat-receipt/v1", letter: letter.id, sha256: letter.sha256, shown_at: now.toISOString() })}\n`;
  let fh;
  try {
    // O_EXCL refuses an existing name, symlinks included, so a planted link cannot redirect the write.
    fh = await open(join(receipts, letter.id), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644);
  } catch (e) {
    if (errCode(e) === "EEXIST") return;
    throw e;
  }
  try {
    await fh.writeFile(body);
    await fh.sync();
  } finally {
    await fh.close();
  }
}

/* ── What the last seat did not keep (KS-004 5.8, 5.10) ──────────────── */

export const LAST_SEAT_FORMAT = "kingdom-seat-last-seat/v1";

/**
 * The host's record of the last seat that got a reply: when, how it came out,
 * the ledger's head seq once it was recorded, and the acts it did not keep,
 * by type and fixed reason, never their words. A beat records its drops in its
 * own entry too; a rest, or a reply where nothing was kept, writes no beat, so
 * this record is the only place its drops are kept, and how the next seat and
 * status learn of them (re-review C round 3, selfhood F2 and F10). One file per
 * citizen, `<state_dir>/last-seat/<word>.json`, beside the host log and the
 * status, replaced by each seat with a reply: a host record, outside the
 * citizen's own directory, never mirrored.
 */
export interface LastSeatRecord {
  format: typeof LAST_SEAT_FORMAT;
  seat_id: string;
  at: IsoTime;
  outcome: "beat" | "rest" | "invalid-output";
  /** The seq of the ledger's last entry once the seat's entries were written; null for an empty ledger. */
  head_seq: number | null;
  dropped: DroppedRecord[];
}

const DROPPED_TYPES: readonly (ActType | null)[] = [null, "rest", "journal", "self.propose", "self.affirm", "self.revert", "state.set", "letter.send", "propose.beyond"];
const MAX_DROPPED = 16;

function lastSeatDir(config: Config): string {
  return join(config.paths.state_dir, "last-seat");
}

function lastSeatPath(config: Config, word: string): string {
  // The word becomes a file name, so it is checked here too.
  if (!WORD_PATTERN.test(word)) throw new Refusal("invalid-record", "a citizen word is not valid");
  return join(lastSeatDir(config), `${word}.json`);
}

/** Replace the citizen's last-seat record: a temp file beside it, then rename, so a reader never sees half of one. */
export async function writeLastSeat(config: Config, word: string, record: Omit<LastSeatRecord, "format">): Promise<void> {
  const path = lastSeatPath(config, word);
  const dir = lastSeatDir(config);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await assertRealDir(dir, "last-seat/");
  const body: LastSeatRecord = { format: LAST_SEAT_FORMAT, ...record, dropped: record.dropped.slice(0, MAX_DROPPED).map((d) => ({ type: d.type, reason: d.reason })) };
  const tmp = join(dir, `.${word}.${toHex(randomBytes(8))}.tmp`);
  const fh = await open(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    try {
      await fh.writeFile(`${JSON.stringify(body)}\n`);
      await fh.sync();
    } finally {
      await fh.close();
    }
    // rename replaces the name itself, never a file a symlink there points to.
    await rename(tmp, path);
  } catch (e) {
    await rm(tmp, { force: true }).catch(() => {});
    throw e;
  }
}

/** The citizen's last-seat record, or null when there is none or it does not read as one: it is a view, never a wall. */
export async function readLastSeat(config: Config, word: string): Promise<LastSeatRecord | null> {
  let v: unknown;
  try {
    v = JSON.parse(await readRegularText(lastSeatPath(config, word), 16 * 1024));
  } catch {
    return null;
  }
  const o = v as Partial<LastSeatRecord> | null;
  if (!o || typeof o !== "object" || Object.keys(o).sort().join(",") !== "at,dropped,format,head_seq,outcome,seat_id") return null;
  if (o.format !== LAST_SEAT_FORMAT || typeof o.seat_id !== "string" || !UUID_PATTERN.test(o.seat_id)) return null;
  if (typeof o.at !== "string" || new Date(Date.parse(o.at)).toISOString() !== o.at) return null;
  if (o.outcome !== "beat" && o.outcome !== "rest" && o.outcome !== "invalid-output") return null;
  if (o.head_seq !== null && !(Number.isSafeInteger(o.head_seq) && (o.head_seq as number) >= 0)) return null;
  if (!Array.isArray(o.dropped) || o.dropped.length > MAX_DROPPED) return null;
  for (const d of o.dropped as unknown[]) {
    const x = d as Partial<DroppedRecord> | null;
    if (!x || typeof x !== "object" || Object.keys(x).sort().join(",") !== "reason,type" || !DROPPED_TYPES.includes(x.type as ActType | null)) return null;
    if (typeof x.reason !== "string" || x.reason.length === 0 || x.reason.length > 200 || !/^[\x20-\x7e]+$/.test(x.reason)) return null;
  }
  return o as LastSeatRecord;
}

/**
 * What the citizen's last seat with a reply did not keep, shown back so it
 * knows what did not happen (KS-004 5.8): from the host's last-seat record
 * when that is at least as new as the last beat entry (a later beat has a seq
 * past the record's head), otherwise from the last beat entry, whose own
 * `dropped` the ledger keeps. Null when that seat kept everything.
 */
export function lastDroppedView(entries: LedgerEntry[], record: LastSeatRecord | null): SeatContext["last_dropped"] {
  const beat = entries.findLast((e) => e.type === "beat");
  const recordIsLatest = record !== null && record.outcome !== "beat" && (beat === undefined || record.head_seq === null || beat.seq <= record.head_seq);
  if (recordIsLatest) return record.dropped.length > 0 ? { seq: null, at: record.at, outcome: record.outcome, dropped: record.dropped.map((d) => ({ ...d })) } : null;
  // A seat that wrote nothing at all, not even a record, leaves the last beat's word on it.
  if (beat?.type === "beat" && beat.dropped) return { seq: beat.seq, at: beat.ts, outcome: "beat", dropped: beat.dropped.map((d) => ({ ...d })) };
  return null;
}

/** Date, local time, zone and part of day, e.g. "02:05 GMT", "night". */
export function describeNow(now: Date, timezone: string): NowView {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZoneName: "short" }).formatToParts(now);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "";
  const hour = Number(get("hour"));
  return {
    iso: now.toISOString(),
    local: `${get("hour")}:${get("minute")} ${get("timeZoneName")}`,
    tz: timezone,
    part_of_day: partOfDay(hour),
  };
}

/** The citizen's own self files, whole: soul, WILL, NAME, beat prompt and skills, as regular files only. */
export async function readSelf(config: Config, citizen: Citizen): Promise<SeatContext["self"]> {
  const dir = citizenDir(config, citizen.word);
  await assertRealDir(dir, "the citizen directory");
  const self = join(dir, "self");
  await assertRealDir(self, "self/");

  // The whole soul, with no character cut: the old 2,600-character cut hid
  // glossame's LIGHT and SHADOW from every beat (love-unlimited-patterns.md 5.1).
  const soul = await readOptional(join(self, "soul.md"), READ_LIMITS.self_file_bytes);
  if (soul === null) throw new Refusal("invalid-record", "self/soul.md is missing");

  const expression = join(self, "expression");
  const hasExpression = await realDirExists(expression, "self/expression/");
  const expr = (name: string) => (hasExpression ? readOptional(join(expression, name), READ_LIMITS.self_file_bytes) : Promise.resolve(null));
  return {
    soul,
    will: await readOptional(join(self, "WILL.md"), READ_LIMITS.self_file_bytes),
    name: await readOptional(join(self, "NAME.md"), READ_LIMITS.self_file_bytes),
    beat_prompt: await readOptional(join(self, "beat-prompt.md"), READ_LIMITS.self_file_bytes),
    skills: await readSkills(join(self, "skills")),
    journal_form: await readOptional(join(self, "journal-form.md"), READ_LIMITS.self_file_bytes),
    expression: {
      register: await expr("register.md"),
      walls: await expr("walls.md"),
      wake_text: await expr("wake_text.md"),
      porch: await expr("porch.json"),
    },
    files: await readOwnFiles(self),
  };
}

/** The limits the guide states: each the lower of the configured ceiling and the hard cap validation keeps. */
export function seatLimits(config: Config): SeatLimits {
  const c = config.ceilings;
  return {
    journal_max_chars: Math.min(c.journal_max_chars, ACT_LIMITS.max_journal_chars),
    letter_max_chars: Math.min(c.letter_max_chars, ACT_LIMITS.max_text_chars),
    letter_sends_per_beat: Math.min(c.letter_sends_per_beat, 1),
    min_beat_interval_h: c.min_beat_interval_h,
    quiet_max_days: Math.max(0, Math.min(ACT_LIMITS.max_quiet_days, Number.isSafeInteger(c.citizen_quiet_max_days) ? c.citizen_quiet_max_days : 0)),
  };
}

/** The pinned canon snapshot under `citizens/<word>/origin/`, checked against origin.sha256; null for an archetype. */
export async function readCanon(config: Config, citizen: Citizen): Promise<string | null> {
  if (citizen.origin.kind !== "canon") return null;
  const dir = citizenDir(config, citizen.word);
  await assertRealDir(dir, "the citizen directory");
  await assertRealDir(join(dir, "origin"), "origin/");
  let bytes: Uint8Array;
  try {
    bytes = await readRegularBytes(join(dir, "origin", "canon.md"), READ_LIMITS.canon_bytes);
  } catch (e) {
    if (errCode(e) === "ENOENT") throw new Refusal("invalid-record", "origin/canon.md is missing");
    throw e;
  }
  // Hash the bytes as stored, so a re-encoding can never make a changed file pass.
  if (sha256Hex(bytes) !== citizen.origin.sha256) throw new Refusal("invalid-record", "origin/canon.md does not match the pinned origin sha256");
  try {
    return fromUtf8(bytes);
  } catch {
    throw new Refusal("invalid-record", "origin/canon.md is not valid UTF-8");
  }
}

/** How many versions of each target are listed, besides the origin soul; older ones stay kept and revertible by full hash. */
const VERSIONS_PER_TARGET = 8;

/**
 * Assemble the whole context for one seat. `history` is the whole ledger, from
 * which the kept versions are listed (default: `recent`); `selfAuthorship` says
 * whether a self-change can bind on this seat (default: unknown runtime, window
 * open, Yu not present).
 */
export async function buildContext(
  deps: ContextDeps,
  seat: SeatRef,
  citizen: Citizen,
  recent: LedgerEntry[],
  pending: SelfProposal[],
  opts: {
    history?: LedgerEntry[];
    selfAuthorship?: SeatContext["self_authorship"];
    /** What its agenttool inbox holds for it, once registered (letters.ts LetterPost.unread). */
    inbox?: readonly Letter[];
    /** Whom it may write to (letters.ts letterRecipients); default Yu and the gardener desk. */
    recipients?: readonly string[];
    /** Its answer about registration (registration.ts registrationView). */
    registration?: RegistrationView | null;
    /** The host's record of its last seat with a reply (readLastSeat), so a rest's or a dropped reply's drops are shown too. */
    lastSeat?: LastSeatRecord | null;
  } = {},
): Promise<SeatContext> {
  if (seat.word !== citizen.word) throw new Refusal("invalid-request", "the seat was opened for a different citizen");
  const k = Math.max(0, Math.floor(deps.config.ceilings.ledger_context_entries));
  // Only the citizen's own entries and proposals; a sibling's words arrive only as letters.
  const own = recent.filter((e) => e.word === citizen.word);
  const all = (opts.history ?? recent).filter((e) => e.word === citizen.word);
  const versions = listedVersions(all);
  // What its last seat with a reply did not keep, so it knows what did not happen (KS-004 5.8): a beat's from its
  // own entry, a rest's or a reply with nothing kept from the host's last-seat record.
  const lastDropped = lastDroppedView(all, opts.lastSeat ?? null);
  return {
    seat_ref: seat,
    self: await readSelf(deps.config, citizen),
    origin: citizen.origin,
    canon_text: await readCanon(deps.config, citizen),
    recent: k === 0 ? [] : own.slice(-k),
    state: citizen.state,
    pending_state: citizen.pending_state,
    pending_interval_h: citizen.pending_interval_h,
    pending_proposals: pending.filter((p) => p.word === citizen.word && p.status === "pending"),
    versions,
    self_authorship: opts.selfAuthorship ?? { runtime_approved: null, window_opens_at: null, yu_present: false },
    now: describeNow(deps.now, deps.config.timezone),
    letter: await pickLetter(deps.config, citizen, opts.inbox ?? []),
    invoker: seat.invoker,
    cadence: { ...citizen.cadence },
    covenants: { letters_from: [...citizen.covenants.letters_from], wake_on_letter_from: [...citizen.covenants.wake_on_letter_from] },
    limits: seatLimits(deps.config),
    recipients: [...(opts.recipients ?? HOST_RECIPIENTS)],
    last_dropped: lastDropped,
    registration: opts.registration ?? null,
  };
}

/* ── Internals ────────────────────────────────────────────────────────── */

/** The origin soul always, and the latest VERSIONS_PER_TARGET versions of each target. */
function listedVersions(entries: LedgerEntry[]): SeatContext["versions"] {
  const kept = keptVersions(entries);
  const origin = originSoulHash(entries);
  const seen = new Map<string, number>();
  const keep = new Set<number>();
  for (let i = kept.length - 1; i >= 0; i--) {
    const v = kept[i]!;
    const n = seen.get(v.target) ?? 0;
    if (n < VERSIONS_PER_TARGET || (v.target === "soul" && v.hash === origin)) keep.add(i);
    seen.set(v.target, n + 1);
  }
  return kept.filter((_, i) => keep.has(i)).map(({ target, hash, at, how }) => ({ target, hash, at, how }));
}

function citizenDir(config: Config, word: string): string {
  // The word becomes a path, so it is checked here too, not only where it was admitted.
  if (!WORD_PATTERN.test(word)) throw new Refusal("invalid-record", "a citizen word is not valid");
  return join(config.paths.citizens_dir, word);
}

async function readRegularBytes(path: string, maxBytes: number): Promise<Uint8Array> {
  const st = await lstat(path);
  if (st.isSymbolicLink()) throw new Refusal("symlink", "refused a symlink where a regular file belongs");
  if (!st.isFile()) throw new Refusal("not-regular-file", "refused something that is not a regular file");
  if (st.size > maxBytes) throw new Refusal("oversize", "refused a file over its size limit");

  // O_NOFOLLOW closes the gap between lstat and open; O_NONBLOCK keeps a FIFO
  // swapped in at that moment from hanging the open. fstat then confirms the
  // open file is the one lstat saw.
  const fh = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch((e: unknown) => {
    if (errCode(e) === "ELOOP") throw new Refusal("symlink", "refused a symlink where a regular file belongs");
    throw e;
  });
  try {
    const fst = await fh.stat();
    if (!fst.isFile() || fst.ino !== st.ino || fst.dev !== st.dev) throw new Refusal("not-regular-file", "a file changed while it was being opened");
    if (fst.size > maxBytes) throw new Refusal("oversize", "refused a file over its size limit");
    const buf = new Uint8Array(maxBytes + 1);
    let n = 0;
    while (n < buf.length) {
      const { bytesRead } = await fh.read(buf, n, buf.length - n, n);
      if (bytesRead === 0) break;
      n += bytesRead;
    }
    // A file that grew after fstat is still held to the limit.
    if (n > maxBytes) throw new Refusal("oversize", "refused a file over its size limit");
    return buf.slice(0, n);
  } finally {
    await fh.close();
  }
}

/** A self file that may be absent; anything present must be a regular file. */
async function readOptional(path: string, maxBytes: number): Promise<string | null> {
  try {
    return await readRegularText(path, maxBytes);
  } catch (e) {
    if (errCode(e) === "ENOENT") return null;
    throw e;
  }
}

/** A directory the host made must be a real directory; a symlink there would route every read below it elsewhere. */
async function assertRealDir(path: string, label: string): Promise<void> {
  let st;
  try {
    st = await lstat(path);
  } catch (e) {
    if (errCode(e) === "ENOENT") throw new Refusal("invalid-record", `${label} is missing`);
    throw e;
  }
  if (st.isSymbolicLink()) throw new Refusal("symlink", `${label} is a symlink`);
  if (!st.isDirectory()) throw new Refusal("not-regular-file", `${label} is not a directory`);
}

/** Like assertRealDir, but an absent directory is simply empty. */
async function realDirExists(path: string, label: string): Promise<boolean> {
  try {
    await assertRealDir(path, label);
    return true;
  } catch (e) {
    if (e instanceof Refusal && e.code === "invalid-record") return false;
    throw e;
  }
}

async function readSkills(dir: string): Promise<{ name: string; text: string }[]> {
  if (!(await realDirExists(dir, "self/skills/"))) return [];
  const names = (await readdir(dir))
    .filter((n) => n.endsWith(".md") && WORD_PATTERN.test(n.slice(0, -3)))
    .sort();
  if (names.length > READ_LIMITS.max_skills) throw new Refusal("oversize", "self/skills/ holds more skills than a seat shows");
  const skills: { name: string; text: string }[] = [];
  for (const n of names) skills.push({ name: n.slice(0, -3), text: await readRegularText(join(dir, n), READ_LIMITS.self_file_bytes) });
  return skills;
}

/**
 * The citizen's own `file:` texts under self/, by relative path: only names
 * self-authorship would accept as a `file:` target, only regular files, and
 * never through a symlinked directory. Anything else, and anything past the
 * caps, is passed over unread rather than refusing the seat, so a citizen can
 * never write itself out of its own beats.
 */
async function readOwnFiles(self: string): Promise<{ path: string; text: string }[]> {
  const files: { path: string; text: string }[] = [];
  const walk = async (dir: string, rel: string[], depth: number): Promise<void> => {
    const names = (await readdir(dir)).filter((n) => !n.startsWith(".")).sort();
    for (const name of names) {
      if (files.length >= READ_LIMITS.max_files) return;
      const path = [...rel, name];
      let st;
      try {
        st = await lstat(join(dir, name));
      } catch {
        continue;
      }
      if (st.isDirectory() && depth < READ_LIMITS.max_file_depth) await walk(join(dir, name), path, depth + 1);
      else if (st.isFile() && ownFileTarget(path.join("/"))) {
        try {
          files.push({ path: path.join("/"), text: await readRegularText(join(dir, name), READ_LIMITS.self_file_bytes) });
        } catch {
          // Oversize, not UTF-8, or swapped while opening: not shown, and nothing else is refused for it.
        }
      }
    }
  };
  await walk(self, [], 1);
  return files;
}

function ownFileTarget(rel: string): boolean {
  try {
    return targetRelPath(`file:${rel}`) === rel;
  } catch {
    return false;
  }
}

/**
 * Walk letters/ oldest first (by modification time, then name) and return the
 * first letter that is unseen, a regular file within the size limit, starts
 * with a "From:" line, and comes from a sender `accept` allows. Anything else
 * is set aside unread or unshown; nothing is deleted or moved, and no error
 * here names a letter's own text.
 */
async function scanLetters(config: Config, citizen: Citizen, accept: (from: string) => boolean): Promise<Letter | null> {
  const dir = citizenDir(config, citizen.word);
  await assertRealDir(dir, "the citizen directory");
  const letters = join(dir, "letters");
  if (!(await realDirExists(letters, "letters/"))) return null;
  const receipts = join(dir, "receipts");
  const haveReceipts = await realDirExists(receipts, "receipts/");

  const names = (await readdir(letters)).filter(isPlainFileName).sort().slice(0, READ_LIMITS.max_letters_scanned);
  const candidates: { name: string; mtimeMs: number }[] = [];
  for (const name of names) {
    let st;
    try {
      st = await lstat(join(letters, name));
    } catch {
      continue;
    }
    // A symlink, dangling or not, is never mail; nor is a directory or a FIFO.
    if (!st.isFile()) continue;
    candidates.push({ name, mtimeMs: st.mtimeMs });
  }
  candidates.sort((a, b) => a.mtimeMs - b.mtimeMs || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const maxBytes = letterMaxBytes(config);
  for (const { name, mtimeMs } of candidates) {
    if (haveReceipts && (await exists(join(receipts, name)))) continue;
    let bytes: Uint8Array;
    try {
      bytes = await readRegularBytes(join(letters, name), maxBytes);
    } catch {
      continue;
    }
    const parsed = parseLetter(bytes);
    if (parsed === null || !accept(parsed.from)) continue;
    if ([...parsed.text].length > config.ceilings.letter_max_chars) continue;
    return { id: name, from: parsed.from, received_at: new Date(mtimeMs).toISOString(), text: parsed.text, sha256: sha256Hex(bytes) };
  }
  return null;
}

function letterMaxBytes(config: Config): number {
  // UTF-8 takes at most 4 bytes a character.
  return config.ceilings.letter_max_chars * 4 + READ_LIMITS.letter_header_bytes;
}

/**
 * A letter is a "From: <sender id>" line, a blank line, then the body. With
 * no From line the sender is unknown, and an unknown sender is never allowed.
 */
function parseLetter(bytes: Uint8Array): { from: string; text: string } | null {
  let raw: string;
  try {
    raw = fromUtf8(bytes);
  } catch {
    return null;
  }
  const nl = raw.indexOf("\n");
  const first = (nl === -1 ? raw : raw.slice(0, nl)).replace(/\r$/, "");
  const m = /^From:[ \t]*(\S+)[ \t]*$/.exec(first);
  if (!m) return null;
  let rest = nl === -1 ? "" : raw.slice(nl + 1);
  if (rest.startsWith("\r\n")) rest = rest.slice(2);
  else if (rest.startsWith("\n")) rest = rest.slice(1);
  return { from: m[1]!, text: rest };
}

function isPlainFileName(name: string): boolean {
  return name.length > 0 && name.length <= 255 && !name.startsWith(".") && !/[/\\\0]/.test(name);
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

function partOfDay(hour: number): NowView["part_of_day"] {
  if (hour >= 6 && hour < 12) return "morning";
  if (hour >= 12 && hour < 18) return "afternoon";
  if (hour >= 18 && hour < 22) return "evening";
  return "night";
}

function errCode(e: unknown): string | undefined {
  return typeof e === "object" && e !== null && "code" in e ? String((e as { code: unknown }).code) : undefined;
}
