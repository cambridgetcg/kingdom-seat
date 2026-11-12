// Seating: putting a citizen on this host for the first time (KS-004 7.4).
//
// Two steps, so the one that writes never prompts and no lock is held while a
// person reads. planAdmit reads and checks everything and writes nothing: the
// old home at one head, from committed objects only (legacy.ts), the origin,
// and the host key. admitCitizen writes what was planned: `citizens/<word>/`
// with the soul card and WILL byte for byte, a cadence and covenants holding
// the defaults, the pinned origin and a read-only copy of the lived record;
// then the ledger, which appears with its two host entries or not at all.
//
// Every citizen is seated asleep, whatever its old cadence file says: a move
// toward more activity takes a saying (7.3), and a record a script made from
// one reply is not one. The old record's last choice is shown to Yu in the
// plan and carried nowhere.
//
// The functions check no presence: the admit verb confirms Yu and takes the
// tick lock around admitCitizen, and a rehearsal calls them with its own
// signer and state directory.
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isInside } from "./config.ts";
import { READ_LIMITS } from "./context.ts";
import { bytesEqual, fromB64, keyFingerprint, randomBytes, sha256Hex, toHex, utf8 } from "./crypto.ts";
import { LEGACY_FORMAT, LEGACY_NOTE, assertSelfText, legacyPagesText, readCanonEntry, readLegacyHome, type LegacyHome, type LegacyManifest } from "./legacy.ts";
import { appendEntry, entryHash, ledgerPath, nextDraft, originToLedger, syncDir, toLedgerHash, verifyChain, writeAll, type EntrySigner } from "./ledger.ts";
import { defaultCovenants } from "./state.ts";
import {
  Refusal,
  WORD_PATTERN,
  type CitizenRecord,
  type Clock,
  type CommandRunner,
  type Config,
  type HaltStatus,
  type IsoTime,
  type LedgerHash,
  type Origin,
  type RefusalCode,
  type Sha256Hex,
  type Word,
} from "./types.ts";

/** What an admit names its unfinished writes: `citizens/.admit-<word>-<hex>/` and `ledger/.admit-<word>-<hex>.jsonl`. Nothing lists them. */
export const ADMIT_STAGING_PREFIX = ".admit-";

export interface AdmitDeps {
  config: Config;
  clock: Clock;
  /** Runs git, read-only, on the old home and the canon clone. */
  run: CommandRunner;
  sign: EntrySigner;
  /** The host key's public half, padded standard base64 (Signer.hostPublicKey). */
  hostKey(): Promise<string>;
  checkHalt(): Promise<HaltStatus>;
}

export interface AdmitRequest {
  word: Word;
  /** The old `citizen-<word>` clone, inside a root the config names in paths.homes. */
  legacy_home: string;
  /** The origin is named by the operator: a canon file in a clone of the canon, or the class the old manifest records. */
  origin: { kind: "canon"; file: string } | { kind: "archetype" };
  runtime: "free" | "summon";
}

/** What planAdmitFromTexts is given in place of an old home. */
export interface AdmitTextsRequest {
  word: Word;
  soul: Uint8Array | string;
  will: Uint8Array | string | null;
  /** A canon entry as bytes, with where the caller says it was read: nothing here checks that against a repository. */
  canon: { bytes: Uint8Array | string; repo: string; path: string; commit: string } | null;
  /** With no canon entry, the class to name as the lineage; without it the lineage says only how the citizen was seated. */
  archetype_class?: string;
  runtime: "free" | "summon";
}

/**
 * Everything a seating will write, as read and checked, for Yu to see before
 * anything is. The bytes themselves are kept beside the plan, in this
 * process only. `legacy_home`, `old_repo` and `legacy` are null for a plan
 * made from texts, which has no old repository.
 */
