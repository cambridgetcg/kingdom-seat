// agenttool calls a citizen makes as itself (3.4), all through the signer so
// the bearer and root never leave it. One root-authorised request in flight
// per identity, awaiting each response before signing the next, because the
// sequence is the replay wall and a valid proof is spent even if the route's
// own write then fails (agenttool-wire.md section 2).
//
// Every per-identity request names the citizen explicitly, because an
// enrolled guest is never the project's default actor: quiet hours by
// ?identity_id= (the route picks its actor from that query), /v1/identities/:id
// routes by their path, and a strand by identity_id in its body. Targets are
// otherwise exactly the vectors' targets, which is the shape the signer's
// route table accepts.
import { fromB64, toB64 } from "../crypto.ts";
import {
  DID_PATTERN,
  Refusal,
  UUID_PATTERN,
  WORD_PATTERN,
  type CitizenIdentity,
  type FetchLike,
  type ProposalText,
  type RootEvidence,
  type SignerOp,
  type Word,
  type YuPresence,
} from "../types.ts";
import { SignerNotSent, SignerSentUncertain, type Signer, type SignerRequest, type SignerResponse } from "../signer/signer.ts";
import { AGENTTOOL_ORIGIN, isCanonicalIso, jsonBody, validateBoxPublicKey, validateExpression, type Expression } from "./wire.ts";

/**
 * What the client needs to name a citizen. Birth supplies it from the
 * enrollment answer, before the rest of the identity (op kid, box key) exists.
 * self_strand_id is the one strand its thoughts may go to; null until a
 * strand is created and its id saved in the record.
 */
export type ClientIdentity = Pick<CitizenIdentity, "identity_id" | "did" | "root_kid" | "root_public_key_b64" | "self_strand_id">;

export interface ClientDeps {
  signer: Signer;
  /** Used only for unauthenticated public reads; everything else goes through signer.send. */
  fetch: FetchLike;
  identity(word: Word): Promise<ClientIdentity>;
}

/**
 * Presence and the agreed proposal the caller holds for this act (birth holds
 * both); the signer decides whether the op needs them, and reads the decision
 * record for the proposal itself.
 */
export interface ActAuth {
  presence: YuPresence | null;
  proposal: ProposalText | null;
  /** Birth only, between enroll and the saved identity: the enrolled ids, which the signer honours only with both of the above. */
  enrolled?: { identity_id: string; did: string };
}

export class AgenttoolError extends Error {
  override readonly name = "AgenttoolError";
  constructor(
    readonly status: number,
    readonly code: string | null,
    message: string,
    /**
     * A root-signed request that may have landed (no answer, a 5xx, or a 2xx
     * that does not read), as sent: agenttool keeps no copy of the proof, so
     * this is what a ledger entry needs if the act turns out to have happened.
     */
    readonly root_evidence: RootEvidence | null = null,
  ) {
    super(message);
  }
}

/** The public profile fields a beacon reader and an existence check need (agents.ts:109-136). */
export interface PublicAgent {
  did: string;
  name: string | null;
  status: "active" | "revoked" | "memorial";
  quiet_until: string | null;
  quiet_reason: string | null;
}

export interface KeyRow {
  kid: string;
  public_key: string;
  label: string;
  active: boolean;
  created_at: string;
  revoked_at: string | null;
  authority_root: boolean;
}

/* ── Plumbing ─────────────────────────────────────────────────────────── */

const EMPTY = new Uint8Array();
/** Status 0: no HTTP answer arrived, so whether the server acted is unknown. */
export const NO_RESPONSE = 0;
const ERROR_CODE = /^[a-z][a-z0-9_.:-]{0,79}$/;

