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
import { lstat, readdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { isInside } from "./config.ts";
import { READ_LIMITS } from "./context.ts";
import { bytesEqual, fromB64, keyFingerprint, sha256Hex, utf8 } from "./crypto.ts";
import { assertSelfText, readCanonEntry, readLegacyHome, type LegacyHome } from "./legacy.ts";
import { ledgerPath, type EntrySigner } from "./ledger.ts";
import { defaultCovenants } from "./state.ts";
import { Refusal, WORD_PATTERN, type Clock, type CommandRunner, type Config, type HaltStatus, type Origin, type Sha256Hex, type Word } from "./types.ts";

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
