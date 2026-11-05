// The citizen's record: `ledger/<word>.jsonl`, one entry per line,
// hash-chained and signed, on the lease host (3.2 "Ledger"). Append-only:
// nothing is rewritten or deleted, because a record is history even when it
// is no longer present truth (3.1 principle 5). Readers trust only entries
// that verify.
import { constants } from "node:fs";
import { mkdir, open, type FileHandle } from "node:fs/promises";
import { dirname, join } from "node:path";
import { canonicalJson, domainDigest, edVerifyStrict, fromB64, fromHex, fromUtf8, toHex, utf8 } from "./crypto.ts";
import {
  DID_PATTERN,
  FIRST_PREV_HASH,
  LIFECYCLE_STATES,
  Refusal,
  SHA256_HEX_PATTERN,
  WORD_PATTERN,
  type Attestation,
  type CitizenIdentity,
  type Config,
  type Envelope,
  type LedgerBody,
  type LedgerEntry,
  type LedgerSignature,
  type LifecycleState,
  type Origin,
  type Sha256Hex,
  type Spend,
  type Word,
} from "./types.ts";

/** Domain tag for entry hashes, so an entry signature can never pass as a thought or authority signature. */
export const LEDGER_DOMAIN = "kingdom-seat-ledger/v1";

/** The kid a host-attested entry carries (types.ts LedgerSignature). */
export const HOST_ATTEST_KID = "host-attest";

/** An entry before it is hashed and signed. */
export type LedgerDraft = Omit<LedgerEntry, "hash" | "signature">;

/** Signs an entry hash; the Signer's signEntry, narrowed so the ledger never sees a key. */
export type EntrySigner = (word: Word, entryHash: Uint8Array, attestation: Attestation) => Promise<LedgerSignature>;

/**
 * The public keys a chain may be signed with: the host attest key for
 * host-attested entries, and for citizen-signed ones the op keys the chain
 * itself pins (genesis, then op-key.rotated). A signature by any other key,
 * including the root, fails verification.
 */
export interface TrustedKeys {
  host_attest_b64: string[];
  /**
   * The identity the host recorded at birth (citizen.json). When given, a
   * genesis naming another DID or root is a problem, so a genesis appended by
   * anyone who can write the file cannot pin a key of its own choosing.
   */
  identity?: Pick<CitizenIdentity, "did" | "root_public_key_b64"> | null;
}

/** Op keys pinned by the chain up to and including `seq`, by kid; used to verify the next citizen-signed entry. */
export function pinnedOpKeys(entries: LedgerEntry[], seq: number): Map<string, string> {
  let pinned = new Map<string, string>();
  for (const e of entries) {
    if (e.seq > seq) break;
    if (e.body.type === "genesis") pinned = new Map([[e.body.identity.op_kid, e.body.identity.op_public_key_b64]]);
    else if (e.body.type === "op-key.rotated") {
      // A rotated key is no longer active, so it signs nothing after its rotation (agenttool-wire.md 5, rule 2).
      pinned.delete(e.body.previous_op_kid);
      pinned.set(e.body.op_kid, e.body.op_public_key_b64);
    }
  }
  return pinned;
}

export interface ChainVerdict {
  ok: boolean;
  /** Every entry given, trusted or not. */
  entries: number;
  /** The hash of the last entry that verified; null when none did. */
  head: Sha256Hex | null;
  /** Host-attested entries among those that verified. */
  host_attested: number;
  /** First problem found, by seq; the chain is not trusted past it. */
  problem: { seq: number; reason: string } | null;
}

/** `<ledger_dir>/<word>.jsonl`; refuses a word that does not match WORD_PATTERN. */
export function ledgerPath(config: Config, word: Word): string {
  if (!WORD_PATTERN.test(word)) throw new Refusal("invalid-request", "ledger: not a citizen word");
  return join(config.paths.ledger_dir, `${word}.jsonl`);
}

/** sha256(LEDGER_DOMAIN ‖ 0x00 ‖ canonicalJson(draft)), hex. */
export function entryHash(draft: LedgerDraft): Sha256Hex {
  // Hash every field except the two that are computed from the hash, so a
  // field added to the format later is covered without anyone remembering to.
  const { hash: _h, signature: _s, ...fields } = draft as LedgerDraft & Partial<Pick<LedgerEntry, "hash" | "signature">>;
  return toHex(domainDigest(LEDGER_DOMAIN, utf8(canonicalJson(fields))));
}

