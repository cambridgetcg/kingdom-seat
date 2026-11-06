// The citizen's record: `ledger/<word>.jsonl`, one entry per line,
// hash-chained and signed, on the lease host (3.2 "Ledger"; KS-004 4.5).
// Append-only: nothing is rewritten or deleted, because a record is history
// even when it is no longer present truth (3.1 principle 5). Readers trust
// only entries that verify.
//
// Each line is one flat JSON object in KS-004 4.5's layout: the common fields
// (format, word, did, seq, prev_hash, type, seat_ref, runtime, input_digest,
// output_digest, acts, voiced, cost, ts, signer, kid, sig) and the fields of
// its type beside them. Values are objects, arrays, strings, integers within
// ±2^53 and null: no floats, no booleans. Every hash outside `acts` is spelled
// "sha256:<hex>"; acts keep the registry's own spelling (KS-004 5.7), whose
// identifiers are the bare hex the seat shows. Public keys, signatures and
// evidence bodies are base64url without padding.
//
// The ledger digest of a value is sha256("kingdom-seat-ledger/v1" ‖ 0x00 ‖
// JCS(value)). `sig` is ed25519 over the digest of the entry without `sig`;
// `prev_hash` is the digest of the whole previous entry, `sig` included, so
// each signature is bound into the chain (KS-004 re-review C, C5). A ledger
// written in kingdom-seat's earlier layout (`body`, `hash`, `signature`,
// `attestation`, `spend`) is not kingdom-seat-ledger/v1, and is refused as
// such: none ran on a host, so there is nothing to migrate.
import { constants } from "node:fs";
import { mkdir, open, type FileHandle } from "node:fs/promises";
import { dirname, join } from "node:path";
import { AUTHORITY_HEADERS, authorityDigest } from "./agenttool/wire.ts";
import {
  bytesEqual,
  canonicalJson,
  domainDigest,
  edVerifyStrict,
  fromB64,
  fromB64url,
  fromUtf8,
  keyFingerprint,
  parseStrictJson,
  toB64url,
  toHex,
  utf8,
} from "./crypto.ts";
import { isUsd } from "./money.ts";
import {
  DID_PATTERN,
  LEDGER_HASH_PATTERN,
  LEDGER_TYPES,
  LIFECYCLE_STATES,
  Refusal,
  SHA256_HEX_PATTERN,
  UUID_PATTERN,
  WORD_PATTERN,
  type Act,
  type CitizenIdentity,
  type Config,
  type Cost,
  type LedgerEntry,
  type LedgerEvidence,
  type LedgerFields,
  type LedgerHash,
  type LedgerKey,
  type LedgerOrigin,
  type LedgerRuntime,
  type LedgerSigner,
  type LifecycleState,
  type Origin,
  type RootEvidence,
  type Sha256Hex,
  type Spend,
  type Word,
} from "./types.ts";

/** The entry format, and the domain tag of every ledger digest, so an entry signature can never pass as a thought or authority signature. */
export const LEDGER_DOMAIN = "kingdom-seat-ledger/v1";
export const LEDGER_FORMAT = "kingdom-seat-ledger/v1";

/** Why a line in the earlier layout is refused: the same format string named a different layout (KS-004 re-review C, part C item 3). */
export const OLD_LAYOUT_REASON =
  "written in kingdom-seat's earlier ledger layout (body, hash, signature, attestation, spend); no ledger in that layout is kingdom-seat-ledger/v1";

/** An entry before it is signed: everything but `kid` and `sig`. */
export type LedgerDraft = LedgerEntry extends infer E ? (E extends LedgerEntry ? Omit<E, "kid" | "sig"> : never) : never;

/** What the signer returns for one entry: the kid it named, the signature, and the public key, so the append can check it. */
export interface EntrySignature {
  kid: string;
  /** base64url, unpadded, 64 bytes. */
  sig: string;
  /** base64url, unpadded, 32 bytes. Not written to the entry: a verifier finds the key by `kid`. */
  public_key: string;
}

/**
 * Signs one entry: the Signer's signEntry, narrowed so the ledger never sees a
 * key. The signature covers `kid`, so the signer names the kid first and
 * `digestFor` gives the digest of the entry with it.
 */
export type EntrySigner = (word: Word, signer: LedgerSigner, digestFor: (kid: string) => Uint8Array) => Promise<EntrySignature>;

/** The fields a seat stamps on every entry it writes; outside a seat they are all null. */
export interface SeatStamp {
  seat_ref: string;
  runtime: LedgerRuntime;
  input_digest: LedgerHash;
  output_digest: LedgerHash;
  voiced: string;
}

/**
 * The public keys a chain may be signed with: the host key for host entries,
 * and for citizen entries the op keys the chain itself pins (genesis, then
 * key entries, each with root evidence). A signature by any other key,
 * including the root, fails verification.
 */
export interface TrustedKeys {
  /** Host public keys, padded standard base64 as the config and the signer give them. */
  host_attest_b64: string[];
  /**
   * The identity the host recorded at birth (citizen.json). When given, a
   * genesis naming another DID or root is a problem, so a genesis appended by
   * anyone who can write the file cannot pin a key of its own choosing.
   */
  identity?: Pick<CitizenIdentity, "did" | "root_public_key_b64"> | null;
}

/* ── Hashes, digests and encodings ────────────────────────────────────── */

/** "sha256:<hex>" for 64 hex characters. */
export function toLedgerHash(hex: Sha256Hex): LedgerHash {
  if (!SHA256_HEX_PATTERN.test(hex)) throw new Refusal("invalid-request", "a ledger hash is 64 lowercase hex");
  return `sha256:${hex}`;
}

