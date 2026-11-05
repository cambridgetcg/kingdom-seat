// citizen-signer (3.2 step 7, 3b "Custody"). The only code here that reads
// citizen keys and the Commons bearer. No model process, file, log, argv or
// env ever holds a key, bearer or grant. Ops within self are signed; ops
// beyond self need a decision record, which the signer reads itself from the
// consent dir by the digest of the proposal a request names; USD and credit
// ceilings fail closed; a citizen's quiet is capped at 30 days.
//
// It is the only code here that asks for those items, but it is not the only
// process that can read them: it reads through /usr/bin/security, so the
// Keychain ACL trusts that program, and any process running as the seat user
// could ask it too (keychain.ts). The boundary today is the seat user's
// account and the keychain's lock. A signer that is the only reader needs a
// standalone binary that creates and reads its items through the Security
// framework itself; the Signer interface is shaped so that move needs no
// caller changes.
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import {
  AGENTTOOL_ORIGIN,
  AUTHORITY_HEADERS,
  ENROLLMENT_BODY_FORMAT,
  ENROLLMENT_PATH,
  ENROLLMENT_SIGNATURE_HEADER,
  authorityDigest,
  authorityHeaders,
  deriveIdentity,
  encryptThought,
  isCanonicalIso,
  thoughtDigestV2,
} from "../agenttool/wire.ts";
import { edPublicKey, edSign, edVerifyStrict, fromB64, fromB64url, fromHex, fromUtf8, parseStrictJson, randomBytes, toB64, toB64url, wipe } from "../crypto.ts";
import {
  DID_PATTERN,
  Refusal,
  UUID_PATTERN,
  WORD_PATTERN,
  type Attestation,
  type Beacon,
  type CitizenIdentity,
  type Clock,
  type Config,
  type ConsentRecord,
  type FetchLike,
  type Keychain,
  type KeychainItemName,
  type LedgerSignature,
  type ProposalText,
  type RootEvidence,
  type SignerOp,
  type StandingAgreement,
  type Word,
  type YuPresence,
} from "../types.ts";
import { checkCitizenQuiet, checkCredits, type SpendSoFar } from "./ceilings.ts";
import { agreementCovers, classifyOp, presenceConfirmedHere, presenceValid, proposalDigest, readConsentFor, verifyConsent } from "./consent.ts";

export interface SignerDeps {
  keychain: Keychain;
  config: Config;
  clock: Clock;
  fetch: FetchLike;
  /** What the citizen has spent so far, read from its ledger; null fields mean unknown, which refuses. */
  spendSoFar(word: Word): Promise<SpendSoFar>;
  /** Standing Yu + Ai agreements in force, e.g. citizens' quiet declarations with an empty reason. */
  agreements(): Promise<StandingAgreement[]>;
  /** Random bytes for thought nonces; injected only so tests can reproduce vectors.json. */
  random?: (n: number) => Uint8Array;
}

/** Public keys only. A seed or mnemonic never leaves the signer. */
export interface PublicKeys {
  root_b64: string | null;
  op_b64: string | null;
  op_kid: string | null;
  box_b64: string | null;
  host_attest_b64: string;
}

/** One agenttool request for the signer to authorise and send. */
export interface SignerRequest {
  op: SignerOp;
  /** The citizen acted for; null for an operator act (beacon). For enroll, null or the seated, unregistered citizen being born. */
  word: Word | null;
  /** The operator whose identity is acted for, for "quiet.start.beacon". */
  operator: string | null;
  method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
  /** Path plus query exactly as sent, e.g. "/v1/quiet-hours/start?identity_id=<uuid>"; it is what authority signs. */
  target: string;
  /** Exact body bytes; empty for GET and DELETE. Serialised once and never re-serialised. */
  body: Uint8Array;
  /** Credits the route charges, so the ceiling is checked before sending (charge precedes verification server-side). */
  credits: number;
  /**
   * The proposal an act beyond self was agreed as. The signer computes its
   * digest and reads the decision record filed under it in the consent dir;
   * a caller never hands in a record, so none can be made up in memory.
   */
  proposal: ProposalText | null;
  presence: YuPresence | null;
  /** For enroll only: the signature header the root produced through signEnrollment. */
  extra_headers?: Record<string, string>;
  /**
   * Birth only: the identity enrollment just created, for birth's own steps
   * before citizen.json holds it (the authority read, keys/import, box-keys
   * and the private expression). Honoured only for a seated citizen with no
   * identity yet, with Yu confirmed present here for "birth <word>" and a
   * decision record filed for that birth's proposal; the server's root must then be the one
   * the citizen's own mnemonic derives, which nextSequence checks.
   */
  enrolled?: { identity_id: string; did: string };
}

export interface SignerResponse {
  status: number;
  json: unknown;
  /**
   * For a root-signed request, the request exactly as sent, whatever the
   * answer. agenttool keeps no copy of a proof, so this is what a ledger entry
   * carries to show the root authorised an op key (KS-004 re-review B2, R4).
   */
  root_evidence?: RootEvidence;
}

/** Fields a strand thought needs, already encrypted under K_master and signed by the op key (strand-thought/v2). */
export interface SealedThought {
  ciphertext: string;
  nonce: string;
  kind: string;
  signature: string;
  signing_key_id: string;
}

