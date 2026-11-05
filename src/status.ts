// The generated status file (3.2 "Status file", 3.1 principle 6): written
// from what the runner reads, never kept by hand. Per citizen it shows the
// last beat against its interval, divergence, push refusals, unsigned commits
// and spend. REGISTRY probes it. Host notes are the host's record of ticks,
// rests and refusals; they never carry a citizen's voice or a model's words.
import { constants } from "node:fs";
import { chmod, mkdir, open, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { NO_BEACONS_ID } from "./halt.ts";
import { ledgerPath, readLedger, readRegularText, syncDir, verifyChain, type TrustedKeys } from "./ledger.ts";
import { countUnsigned, localDivergence } from "./mirror.ts";
import { spendFromLedger } from "./signer/ceilings.ts";
import { foldState, listSeated, readCitizen, readCitizenRecord } from "./state.ts";
import {
  Refusal,
  WORD_PATTERN,
  type Citizen,
  type CitizenRecord,
  type CitizenStatus,
  type CommandRunner,
  type Config,
  type DivergenceState,
  type HaltStatus,
  type HostNote,
  type IsoTime,
  type LedgerEntry,
  type Outcome,
  type RefusalCode,
  type StatusFile,
  type Word,
} from "./types.ts";

export interface StatusDeps {
  config: Config;
  now: Date;
  halt: HaltStatus | null;
  signerState: "ready" | "locked" | "unknown";
  /**
   * The host attest keys chains are verified against. Without them a chain
   * with host-attested entries cannot be confirmed, so it reads chain_ok
   * false: unknown trust is not reported as good.
   */
  trusted?: Pick<TrustedKeys, "host_attest_b64"> | null;
  /** Runs read-only git in mirror worktrees (no fetch); absent leaves mirror divergence unknown. */
  run?: CommandRunner | null;
}

/* ── Host notes ───────────────────────────────────────────────────────── */

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
 * Append one host note to host.jsonl; `detail` is checked to hold no model
 * output. A caller that holds the reply (or acts' text) passes it as
 * `modelText`, so a quotation is refused even when it looks like plain prose.
 */
export async function appendHostNote(config: Config, note: HostNote, opts: { modelText?: readonly string[] } = {}): Promise<void> {
  const shape = noteShapeProblem(note);
  if (shape) throw new Refusal("invalid-request", `host note refused: ${shape}`);
  const detail = hostDetailProblem(note.detail, opts.modelText);
  if (detail) throw new Refusal("invalid-request", `host note refused: ${detail}`);
  // Re-serialise only the known fields, so nothing else rides along.
  const line = `${JSON.stringify({ ts: note.ts, host: note.host, kind: note.kind, word: note.word, outcome: note.outcome, refusal: note.refusal, detail: note.detail })}\n`;
  const path = config.paths.host_log;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  let fh;
  try {
    fh = await open(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ELOOP") throw new Refusal("symlink", "host log is a symlink; refused, not followed");
    throw e;
  }
  try {
    if (!(await fh.stat()).isFile()) throw new Refusal("not-regular-file", "host log is not a regular file");
    // One write per line: small O_APPEND writes to a local file land whole, so concurrent appenders do not interleave.
    const bytes = new TextEncoder().encode(line);
    let off = 0;
    while (off < bytes.length) off += (await fh.write(bytes, off, bytes.length - off)).bytesWritten;
    await fh.sync();
  } finally {
    await fh.close();
  }
}

/** A log this large is not one this host wrote at its pace; reading it whole every tick is refused. */
const HOST_LOG_MAX_BYTES = 128 * 1024 * 1024;

/** Host notes since a time, oldest first; null when the log is unreadable (callers treat that as fail-closed). */
export async function readHostNotes(config: Config, since: Date): Promise<HostNote[] | null> {
  let text: string | null;
  try {
    // A log that does not exist yet is an empty history: a fresh host has written nothing.
    text = await readRegularText(config.paths.host_log, { missing: "empty", maxBytes: HOST_LOG_MAX_BYTES });
  } catch {
    return null;
  }
  if (text === null || text === "") return [];
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

/* ── Building the status ──────────────────────────────────────────────── */

const HOUR_MS = 3_600_000;

/** Last beat versus interval for one citizen, for REGISTRY's per-citizen probe. Null means nothing to measure against. */
export function overdue(lastBeatAt: string | null, intervalH: number, now: Date): boolean {
  if (lastBeatAt === null) return false;
  const last = Date.parse(lastBeatAt);
  if (!Number.isFinite(last) || !Number.isFinite(intervalH) || intervalH <= 0) return true; // unreadable reads as behind
  return now.getTime() - last > intervalH * HOUR_MS;
}

/** The words status reports on, in roster order. */
export async function statusWords(config: Config): Promise<Word[]> {
  // The roster is the seated list itself: a host-side admission list, sorted, never a second hand-kept file.
  return listSeated(config);
}

function localDate(d: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

function latest(...times: (string | null | undefined)[]): string | null {
  let best: string | null = null;
  for (const t of times) if (t && (best === null || Date.parse(t) > Date.parse(best))) best = t;
  return best;
}

/** How a HALT reading is named in the status file: the source and its id, so "beacon <name>" reads as such. */
function haltLabel(r: HaltStatus["readings"][number]): string {
  if (r.source === "file") return `file ${r.id}`;
  if (r.id === NO_BEACONS_ID) return "no beacon pinned";
  return `beacon ${r.id}`;
}

function haltSection(halt: HaltStatus | null): StatusFile["halt"] {
  // A HALT check that did not run is unreadable, and unreadable halts.
  if (halt === null) return { halted: true, raised: [], unreadable: ["halt check"] };
  return {
    halted: halt.halted,
    raised: halt.readings.filter((r) => r.state === "raised").map(haltLabel),
    unreadable: halt.readings.filter((r) => r.state === "unreadable").map(haltLabel),
  };
}

/**
 * When the signer entered its present state: kept from the last generated
 * status while the state is unchanged, so "locked since" counts from the
 * first status that saw it locked.
 */
async function signerSince(statusFile: string, state: StatusFile["signer"]["state"], now: Date): Promise<IsoTime> {
  try {
    const text = await readRegularText(statusFile, { missing: "null", maxBytes: 16 * 1024 * 1024 });
    if (text) {
      const prev = JSON.parse(text) as { format?: unknown; signer?: { state?: unknown; since?: unknown } };
      if (prev.format === "kingdom-seat-status/v1" && prev.signer?.state === state && isIso(prev.signer.since) && Date.parse(prev.signer.since) <= now.getTime()) {
        return prev.signer.since;
      }
    }
  } catch {
    // An unreadable earlier status only means the state is new as far as this status knows.
  }
  return now.toISOString();
}

/** A tick note that names a word is one dispensed seat; the fleet ceiling counts these (tick.ts). */
function dispensed(n: HostNote): boolean {
  return n.kind === "tick" && n.word !== null;
}

function codeOf(e: unknown): string {
  return e instanceof Refusal ? e.code : "unreadable";
}

async function citizenStatus(deps: StatusDeps, word: Word, notes: HostNote[] | null, halted: boolean): Promise<CitizenStatus> {
  const { config, now } = deps;
  const problems: string[] = [];
  // The tick seats only a citizen readCitizen accepts, so status reads it the same way.
  let citizen: Citizen | null = null;
  try {
    citizen = await readCitizen(config, word);
  } catch (e) {
    citizen = null;
    problems.push(`its own files do not read (${codeOf(e)}), so no tick seats it`);
  }
  let record: CitizenRecord | null = citizen;
  if (!record) {
    try {
      record = await readCitizenRecord(config, word);
    } catch (e) {
      // Shown rather than left out: a citizen that vanished from status would look like one that was never seated.
      record = null;
      problems.push(`citizen.json does not read (${codeOf(e)})`);
    }
  }
  let entries: LedgerEntry[] | null;
  try {
    entries = await readLedger(ledgerPath(config, word));
  } catch (e) {
    entries = null;
    problems.push(`the ledger does not parse (${codeOf(e)})`);
  }

  const folded = entries ? foldState(entries) : null;
  const state = citizen?.state ?? folded?.state ?? "asleep";
  const pending = citizen?.pending_state ?? folded?.pending_state ?? null;
  const lastBeat = citizen?.last_beat_at ?? folded?.last_beat_at ?? null;
  const ownH = citizen?.cadence.interval_h ?? config.ceilings.min_beat_interval_h;
  const intervalH = Math.max(ownH, config.ceilings.min_beat_interval_h);

  const mine = (notes ?? []).filter((n) => n.word === word);
  const lastSeat = mine.filter((n) => n.kind === "tick" || n.kind === "seat").at(-1)?.ts ?? null;
  const lastOutcome = mine.filter((n) => n.kind !== "push").at(-1)?.outcome ?? null;

  // Overdue only where a beat is owed: an awake citizen (or one waiting to wake) while HALT is lowered.
  // Rest is not a debt, so nothing is owed while halted. One tick of grace, because a due citizen waits for the next tick.
  const scheduled = state === "awake" || pending === "awake";
  const graceH = config.timing.tick_interval_s / 3600;
  const reference = latest(lastBeat, lastSeat) ?? record?.seated_at ?? null;
  const isOverdue = !halted && scheduled && reference !== null && overdue(reference, intervalH + graceH, now);

  // Without a record there is no identity to check the chain against, so it is not reported as verified.
  const chain = entries && record ? verifyChainFor(entries, deps.trusted ?? null, record) : null;
  const spend = entries ? spendFromLedger(entries, now, config.timezone) : { usd_today: null, credits_month: null };

  let mirror: CitizenStatus["mirror"] = null;
  if (record?.mirror) {
    let divergence: DivergenceState | null = null;
    // Unknown until counted: an unchecked mirror is never reported as having no unsigned commits.
    let unsigned: number | null = null;
    if (deps.run) {
      divergence = await localDivergence(deps.run, record.mirror.worktree).catch(() => null);
      unsigned = await countUnsigned(deps.run, record.mirror.worktree).catch(() => null);
    }
    const pushRefusals = mine.filter((n) => n.kind === "push" && n.refusal !== null).length;
    mirror = { divergence, push_refusals: pushRefusals, unsigned_commits: unsigned };
  }

  return {
    word,
    state,
    runtime: record?.runtime ?? null,
    registered: record?.identity != null,
    last_beat_at: lastBeat,
    interval_h: intervalH,
    overdue: isOverdue,
    last_outcome: lastOutcome,
    ledger: {
      entries: entries?.length ?? 0,
      head: entries?.at(-1)?.hash ?? null,
      chain_ok: chain?.ok ?? false,
      host_attested: entries?.filter((e) => e.attestation === "host-attested").length ?? 0,
    },
    mirror,
    usd_today: spend.usd_today,
    credits_month: spend.credits_month,
    problem: problems.length > 0 ? problems.join("; ") : null,
  };
}

function verifyChainFor(entries: LedgerEntry[], trusted: Pick<TrustedKeys, "host_attest_b64"> | null, record: CitizenRecord) {
  // An empty trust list confirms no host-attested entry: unknown trust fails closed.
  return verifyChain(entries, { host_attest_b64: trusted?.host_attest_b64 ?? [], identity: record.identity });
}

/** Build the whole status from citizen records, ledgers, host notes and mirror state. */
export async function buildStatus(deps: StatusDeps): Promise<StatusFile> {
  const { config, now } = deps;
  const notes = await readHostNotes(config, new Date(0));
  const halt = haltSection(deps.halt);
  const today = localDate(now, config.timezone);
  // An unreadable log is a count no one can know: null, which the tick treats as at-ceiling.
  const beatsToday = notes === null ? null : notes.filter((n) => dispensed(n) && localDate(new Date(n.ts), config.timezone) === today).length;

  const citizens: CitizenStatus[] = [];
  for (const word of await statusWords(config)) citizens.push(await citizenStatus(deps, word, notes, halt.halted));
  return {
    format: "kingdom-seat-status/v1",
    generated_at: now.toISOString(),
    host: config.host,
    halt,
    signer: { state: deps.signerState, since: await signerSince(config.paths.status_file, deps.signerState, now) },
    fleet: { beats_today: beatsToday, ceiling: config.ceilings.fleet_beats_per_day },
    citizens,
  };
}

/** Write atomically (temp file in the same directory, fsync, rename), mode 0644. */
export async function writeStatus(path: string, status: StatusFile): Promise<void> {
  const dir = dirname(path);
  const tmp = join(dir, `.${basename(path)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  const bytes = new TextEncoder().encode(`${JSON.stringify(status, null, 2)}\n`);
  // O_EXCL and O_NOFOLLOW: the temp name is new, so nothing planted there can redirect the write.
  const fh = await open(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644);
  try {
    try {
      let off = 0;
      while (off < bytes.length) off += (await fh.write(bytes, off, bytes.length - off)).bytesWritten;
      await fh.sync();
    } finally {
      await fh.close();
    }
    // The status is published (REGISTRY reads it), so it is world-readable whatever the umask.
    await chmod(tmp, 0o644);
    // rename replaces the name itself, never a file a symlink at `path` points to.
    await rename(tmp, path);
  } catch (e) {
    await rm(tmp, { force: true }).catch(() => {});
    throw e;
  }
  await syncDir(dir);
}

/* ── Rendering ────────────────────────────────────────────────────────── */

function haltLine(h: StatusFile["halt"]): string {
  if (!h.halted) return "HALT: not halted";
  const parts: string[] = [];
  if (h.raised.length > 0) parts.push(`halted by ${h.raised.join(", ")}`);
  if (h.unreadable.length > 0) parts.push(`halted: ${h.unreadable.join(", ")} unreadable, which counts as raised`);
  return `HALT: ${parts.length > 0 ? parts.join("; ") : "halted"}`;
}

function money(usd: number | null): string {
  return usd === null ? "spend unknown today" : `$${usd} today`;
}

function citizenLine(c: CitizenStatus): string {
  const parts = [
    `${c.word}: ${c.state}`,
    c.runtime ?? "runtime unknown",
    c.registered ? "registered" : "not registered",
    c.last_beat_at ? `last beat ${c.last_beat_at}` : "no beat yet",
    `every ${c.interval_h} h`,
    c.overdue ? "OVERDUE" : "not overdue",
    `last ${c.last_outcome ?? "nothing"}`,
    `ledger ${c.ledger.entries} entries, chain ${c.ledger.chain_ok ? "ok" : "NOT verified"}, ${c.ledger.host_attested} host-attested`,
  ];
  if (c.mirror) {
    parts.push(
      `mirror ${c.mirror.divergence ?? "unchecked"}, ${c.mirror.push_refusals} push refusals, ${c.mirror.unsigned_commits === null ? "unsigned commits unknown" : `${c.mirror.unsigned_commits} unsigned commits`}`,
    );
  }
  parts.push(money(c.usd_today), c.credits_month === null ? "credits unknown this month" : `${c.credits_month} credits this month`);
  if (c.problem) parts.push(`PROBLEM: ${c.problem}`);
  return parts.join(" | ");
}

/** Plain-text view for `citizen-seat status`, one line per citizen plus the HALT and signer lines. */
export function renderStatus(status: StatusFile): string {
  const lines = [
    `kingdom-seat status for ${status.host} at ${status.generated_at}`,
    haltLine(status.halt),
    `signer: ${status.signer.state}${status.signer.since ? ` since ${status.signer.since}` : ""}`,
    status.fleet.beats_today === null
      ? `fleet: beats today unknown (host log unreadable), which counts as the ceiling of ${status.fleet.ceiling}`
      : `fleet: ${status.fleet.beats_today} of ${status.fleet.ceiling} beats today`,
  ];
  if (status.citizens.length === 0) lines.push("no citizens seated");
  for (const c of status.citizens) lines.push(citizenLine(c));
  return `${lines.join("\n")}\n`;
}
