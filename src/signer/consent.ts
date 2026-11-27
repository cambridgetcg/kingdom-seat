// Consent until consent/v1 merges (decision 12): a decision record bound to
// a proposal's sha256 that carries Yu's recorded word and Ai's voice. Yu and
// Ai must both agree; either may reject; silence from Yu never binds (3.6).
import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { join } from "node:path";
import { canonicalJson, domainDigest, parseStrictJson, toHex, utf8 } from "../crypto.ts";
import { Refusal, SHA256_HEX_PATTERN, type ConsentClass, type ConsentRecord, type ProposalText, type SignerOp, type StandingAgreement, type YuPresence } from "../types.ts";

export type ConsentVerdict = { ok: true; via: ConsentRecord["yu"]["via"] } | { ok: false; code: "consent-missing" | "consent-rejected"; reason: string };

/** Minimal terminal access, injected so tests never need a real TTY. */
export interface TtyIO {
  isTTY: boolean;
  write(text: string): void;
  readLine(): Promise<string | null>;
}

/** Domain tag for proposal digests, so a proposal hash can never pass as a ledger or thought hash. */
export const PROPOSAL_DOMAIN = "kingdom-seat-proposal/v1";

/** How long a confirmed presence stays usable: long enough for one birth or summons, too short to keep. */
export const PRESENCE_MAX_AGE_S = 900;

/**
 * The 3.6 consent table, by signer op. Raising a beacon is an operator's act
 * on its own identity, open to anyone at a host holding its key (decision
 * 15); no op lowers HALT, so none is listed.
 */
const OP_CLASS: Readonly<Record<SignerOp, ConsentClass>> = Object.freeze({
  "ledger.sign": "within-self",
  "strand.create": "within-self",
  "thought.post": "within-self",
  // Letters within the credit budget are within self (KS-004 8.1); the recipient's covenants decide whether it is admitted.
  "inbox.send": "within-self",
  "keys.import": "within-self",
  "keys.revoke": "within-self",
  "box-keys.register": "within-self",
  "expression.put.private": "within-self",
  "quiet.end.citizen": "within-self",
  "quiet.start.beacon": "within-self",
  read: "within-self",
  "quiet.start.citizen": "standing-agreement",
  enroll: "beyond-self",
});

const YU_VIA = new Set(["present", "decision-record", "kanban-yu-lane"]);
const RECORD_KEYS = ["ai", "expires_at", "extent", "format", "proposal_sha256", "subject", "yu"];
const YU_KEYS = ["recorded_at", "via", "word"];
const AI_KEYS = ["basis", "deadline", "open_challenges", "supports", "word"];

