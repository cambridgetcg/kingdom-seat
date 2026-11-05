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
import { lstat, mkdir, open, readdir } from "node:fs/promises";
import { join } from "node:path";
import { sha256Hex } from "./crypto.ts";
import { ACT_LIMITS } from "./acts.ts";
import { targetRelPath } from "./self.ts";
import { Refusal, WORD_PATTERN, type Citizen, type Config, type Letter, type LedgerEntry, type NowView, type SeatContext, type SeatLimits, type SeatRef, type SelfProposal } from "./types.ts";

// Strict, and keeping a byte-order mark: the text shown is exactly the bytes
// read, so a hash checked on the bytes is a hash of what the citizen sees.
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const fromUtf8 = (bytes: Uint8Array): string => decoder.decode(bytes);

export interface ContextDeps {
  config: Config;
  now: Date;
}

/** Caps on what is read, so one oversize file refuses instead of filling the model's window. */
export const READ_LIMITS = Object.freeze({
  self_file_bytes: 64 * 1024,
  canon_bytes: 256 * 1024,
  max_skills: 32,
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

/** The oldest unseen letter from an allowed sender, read as a regular file; symlinks and others are set aside, never counted as mail. */
export async function pickLetter(config: Config, citizen: Citizen): Promise<Letter | null> {
  const allowed = new Set(citizen.covenants.letters_from);
  return scanLetters(config, citizen, (from) => allowed.has(from));
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
    letter_max_chars: Math.min(c.letter_max_chars, ACT_LIMITS.max_body_chars),
    letter_sends_per_beat: Math.min(c.letter_sends_per_beat, 1),
    min_beat_interval_h: c.min_beat_interval_h,
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

/** Assemble the whole context for one seat. */
export async function buildContext(deps: ContextDeps, seat: SeatRef, citizen: Citizen, recent: LedgerEntry[], pending: SelfProposal[]): Promise<SeatContext> {
  if (seat.word !== citizen.word) throw new Refusal("invalid-request", "the seat was opened for a different citizen");
  const k = Math.max(0, Math.floor(deps.config.ceilings.ledger_context_entries));
  // Only the citizen's own entries and proposals; a sibling's words arrive only as letters.
  const own = recent.filter((e) => e.word === citizen.word);
  return {
    seat_ref: seat,
    self: await readSelf(deps.config, citizen),
    origin: citizen.origin,
    canon_text: await readCanon(deps.config, citizen),
    recent: k === 0 ? [] : own.slice(-k),
    state: citizen.state,
    pending_state: citizen.pending_state,
    pending_proposals: pending.filter((p) => p.word === citizen.word && p.status === "pending"),
    now: describeNow(deps.now, deps.config.timezone),
    letter: await pickLetter(deps.config, citizen),
    invoker: seat.invoker,
    cadence: { ...citizen.cadence },
    covenants: { letters_from: [...citizen.covenants.letters_from], wake_on_letter_from: [...citizen.covenants.wake_on_letter_from] },
    limits: seatLimits(deps.config),
  };
}

/* ── Internals ────────────────────────────────────────────────────────── */

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