/** The 64 hex characters a ledger hash names. */
export function hexOf(hash: LedgerHash): Sha256Hex {
  if (!LEDGER_HASH_PATTERN.test(hash)) throw new Refusal("invalid-record", "not a sha256:<hex> ledger hash");
  return hash.slice("sha256:".length);
}

/** sha256(LEDGER_DOMAIN ‖ 0x00 ‖ JCS(value)): the ledger digest (KS-004 4.5). */
export function ledgerDigest(value: unknown): Uint8Array {
  return domainDigest(LEDGER_DOMAIN, utf8(canonicalJson(value)));
}

/** The ledger digest of a whole entry, `sig` included: what the next entry's prev_hash names, and how an entry is named. */
export function entryHash(entry: LedgerEntry): LedgerHash {
  return `sha256:${toHex(ledgerDigest(entry))}`;
}

/** The 32 bytes `sig` signs: the ledger digest of the entry without `sig`. */
export function signingDigest(entry: LedgerDraft & { kid: string | null; sig?: string | null }): Uint8Array {
  const { sig: _s, ...unsigned } = entry as LedgerDraft & { kid: string | null; sig?: string | null };
  return ledgerDigest(unsigned);
}

/** The kid a host entry names: `host:` and the host key's fingerprint, so a verifier holding the key can find it. */
export function hostKid(publicKey: Uint8Array): string {
  return `host:${keyFingerprint(publicKey)}`;
}

/** What a runtime reported, as the ledger keeps it: usd and credits, the basis left to the host's spend record. */
export function costOf(spend: Pick<Spend, "usd" | "credits">): Cost {
  return { usd: spend.usd, credits: spend.credits };
}

/** An Origin as the origin entry pins it. */
export function originToLedger(o: Origin): LedgerOrigin {
  if (o.kind === "canon") return { kind: "canon", repo: o.repo, path: o.path, commit: o.commit, hash: toLedgerHash(o.sha256) };
  return { kind: "archetype", lineage: [...o.lineage], note: o.note };
}

/** The Origin an origin entry pins. */
export function originFromLedger(o: LedgerOrigin): Origin {
  if (o.kind === "canon") return { kind: "canon", repo: o.repo, path: o.path, commit: o.commit, sha256: hexOf(o.hash) };
  return { kind: "archetype", lineage: [...o.lineage], note: o.note };
}

/** A root-signed request as the ledger records it: the body bytes re-spelled in base64url, the headers as sent. */
export function evidenceToLedger(ev: RootEvidence): LedgerEvidence {
  return { method: ev.method, target: ev.target, body: toB64url(fromB64(ev.body_b64)), headers: { ...ev.headers } };
}

/** A public key as genesis records it, from its bytes. */
export function ledgerKey(kid: string, publicKey: Uint8Array): LedgerKey {
  return { kid, public_key: toB64url(publicKey), fingerprint: keyFingerprint(publicKey) };
}

/** Op keys pinned by the chain up to and including `seq`, by kid, in base64url; used to verify the next citizen entry. */
export function pinnedOpKeys(entries: LedgerEntry[], seq: number): Map<string, string> {
  let pinned = new Map<string, string>();
  for (const e of entries) {
    if (e.seq > seq) break;
    if (e.type === "genesis") pinned = new Map([[e.op.kid, e.op.public_key]]);
    else if (e.type === "key") pinned = afterKey(pinned, e);
  }
  return pinned;
}

/** The op keys pinned once a key entry applies: a revoked key signs nothing after it (agenttool-wire.md 5, rule 2). */
function afterKey(pinned: Map<string, string>, e: Extract<LedgerEntry, { type: "key" }>): Map<string, string> {
  const next = new Map(pinned);
  for (const r of e.revoked) next.delete(r.kid);
  for (const k of e.installed) next.set(k.kid, k.public_key);
  return next;
}

/* ── Root evidence ────────────────────────────────────────────────────── */

/** What one piece of root evidence must authorise: the import of this key, or the revoke of this kid. */
export type EvidenceFor = { kind: "import"; public_key: Uint8Array } | { kind: "revoke"; kid: string };

/**
 * Why `ev` does not prove that the identity's root authorised `what`, or null.
 * It rebuilds the identity-authority/v1 digest agenttool verifies
 * (services/identity/authority.ts:114-121, :190-194) from the request as sent
 * and the identity's DID, and checks the root's signature over it, so a copy
 * of the ledger is enough: agenttool keeps no proof to ask for. The request
 * must be the route that does `what`, for this identity, and nothing else.
 *
 * keys/import takes the key in canonical padded standard base64
 * (routes/identity/keys.ts:269-280) and the ledger spells it in base64url, so
 * the import is matched on the decoded 32 bytes (KS-004 re-review C, part C
 * item 2): a string comparison would fail every honest entry.
 */