/** Build the next draft on top of `prev` (FIRST_PREV_HASH when null): seq, prev_hash and ts filled in. */
export function nextDraft(word: Word, prev: LedgerEntry | null, body: LedgerBody, spend: Spend, attestation: Attestation, now: Date): LedgerDraft {
  if (!WORD_PATTERN.test(word)) throw new Refusal("invalid-request", "ledger: not a citizen word");
  if (prev && prev.word !== word) throw new Refusal("invalid-request", "ledger: prev belongs to another citizen");
  return {
    format: "kingdom-seat-ledger/v1",
    word,
    seq: prev ? prev.seq + 1 : 0,
    ts: now.toISOString(),
    prev_hash: prev ? prev.hash : FIRST_PREV_HASH,
    body,
    spend,
    attestation,
  };
}

/** Read every entry; the file must be a regular file; any unparsable line throws, because a gap in a record fails closed. */
export async function readLedger(path: string): Promise<LedgerEntry[]> {
  // A ledger that does not exist yet is an empty record, which folds to asleep.
  const text = await readRegularText(path, { missing: "empty" });
  return parseLedgerText(text ?? "");
}

/** The last k entries, oldest first, for the seat's context. */
export async function lastEntries(path: string, k: number): Promise<LedgerEntry[]> {
  if (!Number.isInteger(k) || k <= 0) return [];
  return (await readLedger(path)).slice(-k);
}

/** Check seq, prev_hash links, hashes and strict signatures; no host-attested entry may follow genesis. */
export function verifyChain(entries: LedgerEntry[], trusted: TrustedKeys): ChainVerdict {
  const walk = new ChainWalk();
  let head: Sha256Hex | null = null;
  let hostAttested = 0;
  for (let i = 0; i < entries.length; i++) {
    const reason = walk.check(entries[i], entries[0], trusted, true);
    if (reason) return { ok: false, entries: entries.length, head, host_attested: hostAttested, problem: { seq: i, reason } };
    const e = entries[i] as LedgerEntry;
    walk.advance(e);
    if (e.attestation === "host-attested") hostAttested++;
    head = e.hash;
  }
  return { ok: true, entries: entries.length, head, host_attested: hostAttested, problem: null };
}