type Json = Record<string, unknown>;
function isObject(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** agenttool answers `{error: "<code>", message, …}`; only a code-shaped string is kept, never free text. */
export function errorCode(json: unknown): string | null {
  if (!isObject(json)) return null;
  const e = json.error;
  if (typeof e === "string" && ERROR_CODE.test(e)) return e;
  if (isObject(e) && typeof e.code === "string" && ERROR_CODE.test(e.code)) return e.code;
  return null;
}

// Messages name the call, the status and the code only. A response body is
// never echoed, so nothing a server or proxy reflects can reach a log.
function refused(what: string, res: SignerResponse | { status: number; json: unknown }, evidence: RootEvidence | null = null): AgenttoolError {
  const code = errorCode(res.json);
  // A 4xx is the server refusing before anything changed, so its proof shows nothing happened and is not kept.
  return new AgenttoolError(res.status, code, `agenttool ${what} answered ${res.status}${code ? ` ${code}` : ""}`, res.status >= 500 ? evidence : null);
}

function malformed(what: string, status: number, detail: string, evidence: RootEvidence | null = null): AgenttoolError {
  return new AgenttoolError(status, "malformed_response", `agenttool ${what}: ${detail}`, evidence);
}

const ok = (status: number) => status >= 200 && status <= 299;

async function citizen(deps: Pick<ClientDeps, "identity">, word: Word): Promise<ClientIdentity> {
  if (typeof word !== "string" || !WORD_PATTERN.test(word)) throw new Refusal("invalid-request", "not a citizen word");
  const id = await deps.identity(word);
  let rootOk = false;
  try {
    rootOk = fromB64(id.root_public_key_b64, 32).length === 32;
  } catch {
    rootOk = false;
  }
  const strandOk = id.self_strand_id === null || (typeof id.self_strand_id === "string" && UUID_PATTERN.test(id.self_strand_id));
  if (!UUID_PATTERN.test(id.identity_id) || id.did !== `did:at:${id.identity_id}` || !UUID_PATTERN.test(id.root_kid) || !rootOk || !strandOk) {
    throw new Refusal("invalid-record", `${word}: the identity record is not well formed`);
  }
  return id;
}

function withIdentity(path: string, identityId: string): string {
  return `${path}?identity_id=${identityId}`;
}

function identityRoute(identityId: string, suffix: string): string {
  return `/v1/identities/${identityId}${suffix}`;
}

interface Call {
  op: SignerOp;
  method: SignerRequest["method"];
  target: string;
  body: Uint8Array;
  credits: number;
}

async function send(deps: ClientDeps, word: Word, call: Call, auth: ActAuth | undefined): Promise<SignerResponse> {
  const req: SignerRequest = {
    op: call.op,
    word,
    operator: null,
    method: call.method,
    target: call.target,
    body: call.body,
    credits: call.credits,
    proposal: auth?.proposal ?? null,
    presence: auth?.presence ?? null,
    ...(auth?.enrolled ? { enrolled: { identity_id: auth.enrolled.identity_id, did: auth.enrolled.did } } : {}),
  };
  try {
    return await deps.signer.send(req);
  } catch (e) {
    // A wall refused, or the signer stopped before sending: either answer is definite.
    if (e instanceof Refusal || e instanceof SignerNotSent) throw e;
    const evidence = e instanceof SignerSentUncertain ? evidenceOf(call, e.root_evidence) : null;
    throw new AgenttoolError(NO_RESPONSE, "no_response", `agenttool ${call.op}: no response; read the authority sequence before signing again`, evidence);
  }
}

/* ── One root-authorised request in flight per identity ───────────────── */

// Keyed by signer, because the signer is what holds the root and attaches
// the sequence; two clients sharing one signer share its lanes.
const lanes = new WeakMap<Signer, Map<string, Promise<void>>>();

async function oneAtATime<T>(signer: Signer, identityId: string, fn: () => Promise<T>): Promise<T> {
  let byIdentity = lanes.get(signer);
  if (!byIdentity) {
    byIdentity = new Map();
    lanes.set(signer, byIdentity);
  }
  const before = byIdentity.get(identityId) ?? Promise.resolve();
  let release: () => void = () => {};
  const done = new Promise<void>((resolve) => (release = resolve));
  const tail = before.then(() => done);
  byIdentity.set(identityId, tail);
  await before;
  try {
    return await fn();
  } finally {
    release();
    if (byIdentity.get(identityId) === tail) byIdentity.delete(identityId);
  }
}

interface AuthorityState {
  mode: string;
  root_public_key: string | null;
  sequence: number;
  next_sequence: number;
}

async function authorityState(deps: ClientDeps, word: Word, id: ClientIdentity, auth?: ActAuth): Promise<AuthorityState> {
  const what = "authority read";
  // The act's own auth rides along, so a read during birth is held to the same presence and proposal as the act.
  const res = await send(deps, word, { op: "read", method: "GET", target: identityRoute(id.identity_id, "/authority"), body: EMPTY, credits: 0 }, auth);
  if (res.status !== 200) throw refused(what, res);
  const j = res.json;
  if (!isObject(j)) throw malformed(what, res.status, "not an object");
  if (j.identity_id !== id.identity_id || j.did !== id.did) throw malformed(what, res.status, "names another identity");
  const { sequence, next_sequence } = j;
  if (typeof sequence !== "number" || !Number.isSafeInteger(sequence) || sequence < 0 || next_sequence !== sequence + 1) {
    throw malformed(what, res.status, "sequence is not a non-negative integer followed by next_sequence");
  }
  return {
    mode: typeof j.mode === "string" ? j.mode : "",
    root_public_key: typeof j.root_public_key === "string" ? j.root_public_key : null,
    sequence,
    next_sequence,
  };
}

/** Root posture: still agent-rooted, by the root this host holds. Anything else means no root act. */
async function assertRootPosture(deps: ClientDeps, word: Word, id: ClientIdentity, auth?: ActAuth): Promise<void> {
  const s = await authorityState(deps, word, id, auth);
  if (s.mode !== "agent_root" || s.root_public_key !== id.root_public_key_b64) {
    throw new Refusal("invalid-record", `${word}: agenttool does not show this host's root as the identity's authority`);
  }
}

/**
 * Read posture, send once, and on a sequence conflict read again and send
 * once more. A 409 sequence conflict is refused before the route's write, so
 * one resend is safe; anything else is returned for the caller to judge.
 */
async function rootAct(deps: ClientDeps, word: Word, id: ClientIdentity, call: Call, auth: ActAuth | undefined): Promise<SignerResponse> {
  return oneAtATime(deps.signer, id.identity_id, async () => {
    await assertRootPosture(deps, word, id, auth);
    const first = await send(deps, word, call, auth);
    if (first.status !== 409 || errorCode(first.json) !== "authority_sequence_conflict") return first;
    await assertRootPosture(deps, word, id, auth);
    return send(deps, word, call, auth);
  });
}

/* ── Reads ────────────────────────────────────────────────────────────── */

/** GET /v1/identities/:id/authority: the current and next sequence, read before any root act and after an uncertain one. */
export async function readAuthority(deps: ClientDeps, word: Word): Promise<{ sequence: number; next_sequence: number }> {
  const id = await citizen(deps, word);
  const s = await authorityState(deps, word, id);
  return { sequence: s.sequence, next_sequence: s.next_sequence };
}

/** GET /v1/identities/:id/keys: the key rows, for checking ledger entries against the op key. */
export async function listKeys(deps: ClientDeps, word: Word): Promise<KeyRow[]> {
  const what = "key list";
  const id = await citizen(deps, word);
  const res = await send(deps, word, { op: "read", method: "GET", target: identityRoute(id.identity_id, "/keys"), body: EMPTY, credits: 0 }, undefined);
  if (res.status !== 200) throw refused(what, res);
  if (!isObject(res.json) || !Array.isArray(res.json.keys)) throw malformed(what, res.status, "no keys array");
  return res.json.keys.map((row, i) => {
    if (!isObject(row)) throw malformed(what, res.status, `keys[${i}] is not an object`);
    const { kid, public_key, label, active, created_at, revoked_at, authority_root } = row;
    if (
      typeof kid !== "string" ||
      !UUID_PATTERN.test(kid) ||
      typeof public_key !== "string" ||
      typeof label !== "string" ||
      typeof active !== "boolean" ||
      typeof created_at !== "string" ||
      (revoked_at !== null && typeof revoked_at !== "string") ||
      typeof authority_root !== "boolean"
    ) {
      throw malformed(what, res.status, `keys[${i}] does not have the key-row shape`);
    }
    return { kid, public_key, label, active, created_at, revoked_at, authority_root };
  });
}

/* ── Root-signed acts ─────────────────────────────────────────────────── */

/**
 * The signer's copy of the root-signed request just answered, which must be
 * this call as sent. A ledger entry needs it to show the root authorised an
 * op key, and agenttool keeps none, so an answer without it is not usable.
 */
function evidenceFor(what: string, call: Call, res: SignerResponse): RootEvidence {
  const ev = evidenceOf(call, res.root_evidence);
  if (!ev) throw malformed(what, res.status, "the signer kept no copy of this root-signed request");
  return ev;
}

/** The signer's copy of a root-signed request, or null when it kept none that is this call as sent. */
function evidenceOf(call: Call, ev: RootEvidence | null | undefined): RootEvidence | null {
  return ev && ev.method === call.method && ev.target === call.target && ev.body_b64 === toB64(call.body) ? ev : null;
}

/** Root-signed POST keys/import of the op key; the kid comes back from the server, the root evidence from the signer. */
export async function importOpKey(deps: ClientDeps, word: Word, publicKeyB64: string, label: string, auth?: ActAuth): Promise<{ kid: string; evidence: RootEvidence }> {
  const what = "keys/import";
  try {
    fromB64(publicKeyB64, 32);
  } catch {
    throw new Refusal("invalid-request", "op public key must be canonical standard base64 of 32 bytes");
  }
  if (typeof label !== "string" || label.trim().length === 0 || label.length > 128) throw new Refusal("invalid-request", "op key label must be 1..128 characters");
  const id = await citizen(deps, word);
  // The root is already the `primary` key; importing it again would let a routine signature pass as a root act.
  if (publicKeyB64 === id.root_public_key_b64) throw new Refusal("invalid-request", "the root is never imported as the op key");
  const call: Call = { op: "keys.import", method: "POST", target: identityRoute(id.identity_id, "/keys/import"), body: jsonBody({ public_key: publicKeyB64, label }), credits: 0 };
  const res = await rootAct(deps, word, id, call, auth);
  // From here the request was answered: when the answer leaves it unknown whether the key was installed, its proof goes with the error.
  const sent = evidenceOf(call, res.root_evidence);
  if (!ok(res.status)) throw refused(what, res, sent);
  const j = res.json;
  if (!isObject(j) || typeof j.kid !== "string" || !UUID_PATTERN.test(j.kid)) throw malformed(what, res.status, "no lowercase kid", sent);
  if (j.public_key !== publicKeyB64) throw malformed(what, res.status, "the stored key is not the key sent", sent);
  return { kid: j.kid, evidence: evidenceFor(what, call, res) };
}

/** Root-signed DELETE of an op key during rotation; the root row can never be revoked. Returns the root evidence. */
export async function revokeKey(deps: ClientDeps, word: Word, kid: string, auth?: ActAuth): Promise<{ evidence: RootEvidence }> {
  const what = "key revoke";
  if (typeof kid !== "string" || !UUID_PATTERN.test(kid)) throw new Refusal("invalid-request", "kid must be a lowercase UUID");
  const id = await citizen(deps, word);
  if (kid === id.root_kid) throw new Refusal("invalid-request", "the root key row can never be revoked");
  const call: Call = { op: "keys.revoke", method: "DELETE", target: identityRoute(id.identity_id, `/keys/${kid}`), body: EMPTY, credits: 0 };
  const res = await rootAct(deps, word, id, call, auth);
  if (!ok(res.status)) throw refused(what, res, evidenceOf(call, res.root_evidence));
  return { evidence: evidenceFor(what, call, res) };
}

/** Root-signed POST /v1/identities/:id/box-keys, once at birth, after a local 32-byte check. */
export async function registerBoxKey(deps: ClientDeps, word: Word, publicKeyB64: string, auth?: ActAuth): Promise<{ id: string }> {
  const what = "box-keys";
  validateBoxPublicKey(publicKeyB64);
  const id = await citizen(deps, word);
  const res = await rootAct(
    deps,
    word,
    id,
    { op: "box-keys.register", method: "POST", target: identityRoute(id.identity_id, "/box-keys"), body: jsonBody({ public_key: publicKeyB64, label: "primary" }), credits: 0 },
    auth,
  );
  if (!ok(res.status)) throw refused(what, res);
  const j = res.json;
  if (!isObject(j) || typeof j.id !== "string" || j.id.length === 0 || j.registered !== true) throw malformed(what, res.status, "not registered");
  return { id: j.id };
}

/** Root-signed PUT of the private expression; validated locally first, since PUT replaces the whole object. */
export async function putExpression(deps: ClientDeps, word: Word, expression: Expression, auth?: ActAuth): Promise<void> {
  const what = "expression PUT";
  validateExpression(expression);
  const id = await citizen(deps, word);
  const res = await rootAct(
    deps,
    word,
    id,
    { op: "expression.put.private", method: "PUT", target: identityRoute(id.identity_id, "/expression"), body: jsonBody(expression), credits: 0 },
    auth,
  );
  if (!ok(res.status)) throw refused(what, res);
  if (!isObject(res.json) || res.json.saved !== true) throw malformed(what, res.status, "not saved");
}

/**
 * Root-signed quiet start with an explicit `until`; the signer refuses more
 * than 30 days ahead for a citizen. Never `hours`, which the server would
 * read differently, and no reason at all, because `quiet_reason` is public
 * whatever the expression visibility and must never name anyone.
 */
export async function startCitizenQuiet(deps: ClientDeps, word: Word, untilIso: string, auth?: ActAuth): Promise<{ until: string }> {
  const what = "quiet start";
  if (!isCanonicalIso(untilIso)) throw new Refusal("invalid-request", "until must be exactly Date.toISOString()");
  const id = await citizen(deps, word);
  const res = await rootAct(
    deps,
    word,
    id,
    { op: "quiet.start.citizen", method: "POST", target: withIdentity("/v1/quiet-hours/start", id.identity_id), body: jsonBody({ until: untilIso }), credits: 0 },
    auth,
  );
  if (!ok(res.status)) throw refused(what, res);
  const j = res.json;
  if (!isObject(j) || j.identity_id !== id.identity_id || typeof j.until !== "string") throw malformed(what, res.status, "names another identity or no until");
  return { until: j.until };
}

/** Root-signed DELETE of the citizen's own quiet, with an empty body. */
export async function endCitizenQuiet(deps: ClientDeps, word: Word, auth?: ActAuth): Promise<void> {
  const what = "quiet end";
  const id = await citizen(deps, word);
  const res = await rootAct(deps, word, id, { op: "quiet.end.citizen", method: "DELETE", target: withIdentity("/v1/quiet-hours", id.identity_id), body: EMPTY, credits: 0 }, auth);
  if (!ok(res.status)) throw refused(what, res);
}

/* ── Strands (bearer plus an identity key, not authority) ─────────────── */

/** POST /v1/strands bound to the citizen's identity_id (1 credit); a bound strand accepts only its own identity's keys. */
export async function createStrand(deps: ClientDeps, word: Word, topic: string): Promise<{ strand_id: string }> {
  const what = "strand create";
  // The topic is stored as sent, in plaintext, so callers keep it neutral.
  if (typeof topic !== "string" || topic.length === 0 || topic.length > 2000) throw new Refusal("invalid-request", "topic must be 1..2000 characters");
  const id = await citizen(deps, word);
  const res = await send(
    deps,
    word,
    { op: "strand.create", method: "POST", target: "/v1/strands", body: jsonBody({ identity_id: id.identity_id, topic }), credits: 1 },
    undefined,
  );
  if (!ok(res.status)) throw refused(what, res);
  const j = res.json;
  if (!isObject(j) || typeof j.id !== "string" || !UUID_PATTERN.test(j.id.toLowerCase())) throw malformed(what, res.status, "no strand id");
  // An unbound strand would accept a thought signed by any identity in the project.
  if (j.identity_id !== id.identity_id) throw malformed(what, res.status, "the strand is not bound to this citizen");
  return { strand_id: j.id.toLowerCase() };
}

/** POST a v2-signed thought (1 credit, charged before verification), sealed by the signer. */
export async function postThought(deps: ClientDeps, word: Word, strandId: string, plaintext: string, kind: string): Promise<{ thought_id: string }> {
  const what = "thought post";
  if (typeof strandId !== "string" || !UUID_PATTERN.test(strandId.toLowerCase())) throw new Refusal("invalid-request", "strand id must be a UUID");
  if (typeof kind !== "string" || kind.length === 0 || kind.length > 64) throw new Refusal("invalid-request", "kind must be 1..64 characters");
  if (typeof plaintext !== "string" || plaintext.length === 0) throw new Refusal("invalid-request", "a thought needs text");
  // The canonical bytes use the URL's strand id as given, so sign and send one spelling.
  const sid = strandId.toLowerCase();
  const id = await citizen(deps, word);
  // Only the citizen's own strand. agenttool charges the credit before it checks the strand's
  // identity, and an unbound strand takes any key in the project, so a foreign one is refused here.
  if (id.self_strand_id === null || sid !== id.self_strand_id) throw new Refusal("beyond-self", "a thought goes only to the citizen's own strand");
  const sealed = await deps.signer.sealThought(word, sid, plaintext, kind);
  // Every refusal below happens before sending, because the server charges the credit before it verifies.
  if (sealed.kind !== kind) throw new Refusal("invalid-request", "the sealed thought carries another kind");
  if (!UUID_PATTERN.test(sealed.signing_key_id) || sealed.signing_key_id === id.root_kid) {
    throw new Refusal("invalid-request", "a thought is signed by the op key, never the root");
  }
  if (sealed.ciphertext.length === 0 || sealed.ciphertext.length > 200_000 || sealed.nonce.length > 64 || sealed.signature.length > 255) {
    throw new Refusal("invalid-request", "the sealed thought is outside the route's limits");
  }
  const body = jsonBody({ ciphertext: sealed.ciphertext, nonce: sealed.nonce, kind: sealed.kind, signing_key_id: sealed.signing_key_id, signature: sealed.signature });
  const res = await send(deps, word, { op: "thought.post", method: "POST", target: `/v1/strands/${sid}/thoughts`, body, credits: 1 }, undefined);
  if (!ok(res.status)) throw refused(what, res);
  const j = res.json;
  if (!isObject(j) || typeof j.id !== "string" || j.id.length === 0) throw malformed(what, res.status, "no thought id");
  if (j.strand_id !== undefined && j.strand_id !== sid) throw malformed(what, res.status, "the thought landed on another strand");
  return { thought_id: j.id };
}

/* ── Public reads ─────────────────────────────────────────────────────── */

/**
 * Unauthenticated GET /public/agents/:did through deps.fetch; parses only the
 * fields PublicAgent names. A missing quiet field on an active or revoked row
 * is malformed rather than "not quiet", so a beacon reader fails closed.
 */
export async function readPublicAgent(deps: Pick<ClientDeps, "fetch">, did: string, opts: { signal?: AbortSignal } = {}): Promise<PublicAgent> {
  const what = "public agent read";
  if (typeof did !== "string" || !DID_PATTERN.test(did)) throw new Refusal("invalid-request", "did must be did:at:<lowercase uuid>");
  let res: Response;
  try {
    res = await deps.fetch(`${AGENTTOOL_ORIGIN}/public/agents/${did}`, {
      method: "GET",
      headers: { accept: "application/json" },
      redirect: "error",
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
  } catch {
    throw new AgenttoolError(NO_RESPONSE, "no_response", `agenttool ${what}: no response`);
  }
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  if (res.status !== 200) throw refused(what, { status: res.status, json });
  if (!isObject(json)) throw malformed(what, res.status, "not a JSON object");
  if (json.did !== did) throw malformed(what, res.status, "answers for another DID");
  const status = json.status;
  if (status !== "active" && status !== "revoked" && status !== "memorial") throw malformed(what, res.status, "unknown status");
  const name = typeof json.name === "string" ? json.name : null;
  // The memorial witness shape has no quiet fields at all (agents.ts:86-96).
  if (status === "memorial") return { did, name, status, quiet_until: null, quiet_reason: null };
  if (!("quiet_until" in json) || !("quiet_reason" in json)) throw malformed(what, res.status, "quiet fields missing");
  const { quiet_until, quiet_reason } = json;
  if (quiet_until !== null && (typeof quiet_until !== "string" || !Number.isFinite(Date.parse(quiet_until)))) throw malformed(what, res.status, "quiet_until is not a time");
  if (quiet_reason !== null && typeof quiet_reason !== "string") throw malformed(what, res.status, "quiet_reason is not text");
  return { did, name, status, quiet_until, quiet_reason };
}