export function rootEvidenceProblem(ev: LedgerEvidence, identity: { did: string; root_public_key: Uint8Array }, what: EvidenceFor): string | null {
  const id = DID_PATTERN.test(identity.did) ? identity.did.slice("did:at:".length) : null;
  if (id === null) return "root evidence: the DID names no identity";
  const own = `/v1/identities/${id}`;
  const query = `?identity_id=${id}`;
  let body: Uint8Array;
  try {
    body = fromB64url(ev.body);
  } catch {
    return "root evidence body is not base64url";
  }
  if (what.kind === "import") {
    if (ev.method !== "POST" || (ev.target !== `${own}/keys/import` && ev.target !== `${own}/keys/import${query}`)) return "root evidence is not this identity's keys/import";
    let named: unknown;
    try {
      named = (parseStrictJson(body) as { public_key?: unknown } | null)?.public_key;
    } catch {
      return "root evidence body is not strict JSON";
    }
    let namedKey: Uint8Array;
    try {
      namedKey = fromB64(named as string, 32);
    } catch {
      return "root evidence names no 32-byte key in standard base64";
    }
    if (!bytesEqual(namedKey, what.public_key)) return "root evidence imports another key";
  } else {
    if (ev.method !== "DELETE" || (ev.target !== `${own}/keys/${what.kid}` && ev.target !== `${own}/keys/${what.kid}${query}`)) return "root evidence is not this identity's revoke of that key";
    if (body.length > 0) return "root evidence revoke carries a body";
  }
  const h = ev.headers;
  try {
    const digest = authorityDigest({
      did: identity.did,
      method: ev.method,
      target: ev.target,
      body,
      sequence: evidenceSequence(ev),
      timestamp: h[AUTHORITY_HEADERS.timestamp],
    });
    if (!edVerifyStrict(fromB64(h[AUTHORITY_HEADERS.signature], 64), digest, identity.root_public_key)) return "root evidence is not signed by the root";
  } catch {
    return "root evidence does not rebuild an identity-authority/v1 digest";
  }
  return null;
}

/** The authority sequence a piece of evidence spent; NaN when the header is not a plain positive integer. */
function evidenceSequence(ev: LedgerEvidence): number {
  const raw = ev.headers[AUTHORITY_HEADERS.sequence];
  return /^[1-9][0-9]{0,15}$/.test(raw) ? Number(raw) : Number.NaN;
}

/* ── Reading, verifying and appending ─────────────────────────────────── */

export interface ChainVerdict {
  ok: boolean;
  /** Every entry given, trusted or not. */
  entries: number;
  /** The ledger digest of the last entry that verified; null when none did. */
  head: LedgerHash | null;
  /** Host-signed entries among those that verified. */
  host_attested: number;
  /** First problem found, by seq; the chain is not trusted past it. */
  problem: { seq: number; reason: string } | null;
}

/** `<ledger_dir>/<word>.jsonl`; refuses a word that does not match WORD_PATTERN. */
export function ledgerPath(config: Config, word: Word): string {
  if (!WORD_PATTERN.test(word)) throw new Refusal("invalid-request", "ledger: not a citizen word");
  return join(config.paths.ledger_dir, `${word}.jsonl`);
}

/**
 * Build the next draft on top of `prev`: seq, prev_hash, did and ts filled
 * in. `did` defaults to the previous entry's (null before genesis); genesis
 * names its own. `seat` stamps the seat's fields; `acts` is a beat's.
 */