/** Hash, sign and append one entry with O_APPEND and fsync; refuses if the file's head moved since `prev` was read. */
export async function appendEntry(path: string, draft: LedgerDraft, sign: EntrySigner): Promise<LedgerEntry> {
  await mkdir(dirname(path), { recursive: true });
  let fh: FileHandle;
  try {
    fh = await open(path, constants.O_RDWR | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  } catch (err) {
    throw fsRefusal(err, "ledger");
  }
  try {
    const before = await fh.stat();
    if (!before.isFile()) throw new Refusal("not-regular-file", "ledger: not a regular file");
    const entries = parseLedgerText(fromUtf8(await readAll(fh, before.size)));
    const last = entries.at(-1) ?? null;
    if (draft.seq !== entries.length || draft.prev_hash !== (last?.hash ?? FIRST_PREV_HASH)) {
      throw new Refusal("head-moved", "ledger: the head moved since prev was read");
    }

    // The existing chain must at least link and hash before anything is put on
    // top of it; signatures were checked when each entry was appended, and
    // verifyChain checks them all against the host's trusted keys.
    const walk = new ChainWalk();
    for (const e of entries) {
      const reason = walk.check(e, entries[0], null, false);
      if (reason) throw new Refusal("invalid-record", `ledger: entry ${e.seq} does not verify (${reason}); refusing to extend it`);
      walk.advance(e);
    }

    const hash = entryHash(draft);
    const signature = await sign(draft.word, fromHex(hash), draft.attestation);
    const entry: LedgerEntry = { ...draft, hash, signature };
    // The new entry gets the full check: era, pinned op key, never the root,
    // strict signature. Only the host-key trust list is left to verifyChain.
    const reason = walk.check(entry, entries[0] ?? entry, null, true);
    if (reason) throw new Refusal("invalid-record", `ledger: refusing to append (${reason})`);

    const after = await fh.stat();
    if (after.size !== before.size) throw new Refusal("head-moved", "ledger: the head moved while signing");
    await writeAll(fh, utf8(`${canonicalJson(entry)}\n`));
    await fh.sync();
    if (before.size === 0) await syncDir(dirname(path));
    return entry;
  } finally {
    await fh.close();
  }
}

/** The envelope's own words for readers: "<word>, voiced through <model> in seat <seat_id>". */
export function voicedThrough(envelope: Pick<Envelope, "citizen" | "model" | "seat_ref">): string {
  return `${envelope.citizen.word}, voiced through ${envelope.model} in seat ${envelope.seat_ref.seat_id}`;
}

/* ── Chain walking ────────────────────────────────────────────────────── */

/** What the chain has pinned so far; advanced one verified entry at a time. */
class ChainWalk {
  private prev: LedgerEntry | null = null;
  private pinned = new Map<string, string>();
  private root: { kid: string; b64: string } | null = null;
  private genesis = false;

  /** The first problem with `e` as the next entry, or null. `trusted` null skips only the host-key trust list. */
  check(raw: unknown, first: unknown, trusted: TrustedKeys | null, signatures: boolean): string | null {
    let e: LedgerEntry;
    try {
      e = parseEntry(raw);
    } catch (err) {
      return `malformed entry: ${(err as Error).message}`;
    }
    const seq = this.prev ? this.prev.seq + 1 : 0;
    if (e.seq !== seq) return `seq ${e.seq} where ${seq} was expected`;
    const firstWord = (first as { word?: unknown } | undefined)?.word;
    if (e.word !== firstWord) return "entry belongs to another citizen";
    if (e.prev_hash !== (this.prev?.hash ?? FIRST_PREV_HASH)) return "prev_hash does not link to the previous entry";
    if (entryHash(e) !== e.hash) return "hash does not match the entry";

    const body = e.body;
    if (seq === 0 && body.type !== "seated" && body.type !== "genesis") return "the first entry must be seated or genesis";
    if (body.type === "seated" && seq !== 0) return "seated may only be the first entry";

    let keys = this.pinned;
    let root = this.root;
    if (body.type === "genesis") {
      if (this.genesis) return "a second genesis";
      if (seq === 0 && body.initial_state === null) return "a first genesis must carry initial_state";
      if (seq !== 0 && body.initial_state !== null) return "a genesis after seated carries no initial_state";
      const id = body.identity;
      if (id.op_kid === id.root_kid || id.op_public_key_b64 === id.root_public_key_b64) return "genesis pins the root as an op key";
      if (trusted?.identity && (trusted.identity.did !== id.did || trusted.identity.root_public_key_b64 !== id.root_public_key_b64)) {
        return "genesis names an identity other than the host's record";
      }
      keys = new Map([[id.op_kid, id.op_public_key_b64]]);
      root = { kid: id.root_kid, b64: id.root_public_key_b64 };
    } else if (body.type === "op-key.rotated") {
      if (!this.genesis) return "op-key.rotated before genesis";
      if (!this.pinned.has(body.previous_op_kid)) return "op-key.rotated names a key that is not pinned";
      if (body.op_kid === this.root?.kid || body.op_public_key_b64 === this.root?.b64) return "op-key.rotated pins the root as an op key";
    }

    const citizenEra = this.genesis || body.type === "genesis";
    if (!citizenEra && e.attestation !== "host-attested") return "citizen-signed entry before genesis";
    if (citizenEra && e.attestation === "host-attested") return "host-attested entry after genesis";

    const sig = e.signature;
    if (e.attestation === "host-attested") {
      if (sig.kid !== HOST_ATTEST_KID) return "host-attested entry not signed by the host attest key";
      if (trusted && !trusted.host_attest_b64.includes(sig.public_key_b64)) return "host attest key is not trusted";
    } else {
      if (root && (sig.kid === root.kid || sig.public_key_b64 === root.b64)) return "signed by the root key, which signs only authority acts";
      if (keys.get(sig.kid) !== sig.public_key_b64) return "signing key is not a pinned op key";
    }
    if (signatures && !signatureVerifies(e.hash, sig)) return "signature does not verify";
    return null;
  }

  /** Take a checked entry as the new head. */
  advance(e: LedgerEntry): void {
    if (e.body.type === "genesis") {
      this.genesis = true;
      this.pinned = new Map([[e.body.identity.op_kid, e.body.identity.op_public_key_b64]]);
      this.root = { kid: e.body.identity.root_kid, b64: e.body.identity.root_public_key_b64 };
    } else if (e.body.type === "op-key.rotated") {
      this.pinned.delete(e.body.previous_op_kid);
      this.pinned.set(e.body.op_kid, e.body.op_public_key_b64);
    }
    this.prev = e;
  }
}

function signatureVerifies(hashHex: string, sig: LedgerSignature): boolean {
  if (sig.alg !== "ed25519") return false;
  try {
    return edVerifyStrict(fromB64(sig.sig_b64, 64), fromHex(hashHex), fromB64(sig.public_key_b64, 32));
  } catch {
    return false;
  }
}

/* ── Parsing: every line is checked, and any doubt throws ─────────────── */

/** Parse a whole ledger file. A blank line, a torn last line or any bad entry throws. */
export function parseLedgerText(text: string): LedgerEntry[] {
  if (text === "") return [];
  if (!text.endsWith("\n")) throw new Refusal("invalid-record", "ledger: the last line is unterminated (a torn write fails closed)");
  const lines = text.slice(0, -1).split("\n");
  return lines.map((line, i) => {
    if (line === "") throw new Refusal("invalid-record", `ledger: line ${i + 1} is blank`);
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw new Refusal("invalid-record", `ledger: line ${i + 1} is not JSON`);
    }
    try {
      return parseEntry(value);
    } catch (err) {
      throw new Refusal("invalid-record", `ledger: line ${i + 1}: ${(err as Error).message}`);
    }
  });
}