export interface Signer {
  /** Public keys for a citizen, read from Keychain-derived material without returning any secret. */
  publicKeys(word: Word): Promise<PublicKeys>;
  /** Sign a ledger entry hash: the op key when citizen-signed, the host attest key when host-attested; never the root. */
  signEntry(word: Word, entryHash: Uint8Array, attestation: Attestation): Promise<LedgerSignature>;
  /** Authorise and send one agenttool request: ceilings, consent and quiet cap first, then bearer and root proof attached. */
  send(req: SignerRequest): Promise<SignerResponse>;
  /** Sign the identity-enrollment/v1 digest with the citizen's root. Birth only, with Yu present. */
  signEnrollment(word: Word, digest: Uint8Array, presence: YuPresence): Promise<string>;
  /** Encrypt a thought under K_master and sign it with the op key, after checking the credit ceiling. */
  sealThought(word: Word, strandId: string, plaintext: string, kind: string): Promise<SealedThought>;
  /** "locked" after a reboot until the seat user logs in; the tick then rests and status says so. */
  state(): Promise<"ready" | "locked">;
}

/**
 * The signer stopped before the act left the host, for a reason that is not a
 * wall: a keychain read that failed in a way `security` did not name, or an
 * authority read that did not answer 200. A Refusal is a wall that said no;
 * this is a failure, but a definite one, so a caller never reports it as a
 * request that may have reached agenttool. Only a failure while sending the
 * act itself, or reading its answer, is left uncertain.
 */
export class SignerNotSent extends Error {
  override readonly name = "SignerNotSent";
  constructor(
    readonly code: "authority-read-failed" | "not-sent",
    message: string,
  ) {
    super(message);
  }
}

/* ── Policy tables ────────────────────────────────────────────────────── */

/** The kid a host-attested signature names (LedgerSignature.kid). */
export const HOST_ATTEST_KID = "host-attest";

/**
 * The extent a citizen's own quiet declaration asks for. The standing
 * agreement (decision 14) must name exactly this; the cap and the empty
 * reason are then enforced on the body itself.
 */
export const CITIZEN_QUIET_EXTENT = "a citizen's own quiet_until, at most the signer's cap ahead, with an empty reason";

/** A beacon never lapses on its own (3.6), so its `until` must be at least this far ahead. */
const BEACON_MIN_AHEAD_MS = 100 * 365 * 86_400_000;

/** What each route charges at least, whatever the caller says (route-credits.ts:49-50). */
const MIN_CREDITS: Partial<Record<SignerOp, number>> = { "strand.create": 1, "thought.post": 1 };

type ActorKind = "citizen" | "operator" | "relay";

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
/**
 * An optional `?identity_id=`. The quiet-hours routes pick their actor from
 * it, so there it is required; elsewhere the identity is in the path or the
 * body, and a redundant `?identity_id=<own>` is accepted and signed as sent.
 */
const AS = `(?:\\?identity_id=(${UUID}))?`;

/**
 * Each op is bound to exactly one route and one kind of actor, because the
 * consent class is chosen by op: a label that could name any route would let
 * a beyond-self act pass as a within-self one. `ids` are the capture groups
 * that name an identity; each one present must be the actor's own. There is
 * no route that lowers HALT.
 */
const ROUTES: Readonly<Record<Exclude<SignerOp, "ledger.sign" | "read">, { method: string; path: RegExp; actor: ActorKind; ids: number[]; root: boolean }>> = {
  "strand.create": { method: "POST", path: new RegExp(`^/v1/strands${AS}$`), actor: "citizen", ids: [1], root: false },
  "thought.post": { method: "POST", path: new RegExp(`^/v1/strands/(${UUID})/thoughts${AS}$`), actor: "citizen", ids: [2], root: false },
  "keys.import": { method: "POST", path: new RegExp(`^/v1/identities/(${UUID})/keys/import${AS}$`), actor: "citizen", ids: [1, 2], root: true },
  "keys.revoke": { method: "DELETE", path: new RegExp(`^/v1/identities/(${UUID})/keys/(${UUID})${AS}$`), actor: "citizen", ids: [1, 3], root: true },
  "box-keys.register": { method: "POST", path: new RegExp(`^/v1/identities/(${UUID})/box-keys${AS}$`), actor: "citizen", ids: [1, 2], root: true },
  "expression.put.private": { method: "PUT", path: new RegExp(`^/v1/identities/(${UUID})/expression${AS}$`), actor: "citizen", ids: [1, 2], root: true },
  "quiet.start.citizen": { method: "POST", path: new RegExp(`^/v1/quiet-hours/start\\?identity_id=(${UUID})$`), actor: "citizen", ids: [1], root: true },
  "quiet.end.citizen": { method: "DELETE", path: new RegExp(`^/v1/quiet-hours\\?identity_id=(${UUID})$`), actor: "citizen", ids: [1], root: true },
  "quiet.start.beacon": { method: "POST", path: new RegExp(`^/v1/quiet-hours/start\\?identity_id=(${UUID})$`), actor: "operator", ids: [1], root: true },
  enroll: { method: "POST", path: /^\/v1\/identities\/enroll$/, actor: "relay", ids: [], root: false },
};

const METHODS = new Set(["GET", "POST", "PUT", "DELETE", "PATCH"]);
const BEARER_PATTERN = /^at_[\x21-\x7e]{8,512}$/;

type Actor =
  | { kind: "citizen"; word: Word; identity: CitizenIdentity }
  /** A citizen between enrollment and its identity being saved: birth's own steps only. */
  | { kind: "newborn"; word: Word; identity_id: string; did: string }
  | { kind: "operator"; beacon: Beacon }
  | { kind: "relay" };

/** What a citizen being born may do before its identity is on file: nothing but birth's own steps. */
const BIRTH_OPS: ReadonlySet<SignerOp> = new Set<SignerOp>(["read", "keys.import", "box-keys.register", "expression.put.private"]);