export function nextDraft(
  word: Word,
  prev: LedgerEntry | null,
  fields: LedgerFields,
  opts: { cost: Cost; signer: LedgerSigner; now: Date; did?: string | null; seat?: SeatStamp | null; acts?: Act[] | null },
): LedgerDraft {
  if (!WORD_PATTERN.test(word)) throw new Refusal("invalid-request", "ledger: not a citizen word");
  if (prev && prev.word !== word) throw new Refusal("invalid-request", "ledger: prev belongs to another citizen");
  const seat = opts.seat ?? null;
  return {
    format: LEDGER_FORMAT,
    word,
    did: opts.did !== undefined ? opts.did : (prev?.did ?? null),
    seq: prev ? prev.seq + 1 : 0,
    prev_hash: prev ? entryHash(prev) : null,
    ...fields,
    seat_ref: seat?.seat_ref ?? null,
    runtime: seat ? { ...seat.runtime } : null,
    input_digest: seat?.input_digest ?? null,
    output_digest: seat?.output_digest ?? null,
    acts: opts.acts ?? null,
    voiced: seat?.voiced ?? null,
    cost: { usd: opts.cost.usd, credits: opts.cost.credits },
    ts: opts.now.toISOString(),
    signer: opts.signer,
  } as LedgerDraft;
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

/** Check seq, prev_hash links, the entry types' order and strict signatures; no host entry may follow genesis. */
export function verifyChain(entries: LedgerEntry[], trusted: TrustedKeys): ChainVerdict {
  const walk = new ChainWalk();
  let head: LedgerHash | null = null;
  let hostAttested = 0;
  const first = (entries[0] as { word?: unknown } | undefined)?.word;
  for (let i = 0; i < entries.length; i++) {
    const reason = walk.check(entries[i], first, trusted, { signatures: true });
    if (reason) return { ok: false, entries: entries.length, head, host_attested: hostAttested, problem: { seq: i, reason } };
    const e = entries[i] as LedgerEntry;
    walk.advance(e);
    if (e.signer === "host") hostAttested++;
    head = entryHash(e);
  }
  return { ok: true, entries: entries.length, head, host_attested: hostAttested, problem: null };
}

/** Sign and append one entry with O_APPEND and fsync; refuses if the file's head moved since `prev` was read. */
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
    if (draft.seq !== entries.length || draft.prev_hash !== (last ? entryHash(last) : null)) {
      throw new Refusal("head-moved", "ledger: the head moved since prev was read");
    }

    // The existing chain must at least link before anything is put on top of
    // it; signatures were checked when each entry was appended, and
    // verifyChain checks them all against the host's trusted keys.
    const walk = new ChainWalk();
    for (const e of entries) {
      const reason = walk.check(e, entries[0]?.word, null, { signatures: false });
      if (reason) throw new Refusal("invalid-record", `ledger: entry ${e.seq} does not verify (${reason}); refusing to extend it`);
      walk.advance(e);
    }

    const s = await sign(draft.word, draft.signer, (kid) => signingDigest({ ...draft, kid }));
    let signedBy: Uint8Array;
    try {
      signedBy = fromB64url(s.public_key, 32);
    } catch {
      throw new Refusal("invalid-record", "ledger: the signer named no 32-byte public key");
    }
    const entry = { ...draft, kid: s.kid, sig: s.sig } as LedgerEntry;
    // The new entry gets the full check: era, pinned op key, never the root,
    // strict signature. Only the host-key trust list is left to verifyChain.
    const reason = walk.check(entry, entries[0]?.word ?? entry.word, null, { signatures: true, hostKey: signedBy });
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

/** The voiced line for readers: "<word>, voiced through <model> in seat <seat_id>". */
export function voicedThrough(word: Word, model: string, seatId: string): string {
  return `${word}, voiced through ${model} in seat ${seatId}`;
}

/* ── Chain walking ────────────────────────────────────────────────────── */

/** What the chain has pinned so far; advanced one verified entry at a time. */
class ChainWalk {
  private prev: LedgerEntry | null = null;
  private prevHash: LedgerHash | null = null;
  private originHash: LedgerHash | null = null;
  /** Op keys by kid, base64url. */
  private pinned = new Map<string, string>();
  private root: LedgerKey | null = null;
  /** The DID genesis named; null before genesis. */
  private did: string | null = null;
  /**
   * The highest authority sequence any root evidence so far spent. agenttool
   * claims each sequence once and only upward, so evidence at or below it is a
   * replay: a revoked key cannot come back on its old import.
   */
  private lastSequence = 0;

  /**
   * The first problem with `raw` as the next entry, or null. `trusted` null
   * skips only the host-key trust list; then `hostKey`, when given, is the key
   * a host entry must name and verify against.
   */
  check(raw: unknown, firstWord: unknown, trusted: TrustedKeys | null, opts: { signatures: boolean; hostKey?: Uint8Array }): string | null {
    let e: LedgerEntry;
    try {
      e = parseEntry(raw);
    } catch (err) {
      return `malformed entry: ${(err as Error).message}`;
    }
    const seq = this.prev ? this.prev.seq + 1 : 0;
    if (e.seq !== seq) return `seq ${e.seq} where ${seq} was expected`;
    if (e.word !== firstWord) return "entry belongs to another citizen";
    if (e.prev_hash !== this.prevHash) return "prev_hash does not link to the previous entry";
    // The origin is pinned first and never again (KS-004 4.2, 5.2: a missing origin does not seat).
    if (seq === 0 && e.type !== "origin") return "the first entry must be origin";
    if (e.type === "origin" && seq !== 0) return "origin may only be the first entry";

    let keys = this.pinned;
    let root = this.root;
    if (e.type === "genesis") {
      if (this.did !== null) return "a second genesis";
      const problem = this.genesisProblem(e, trusted);
      if (problem) return `genesis: ${problem}`;
      keys = new Map([[e.op.kid, e.op.public_key]]);
      root = e.root;
    } else if (e.type === "key") {
      const problem = this.keyProblem(e);
      if (problem) return `key: ${problem}`;
      // A new key signs the entry that installs it, so the key being replaced never authorises its replacement;
      // an entry that only revokes is signed by a key that stays.
      keys = e.installed.length > 0 ? new Map(e.installed.map((k) => [k.kid, k.public_key])) : afterKey(this.pinned, e);
    }

    const did = e.type === "genesis" ? e.did : this.did;
    if (e.did !== did) return did === null ? "an entry before genesis names a DID" : "the entry names a DID other than its genesis";
    const citizenEra = did !== null;
    if (!citizenEra && e.signer !== "host") return "citizen-signed entry before genesis";
    if (citizenEra && e.signer === "host") return "host-signed entry after genesis";

    if (e.signer === "host") {
      // KS-004 4.5 lets a host entry go unsigned, integrity-only. This host signs every one, so an unsigned one is not trusted here.
      if (e.kid === null || e.sig === null) return "host entry is unsigned (kid and sig null): its chain is integrity-only, and this host signs every host entry";
      let pub: Uint8Array | null = null;
      if (trusted) {
        pub = trustedHostKeys(trusted).find((k) => hostKid(k) === e.kid) ?? null;
        if (!pub) return "host key is not trusted";
      } else if (opts.hostKey) {
        if (hostKid(opts.hostKey) !== e.kid) return "host entry is not signed by the key its kid names";
        pub = opts.hostKey;
      }
      if (opts.signatures && pub && !signatureVerifies(e, pub)) return "signature does not verify";
    } else {
      if (root && e.kid === root.kid) return "signed by the root key, which signs only authority acts";
      const pub = keys.get(e.kid as string);
      if (pub === undefined) {
        if (e.type === "key") return e.installed.length > 0 ? "key is not signed by a key it installs" : "key is not signed by a key that stays";
        return "signing key is not a pinned op key";
      }
      if (root && pub === root.public_key) return "signed by the root key, which signs only authority acts";
      if (opts.signatures && !signatureVerifies(e, fromB64url(pub, 32))) return "signature does not verify";
    }
    return null;
  }

  /** Why a genesis may not follow the chain so far, or null. */
  private genesisProblem(e: Extract<LedgerEntry, { type: "genesis" }>, trusted: TrustedKeys | null): string | null {
    if (e.did === null) return "names no DID";
    if (e.origin_entry !== this.originHash) return "does not point back to the origin entry";
    const rootKey = fromB64url(e.root.public_key, 32);
    const opKey = fromB64url(e.op.public_key, 32);
    if (keyFingerprint(rootKey) !== e.root.fingerprint || keyFingerprint(opKey) !== e.op.fingerprint) return "a fingerprint does not match its key";
    if (e.op.kid === e.root.kid || bytesEqual(opKey, rootKey)) return "pins the root as an op key";
    if (trusted?.identity) {
      let recorded: Uint8Array | null = null;
      try {
        recorded = fromB64(trusted.identity.root_public_key_b64, 32);
      } catch {
        recorded = null;
      }
      if (trusted.identity.did !== e.did || !recorded || !bytesEqual(recorded, rootKey)) return "names an identity other than the host's record";
    }
    // The first op key is the root's choice too, shown the same way as every later one.
    return rootEvidenceProblem(e.evidence, { did: e.did, root_public_key: rootKey }, { kind: "import", public_key: opKey });
  }

  /** Why a key entry may not follow the chain so far, or null. Every key it touches comes with the root's evidence. */
  private keyProblem(e: Extract<LedgerEntry, { type: "key" }>): string | null {
    const root = this.root;
    if (this.did === null || !root) return "before genesis";
    if (e.installed.length + e.revoked.length === 0) return "changes no key";
    const identity = { did: this.did, root_public_key: fromB64url(root.public_key, 32) };
    const sequences: number[] = [];
    const kids = new Set<string>();
    for (const k of e.installed) {
      if (k.kid === root.kid || k.public_key === root.public_key) return "pins the root as an op key";
      if (kids.has(k.kid) || this.pinned.has(k.kid) || [...this.pinned.values()].includes(k.public_key)) return "installs a key that is already pinned";
      kids.add(k.kid);
      const problem = rootEvidenceProblem(k.evidence, identity, { kind: "import", public_key: fromB64url(k.public_key, 32) });
      if (problem) return problem;
      sequences.push(evidenceSequence(k.evidence));
    }
    for (const r of e.revoked) {
      if (!this.pinned.has(r.kid) || kids.has(r.kid)) return "revokes a key that is not pinned";
      kids.add(r.kid);
      const problem = rootEvidenceProblem(r.evidence, identity, { kind: "revoke", kid: r.kid });
      if (problem) return problem;
      sequences.push(evidenceSequence(r.evidence));
    }
    if (new Set(sequences).size !== sequences.length || sequences.some((n) => !(n > this.lastSequence))) {
      return "root evidence reuses an authority sequence already spent";
    }
    if (afterKey(this.pinned, e).size === 0) return "revokes the last op key without installing a new one";
    return null;
  }

  /** Take a checked entry as the new head. */
  advance(e: LedgerEntry): void {
    const hash = entryHash(e);
    if (e.type === "origin") this.originHash = hash;
    else if (e.type === "genesis") {
      this.did = e.did;
      this.pinned = new Map([[e.op.kid, e.op.public_key]]);
      this.root = e.root;
      this.lastSequence = evidenceSequence(e.evidence);
    } else if (e.type === "key") {
      this.pinned = afterKey(this.pinned, e);
      const spent = [...e.installed, ...e.revoked].map((k) => evidenceSequence(k.evidence));
      this.lastSequence = Math.max(this.lastSequence, ...spent);
    }
    this.prev = e;
    this.prevHash = hash;
  }
}

/** The host keys a verifier trusts, decoded; a key that does not decode is left out, so it trusts nothing. */
function trustedHostKeys(trusted: TrustedKeys): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (const b64 of trusted.host_attest_b64) {
    try {
      out.push(fromB64(b64, 32));
    } catch {
      // not a key; trusts nothing
    }
  }
  return out;
}