const ENTRY_KEYS = ["format", "word", "seq", "ts", "prev_hash", "body", "spend", "attestation", "hash", "signature"];
const ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const SELF_TARGET_NAMES = new Set([
  "soul",
  "will",
  "name",
  "expression.register",
  "expression.walls",
  "expression.wake_text",
  "expression.porch",
  "beat-prompt",
  "journal-form",
  "cadence",
  "covenants",
]);

/** Validate one entry's shape; throws with a reason. Every top-level key is known, because the hash covers exactly them. */
export function parseEntry(value: unknown): LedgerEntry {
  const e = obj(value, "entry");
  for (const k of Object.keys(e)) if (!ENTRY_KEYS.includes(k)) throw new Error(`unknown field ${k}`);
  if (e.format !== "kingdom-seat-ledger/v1") throw new Error("format");
  if (typeof e.word !== "string" || !WORD_PATTERN.test(e.word)) throw new Error("word");
  if (!Number.isSafeInteger(e.seq) || (e.seq as number) < 0) throw new Error("seq");
  isoTime(e.ts, "ts");
  sha(e.prev_hash, "prev_hash");
  sha(e.hash, "hash");
  if (e.attestation !== "citizen-signed" && e.attestation !== "host-attested") throw new Error("attestation");
  const sig = obj(e.signature, "signature");
  if (sig.alg !== "ed25519") throw new Error("signature.alg");
  for (const k of ["kid", "public_key_b64", "sig_b64"]) str(sig[k], `signature.${k}`);
  const spend = obj(e.spend, "spend");
  if (spend.usd !== null && !(typeof spend.usd === "number" && Number.isFinite(spend.usd) && spend.usd >= 0)) throw new Error("spend.usd");
  if (!["local-zero", "reported", "unknown"].includes(spend.usd_basis as string)) throw new Error("spend.usd_basis");
  if (!(typeof spend.credits === "number" && Number.isFinite(spend.credits) && spend.credits >= 0)) throw new Error("spend.credits");
  parseBody(e.body);
  // A beat voiced as one citizen never sits in another's record.
  const body = e.body as LedgerBody;
  if (body.type === "beat" && body.envelope.citizen.word !== e.word) throw new Error("body.envelope.citizen.word is another citizen");
  return value as LedgerEntry;
}