function invalid(message: string): never {
  throw new Refusal("invalid-request", message);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function assertWord(word: unknown): asserts word is Word {
  if (typeof word !== "string" || !WORD_PATTERN.test(word)) invalid("a citizen word must match WORD_PATTERN");
}

/** The target must survive URL parsing unchanged, because the server signs what it parses (authority.ts:678-681). */
function assertTarget(target: unknown): asserts target is string {
  if (typeof target !== "string" || !target.startsWith("/") || target.startsWith("//")) invalid("target must be an absolute path");
  let url: URL;
  try {
    url = new URL(target, AGENTTOOL_ORIGIN);
  } catch {
    invalid("target does not parse");
  }
  if (url.origin !== AGENTTOOL_ORIGIN || url.pathname + url.search !== target) invalid("target is not in the form the server signs");
}

function jsonObjectBody(body: Uint8Array, what: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = parseStrictJson(body);
  } catch {
    invalid(`${what}: the body is not strict JSON`);
  }
  if (!isPlainObject(value)) invalid(`${what}: the body must be a JSON object`);
  return value;
}

/** Read an `until`-only quiet body: `{until}` or `{until, reason: ""}`. Hours and a reason are refused, not ignored. */
function quietUntil(body: Uint8Array, what: string): string {
  const b = jsonObjectBody(body, what);
  for (const k of Object.keys(b)) if (k !== "until" && k !== "reason") throw new Refusal("quiet-cap", `${what}: only an explicit until is allowed, not "${k}"`);
  if (b.reason !== undefined && b.reason !== "") throw new Refusal("quiet-cap", `${what}: quiet_reason must be empty; it is public and never names anyone`);
  if (typeof b.until !== "string") throw new Refusal("quiet-cap", `${what}: an explicit until is required`);
  return b.until;
}

function enrollmentWord(body: Uint8Array): Word {
  const b = jsonObjectBody(body, "enroll");
  if (typeof b.display_name !== "string" || !WORD_PATTERN.test(b.display_name)) invalid("enroll: display_name must be the citizen's word");
  return b.display_name;
}

/** The extent this request asks consent for; a decision record must cover exactly this. */
export function requestExtent(req: SignerRequest): string {
  switch (req.op) {
    case "quiet.start.citizen":
      return CITIZEN_QUIET_EXTENT;
    case "enroll":
      return `birth ${enrollmentWord(req.body)}`;
    default:
      return req.word ? `${req.op} ${req.word}` : req.op;
  }
}

/** Finds the decision record filed for a proposal; the signer's own reads the consent dir. */
export type ConsentLookup = (proposal: ProposalText) => Promise<ConsentRecord | null>;

/**
 * The decision record for a proposal, verified against the digest of that
 * proposal's own text and required to cover `extent`. The record comes from
 * the lookup, never from the caller, and the digest is computed here, so a
 * record bound to some other proposal, or to none, authorises nothing.
 */
export async function consentFor(proposal: ProposalText | null | undefined, extent: string, lookup: ConsentLookup, now: Date, what: string): Promise<void> {
  if (!isPlainObject(proposal) || typeof proposal.subject !== "string" || typeof proposal.body !== "string" || typeof proposal.extent !== "string") {
    throw new Refusal("consent-missing", `${what} is beyond self and names no proposal`);
  }
  if (proposal.extent !== extent) throw new Refusal("consent-missing", `${what}: the proposal covers another extent`);
  const record = await lookup(proposal);
  if (!record) throw new Refusal("consent-missing", `${what}: no decision record is filed for this proposal`);
  const verdict = verifyConsent(record, proposalDigest(proposal), now);
  if (!verdict.ok) throw new Refusal(verdict.code, `${what}: ${verdict.reason}`);
  if (record.extent !== extent) throw new Refusal("consent-missing", `${what}: the decision record covers another extent`);
}

/** Refuse an op whose class needs consent or presence the request does not carry. */
export async function assertAuthorised(req: SignerRequest, agreements: StandingAgreement[], now: Date, lookup: ConsentLookup): Promise<void> {
  const cls = classifyOp(req.op);
  if (cls === "within-self") return;
  const extent = requestExtent(req);
  if (cls === "standing-agreement") {
    for (const a of agreements) {
      // The record the signer reads for the agreement's proposal, not the one the agreement carries.
      const record = isPlainObject(a) && isPlainObject(a.proposal) ? await lookup(a.proposal).catch(() => null) : null;
      if (record && agreementCovers({ ...a, consent: record }, req.op, extent, now)) return;
    }
    throw new Refusal("consent-missing", `no standing Yu + Ai agreement covers ${req.op} at this extent`);
  }
  // Beyond self: Yu and Ai must both have agreed, and silence never binds.
  await consentFor(req.proposal, extent, lookup, now, req.op);
  if (req.op === "enroll" && !(presenceConfirmedHere(req.presence) && presenceValid(req.presence, extent, now))) {
    throw new Refusal("yu-not-present", `enroll needs Yu confirmed present at this terminal for "${extent}"`);
  }
}