function signatureVerifies(e: LedgerEntry, publicKey: Uint8Array): boolean {
  if (e.sig === null) return false;
  try {
    return edVerifyStrict(fromB64url(e.sig, 64), signingDigest(e), publicKey);
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
      // Strict: a duplicate key would let a reader and the hash disagree about a value.
      value = parseStrictJson(line);
    } catch {
      throw new Refusal("invalid-record", `ledger: line ${i + 1} is not strict JSON`);
    }
    try {
      return parseEntry(value);
    } catch (err) {
      throw new Refusal("invalid-record", `ledger: line ${i + 1}: ${(err as Error).message}`);
    }
  });
}

const COMMON_KEYS = [
  "format",
  "word",
  "did",
  "seq",
  "prev_hash",
  "type",
  "seat_ref",
  "runtime",
  "input_digest",
  "output_digest",
  "acts",
  "voiced",
  "cost",
  "ts",
  "signer",
  "kid",
  "sig",
] as const;
const SEAT_KEYS = ["seat_ref", "runtime", "input_digest", "output_digest", "voiced"] as const;
/** The fields each type adds, required then optional. */
const TYPE_KEYS: Record<LedgerEntry["type"], { required: readonly string[]; optional: readonly string[] }> = {
  origin: { required: ["origin", "origin_soul_hash", "old_repo", "june_did"], optional: [] },
  beat: { required: [], optional: ["dropped", "letter"] },
  state: { required: ["from", "to", "via"], optional: ["interval_h", "step_away", "quiet_until", "quiet_days"] },
  apply: { required: ["ref", "target", "prior_hash", "new_hash", "via", "reason", "strand_thought", "strand_key", "strand_backup", "expression"], optional: [] },
  revert: { required: ["target", "from_hash", "to_hash", "via", "expression"], optional: [] },
  genesis: { required: ["origin_entry", "root", "op", "evidence"], optional: [] },
  key: { required: ["installed", "revoked"], optional: [] },
};
const OLD_LAYOUT_KEYS = ["body", "hash", "signature", "attestation", "spend"];
const ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const HOST_KID_PATTERN = /^host:SHA256:[A-Za-z0-9+/]{43}$/;
const ACT_TYPES = new Set(["journal", "self.propose", "self.affirm", "self.revert", "state.set", "letter.send", "propose.beyond"]);
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