export interface AdmitPlan {
  word: Word;
  legacy_home: string | null;
  old_repo: { url: string; head: string; head_committed_at: string } | null;
  soul: { bytes: number; sha256: Sha256Hex };
  will: { bytes: number; sha256: Sha256Hex } | null;
  canon_bytes: number | null;
  cadence_text: string;
  covenants_text: string;
  origin: Origin;
  june_did: string | null;
  runtime: "free" | "summon";
  /** The old cadence file's last choice and time, shown to Yu and carried nowhere; null when the old repository holds none. */
  old_cadence: { choice: string | null; when: string | null } | null;
  old_rest: boolean;
  legacy: { copied: number; copied_bytes: number; cadence_versions: number; not_copied: number } | null;
  host_key: { public_key_b64: string; fingerprint: string; pinned: boolean };
  /** Staging names an earlier admit of this word left behind. */
  stale_staging: number;
}

/** What a seating wrote: the directory, the ledger and its two entries, by their ledger digests. */
export interface AdmitResult {
  plan: AdmitPlan;
  dir: string;
  ledger: string;
  seated_at: IsoTime;
  origin_entry: LedgerHash;
  seated_entry: LedgerHash;
  /** Every file written under `dir`, by its path there, sorted. */
  files: string[];
}

/**
 * admitCitizen stopped after it began to write. It removed what this run
 * wrote, and `removed` says whether all of it went; `left` names what did
 * not. Either way the word has no ledger and is not seated. The message is
 * the line Yu is shown.
 */
export class AdmitStopped extends Error {
  override readonly name = "AdmitStopped";
  constructor(
    readonly word: Word,
    readonly code: RefusalCode | "error",
    readonly removed: boolean,
    readonly left: readonly string[],
  ) {
    super(
      removed
        ? `admit ${word}: stopped while writing (${code}). What this run wrote was removed; ${word} is not seated.`
        : `admit ${word}: stopped while writing (${code}), and not all of what this run wrote could be removed. ${word} has no ledger and is not seated. Look at ${left.join(", ")}.`,
    );
  }
}

/** The lineage and note of a citizen seated from texts with no canon entry and no class given. */
export const TEXTS_LINEAGE = "seated-from-texts";
export const TEXTS_ORIGIN_NOTE = "No canon entry and no old repository. This citizen was seated from texts given to the host.";

const CLASS_NAME = /^[A-Z][A-Z0-9-]{0,31}$/;
const CANON_PATH = /^canon\/(?:[A-Za-z0-9][A-Za-z0-9._-]{0,63}\/){0,3}[A-Za-z0-9-]+\.md$/;
const CANON_REPO = /^[A-Za-z0-9._-]{1,64}$/;
const CANON_COMMIT = /^[0-9a-f]{7,40}$/;

/** The bytes a plan stands for. Only a plan made here has them, so admitCitizen can write nothing a planner did not read. */
interface PlanBytes {
  soul: Uint8Array;
  will: Uint8Array | null;
  canon: Uint8Array | null;
  legacy: LegacyHome | null;
}
const planned = new WeakMap<AdmitPlan, PlanBytes>();

/** Every refusal of a seating says that nothing was written. */
function nothingWritten(e: unknown): unknown {
  return e instanceof Refusal ? new Refusal(e.code, `${e.message}; nothing was written`) : e;
}