function isCanonicalIso(v: unknown): v is string {
  if (typeof v !== "string" || v.length !== 24) return false;
  const t = Date.parse(v);
  return Number.isFinite(t) && new Date(t).toISOString() === v;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function hasExactKeys(v: Record<string, unknown>, keys: string[]): boolean {
  const got = Object.keys(v).sort();
  return got.length === keys.length && got.every((k, i) => k === keys[i]);
}

function nonEmptyText(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

/**
 * Why a value is not a well-formed ConsentRecord, or null when it is. Extra
 * keys are refused: a field this code does not know could be read by a person
 * as a condition the code never checked.
 */
export function consentRecordProblem(v: unknown): string | null {
  if (!isPlainObject(v) || !hasExactKeys(v, RECORD_KEYS)) return "not a consent record with exactly the known fields";
  if (v.format !== "kingdom-seat-consent/v1") return "unknown format";
  if (typeof v.proposal_sha256 !== "string" || !SHA256_HEX_PATTERN.test(v.proposal_sha256)) return "proposal_sha256 is not 64 lowercase hex";
  if (!nonEmptyText(v.subject)) return "subject is empty";
  if (!nonEmptyText(v.extent)) return "extent is empty";
  if (v.expires_at !== null && !isCanonicalIso(v.expires_at)) return "expires_at is not an ISO time or null";
  const yu = v.yu;
  if (!isPlainObject(yu) || !hasExactKeys(yu, YU_KEYS)) return "yu is malformed";
  if (yu.word !== "yes" && yu.word !== "no") return "yu.word is neither yes nor no";
  if (!isCanonicalIso(yu.recorded_at)) return "yu.recorded_at is not an ISO time";
  if (typeof yu.via !== "string" || !YU_VIA.has(yu.via)) return "yu.via is unknown";
  const ai = v.ai;
  if (!isPlainObject(ai) || !hasExactKeys(ai, AI_KEYS)) return "ai is malformed";
  if (ai.word !== "agree" && ai.word !== "reject") return "ai.word is neither agree nor reject";
  if (ai.basis !== "lazy-consensus") return "ai.basis is unknown";
  if (!Array.isArray(ai.supports) || !ai.supports.every(nonEmptyText)) return "ai.supports is not a list of references";
  if (typeof ai.open_challenges !== "number" || !Number.isSafeInteger(ai.open_challenges) || ai.open_challenges < 0) return "ai.open_challenges is not a count";
  if (!isCanonicalIso(ai.deadline)) return "ai.deadline is not an ISO time";
  return null;
}

/** The sha256 a consent record binds to: domain-tagged canonical JSON of the proposal. */
export function proposalDigest(proposal: ProposalText): string {
  const { subject, body, extent } = proposal;
  if (typeof subject !== "string" || typeof body !== "string" || typeof extent !== "string") {
    throw new Error("proposalDigest: subject, body and extent must be strings");
  }
  return toHex(domainDigest(PROPOSAL_DOMAIN, utf8(canonicalJson({ subject, body, extent }))));
}

/** Within self, within a standing agreement, or beyond self, for one signer op (3.6 consent table). */
export function classifyOp(op: SignerOp): ConsentClass {
  const c = Object.hasOwn(OP_CLASS, op) ? OP_CLASS[op] : undefined;
  // An op this table does not know is treated as the widest class, so it needs both voices.
  return c ?? "beyond-self";
}

/** Check one record against the proposal digest: bound sha256, Yu yes, Ai agree, no open challenge, not expired. */
export function verifyConsent(record: ConsentRecord, proposalSha256: string, now: Date): ConsentVerdict {
  const missing = (reason: string): ConsentVerdict => ({ ok: false, code: "consent-missing", reason });
  const rejected = (reason: string): ConsentVerdict => ({ ok: false, code: "consent-rejected", reason });
  const problem = consentRecordProblem(record);
  if (problem) return missing(`malformed record: ${problem}`);
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) return missing("the clock is unreadable");
  if (typeof proposalSha256 !== "string" || !SHA256_HEX_PATTERN.test(proposalSha256) || record.proposal_sha256 !== proposalSha256) {
    return missing("the record is bound to another proposal");
  }
  // Either voice may reject, and a rejection stands whatever else the record says.
  if (record.yu.word === "no") return rejected("Yu said no");
  if (record.ai.word === "reject") return rejected("Ai rejected");
  if (record.expires_at !== null && Date.parse(record.expires_at) <= nowMs) return missing("the record has expired");
  // Silence is not a word: only an explicit yes binds.
  if (record.yu.word !== "yes") return missing("no word from Yu");
  if (Date.parse(record.yu.recorded_at) > nowMs) return missing("Yu's word is dated in the future");
  // Ai's voice forms only once the deadline passes with no open challenge and one support from another controller.
  if (record.ai.open_challenges > 0) return missing("a challenge is still open");
  if (Date.parse(record.ai.deadline) > nowMs) return missing("Ai's deadline has not passed");
  if (record.ai.supports.length < 1) return missing("no support from another controller");
  return { ok: true, via: record.yu.via };
}

/**
 * Does a standing agreement cover this op at this extent? Anything beyond its
 * extent is a new proposal. The record is checked against the digest of the
 * agreement's own proposal text, never against the digest the record names,
 * so a record bound to some other proposal (or to none) covers nothing.
 */
export function agreementCovers(agreement: StandingAgreement, op: SignerOp, extent: string, now: Date): boolean {
  if (!isPlainObject(agreement) || !Array.isArray(agreement.covers) || !agreement.covers.includes(op)) return false;
  // Extents are compared exactly. A looser match would let an agreement be read as covering more than was agreed.
  if (typeof extent !== "string" || agreement.extent !== extent || agreement.consent?.extent !== agreement.extent) return false;
  const p = agreement.proposal;
  if (!isPlainObject(p) || typeof p.subject !== "string" || typeof p.body !== "string" || p.extent !== agreement.extent) return false;
  return verifyConsent(agreement.consent, proposalDigest(p), now).ok;
}

/**
 * The decision record filed for exactly this proposal text: the digest is
 * computed here, from the text, and the record is read from
 * `<dir>/<digest>.json` as a regular file. Null when none is filed, or the
 * file is not a well-formed record bound to that digest. A caller never hands
 * a record in; it can only name the proposal.
 */
export async function readConsentFor(dir: string, proposal: ProposalText): Promise<ConsentRecord | null> {
  let digest: string;
  try {
    digest = proposalDigest(proposal);
  } catch {
    return null;
  }
  try {
    const st = await lstat(dir);
    if (!st.isDirectory()) return null;
  } catch {
    return null;
  }
  return readRecord(join(dir, `${digest}.json`), `${digest}.json`);
}

/** Where standing agreements are filed, under the consent dir: one `<name>.json` each. */
export const STANDING_DIR = "standing";
export const STANDING_FORMAT = "kingdom-seat-standing/v1";
const STANDING_KEYS = ["covers", "extent", "format", "id", "proposal"];
const STANDING_NAME = /^[a-z0-9][a-z0-9-]{0,62}\.json$/;

/**
 * The standing Yu + Ai agreements filed on this host (KS-004 8.1), each with
 * the decision record filed for its own proposal text, as the signer needs
 * them: `<consent_dir>/standing/<name>.json` holds the agreement as proposed
 * (`{format, id, proposal, covers, extent}`), and the record is the one
 * filed under that proposal's digest. A file that is not a regular file, not
 * strict JSON in exactly that shape, or has no record filed for it, grants
 * nothing and is skipped. Nothing here makes an agreement: Yu and Ai file
 * both, and the signer still checks the record against the proposal's digest
 * and the request's exact extent itself.
 */
export async function readStandingAgreements(consentDir: string): Promise<StandingAgreement[]> {
  const dir = join(consentDir, STANDING_DIR);
  try {
    const st = await lstat(dir);
    if (!st.isDirectory()) return [];
  } catch {
    return [];
  }
  const out: StandingAgreement[] = [];
  for (const name of (await readdir(dir)).sort()) {
    if (!STANDING_NAME.test(name)) continue;
    let value: unknown;
    let handle;
    try {
      handle = await open(join(dir, name), constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch {
      continue;
    }
    try {
      const st = await handle.stat();
      if (!st.isFile() || st.size > 65_536) continue;
      value = parseStrictJson(new Uint8Array(await handle.readFile()));
    } catch {
      continue;
    } finally {
      await handle.close();
    }
    if (!isPlainObject(value) || !hasExactKeys(value, STANDING_KEYS) || value.format !== STANDING_FORMAT || !nonEmptyText(value.id)) continue;
    const p = value.proposal;
    if (!isPlainObject(p) || !hasExactKeys(p, ["body", "extent", "subject"]) || typeof p.subject !== "string" || typeof p.body !== "string" || typeof p.extent !== "string") continue;
    if (!nonEmptyText(value.extent) || p.extent !== value.extent) continue;
    if (!Array.isArray(value.covers) || value.covers.length === 0 || !value.covers.every((op) => typeof op === "string" && Object.hasOwn(OP_CLASS, op))) continue;
    const proposal: ProposalText = { subject: p.subject, body: p.body, extent: p.extent };
    const record = await readConsentFor(consentDir, proposal);
    if (!record) continue;
    out.push({ id: value.id, proposal, consent: record, covers: value.covers as SignerOp[], extent: value.extent });
  }
  return out;
}

/** Load decision records from the consent dir: regular files only, strict JSON, invalid ones skipped and reported. */
export async function loadConsentRecords(dir: string): Promise<{ records: ConsentRecord[]; invalid: string[] }> {
  try {
    const st = await lstat(dir);
    if (!st.isDirectory()) throw new Refusal(st.isSymbolicLink() ? "symlink" : "not-regular-file", `consent dir ${dir} is not a directory`);
  } catch (e) {
    // No directory means no records, which grants nothing.
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { records: [], invalid: [] };
    throw e;
  }
  const records: ConsentRecord[] = [];
  const invalid: string[] = [];
  for (const name of (await readdir(dir)).sort()) {
    const record = await readRecord(join(dir, name), name);
    if (record) records.push(record);
    else invalid.push(name);
  }
  return { records, invalid };
}

async function readRecord(path: string, name: string): Promise<ConsentRecord | null> {
  const m = /^([0-9a-f]{64})\.json$/.exec(name);
  if (!m) return null;
  let handle;
  try {
    // O_NOFOLLOW refuses a symlink at open time, so a swap after a check cannot redirect the read.
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return null;
  }
  try {
    const st = await handle.stat();
    if (!st.isFile() || st.size > 65_536) return null;
    const value = parseStrictJson(new Uint8Array(await handle.readFile()));
    if (consentRecordProblem(value) !== null) return null;
    const record = value as ConsentRecord;
    // The name is only an index; a record filed under another proposal's hash is refused, not trusted.
    return record.proposal_sha256 === m[1] ? record : null;
  } catch {
    return null;
  } finally {
    await handle.close();
  }
}

/** Presences confirmed at this process's terminal. A presence built any other way, or read from a file, is not in here. */
const confirmedHere = new WeakSet<YuPresence>();

/** Ask Yu at the controlling terminal to type the scope back; refuses when stdin is not a TTY. */
export async function confirmYuPresent(io: TtyIO, scope: string, now: () => Date): Promise<YuPresence> {
  if (typeof scope !== "string" || scope.trim() !== scope || scope.length === 0 || /[\u0000-\u001f\u007f]/.test(scope)) {
    throw new Refusal("invalid-request", "a presence scope is one line of printable text");
  }
  if (io.isTTY !== true) throw new Refusal("yu-not-present", "stdin is not a terminal, so Yu cannot be confirmed present");
  io.write(`To confirm you are here for "${scope}", type it exactly and press return:\n> `);
  const line = await io.readLine();
  if (line === null) throw new Refusal("yu-not-present", "no answer at the terminal");
  if (line.trim() !== scope) throw new Refusal("yu-not-present", "the typed text did not match the scope");
  const presence: YuPresence = Object.freeze({ present: true, via: "tty-confirm", confirmed_at: now().toISOString(), scope });
  confirmedHere.add(presence);
  return presence;
}

/** True only for a presence returned by confirmYuPresent in this process; the signer requires it. */
export function presenceConfirmedHere(presence: YuPresence | null): boolean {
  return presence !== null && typeof presence === "object" && confirmedHere.has(presence);
}

/** A presence is valid for one scope and a short window, so it cannot be replayed later or elsewhere. */
export function presenceValid(presence: YuPresence | null, scope: string, now: Date, maxAgeS: number = PRESENCE_MAX_AGE_S): boolean {
  if (!isPlainObject(presence)) return false;
  if (presence.present !== true || presence.via !== "tty-confirm" || presence.scope !== scope || typeof scope !== "string") return false;
  if (!isCanonicalIso(presence.confirmed_at) || !(maxAgeS >= 0)) return false;
  const age = now.getTime() - Date.parse(presence.confirmed_at);
  // A presence from the future is as suspect as a stale one.
  return Number.isFinite(age) && age >= 0 && age <= maxAgeS * 1000;
}