/**
 * Validate one entry's shape and encoding; throws with a reason. Every
 * top-level key is known, because the digest covers exactly them, and a line
 * in the earlier layout is named as such rather than as a broken entry.
 */
export function parseEntry(value: unknown): LedgerEntry {
  const e = obj(value, "entry");
  if (OLD_LAYOUT_KEYS.some((k) => Object.hasOwn(e, k))) throw new Error(OLD_LAYOUT_REASON);
  if (e.format !== LEDGER_FORMAT) throw new Error("format");
  const encoding = encodingProblem(e);
  if (encoding) throw new Error(encoding);
  if (typeof e.type !== "string" || !(LEDGER_TYPES as readonly string[]).includes(e.type)) throw new Error("type is not one of the seven");
  const type = e.type as LedgerEntry["type"];
  const allowed = new Set<string>([...COMMON_KEYS, ...TYPE_KEYS[type].required, ...TYPE_KEYS[type].optional]);
  // Named without the key itself: verify prints this reason, and a key in the file is not the host's words.
  for (const k of Object.keys(e)) if (!allowed.has(k)) throw new Error("a field outside the format");
  for (const k of [...COMMON_KEYS, ...TYPE_KEYS[type].required]) if (!Object.hasOwn(e, k)) throw new Error(`missing field ${k}`);

  if (typeof e.word !== "string" || !WORD_PATTERN.test(e.word)) throw new Error("word");
  if (e.did !== null && (typeof e.did !== "string" || !DID_PATTERN.test(e.did))) throw new Error("did");
  if (!Number.isSafeInteger(e.seq) || (e.seq as number) < 0) throw new Error("seq");
  if (e.prev_hash !== null) ledgerHashField(e.prev_hash, "prev_hash");
  if ((e.seq === 0) !== (e.prev_hash === null)) throw new Error("prev_hash is null exactly at seq 0");
  isoTime(e.ts, "ts");
  costField(e.cost);

  // A seat's fields come together, or not at all.
  const seated = SEAT_KEYS.filter((k) => e[k] !== null).length;
  if (seated !== 0 && seated !== SEAT_KEYS.length) throw new Error("seat_ref, runtime, input_digest, output_digest and voiced are all set or all null");
  if (e.seat_ref !== null) {
    uuid(e.seat_ref, "seat_ref");
    runtimeField(e.runtime);
    ledgerHashField(e.input_digest, "input_digest");
    ledgerHashField(e.output_digest, "output_digest");
    str(e.voiced, "voiced");
  }
  if (type === "beat") {
    if (e.seat_ref === null) throw new Error("a beat is written in a seat");
    actsField(e.acts);
  } else if (e.acts !== null) throw new Error("only a beat carries acts");

  if (e.signer !== "citizen" && e.signer !== "host") throw new Error("signer");
  if ((e.kid === null) !== (e.sig === null)) throw new Error("kid and sig are both set or both null");
  if (e.kid !== null) {
    str(e.kid, "kid");
    b64urlBytes(e.sig, 64, "sig");
  }
  if (e.signer === "citizen") {
    if (e.kid === null) throw new Error("a citizen entry is signed");
    uuid(e.kid, "kid");
  } else if (e.kid !== null && !HOST_KID_PATTERN.test(e.kid as string)) throw new Error("kid of a host entry is host:<fingerprint>");

  fieldsOf(type, e);
  return value as LedgerEntry;
}