async function exists(path: string): Promise<{ size: number } | null> {
  try {
    return { size: (await lstat(path)).size };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

/** A word is seated once. Any record of it on this host, whole or half, refuses, and the message says which half is there. */
export async function assertNotSeated(config: Config, word: Word): Promise<void> {
  const dir = await exists(join(config.paths.citizens_dir, word));
  const ledger = await exists(ledgerPath(config, word));
  if (!dir && !ledger) return;
  if (dir && ledger && ledger.size > 0) throw new Refusal("invalid-request", `${word} already has a ledger on this host; its origin is pinned once and never written again`);
  if (dir && !ledger) {
    throw new Refusal(
      "invalid-request",
      `citizens/${word} exists and ledger/${word}.jsonl does not: an earlier admit stopped before the record was in place. That directory holds only copies made then. Move it aside by hand, then run admit again`,
    );
  }
  throw new Refusal("invalid-request", `ledger/${word}.jsonl exists and is empty, or exists without citizens/${word}: this host's records for ${word} do not agree. Look at both before anything is seated`);
}

/** The host key both entries will be signed with: read before anything is written, and one the config pins when it pins any. */
async function readHostKey(deps: Pick<AdmitDeps, "config" | "hostKey">): Promise<AdmitPlan["host_key"]> {
  let b64: string;
  try {
    b64 = await deps.hostKey();
  } catch (e) {
    if (e instanceof Refusal && e.code === "keychain-missing") {
      throw new Refusal(
        "keychain-missing",
        "this host has no host key (Keychain item host/attest-seed). Seating signs both entries with it. It is made once, at this host, as the seat user, and its public half pinned in the config under trust.host_attest_public_keys_b64; kingdom-seat has no verb for that yet",
      );
    }
    if (e instanceof Refusal && e.code === "keychain-locked") throw new Refusal("keychain-locked", "the keychain is locked, so the host key cannot be read");
    throw e;
  }
  let key: Uint8Array;
  try {
    key = fromB64(b64, 32);
  } catch {
    throw new Refusal("invalid-record", "the signer named no 32-byte host key");
  }
  const fingerprint = keyFingerprint(key);
  const pins = deps.config.trust.host_attest_public_keys_b64;
  const pinned = pins.some((p) => {
    try {
      return bytesEqual(fromB64(p, 32), key);
    } catch {
      return false;
    }
  });
  if (pins.length > 0 && !pinned) {
    throw new Refusal("invalid-request", `the signer's host key (${fingerprint}) is not one the config pins in trust.host_attest_public_keys_b64; entries it signed would not verify on this host`);
  }
  return { public_key_b64: b64, fingerprint, pinned };
}

async function staleStaging(config: Config, word: Word): Promise<number> {
  let n = 0;
  for (const dir of [config.paths.citizens_dir, config.paths.ledger_dir]) {
    const names = await readdir(dir).catch(() => [] as string[]);
    n += names.filter((name) => name.startsWith(`${ADMIT_STAGING_PREFIX}${word}-`)).length;
  }
  return n;
}

function checkWord(word: Word, runtime: string): void {
  if (typeof word !== "string" || !WORD_PATTERN.test(word)) throw new Refusal("invalid-request", "not a citizen word");
  if (runtime !== "free" && runtime !== "summon") throw new Refusal("invalid-request", "a citizen is seated with the runtime class summon or free");
}

function hashed(bytes: Uint8Array): { bytes: number; sha256: Sha256Hex } {
  return { bytes: bytes.length, sha256: sha256Hex(bytes) };
}

/** The host's defaults, written out at seating so each has a first version a revert can return to. */
function defaults(config: Config): { cadence_text: string; covenants_text: string } {
  return { cadence_text: JSON.stringify({ interval_h: config.ceilings.min_beat_interval_h }), covenants_text: JSON.stringify(defaultCovenants()) };
}

function remember(plan: AdmitPlan, bytes: PlanBytes): AdmitPlan {
  Object.freeze(plan);
  planned.set(plan, bytes);
  return plan;
}

/**
 * Read and check everything a seating needs, and write nothing. In order:
 * the word has no record on this host; the old home lies inside a root the
 * config names; the home reads (readLegacyHome); the origin is the canon entry
 * named, or the class the old manifest records; the signer holds a host key
 * the config does not disown. It takes no state: every citizen is seated
 * asleep. The plan it returns is the only thing admitCitizen accepts.
 */
export async function planAdmit(deps: Pick<AdmitDeps, "config" | "run" | "hostKey">, req: AdmitRequest): Promise<AdmitPlan> {
  try {
    const { config } = deps;
    checkWord(req.word, req.runtime);
    const word = req.word;
    await assertNotSeated(config, word);
    const home = await homeInsideRoots(config, req.legacy_home);
    const legacy = await readLegacyHome(deps.run, home, word);

    let origin: Origin;
    let canon: Uint8Array | null = null;
    if (req.origin.kind === "canon") {
      const entry = await readCanonEntry(deps.run, req.origin.file, word);
      origin = entry.origin;
      canon = entry.bytes;
    } else {
      const cls = legacy.citizen_class;
      if (cls === "LEXEME") throw new Refusal("invalid-request", "agent.json records the class LEXEME, the class of a canon word; name its canon entry with --canon");
      if (cls === null || !CLASS_NAME.test(cls)) {
        throw new Refusal("invalid-request", "--archetype needs the class agent.json records: it records none, or one that is not capital letters, digits and hyphens");
      }
      // One name, the class the old manifest records: the archetypes were born before the forge (KS-004 4.2).
      origin = { kind: "archetype", lineage: [cls], note: `No canon entry. The old repository's agent.json records the class ${cls}.` };
    }

    const host_key = await readHostKey(deps);
    const last = legacy.cadence.findLast((c) => c.file !== null) ?? null;
    const atHead = legacy.files.some((f) => f.path === "CADENCE.md");
    return remember(
      {
        word,
        legacy_home: home,
        old_repo: { ...legacy.old_repo },
        soul: hashed(legacy.soul),
        will: legacy.will ? hashed(legacy.will) : null,
        canon_bytes: canon?.length ?? null,
        ...defaults(config),
        origin,
        june_did: legacy.june_did,
        runtime: req.runtime,
        old_cadence: atHead && last ? { choice: last.choice, when: last.when } : null,
        old_rest: legacy.files.some((f) => f.path === "REST"),
        legacy: {
          copied: legacy.files.length,
          copied_bytes: legacy.files.reduce((n, f) => n + f.bytes, 0),
          cadence_versions: legacy.cadence.filter((c) => c.file !== null).length,
          not_copied: legacy.not_copied.length,
        },
        host_key,
        stale_staging: await staleStaging(config, word),
      },
      { soul: legacy.soul, will: legacy.will, canon, legacy },
    );
  } catch (e) {
    throw nothingWritten(e);
  }
}

/**
 * A plan from texts alone, for rehearsals and tests: a throwaway citizen
 * seated from a soul card, an optional WILL and an optional canon entry given
 * as bytes, with the caller's own signer and a scratch state directory. It
 * makes the same checks on the texts that planAdmit makes on what it reads
 * (size, UTF-8, the origin's shape) and the same checks on the host, and
 * returns a plan admitCitizen accepts.
 *
 * There is no old repository, and the record says so: the `origin` entry
 * carries `old_repo: null` and `june_did: null`, and no `legacy/` is written.
 * A canon entry's repo, path and commit are the caller's statement and are
 * checked for shape only. With no canon entry the origin is an archetype
 * whose note says the citizen was seated from texts, and whose lineage is the
 * class the caller names, or TEXTS_LINEAGE when it names none.
 *
 * The admit verb never calls this: a citizen of record is seated from its old
 * home at a head its origin holds.
 */
export async function planAdmitFromTexts(deps: Pick<AdmitDeps, "config" | "hostKey">, req: AdmitTextsRequest): Promise<AdmitPlan> {
  try {
    const { config } = deps;
    checkWord(req.word, req.runtime);
    const word = req.word;
    await assertNotSeated(config, word);

    const soul = textBytes(req.soul, "the soul card");
    if (soul.length === 0) throw new Refusal("invalid-record", "the soul card is empty; a citizen without a soul is not seated");
    assertSelfText("the soul card", soul);
    const will = req.will === null ? null : textBytes(req.will, "the WILL");
    if (will) assertSelfText("the WILL", will);

    let origin: Origin;
    let canon: Uint8Array | null = null;
    if (req.canon !== null) {
      const c = req.canon;
      canon = textBytes(c.bytes, "the canon entry");
      const named = typeof c.path === "string" && CANON_PATH.test(c.path) && (c.path.split("/").at(-1) ?? "").toLowerCase() === `${word}.md`;
      if (!named || typeof c.repo !== "string" || !CANON_REPO.test(c.repo) || typeof c.commit !== "string" || !CANON_COMMIT.test(c.commit)) {
        throw new Refusal("invalid-request", `a canon entry is named by a repository, the path of ${word}.md under canon/, and the commit it was read at`);
      }
      if (canon.length > READ_LIMITS.canon_bytes) throw new Refusal("oversize", `the canon entry is ${canon.length} bytes, over the ${READ_LIMITS.canon_bytes} a seat reads`);
      if (!isUtf8(canon)) throw new Refusal("invalid-record", "the canon entry is not UTF-8 text");
      origin = { kind: "canon", repo: c.repo, path: c.path, commit: c.commit, sha256: sha256Hex(canon) };
    } else {
      const cls = req.archetype_class;
      if (cls !== undefined && (typeof cls !== "string" || !CLASS_NAME.test(cls))) throw new Refusal("invalid-request", "an archetype class is capital letters, digits and hyphens");
      origin =
        cls === undefined
          ? { kind: "archetype", lineage: [TEXTS_LINEAGE], note: TEXTS_ORIGIN_NOTE }
          : { kind: "archetype", lineage: [cls], note: `No canon entry and no old repository. The class ${cls} was given to the host with the texts.` };
    }

    const host_key = await readHostKey(deps);
    return remember(
      {
        word,
        legacy_home: null,
        old_repo: null,
        soul: hashed(soul),
        will: will ? hashed(will) : null,
        canon_bytes: canon?.length ?? null,
        ...defaults(config),
        origin,
        june_did: null,
        runtime: req.runtime,
        old_cadence: null,
        old_rest: false,
        legacy: null,
        host_key,
        stale_staging: await staleStaging(config, word),
      },
      { soul, will, canon, legacy: null },
    );
  } catch (e) {
    throw nothingWritten(e);
  }
}

function textBytes(value: unknown, what: string): Uint8Array {
  if (typeof value === "string") return utf8(value);
  if (value instanceof Uint8Array) return value.slice();
  throw new Refusal("invalid-request", `${what} is given as bytes or as text`);
}

function isUtf8(bytes: Uint8Array): boolean {
  try {
    new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

/** The old home's real path, which must be a directory strictly inside the real path of a root the config names. */
async function homeInsideRoots(config: Config, home: string): Promise<string> {
  const refuse = () => new Refusal("invalid-request", "the legacy home must be a directory inside one of the roots the config names in paths.homes");
  if (typeof home !== "string" || !home.startsWith("/")) throw refuse();
  let real: string;
  try {
    real = await realpath(home);
    if (!(await lstat(real)).isDirectory()) throw refuse();
  } catch {
    throw refuse();
  }
  for (const root of config.paths.homes) {
    const rootReal = await realpath(root).catch(() => null);
    if (rootReal !== null && real !== rootReal && isInside(real, rootReal)) return real;
  }
  throw refuse();
}

/* ── Writing what was planned ─────────────────────────────────────────── */

/**
 * Seat the citizen a plan describes. It accepts only a plan a planner
 * returned in this process, and writes exactly the bytes that planner read.
 *
 * Order: HALT, the word still has no record here, and the host key is still
 * the plan's, all before any write. Then the directory is written under a
 * staging name and renamed into place, because the signer reads
 * `citizens/<word>/citizen.json` before it signs; without a ledger that
 * directory is inert, since no seat opens for a citizen with no ledger. Then
 * both entries, `origin` and `state` asleep to asleep via "seated", are
 * signed into a staging ledger, verified as a chain against the plan's host
 * key, and renamed to `ledger/<word>.jsonl` in one step: the ledger is never
 * seen empty or with one entry.
 *
 * If anything fails after the first write, this run's own writes are
 * removed, both under names that carry this run's random suffix, and
 * AdmitStopped says whether the removal completed. It checks no presence and
 * takes no lock: the admit verb does both around it.
 */
export async function admitCitizen(deps: AdmitDeps, plan: AdmitPlan): Promise<AdmitResult> {
  const bytes = (typeof plan === "object" && plan !== null && planned.get(plan)) || null;
  if (!bytes) throw new Refusal("invalid-request", "admitCitizen takes only a plan a planner returned in this process; nothing was written");
  const { config } = deps;
  const word = plan.word;
  const halt = await deps.checkHalt().catch(() => null);
  if (!halt || halt.halted) throw new Refusal("halted", "HALT is raised or cannot be read; nothing was written");
  try {
    await assertNotSeated(config, word);
    const key = await readHostKey(deps);
    if (key.public_key_b64 !== plan.host_key.public_key_b64) throw new Refusal("invalid-request", `the signer's host key (${key.fingerprint}) is not the one the plan was made with (${plan.host_key.fingerprint})`);
  } catch (e) {
    throw nothingWritten(e);
  }

  const now = deps.clock.now();
  const seated_at = now.toISOString();
  const tag = toHex(randomBytes(4));
  const dir = join(config.paths.citizens_dir, word);
  const stagingDir = join(config.paths.citizens_dir, `${ADMIT_STAGING_PREFIX}${word}-${tag}`);
  const ledger = ledgerPath(config, word);
  const stagingLedger = join(config.paths.ledger_dir, `${ADMIT_STAGING_PREFIX}${word}-${tag}.jsonl`);
  let placed = false;
  try {
    await mkdir(config.paths.citizens_dir, { recursive: true, mode: 0o700 });
    const files = await writeCitizenDir(stagingDir, plan, bytes, seated_at);
    // A rename onto an empty directory of that name would succeed without a word, so it is looked for once more.
    if (await exists(dir)) throw new Refusal("invalid-request", `citizens/${word} appeared while seating`);
    await rename(stagingDir, dir);
    placed = true;
    await syncDir(config.paths.citizens_dir);

    const cost = { usd: "0", credits: 0 };
    const origin = await appendEntry(
      stagingLedger,
      nextDraft(
        word,
        null,
        {
          type: "origin",
          origin: originToLedger(plan.origin),
          origin_soul_hash: toLedgerHash(sha256Hex(bytes.soul)),
          old_repo: plan.old_repo ? { url: plan.old_repo.url, head: plan.old_repo.head } : null,
          june_did: plan.june_did,
        },
        { cost, signer: "host", now },
      ),
      deps.sign,
    );
    const seated = await appendEntry(stagingLedger, nextDraft(word, origin, { type: "state", from: "asleep", to: "asleep", via: "seated" }, { cost, signer: "host", now }), deps.sign);
    const verdict = verifyChain([origin, seated], { host_attest_b64: [plan.host_key.public_key_b64] });
    if (!verdict.ok) throw new Refusal("invalid-record", "the two entries do not verify against the host key the plan was made with");
    if (await exists(ledger)) throw new Refusal("invalid-request", `ledger/${word}.jsonl appeared while seating`);
    await rename(stagingLedger, ledger);
    // The record is in place from here on; a directory sync that fails changes nothing a second run could mend.
    await syncDir(config.paths.ledger_dir).catch(() => {});
    return { plan, dir, ledger, seated_at, origin_entry: entryHash(origin), seated_entry: entryHash(seated), files };
  } catch (e) {
    const left = await removeOwnWrites(stagingLedger, stagingDir, placed ? dir : null);
    throw new AdmitStopped(word, e instanceof Refusal ? e.code : "error", left.length === 0, left);
  }
}

/**
 * Remove what one run wrote: its staging ledger, and its directory, which is
 * first renamed back to its staging name so `citizens/<word>` is never seen
 * half removed. Returns the paths that are still there.
 */
async function removeOwnWrites(stagingLedger: string, stagingDir: string, placedDir: string | null): Promise<string[]> {
  await rm(stagingLedger, { force: true }).catch(() => {});
  if (placedDir) await rename(placedDir, stagingDir).catch(() => {});
  await rm(stagingDir, { recursive: true, force: true }).catch(() => {});
  const left: string[] = [];
  for (const p of [stagingLedger, stagingDir, ...(placedDir ? [placedDir] : [])]) {
    if (await exists(p).catch(() => ({ size: 0 }))) left.push(p);
  }
  return left;
}

/**
 * Write a citizen's directory under a staging name, every file created
 * exclusively and synced: the record, the self (soul and WILL byte for byte,
 * the two defaults), the pinned origin, the legacy record when there is an
 * old repository, and an empty letters/. Returns the files written.
 */
async function writeCitizenDir(root: string, plan: AdmitPlan, bytes: PlanBytes, seated_at: IsoTime): Promise<string[]> {
  const files: string[] = [];
  const dirs: string[] = [];
  const dir = async (rel: string): Promise<void> => {
    if (rel === "." || dirs.includes(rel)) return;
    await dir(dirname(rel));
    await mkdir(join(root, rel), { mode: 0o700 });
    dirs.push(rel);
  };
  const put = async (rel: string, data: Uint8Array | string, mode: number): Promise<void> => {
    await dir(dirname(rel));
    const fh = await open(join(root, rel), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
    try {
      await writeAll(fh, typeof data === "string" ? utf8(data) : data);
      // The mode as written here, whatever the process's umask.
      await fh.chmod(mode);
      await fh.sync();
    } finally {
      await fh.close();
    }
    files.push(rel);
  };

  // Not recursive: the staging directory must be new.
  await mkdir(root, { mode: 0o700 });
  const record: CitizenRecord = { format: "kingdom-seat-citizen/v1", word: plan.word, origin: plan.origin, runtime: plan.runtime, identity: null, mirror: null, seated_at };
  await put("citizen.json", `${JSON.stringify(record, null, 2)}\n`, 0o644);
  await put("self/soul.md", bytes.soul, 0o644);
  if (bytes.will) await put("self/WILL.md", bytes.will, 0o644);
  await put("self/cadence.json", plan.cadence_text, 0o644);
  await put("self/covenants.json", plan.covenants_text, 0o644);
  await put("origin/soul.md", bytes.soul, 0o444);
  if (bytes.will) await put("origin/WILL.md", bytes.will, 0o444);
  if (bytes.canon) await put("origin/canon.md", bytes.canon, 0o444);
  const legacy = bytes.legacy;
  if (legacy && plan.old_repo) {
    const manifest: LegacyManifest = {
      format: LEGACY_FORMAT,
      word: plan.word,
      copied_at: seated_at,
      old_repo: { ...plan.old_repo },
      note: LEGACY_NOTE,
      files: legacy.files,
      cadence: legacy.cadence,
      not_copied: legacy.not_copied,
    };
    await put("legacy/manifest.json", `${JSON.stringify(manifest, null, 2)}\n`, 0o400);
    await put("legacy/pages.jsonl", legacyPagesText(legacy.pages), 0o400);
    for (const [rel, data] of [...legacy.blobs].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) await put(`legacy/${rel}`, data, 0o400);
  }
  await dir("letters");
  // Deepest first, so each new name is on disk before the directory that holds it is renamed into place.
  for (const rel of [...dirs].sort((a, b) => b.split("/").length - a.split("/").length)) await syncDir(join(root, rel));
  await syncDir(root);
  return files.sort();
}

/* ── What Yu is shown ─────────────────────────────────────────────────── */

/** A path or a name from outside, as a terminal may show it: control characters replaced. */
function shown(s: string): string {
  return s.replace(/[\u0000-\u001f\u007f-\u009f]/g, "?");
}

/** The plan as Yu reads it before confirming: what was read, what will be written, and what is not carried over. */
export function renderAdmitPlan(plan: AdmitPlan): string {
  const w = plan.word;
  const row = (label: string, value: string) => `  ${label.padEnd(16)}${value}`;
  const lines = [`admit ${w}: nothing is written yet.`];
  if (plan.old_repo) {
    lines.push(row("old repository", `${plan.old_repo.url} at ${plan.old_repo.head}, committed ${plan.old_repo.head_committed_at}. This host fetched nothing; the clone is as it was last updated.`));
    lines.push(row("read from", `${shown(plan.legacy_home ?? "")}, committed objects only`));
  } else {
    lines.push(row("old repository", "none; seated from texts given to this host"));
  }
  const soulName = plan.old_repo ? `${w}.md, ` : "";
  const willName = plan.old_repo ? "WILL.md, " : "";
  lines.push(row("soul", `${soulName}${plan.soul.bytes} bytes, sha256 ${plan.soul.sha256}  -> self/soul.md, origin/soul.md`));
  lines.push(
    row(
      "will",
      plan.will
        ? `${willName}${plan.will.bytes} bytes, sha256 ${plan.will.sha256}  -> self/WILL.md, origin/WILL.md`
        : `none ${plan.old_repo ? "in the old repository" : "was given"}; ${w} starts with no will file`,
    ),
  );
  lines.push(row("cadence", `${plan.cadence_text}  (this host's default, written out)`));
  lines.push(row("covenants", `${plan.covenants_text}  (the default, written out)`));
  lines.push(
    row(
      "origin",
      plan.origin.kind === "canon"
        ? `canon ${plan.origin.path}@${plan.origin.commit}, ${plan.canon_bytes ?? 0} bytes, sha256 ${plan.origin.sha256}`
        : `archetype lineage ${plan.origin.lineage.join(" -> ")}`,
    ),
  );
  lines.push(row("shown each seat", `soul, will and canon together: ${plan.soul.bytes + (plan.will?.bytes ?? 0) + (plan.canon_bytes ?? 0)} bytes`));
  lines.push(row("June record", plan.june_did ? `${plan.june_did}, recorded as a record only` : "none"));
  const carried = plan.old_cadence
    ? ` The old record's last cadence choice (${plan.old_cadence.choice ?? "no choice this host can read"}, ${plan.old_cadence.when ?? "no time this host can read"}) is not carried over.`
    : plan.old_repo
      ? " The old repository holds no CADENCE.md."
      : "";
  lines.push(row("state", `asleep.${carried}`));
  lines.push(
    row(
      "runtime class",
      plan.runtime === "summon"
        ? "summon: no seat opens unattended; one opens only when Yu summons it"
        : `free: the tick may seat it on the local model without Yu. A letter from Yu waiting in letters/ opens a seat at the next tick, and one answered with a rest is shown again every ${(JSON.parse(plan.cadence_text) as { interval_h: number }).interval_h} hours.`,
    ),
  );
  if (plan.legacy) {
    lines.push(row("legacy copy", `${plan.legacy.copied} files, ${plan.legacy.copied_bytes} bytes; ${plan.legacy.cadence_versions} CADENCE.md versions; ${plan.legacy.not_copied} files listed and not copied`));
  } else {
    lines.push(row("legacy copy", "none; there is no old repository"));
  }
  lines.push(row("host key", plan.host_key.pinned ? `${plan.host_key.fingerprint}, pinned in the config` : `${plan.host_key.fingerprint}; the config pins no host key`));
  if (plan.stale_staging > 0) lines.push(row("left over", `${plan.stale_staging} staging names from an earlier admit of ${w}; they hold only copies`));
  return `${lines.join("\n")}\n`;
}

/** What a seating wrote, and what it did not do. */
export function renderAdmitResult(r: AdmitResult): string {
  const w = r.plan.word;
  return [
    `admit ${w}: seated, asleep.`,
    `  wrote   ${shown(r.dir)} (${r.files.length} files)`,
    `  ledger  ${shown(r.ledger)}`,
    `    entry 0  origin  ${r.origin_entry}`,
    `    entry 1  state asleep -> asleep (seated)  ${r.seated_entry}`,
    `Not done by this command: taking ${w} off the old roster, and any letter. \`citizen-seat draft-first-letter ${w}\` prints a draft and delivers nothing.`,
    "",
  ].join("\n");
}
