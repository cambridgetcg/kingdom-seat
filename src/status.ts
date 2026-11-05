// The generated status file (3.2 "Status file", 3.1 principle 6): written
// from what the runner reads, never kept by hand. Per citizen it shows the
// last beat against its interval (by the tick's own rule), divergence, push
// refusals, unsigned commits, spend and the pinned origin. REGISTRY probes
// it. Host notes, which it reads, live in notes.ts.
import { constants } from "node:fs";
import { chmod, lstat, open, readFile, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { NO_BEACONS_ID } from "./halt.ts";
import { ledgerPath, readLedger, readRegularText, syncDir, verifyChain, type TrustedKeys } from "./ledger.ts";
import { countUnsigned, localDivergence } from "./mirror.ts";
import { creditsFromLedger } from "./signer/ceilings.ts";
import { readSpendRecord, usdToday, type SpendLine } from "./spend.ts";
import { foldState, listSeated, readCitizen, readCitizenRecord } from "./state.ts";
import { wakingLetter } from "./context.ts";
import { isDue } from "./due.ts";
import { isResultNote, lastSeatOf, readHostNotes, seatsOpenedToday } from "./notes.ts";
import { driftFromOrigin, originIntact } from "./self.ts";
import {
  Refusal,
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
  type StatusFile,
  type Timing,
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

// Host notes live in notes.ts; these names are kept here for callers that read status and notes together.
export { HOST_DETAIL_MAX, appendHostNote, hostDetailProblem, readHostNotes } from "./notes.ts";

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

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function isIso(v: unknown): v is IsoTime {
  return typeof v === "string" && ISO.test(v) && new Date(Date.parse(v)).toISOString() === v;
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

function codeOf(e: unknown): string {
  return e instanceof Refusal ? e.code : "unreadable";
}

async function ledgerExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw e;
  }
}

async function citizenStatus(deps: StatusDeps, word: Word, notes: HostNote[] | null, spendLines: SpendLine[] | null, halted: boolean): Promise<CitizenStatus> {
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
    // A citizen with a record has a ledger from the moment it is seated; a missing one is a lost history, not an empty one.
    if (!(await ledgerExists(ledgerPath(config, word)))) {
      entries = null;
      problems.push("no ledger; its history is missing, so it is not seated");
    } else entries = await readLedger(ledgerPath(config, word));
  } catch (e) {
    entries = null;
    problems.push(`the ledger does not parse (${codeOf(e)})`);
  }

  const folded = entries ? foldState(entries) : null;
  const state = citizen?.state ?? folded?.state ?? "asleep";
  const lastBeat = citizen?.last_beat_at ?? folded?.last_beat_at ?? null;
  const ownH = citizen?.cadence.interval_h ?? config.ceilings.min_beat_interval_h;
  const intervalH = Math.max(ownH, config.ceilings.min_beat_interval_h);

  const mine = (notes ?? []).filter((n) => n.word === word);
  const lastSeat = lastSeatOf(mine, word);
  const lastOutcome = mine.filter((n) => n.kind !== "push" && isResultNote(n)).at(-1)?.outcome ?? null;

  // Overdue by the tick's own rule, so status never says a beat is owed that the tick would not give:
  // only a seat that is due, more than one tick late, while HALT is lowered. Rest is not a debt.
  // A citizen never seated counts from its seating.
  let isOverdue = false;
  let awaitsYu = false;
  if (citizen) {
    const letter = await wakingLetter(config, citizen).catch(() => false);
    const since = lastSeat ?? (citizen.last_beat_at === null ? citizen.seated_at : null);
    const verdict = isDue(citizen, letter, now, config.ceilings.min_beat_interval_h, since, config.schedule);
    const graceH = config.timing.tick_interval_s / 3600;
    isOverdue = !halted && verdict.due && verdict.overdue_h > graceH;
    // A citizen whose seat would be due on the free lane, but whose runtime runs only with Yu, waits for Yu.
    awaitsYu = citizen.runtime !== "free" && isDue({ ...citizen, runtime: "free" }, letter, now, config.ceilings.min_beat_interval_h, since, config.schedule).due;
  }

  // Without a record there is no identity to check the chain against, so it is not reported as verified.
  const chain = entries && record ? verifyChainFor(entries, deps.trusted ?? null, record) : null;
  // USD from the host's spend record, which holds the seats that wrote no entry too; credits from the ledger.
  const usd = spendLines ? usdToday(spendLines, word, now, config.timezone) : null;
  const credits = entries ? creditsFromLedger(entries, now, config.timezone) : null;

  // The pinned origin: unknown stays null, and a changed one is a problem, because drift is measured against it.
  let origin: CitizenStatus["origin"] = { intact: null, drift: null };
  if (entries && entries.length > 0) {
    const intact = await originIntact(config, word, entries).catch(() => null);
    const drift = intact ? await driftFromOrigin(config, word).then((d) => d.fraction).catch(() => null) : null;
    origin = { intact, drift };
    if (intact === false) problems.push("origin/ no longer matches the origin its record pinned");
  }

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
    awaits_yu: awaitsYu,
    last_outcome: lastOutcome,
    ledger: {
      entries: entries?.length ?? 0,
      head: entries?.at(-1)?.hash ?? null,
      chain_ok: chain?.ok ?? false,
      host_attested: entries?.filter((e) => e.attestation === "host-attested").length ?? 0,
    },
    mirror,
    usd_today: usd,
    credits_month: credits,
    origin,
    problem: problems.length > 0 ? problems.join("; ") : null,
  };
}