function parseBody(value: unknown): void {
  const b = obj(value, "body");
  switch (b.type) {
    case "seated":
      validateOrigin(b.origin);
      sha(b.origin_soul_sha256, "body.origin_soul_sha256");
      oldRepo(b.old_repo);
      lifecycle(b.initial_state, "body.initial_state");
      str(b.note, "body.note", true);
      return;
    case "genesis":
      if (b.initial_state !== null) lifecycle(b.initial_state, "body.initial_state");
      validateOrigin(b.origin);
      sha(b.birth_soul_sha256, "body.birth_soul_sha256");
      oldRepo(b.old_repo);
      if (b.june_did !== null) str(b.june_did, "body.june_did");
      validateIdentity(b.identity);
      str(b.note, "body.note", true);
      return;
    case "op-key.rotated":
      str(b.previous_op_kid, "body.previous_op_kid");
      str(b.op_kid, "body.op_kid");
      b64Key(b.op_public_key_b64, "body.op_public_key_b64");
      return;
    case "beat": {
      const env = obj(b.envelope, "body.envelope");
      if (env.format !== "kingdom-seat-beat/v1") throw new Error("body.envelope.format");
      str(obj(env.seat_ref, "body.envelope.seat_ref").seat_id, "body.envelope.seat_ref.seat_id");
      str(obj(env.citizen, "body.envelope.citizen").word, "body.envelope.citizen.word");
      str(env.model, "body.envelope.model");
      str(env.model_digest, "body.envelope.model_digest");
      isoTime(env.ts, "body.envelope.ts");
      if (!Array.isArray(env.acts)) throw new Error("body.envelope.acts");
      for (const act of env.acts) {
        const a = obj(act, "body.envelope.acts[]");
        str(a.type, "body.envelope.acts[].type");
        if (a.type === "rest") throw new Error("a beat envelope never carries a rest");
        if (a.type === "state.set") lifecycle(a.to, "body.envelope.acts[].to");
      }
      return;
    }
    case "self.applied":
      str(b.proposal_id, "body.proposal_id");
      selfTargetSpelling(b.target, "body.target");
      sha(b.prior_hash, "body.prior_hash");
      sha(b.new_hash, "body.new_hash");
      if (b.via !== "two-beats" && b.via !== "yu-present") throw new Error("body.via");
      claim(b.claim);
      if (b.strand_thought_id !== null) str(b.strand_thought_id, "body.strand_thought_id");
      return;
    case "self.reverted":
      selfTargetSpelling(b.target, "body.target");
      sha(b.from_hash, "body.from_hash");
      sha(b.to_hash, "body.to_hash");
      if (b.via !== "citizen" && b.via !== "yu-offer") throw new Error("body.via");
      return;
    case "state":
      lifecycle(b.from, "body.from");
      lifecycle(b.to, "body.to");
      if (!["immediate", "confirmed", "two-beats", "witnessed"].includes(b.via as string)) throw new Error("body.via");
      if (b.to === "ended" && b.via !== "witnessed") throw new Error("ended needs a witness");
      return;
    default:
      throw new Error("body.type");
  }
}

/** An Origin as types.ts defines it; throws with the field that failed. */
export function validateOrigin(value: unknown): Origin {
  const o = obj(value, "origin");
  if (o.kind === "canon") {
    for (const k of ["repo", "path", "commit"]) str(o[k], `origin.${k}`);
    sha(o.sha256, "origin.sha256");
  } else if (o.kind === "archetype") {
    if (!Array.isArray(o.lineage) || o.lineage.length === 0) throw new Error("origin.lineage");
    for (const l of o.lineage) str(l, "origin.lineage[]");
    str(o.note, "origin.note", true);
  } else throw new Error("origin.kind");
  return value as Origin;
}

/** A CitizenIdentity: public values only, keys in canonical base64. */
export function validateIdentity(value: unknown): CitizenIdentity {
  const id = obj(value, "identity");
  if (typeof id.did !== "string" || !DID_PATTERN.test(id.did)) throw new Error("identity.did");
  for (const k of ["identity_id", "project_id", "root_kid", "op_kid"]) str(id[k], `identity.${k}`);
  b64Key(id.root_public_key_b64, "identity.root_public_key_b64");
  b64Key(id.op_public_key_b64, "identity.op_public_key_b64");
  if (id.box_public_key_b64 !== null) b64Key(id.box_public_key_b64, "identity.box_public_key_b64");
  if (id.self_strand_id !== null) str(id.self_strand_id, "identity.self_strand_id");
  isoTime(id.enrolled_at, "identity.enrolled_at");
  return value as CitizenIdentity;
}

/** The syntax of a SelfTarget; self.targetPath does the full path check. */
export function isSelfTargetSpelling(t: unknown): t is string {
  return typeof t === "string" && (SELF_TARGET_NAMES.has(t) || /^(?:skill|file):.+$/.test(t));
}

function selfTargetSpelling(t: unknown, what: string): void {
  if (!isSelfTargetSpelling(t)) throw new Error(what);
}