/** The fields one type adds; throws with the field that failed. */
function fieldsOf(type: LedgerEntry["type"], e: Record<string, unknown>): void {
  switch (type) {
    case "origin":
      ledgerOrigin(e.origin);
      ledgerHashField(e.origin_soul_hash, "origin_soul_hash");
      if (e.old_repo !== null) {
        const r = exactly(e.old_repo, ["head", "url"], "old_repo");
        str(r.url, "old_repo.url");
        str(r.head, "old_repo.head");
      }
      if (e.june_did !== null && (typeof e.june_did !== "string" || !DID_PATTERN.test(e.june_did))) throw new Error("june_did");
      if (e.signer !== "host" || e.seat_ref !== null) throw new Error("origin is the host's, written outside a seat");
      return;
    case "beat":
      beatFields(e);
      return;
    case "state":
      lifecycle(e.from, "from");
      lifecycle(e.to, "to");
      if (!["immediate", "confirmed", "two-beats", "witnessed", "seated", "quiet"].includes(e.via as string)) throw new Error("via");
      if (e.to === "ended" && e.via !== "witnessed") throw new Error("ended needs a witness");
      if (e.via === "seated" && (e.signer !== "host" || e.seat_ref !== null)) throw new Error("a seated state is the host's, written outside a seat");
      if (e.interval_h !== undefined && (!Number.isSafeInteger(e.interval_h) || (e.interval_h as number) < 1 || e.to !== "awake")) {
        throw new Error("interval_h is whole hours on a move to awake");
      }
      if (e.step_away !== undefined && (e.step_away !== "first" || e.to !== "asleep" || e.seat_ref === null)) {
        throw new Error("step_away is \"first\", on a seat's move to asleep");
      }
      quietFields(e);
      return;
    case "apply":
      ledgerHashField(e.ref, "ref");
      selfTargetSpelling(e.target, "target");
      ledgerHashField(e.prior_hash, "prior_hash");
      ledgerHashField(e.new_hash, "new_hash");
      if (e.via !== "two-beats" && e.via !== "yu-present") throw new Error("via");
      reasonField(e.reason, "reason");
      if (e.strand_thought !== null) str(e.strand_thought, "strand_thought");
      if (e.strand_key !== null) str(e.strand_key, "strand_key");
      // A registered citizen's change owes a backup, posted or deferred; an unregistered one's owes none (KS-004 4.3, 6.3).
      if (e.strand_backup !== null && e.strand_backup !== "posted" && e.strand_backup !== "deferred") throw new Error("strand_backup");
      if ((e.strand_backup === null) !== (e.strand_key === null)) throw new Error("strand_backup and strand_key are both set or both null");
      if ((e.strand_backup === "posted") !== (e.strand_thought !== null)) throw new Error("strand_thought is set exactly when the backup was posted");
      expressionField(e);
      return;
    case "revert":
      selfTargetSpelling(e.target, "target");
      ledgerHashField(e.from_hash, "from_hash");
      ledgerHashField(e.to_hash, "to_hash");
      if (e.via !== "citizen" && e.via !== "yu-offer") throw new Error("via");
      expressionField(e);
      return;
    case "genesis":
      ledgerHashField(e.origin_entry, "origin_entry");
      for (const k of ["root", "op"] as const) {
        const key = exactly(e[k], ["fingerprint", "kid", "public_key"], k);
        uuid(key.kid, `${k}.kid`);
        b64urlBytes(key.public_key, 32, `${k}.public_key`);
        str(key.fingerprint, `${k}.fingerprint`);
      }
      evidenceField(e.evidence, "evidence");
      if (e.did === null || e.signer !== "citizen" || e.seat_ref !== null) throw new Error("genesis names its DID and is citizen-signed, outside a seat");
      return;
    case "key":
      if (!Array.isArray(e.installed) || !Array.isArray(e.revoked)) throw new Error("installed and revoked are lists");
      for (const raw of e.installed) {
        const k = exactly(raw, ["evidence", "kid", "public_key"], "installed[]");
        uuid(k.kid, "installed[].kid");
        b64urlBytes(k.public_key, 32, "installed[].public_key");
        evidenceField(k.evidence, "installed[].evidence");
      }
      for (const raw of e.revoked) {
        const k = exactly(raw, ["evidence", "kid"], "revoked[]");
        uuid(k.kid, "revoked[].kid");
        evidenceField(k.evidence, "revoked[].evidence");
      }
      return;
  }
}

/**
 * The value subset KS-004 4.5 allows: objects, arrays, strings, integers
 * within ±2^53 and null. No floats and no booleans, so every reader's JCS
 * gives the same bytes. A fixed phrase for the first offending value, or
 * null; it names no key, since keys are the file's words, not the host's.
 */