function verifyChainFor(entries: LedgerEntry[], trusted: Pick<TrustedKeys, "host_attest_b64"> | null, record: CitizenRecord) {
  // An empty trust list confirms no host-attested entry: unknown trust fails closed.
  return verifyChain(entries, { host_attest_b64: trusted?.host_attest_b64 ?? [], identity: record.identity });
}

/**
 * The longest a tick holds its lock: one seat's deadline and TERM grace, plus
 * two minutes for selection, the host notes and the status refresh. A lock
 * with no owner that is older than this was left by a process that died.
 */
export function tickLockMaxHoldMs(timing: Timing): number {
  return (timing.seat_deadline_s + timing.term_grace_s) * 1000 + 120_000;
}

/** The tick lock as the tick would judge it, read without taking it. */
async function tickLockView(config: Config): Promise<StatusFile["tick_lock"]> {
  let mtimeMs: number;
  try {
    const st = await lstat(config.paths.lock_dir);
    mtimeMs = st.mtimeMs;
  } catch {
    return { state: "free", since: null };
  }
  try {
    const owner = JSON.parse(await readFile(join(config.paths.lock_dir, "owner.json"), "utf8")) as { started_at?: unknown };
    if (isIso(owner.started_at)) return { state: "held", since: owner.started_at };
  } catch {
    // no readable owner
  }
  const since = new Date(mtimeMs).toISOString();
  return Date.now() - mtimeMs > tickLockMaxHoldMs(config.timing) ? { state: "stuck", since } : { state: "held", since };
}

/** Build the whole status from citizen records, ledgers, host notes and mirror state. */
export async function buildStatus(deps: StatusDeps): Promise<StatusFile> {
  const { config, now } = deps;
  const notes = await readHostNotes(config, new Date(0));
  const halt = haltSection(deps.halt);
  // An unreadable log is a count no one can know: null, which the tick treats as at-ceiling.
  const beatsToday = notes === null ? null : seatsOpenedToday(notes, now, config.timezone);

  const spendLines = await readSpendRecord(config);
  const citizens: CitizenStatus[] = [];
  for (const word of await statusWords(config)) citizens.push(await citizenStatus(deps, word, notes, spendLines, halt.halted));
  return {
    format: "kingdom-seat-status/v1",
    generated_at: now.toISOString(),
    host: config.host,
    halt,
    signer: { state: deps.signerState, since: await signerSince(config.paths.status_file, deps.signerState, now) },
    fleet: { beats_today: beatsToday, ceiling: config.ceilings.fleet_beats_per_day },
    tick_lock: await tickLockView(config),
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

function money(usd: string | null): string {
  return usd === null ? "spend unknown today" : `$${usd} today`;
}

function citizenLine(c: CitizenStatus): string {
  const parts = [
    `${c.word}: ${c.state}`,
    c.runtime ?? "runtime unknown",
    c.registered ? "registered" : "not registered",
    c.last_beat_at ? `last beat ${c.last_beat_at}` : "no beat yet",
    `every ${c.interval_h} h`,
    c.overdue ? "OVERDUE" : c.awaits_yu ? "awaits Yu" : "not overdue",
    `last ${c.last_outcome ?? "nothing"}`,
    `ledger ${c.ledger.entries} entries, chain ${c.ledger.chain_ok ? "ok" : "NOT verified"}, ${c.ledger.host_attested} host-attested`,
  ];
  if (c.mirror) {
    parts.push(
      `mirror ${c.mirror.divergence ?? "unchecked"}, ${c.mirror.push_refusals} push refusals, ${c.mirror.unsigned_commits === null ? "unsigned commits unknown" : `${c.mirror.unsigned_commits} unsigned commits`}`,
    );
  }
  parts.push(money(c.usd_today), c.credits_month === null ? "credits unknown this month" : `${c.credits_month} credits this month`);
  parts.push(
    c.origin.intact === null ? "origin unchecked" : c.origin.intact ? `origin intact, soul drift ${c.origin.drift === null ? "unknown" : `${Math.round(c.origin.drift * 100)}%`}` : "origin CHANGED",
  );
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
    status.tick_lock.state === "stuck"
      ? `tick lock: STUCK since ${status.tick_lock.since}; every tick exits 1 until a person removes it`
      : `tick lock: ${status.tick_lock.state}${status.tick_lock.since ? ` since ${status.tick_lock.since}` : ""}`,
  ];
  if (status.citizens.length === 0) lines.push("no citizens seated");
  for (const c of status.citizens) lines.push(citizenLine(c));
  return `${lines.join("\n")}\n`;
}