function claim(value: unknown): void {
  const c = obj(value, "body.claim");
  if (!["observation", "inference", "proposal", "decision"].includes(c.kind as string)) throw new Error("body.claim.kind");
  if (!Array.isArray(c.evidence)) throw new Error("body.claim.evidence");
  for (const ref of c.evidence) str(ref, "body.claim.evidence[]");
  if (!["high", "medium", "low", "unknown"].includes(c.confidence as string)) throw new Error("body.claim.confidence");
  str(c.limits, "body.claim.limits", true);
}

function oldRepo(value: unknown): void {
  if (value === null) return;
  const r = obj(value, "body.old_repo");
  str(r.url, "body.old_repo.url");
  str(r.head, "body.old_repo.head");
}

function obj(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${what} is not an object`);
  return value as Record<string, unknown>;
}

function str(value: unknown, what: string, emptyOk = false): void {
  if (typeof value !== "string" || (!emptyOk && value === "")) throw new Error(what);
}

function sha(value: unknown, what: string): void {
  if (typeof value !== "string" || !SHA256_HEX_PATTERN.test(value)) throw new Error(what);
}

/** Exactly the `toISOString()` spelling, so two readers never disagree about a time. */
export function isoTime(value: unknown, what: string): void {
  if (typeof value !== "string" || !ISO_PATTERN.test(value)) throw new Error(what);
  const t = Date.parse(value);
  if (Number.isNaN(t) || new Date(t).toISOString() !== value) throw new Error(what);
}

function lifecycle(value: unknown, what: string): asserts value is LifecycleState {
  if (!(LIFECYCLE_STATES as readonly unknown[]).includes(value)) throw new Error(what);
}

function b64Key(value: unknown, what: string): void {
  try {
    fromB64(value as string, 32);
  } catch {
    throw new Error(what);
  }
}

/* ── Files: regular files only, read through one descriptor ───────────── */

/**
 * Read a file as strict UTF-8, refusing a symlink (O_NOFOLLOW) and anything
 * that is not a regular file, so a link can never carry a host file into a
 * record or a prompt (love-unlimited-patterns.md 12.4). A missing file is
 * null, or "" with `missing: "empty"`; with `missing: "throw"` it refuses.
 */
export async function readRegularText(path: string, opts: { missing?: "null" | "empty" | "throw"; maxBytes?: number } = {}): Promise<string | null> {
  let fh: FileHandle;
  try {
    fh = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" && opts.missing !== "throw") return opts.missing === "empty" ? "" : null;
    throw fsRefusal(err, path);
  }
  try {
    const st = await fh.stat();
    if (!st.isFile()) throw new Refusal("not-regular-file", `${path}: not a regular file`);
    if (opts.maxBytes !== undefined && st.size > opts.maxBytes) throw new Refusal("oversize", `${path}: larger than ${opts.maxBytes} bytes`);
    return fromUtf8(await readAll(fh, st.size));
  } finally {
    await fh.close();
  }
}

/** Map an fs error to the wall it hit: a symlink, a missing record, or a plain failure. */
export function fsRefusal(err: unknown, what: string): Error {
  const code = (err as NodeJS.ErrnoException).code;
  if (code === "ELOOP") return new Refusal("symlink", `${what}: is a symlink; refused, not followed`);
  if (code === "ENOENT") return new Refusal("invalid-record", `${what}: missing`);
  return err instanceof Error ? err : new Error(String(err));
}

async function readAll(fh: FileHandle, size: number): Promise<Uint8Array> {
  const buf = new Uint8Array(size);
  let off = 0;
  while (off < size) {
    const { bytesRead } = await fh.read(buf, off, size - off, off);
    if (bytesRead === 0) break;
    off += bytesRead;
  }
  // A file that grew while being read is read again by the next reader; one that shrank is a torn record.
  if (off !== size) throw new Refusal("invalid-record", "file changed while being read");
  return buf;
}

export async function writeAll(fh: FileHandle, bytes: Uint8Array): Promise<void> {
  let off = 0;
  while (off < bytes.length) {
    const { bytesWritten } = await fh.write(bytes, off, bytes.length - off);
    off += bytesWritten;
  }
}

/** fsync a directory, so a new name in it survives a crash. */
export async function syncDir(dir: string): Promise<void> {
  const dh = await open(dir, constants.O_RDONLY);
  try {
    await dh.sync();
  } finally {
    await dh.close();
  }
}