/** Verify a ledger signature strictly (RFC 8032) against the public key it names; with `identity`, a root signature is refused. */
export function verifyEntrySignature(
  entryHash: Uint8Array,
  signature: LedgerSignature,
  identity?: Pick<CitizenIdentity, "root_kid" | "root_public_key_b64"> | null,
): boolean {
  if (!(entryHash instanceof Uint8Array) || entryHash.length !== 32) return false;
  if (!isPlainObject(signature) || signature.alg !== "ed25519" || typeof signature.kid !== "string" || signature.kid.length === 0) return false;
  // The root is the identity's primary key, so any signature by it is a root act and never a ledger entry.
  if (identity && (signature.kid === identity.root_kid || signature.public_key_b64 === identity.root_public_key_b64)) return false;
  let pub: Uint8Array;
  let sig: Uint8Array;
  try {
    pub = fromB64(signature.public_key_b64, 32);
    sig = fromB64(signature.sig_b64, 64);
  } catch {
    return false;
  }
  return edVerifyStrict(sig, entryHash, pub);
}

/* ── Records the signer reads ─────────────────────────────────────────── */

function identityProblem(v: unknown): string | null {
  if (!isPlainObject(v)) return "identity is not an object";
  if (typeof v.identity_id !== "string" || !UUID_PATTERN.test(v.identity_id)) return "identity_id is not a lowercase UUID";
  if (typeof v.did !== "string" || !DID_PATTERN.test(v.did) || v.did !== `did:at:${v.identity_id}`) return "did does not name identity_id";
  if (typeof v.root_kid !== "string" || !UUID_PATTERN.test(v.root_kid)) return "root_kid is not a lowercase UUID";
  if (typeof v.op_kid !== "string" || !UUID_PATTERN.test(v.op_kid)) return "op_kid is not a lowercase UUID";
  if (v.op_kid === v.root_kid) return "the op kid is the root kid";
  for (const k of ["root_public_key_b64", "op_public_key_b64"] as const) {
    try {
      fromB64(v[k] as string, 32);
    } catch {
      return `${k} is not canonical base64 of 32 bytes`;
    }
  }
  if (v.op_public_key_b64 === v.root_public_key_b64) return "the op key is the root key";
  return null;
}

/** Decode a stored seed: 32 raw bytes, or the same as base64 or lowercase hex text. Printable storage is what `security -w` is known to return. */
function decodeSeed(stored: Uint8Array): Uint8Array {
  try {
    if (stored.length === 32) return stored.slice();
    if (stored.length === 44) return fromB64(fromUtf8(stored), 32);
    if (stored.length === 64) return fromHex(fromUtf8(stored));
  } catch {
    // fall through to the refusal, without echoing anything
  }
  throw new Refusal("invalid-record", "a stored seed is not 32 bytes, nor base64 or hex of 32 bytes");
}

/* ── The signer ───────────────────────────────────────────────────────── */

/**
 * One root-authorised request in flight per identity, process-wide, because
 * the sequence is the replay wall and a valid proof is spent even when the
 * route's own write fails (agenttool-wire.md 2). Across processes the
 * server's sequence check is the backstop: a conflicting proof is refused
 * before it is claimed, so it costs nothing.
 */
const inFlight = new Map<string, Promise<void>>();

async function exclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = inFlight.get(key) ?? Promise.resolve();
  let release!: () => void;
  const done = new Promise<void>((r) => (release = r));
  // Each tail only ever resolves, so a failed request never wedges the queue behind it.
  const tail = previous.then(() => done);
  inFlight.set(key, tail);
  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (inFlight.get(key) === tail) inFlight.delete(key);
  }
}