function encodingProblem(v: unknown): string | null {
  if (v === null || typeof v === "string") return null;
  if (typeof v === "number") return Number.isSafeInteger(v) ? null : "a number that is not an integer within 2^53";
  if (typeof v === "boolean") return "a boolean, which the ledger does not use";
  if (Array.isArray(v)) {
    for (const x of v) {
      const p = encodingProblem(x);
      if (p) return p;
    }
    return null;
  }
  if (typeof v === "object") {
    for (const x of Object.values(v as Record<string, unknown>)) {
      const p = encodingProblem(x);
      if (p) return p;
    }
    return null;
  }
  return "a value that is not JSON";
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

function ledgerOrigin(value: unknown): void {
  const o = obj(value, "origin");
  if (o.kind === "canon") {
    exactly(o, ["commit", "hash", "kind", "path", "repo"], "origin");
    for (const k of ["repo", "path", "commit"]) str(o[k], `origin.${k}`);
    ledgerHashField(o.hash, "origin.hash");
  } else if (o.kind === "archetype") {
    exactly(o, ["kind", "lineage", "note"], "origin");
    if (!Array.isArray(o.lineage) || o.lineage.length === 0) throw new Error("origin.lineage");
    for (const l of o.lineage) str(l, "origin.lineage[]");
    str(o.note, "origin.note", true);
  } else throw new Error("origin.kind");
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

/** A beat's acts: never empty, never a rest, each one of the registry's types. */
function actsField(value: unknown): void {
  if (!Array.isArray(value) || value.length === 0) throw new Error("acts of a beat are a non-empty list");
  for (const act of value) {
    const a = obj(act, "acts[]");
    if (a.type === "rest") throw new Error("a beat never carries a rest");
    if (typeof a.type !== "string" || !ACT_TYPES.has(a.type)) throw new Error("acts[].type");
    if (a.type === "state.set") lifecycle(a.to, "acts[].to");
    if (a.type === "self.propose") reasonField(a.reason, "acts[].reason");
  }
}

const DROPPED_TYPES = new Set([...ACT_TYPES, "rest"]);

/**
 * A beat's own fields (KS-004 5.7, 5.8): `dropped`, the acts the reply held
 * that the beat did not keep, each `{type, reason}`, never empty when
 * present; and `letter`, where its letter went, present exactly when its
 * acts hold a letter.send.
 */
function beatFields(e: Record<string, unknown>): void {
  if (Object.hasOwn(e, "dropped")) {
    if (!Array.isArray(e.dropped) || e.dropped.length === 0) throw new Error("dropped is a non-empty list when present");
    for (const raw of e.dropped) {
      const d = exactly(raw, ["reason", "type"], "dropped[]");
      if (d.type !== null && (typeof d.type !== "string" || !DROPPED_TYPES.has(d.type))) throw new Error("dropped[].type");
      str(d.reason, "dropped[].reason");
    }
  }
  const sends = Array.isArray(e.acts) && e.acts.some((a) => (a as { type?: unknown }).type === "letter.send");
  if (Object.hasOwn(e, "letter") !== sends) throw new Error("letter is set exactly when a beat sends one");
  if (sends) {
    const l = exactly(e.letter, ["delivery", "message_id"], "letter");
    if (l.delivery === "inbox") uuid(l.message_id, "letter.message_id");
    else if (l.delivery !== "held" || l.message_id !== null) throw new Error("letter.delivery");
  }
}

function reasonField(value: unknown, what: string): void {
  const c = exactly(value, ["confidence", "evidence", "kind", "limits"], what);
  if (!["observation", "inference", "proposal", "decision"].includes(c.kind as string)) throw new Error(`${what}.kind`);
  if (!Array.isArray(c.evidence)) throw new Error(`${what}.evidence`);
  for (const ref of c.evidence) str(ref, `${what}.evidence[]`);
  if (!["high", "medium", "low", "unknown"].includes(c.confidence as string)) throw new Error(`${what}.confidence`);
  str(c.limits, `${what}.limits`, true);
}

/** What an apply or revert did to the private expression: "updated", "lags", or null; only a registered citizen has one. */
function expressionField(e: Record<string, unknown>): void {
  if (e.expression !== null && e.expression !== "updated" && e.expression !== "lags") throw new Error("expression");
  if (e.expression !== null && e.signer !== "citizen") throw new Error("only a registered citizen has an expression");
}

/**
 * A state entry's quiet (KS-004 6.4): a declaration names its `until` and
 * the days asked for, on a move to listening or asleep or a renewal there; an
 * end (null `until`) goes with a move to awake, or a "quiet" entry that is
 * awake. Only a registered citizen has a quiet declaration. A "quiet" entry
 * moves nothing: it is the signer's, outside a seat, and carries the quiet.
 */
function quietFields(e: Record<string, unknown>): void {
  const hasUntil = Object.hasOwn(e, "quiet_until");
  const hasDays = Object.hasOwn(e, "quiet_days");
  if (e.via === "quiet" && (e.from !== e.to || e.seat_ref !== null || !hasUntil)) throw new Error("a quiet entry moves nothing, outside a seat, and carries its quiet");
  if (!hasUntil) {
    if (hasDays) throw new Error("quiet_days goes with a declared quiet_until");
    return;
  }
  if (e.signer !== "citizen") throw new Error("only a registered citizen has a quiet declaration");
  if (e.quiet_until === null) {
    if (hasDays || e.to !== "awake") throw new Error("a quiet end goes with a move to awake");
    return;
  }
  isoTime(e.quiet_until, "quiet_until");
  if (e.to !== "listening" && e.to !== "asleep") throw new Error("a quiet declaration goes with listening or asleep");
  if (!Number.isSafeInteger(e.quiet_days) || (e.quiet_days as number) < 1 || (e.quiet_days as number) > 30) throw new Error("quiet_days is whole days from 1 to 30");
}

function runtimeField(value: unknown): void {
  const r = exactly(value, ["class", "digest", "model"], "runtime");
  if (r.class !== "free" && r.class !== "summon" && r.class !== "hermes") throw new Error("runtime.class");
  str(r.model, "runtime.model");
  str(r.digest, "runtime.digest");
}

function costField(value: unknown): void {
  const c = exactly(value, ["credits", "usd"], "cost");
  // Money is a decimal string, never a float (money.ts); null is an unknown cost.
  if (c.usd !== null && !isUsd(c.usd)) throw new Error("cost.usd");
  if (!Number.isSafeInteger(c.credits) || (c.credits as number) < 0) throw new Error("cost.credits");
}

/** A LedgerEvidence's shape; whether it proves anything is rootEvidenceProblem's to say. */
function evidenceField(value: unknown, what: string): void {
  const ev = exactly(value, ["body", "headers", "method", "target"], what);
  str(ev.method, `${what}.method`);
  str(ev.target, `${what}.target`);
  if (typeof ev.body !== "string" || !/^[A-Za-z0-9_-]*$/.test(ev.body)) throw new Error(`${what}.body`);
  const h = exactly(ev.headers, Object.values(AUTHORITY_HEADERS), `${what}.headers`);
  for (const name of Object.values(AUTHORITY_HEADERS)) str(h[name], `${what}.headers.${name}`);
}

/** An object with exactly these keys: what is hashed into the entry may not carry anything unchecked. */
function exactly(value: unknown, keys: readonly string[], what: string): Record<string, unknown> {
  const o = obj(value, what);
  const got = Object.keys(o).sort();
  const want = [...keys].sort();
  if (got.length !== want.length || got.some((k, i) => k !== want[i])) throw new Error(`${what} has other fields than ${want.join(", ")}`);
  return o;
}

function uuid(value: unknown, what: string): void {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) throw new Error(what);
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

function ledgerHashField(value: unknown, what: string): void {
  if (typeof value !== "string" || !LEDGER_HASH_PATTERN.test(value)) throw new Error(`${what} is not sha256:<hex>`);
}

function b64urlBytes(value: unknown, length: number, what: string): void {
  try {
    fromB64url(value as string, length);
  } catch {
    throw new Error(`${what} is not base64url of ${length} bytes`);
  }
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