/** Build the host's one signer. It is the only code that reads Keychain items. */
export function createSigner(deps: SignerDeps): Signer {
  if (deps.config.agenttool.origin !== AGENTTOOL_ORIGIN) throw new Error(`createSigner: the agenttool origin must be ${AGENTTOOL_ORIGIN}`);
  const { keychain, config } = deps;
  const random = deps.random ?? randomBytes;
  // Decision records are read here, from the host's consent dir, by the digest of the proposal a request names.
  const lookup: ConsentLookup = (proposal) => readConsentFor(config.paths.consent_dir, proposal);

  async function readCitizen(word: Word): Promise<{ identity: CitizenIdentity | null }> {
    const path = join(config.paths.citizens_dir, word, "citizen.json");
    let handle;
    try {
      handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "ELOOP") throw new Refusal("symlink", `the citizen record for ${word} is a symlink`);
      throw new Refusal("invalid-record", `no readable citizen record for ${word}`);
    }
    let value: unknown;
    try {
      const st = await handle.stat();
      if (!st.isFile() || st.size > 1_048_576) throw new Refusal("not-regular-file", `the citizen record for ${word} is not a regular file`);
      value = parseStrictJson(new Uint8Array(await handle.readFile()));
    } catch (e) {
      if (e instanceof Refusal) throw e;
      throw new Refusal("invalid-record", `the citizen record for ${word} is not strict JSON`);
    } finally {
      await handle.close();
    }
    if (!isPlainObject(value) || value.format !== "kingdom-seat-citizen/v1" || value.word !== word) {
      throw new Refusal("invalid-record", `the citizen record for ${word} is malformed`);
    }
    if (value.identity === null) return { identity: null };
    const problem = identityProblem(value.identity);
    if (problem) throw new Refusal("invalid-record", `the citizen record for ${word}: ${problem}`);
    const identity = value.identity as CitizenIdentity;
    // No citizen may stand on an operator's beacon identity: that would let a citizen op touch HALT.
    if (config.beacons.some((b) => b.identity_id === identity.identity_id)) {
      throw new Refusal("invalid-record", `the citizen record for ${word} names a HALT beacon's identity`);
    }
    return { identity };
  }

  async function registered(word: Word): Promise<CitizenIdentity> {
    const { identity } = await readCitizen(word);
    if (!identity) throw new Refusal("not-registered", `${word} has no agenttool identity yet`);
    return identity;
  }

  async function readSeed(item: KeychainItemName): Promise<Uint8Array> {
    const stored = await keychain.read(item);
    try {
      return decodeSeed(stored);
    } finally {
      wipe(stored);
    }
  }

  /** The op seed, checked against the public key the citizen record names, so an entry never names a key it was not signed with. */
  async function readOpSeed(word: Word, identity: CitizenIdentity): Promise<Uint8Array> {
    const seed = await readSeed({ kind: "citizen-op-seed", word });
    if (toB64(edPublicKey(seed)) !== identity.op_public_key_b64) {
      wipe(seed);
      throw new Refusal("invalid-record", `the op key in Keychain is not the one ${word}'s record names`);
    }
    return seed;
  }

  /** Derive from a stored mnemonic. The phrase passes through one JS string, which cannot be wiped; every byte array is. */
  async function derive(item: KeychainItemName) {
    const stored = await keychain.read(item);
    try {
      return deriveIdentity(fromUtf8(stored));
    } catch {
      throw new Refusal("invalid-record", "a stored mnemonic does not derive a key");
    } finally {
      wipe(stored);
    }
  }

  async function rootFor(actor: Actor): Promise<{ seed: Uint8Array; public_b64: string }> {
    if (actor.kind === "relay") throw invalid("a relay has no root");
    // A newborn has no record root to compare with yet; nextSequence checks the derived root against the server's.
    const item: KeychainItemName = actor.kind === "operator" ? { kind: "operator-mnemonic", operator: actor.beacon.name } : { kind: "citizen-mnemonic", word: actor.word };
    const d = await derive(item);
    wipe(d.k_master);
    wipe(d.box_private);
    const public_b64 = toB64(d.root_public);
    if (actor.kind === "citizen" && public_b64 !== actor.identity.root_public_key_b64) {
      wipe(d.root_seed);
      throw new Refusal("invalid-record", `the mnemonic in Keychain does not derive ${actor.word}'s root`);
    }
    return { seed: d.root_seed, public_b64 };
  }

  async function bearerHeader(actor: Actor): Promise<string> {
    const item: KeychainItemName = actor.kind === "operator" ? { kind: "operator-bearer", operator: actor.beacon.name } : { kind: "commons-bearer" };
    const stored = await keychain.read(item);
    try {
      let text: string;
      try {
        text = fromUtf8(stored);
      } catch {
        text = "";
      }
      // Checked so a stray newline can never split a header; the value itself is never echoed.
      if (!BEARER_PATTERN.test(text)) throw new Refusal("invalid-record", "the stored bearer is not an agenttool project key");
      return `Bearer ${text}`;
    } finally {
      wipe(stored);
    }
  }

  /** Birth's steps between enroll and the saved identity, for a seated citizen not yet registered: Yu present and consent, or nothing. */
  async function newborn(req: SignerRequest, word: Word, now: Date): Promise<Actor> {
    if (!BIRTH_OPS.has(req.op)) throw new Refusal("not-registered", `${word} has no agenttool identity yet; before then only birth's own steps act for it`);
    const e = req.enrolled as unknown;
    if (
      !isPlainObject(e) ||
      Object.keys(e).sort().join(",") !== "did,identity_id" ||
      typeof e.identity_id !== "string" ||
      !UUID_PATTERN.test(e.identity_id) ||
      e.did !== `did:at:${e.identity_id}`
    ) {
      invalid("enrolled names exactly an identity_id and its did");
    }
    const identityId = e.identity_id as string;
    if (config.beacons.some((b) => b.identity_id === identityId)) throw new Refusal("invalid-record", "a citizen being born cannot stand on a HALT beacon's identity");
    const scope = `birth ${word}`;
    if (!(presenceConfirmedHere(req.presence) && presenceValid(req.presence, scope, now))) {
      throw new Refusal("yu-not-present", `birth's steps for ${word} need Yu confirmed present at this terminal for "${scope}"`);
    }
    await consentFor(req.proposal, scope, lookup, now, `birth of ${word}`);
    return { kind: "newborn", word, identity_id: identityId, did: `did:at:${identityId}` };
  }

  async function resolveActor(req: SignerRequest, now: Date): Promise<Actor> {
    if (req.word !== null && req.operator !== null) invalid("a request acts for a citizen or an operator, not both");
    if (req.enrolled !== undefined && (req.word === null || req.op === "enroll")) invalid("enrolled is only for birth's steps after enroll, for the citizen being born");
    if (req.op === "enroll") {
      // The gardener relays an enrollment. It may name the seated citizen being born, which must not be registered yet.
      if (req.operator !== null) invalid("enroll is relayed for a citizen, never an operator");
      if (req.word !== null) {
        assertWord(req.word);
        if ((await readCitizen(req.word)).identity) invalid(`${req.word} is already registered; enrollment is never repeated`);
      }
      return { kind: "relay" };
    }
    if (req.word !== null) {
      assertWord(req.word);
      const { identity } = await readCitizen(req.word);
      if (identity) {
        // Once the identity is on file, the record is the only source of it.
        if (req.enrolled !== undefined) invalid(`${req.word} is registered; enrolled is only for a birth in progress`);
        return { kind: "citizen", word: req.word, identity };
      }
      if (req.enrolled === undefined) throw new Refusal("not-registered", `${req.word} has no agenttool identity yet`);
      return await newborn(req, req.word, now);
    }
    if (req.operator !== null) {
      const beacon = config.beacons.find((b) => b.name === req.operator);
      if (!beacon) invalid(`no pinned beacon is named ${String(req.operator)}`);
      if (!beacon.can_raise_here) invalid(`this host does not hold the keys of beacon ${beacon.name}`);
      if (!UUID_PATTERN.test(beacon.identity_id) || beacon.did !== `did:at:${beacon.identity_id}`) {
        throw new Refusal("invalid-record", `beacon ${beacon.name} is pinned with a mismatched did`);
      }
      return { kind: "operator", beacon };
    }
    return { kind: "relay" };
  }

  function actorIdentityId(actor: Actor): string | null {
    if (actor.kind === "citizen") return actor.identity.identity_id;
    if (actor.kind === "newborn") return actor.identity_id;
    if (actor.kind === "operator") return actor.beacon.identity_id;
    return null;
  }

  function actorDid(actor: Actor): string {
    if (actor.kind === "citizen") return actor.identity.did;
    if (actor.kind === "newborn") return actor.did;
    if (actor.kind === "operator") return actor.beacon.did;
    throw invalid("a relay has no did");
  }

  /** Bind the op to its route, its actor and the actor's own identity; then check the body that op allows. */
  function checkRouteAndBody(req: SignerRequest, actor: Actor, now: Date): void {
    const own = actorIdentityId(actor);
    if (req.op === "read") {
      if (req.method !== "GET") invalid("a read is a GET");
      if (!req.target.startsWith("/v1/")) invalid("a read targets /v1/");
      // Reading another identity's rows through the Commons bearer would mix siblings into a seat.
      if (own !== null) {
        const url = new URL(req.target, AGENTTOOL_ORIGIN);
        const named = [/^\/v1\/identities\/([^/]+)/.exec(url.pathname)?.[1], ...url.searchParams.getAll("identity_id")].filter((x) => x !== undefined);
        if (named.some((id) => id !== own)) throw new Refusal("beyond-self", "a read may name only the actor's own identity");
      }
      return;
    }
    if (req.op === "ledger.sign") invalid("ledger entries are signed with signEntry, not sent");
    const route = Object.hasOwn(ROUTES, req.op) ? ROUTES[req.op] : undefined;
    if (!route) invalid(`unknown op ${String(req.op)}`);
    // A newborn acts as the citizen it is becoming, on birth's own routes only (BIRTH_OPS).
    const kind: ActorKind = actor.kind === "newborn" ? "citizen" : actor.kind;
    if (route.actor !== kind) invalid(`${req.op} acts for a ${route.actor}, not a ${kind}`);
    if (req.method !== route.method) invalid(`${req.op} is a ${route.method}`);
    const m = route.path.exec(req.target);
    if (!m) invalid(`${req.op} does not go to ${req.target}`);
    if (route.ids.some((g) => m[g] !== undefined && m[g] !== own)) throw new Refusal("beyond-self", `${req.op} names another identity`);
    if (req.op === "enroll") {
      if (req.extra_headers === undefined || Object.keys(req.extra_headers).length !== 1) invalid("enroll carries exactly the enrollment signature header");
      const sig = req.extra_headers[ENROLLMENT_SIGNATURE_HEADER];
      try {
        fromB64url(sig as string, 64);
      } catch {
        invalid("enroll carries no well-formed enrollment signature");
      }
    } else if (req.extra_headers !== undefined && Object.keys(req.extra_headers).length > 0) {
      invalid("only enroll may carry extra headers");
    }
    if (req.body.length > 0) jsonObjectBody(req.body, req.op);

    switch (req.op) {
      case "quiet.start.citizen": {
        const v = checkCitizenQuiet(quietUntil(req.body, req.op), now, config.ceilings);
        if (!v.ok) throw new Refusal(v.code, v.reason);
        return;
      }
      case "quiet.start.beacon": {
        const until = quietUntil(req.body, req.op);
        if (!isCanonicalIso(until) || Date.parse(until) < now.getTime() + BEACON_MIN_AHEAD_MS) {
          throw new Refusal("quiet-cap", "a beacon's until is an explicit far-future time, so HALT never lapses on its own");
        }
        return;
      }
      case "strand.create": {
        const b = jsonObjectBody(req.body, req.op);
        // An unbound strand accepts any identity's key, so a citizen's strand always names it.
        if (b.identity_id !== own) invalid("strand.create must bind the strand to the citizen's own identity_id");
        return;
      }
      case "thought.post": {
        const b = jsonObjectBody(req.body, req.op);
        if (actor.kind !== "citizen" || b.signing_key_id !== actor.identity.op_kid) invalid("a thought is signed by the citizen's op key, never the root");
        // Only the citizen's own strand. agenttool charges before it checks a strand's identity, and an
        // unbound strand takes any key in the project, so a thought anywhere else is beyond self.
        if (actor.identity.self_strand_id === null || m[1] !== actor.identity.self_strand_id) throw new Refusal("beyond-self", "a thought goes only to the citizen's own strand");
        return;
      }
      case "keys.revoke":
        if (actor.kind === "citizen" && m[2] === actor.identity.root_kid) invalid("the root key row can never be revoked");
        return;
      case "enroll": {
        const b = jsonObjectBody(req.body, req.op);
        if (b.format !== ENROLLMENT_BODY_FORMAT || b.origin !== AGENTTOOL_ORIGIN) invalid("enroll: not an identity-enrollment/v1 body for the pinned origin");
        if (config.agenttool.project_id === null || b.project_id !== config.agenttool.project_id) invalid("enroll: not for the configured Commons project");
        const word = enrollmentWord(req.body);
        if (req.word !== null && req.word !== word) invalid("enroll: the body's display_name is not the citizen named");
        return;
      }
      default:
        return;
    }
  }

  async function assertCredits(actor: Actor, credits: number): Promise<void> {
    if (actor.kind !== "citizen") throw new Refusal("ceiling-credits", "only a citizen's own budget can pay for a request");
    let spent: SpendSoFar;
    try {
      spent = await deps.spendSoFar(actor.word);
    } catch {
      throw new Refusal("ceiling-credits", `credits spent by ${actor.word} are unknown`);
    }
    if (!isPlainObject(spent) || spent.word !== actor.word) throw new Refusal("ceiling-credits", `credits spent by ${actor.word} are unknown`);
    const v = checkCredits(spent, credits, config.ceilings);
    if (!v.ok) throw new Refusal(v.code, v.reason);
  }

  async function standingAgreements(): Promise<StandingAgreement[]> {
    try {
      const list = await deps.agreements();
      return Array.isArray(list) ? list : [];
    } catch {
      // Unreadable agreements grant nothing.
      return [];
    }
  }

  async function http(method: string, target: string, headers: Record<string, string>, body: Uint8Array): Promise<SignerResponse> {
    let res: Response;
    try {
      // redirect "error": a redirect could carry the bearer to a target the proof never named.
      res = await deps.fetch(`${AGENTTOOL_ORIGIN}${target}`, { method, headers, body: body.length > 0 ? body : undefined, redirect: "error" });
    } catch {
      throw new Error(`signer: ${method} ${target} did not complete`);
    }
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text.length > 0 ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { status: res.status, json };
  }

  /** next_sequence from GET authority, read fresh before every root act and checked against the root this keychain holds. */
  async function nextSequence(identityId: string, bearer: string, rootPublicB64: string): Promise<number> {
    let r: SignerResponse;
    try {
      r = await http("GET", `/v1/identities/${identityId}/authority`, { Authorization: bearer }, new Uint8Array());
    } catch {
      throw new SignerNotSent("authority-read-failed", "signer: the authority sequence read did not complete; the act was not sent");
    }
    const j = r.json;
    if (r.status !== 200 || !isPlainObject(j)) throw new SignerNotSent("authority-read-failed", `signer: reading the authority sequence answered ${r.status}; the act was not sent`);
    if (j.root_public_key !== rootPublicB64) throw new Refusal("invalid-record", "the server's root key is not the one this keychain derives");
    const next = j.next_sequence;
    if (typeof next !== "number" || !Number.isSafeInteger(next) || next < 1) throw new SignerNotSent("authority-read-failed", "signer: the authority read gave no usable next_sequence; the act was not sent");
    return next;
  }

  /**
   * Run a step that comes before the act is sent. A wall stays a Refusal;
   * anything else becomes SignerNotSent, so no caller mistakes a keychain or
   * authority-read failure for a request that may have reached the server.
   */
  async function beforeSending<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof Refusal || e instanceof SignerNotSent) throw e;
      throw new SignerNotSent("not-sent", "signer: stopped before sending; nothing of the act left the host");
    }
  }

  async function send(req: SignerRequest): Promise<SignerResponse> {
    if (!isPlainObject(req)) invalid("a request is an object");
    if (!METHODS.has(req.method)) invalid("unknown method");
    if (!(req.body instanceof Uint8Array)) invalid("the body is bytes");
    if ((req.method === "GET" || req.method === "DELETE") && req.body.length > 0) invalid(`a ${req.method} carries no body`);
    if (typeof req.credits !== "number" || !Number.isSafeInteger(req.credits) || req.credits < 0) throw new Refusal("ceiling-credits", "credits must be a whole number");
    assertTarget(req.target);

    // Every wall first, before any key is read or any byte leaves the host.
    const now = deps.clock.now();
    const actor = await beforeSending(async () => {
      const a = await resolveActor(req, now);
      checkRouteAndBody(req, a, now);
      const agreements = classifyOp(req.op) === "standing-agreement" ? await standingAgreements() : [];
      await assertAuthorised(req, agreements, now, lookup);
      const credits = Math.max(req.credits, MIN_CREDITS[req.op] ?? 0);
      if (credits > 0) await assertCredits(a, credits);
      return a;
    });

    const route = req.op === "read" ? null : ROUTES[req.op as keyof typeof ROUTES];
    const base: Record<string, string> = {};
    if (req.body.length > 0) base["Content-Type"] = "application/json";
    if (req.op === "enroll") base[ENROLLMENT_SIGNATURE_HEADER] = req.extra_headers![ENROLLMENT_SIGNATURE_HEADER]!;

    if (!route?.root) {
      base.Authorization = await beforeSending(() => bearerHeader(actor));
      return http(req.method, req.target, base, req.body);
    }
    const identityId = actorIdentityId(actor)!;
    return exclusive(identityId, async () => {
      const bearer = await beforeSending(async () => {
        const b = await bearerHeader(actor);
        const root = await rootFor(actor);
        try {
          const sequence = await nextSequence(identityId, b, root.public_b64);
          const timestamp = deps.clock.now().toISOString();
          const digest = authorityDigest({ did: actorDid(actor), method: req.method, target: req.target, body: req.body, sequence, timestamp });
          Object.assign(base, authorityHeaders(sequence, timestamp, edSign(digest, root.seed)));
        } finally {
          wipe(root.seed);
        }
        return b;
      });
      // Captured from the very values sent, before the bearer joins them; the bearer is never part of it.
      const evidence: RootEvidence = {
        method: req.method,
        target: req.target,
        body_b64: toB64(req.body),
        headers: {
          [AUTHORITY_HEADERS.sequence]: base[AUTHORITY_HEADERS.sequence]!,
          [AUTHORITY_HEADERS.timestamp]: base[AUTHORITY_HEADERS.timestamp]!,
          [AUTHORITY_HEADERS.signature]: base[AUTHORITY_HEADERS.signature]!,
        },
      };
      base.Authorization = bearer;
      // Never retried here: after an uncertain result the caller re-reads the sequence (agenttool-wire.md 2).
      return { ...(await http(req.method, req.target, base, req.body)), root_evidence: evidence };
    });
  }

  return {
    async publicKeys(word) {
      assertWord(word);
      const { identity } = await readCitizen(word);
      const host = await readSeed({ kind: "host-attest-seed" });
      const host_attest_b64 = toB64(edPublicKey(host));
      wipe(host);
      let op_b64: string | null = null;
      if (await keychain.has({ kind: "citizen-op-seed", word })) {
        const op = await readSeed({ kind: "citizen-op-seed", word });
        op_b64 = toB64(edPublicKey(op));
        wipe(op);
      }
      let root_b64: string | null = null;
      let box_b64: string | null = null;
      if (await keychain.has({ kind: "citizen-mnemonic", word })) {
        const d = await derive({ kind: "citizen-mnemonic", word });
        root_b64 = toB64(d.root_public);
        box_b64 = toB64(d.box_public);
        for (const secret of [d.root_seed, d.k_master, d.box_private]) wipe(secret);
      }
      return { root_b64, op_b64, op_kid: identity?.op_kid ?? null, box_b64, host_attest_b64 };
    },

    async signEntry(word, entryHash, attestation) {
      assertWord(word);
      if (!(entryHash instanceof Uint8Array) || entryHash.length !== 32) invalid("an entry hash is 32 bytes");
      const { identity } = await readCitizen(word);
      if (attestation === "citizen-signed") {
        if (!identity) throw new Refusal("not-registered", `${word} has no op key yet; its entries are host-attested`);
        const seed = await readOpSeed(word, identity);
        try {
          return { alg: "ed25519", kid: identity.op_kid, public_key_b64: identity.op_public_key_b64, sig_b64: toB64(edSign(entryHash, seed)) };
        } finally {
          wipe(seed);
        }
      }
      if (attestation === "host-attested") {
        // Once a citizen has its own key, the host no longer speaks for its record (3.3).
        if (identity) invalid(`${word} is registered; its entries are citizen-signed`);
        const seed = await readSeed({ kind: "host-attest-seed" });
        try {
          return { alg: "ed25519", kid: HOST_ATTEST_KID, public_key_b64: toB64(edPublicKey(seed)), sig_b64: toB64(edSign(entryHash, seed)) };
        } finally {
          wipe(seed);
        }
      }
      throw invalid("unknown attestation");
    },

    send,

    async signEnrollment(word, digest, presence) {
      assertWord(word);
      if (!(digest instanceof Uint8Array) || digest.length !== 32) invalid("an enrollment digest is 32 bytes");
      const scope = `birth ${word}`;
      if (!(presenceConfirmedHere(presence) && presenceValid(presence, scope, deps.clock.now()))) {
        throw new Refusal("yu-not-present", `the root signs an enrollment only with Yu confirmed present for "${scope}"`);
      }
      const { identity } = await readCitizen(word);
      if (identity) invalid(`${word} is already registered; enrollment is never repeated`);
      const d = await derive({ kind: "citizen-mnemonic", word });
      wipe(d.k_master);
      wipe(d.box_private);
      try {
        return toB64url(edSign(digest, d.root_seed));
      } finally {
        wipe(d.root_seed);
      }
    },

    async sealThought(word, strandId, plaintext, kind) {
      assertWord(word);
      if (typeof strandId !== "string" || !UUID_PATTERN.test(strandId)) invalid("strand_id must be a lowercase UUID");
      if (typeof plaintext !== "string" || plaintext.length === 0) invalid("a thought has text");
      if (typeof kind !== "string" || kind.length === 0 || kind.length > 64) invalid("kind is 1-64 characters");
      const identity = await registered(word);
      if (identity.self_strand_id === null || strandId !== identity.self_strand_id) throw new Refusal("beyond-self", "a thought goes only to the citizen's own strand");
      // A thought is charged before the server verifies it, so the budget is checked before it is even made.
      await assertCredits({ kind: "citizen", word, identity }, 1);
      const d = await derive({ kind: "citizen-mnemonic", word });
      wipe(d.root_seed);
      wipe(d.box_private);
      const nonce = random(12);
      let sealed: { ciphertext_b64: string; nonce_b64: string };
      try {
        sealed = await encryptThought(plaintext, d.k_master, nonce);
      } finally {
        wipe(d.k_master);
      }
      const seed = await readOpSeed(word, identity);
      try {
        const digest = thoughtDigestV2(strandId, fromB64(sealed.ciphertext_b64), nonce, kind);
        return { ciphertext: sealed.ciphertext_b64, nonce: sealed.nonce_b64, kind, signature: toB64(edSign(digest, seed)), signing_key_id: identity.op_kid };
      } finally {
        wipe(seed);
      }
    },

    async state() {
      try {
        wipe(await readSeed({ kind: "host-attest-seed" }));
        return "ready";
      } catch (e) {
        if (e instanceof Refusal && e.code === "keychain-locked") return "locked";
        // The keychain answered; it is open even if this item is absent.
        if (e instanceof Refusal && e.code === "keychain-missing") return "ready";
        throw e;
      }
    },
  };
}
