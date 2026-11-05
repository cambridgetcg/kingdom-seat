// identity-enrollment/v1 for one citizen (3b "Birth of one citizen", step 2).
// The citizen's root signs; the gardener desk relays with the Commons bearer.
// Enrollment mints no bearer, wallet or credits, and makes the root the
// identity's `primary` signing key, so routine objects are signed by the op
// key instead. It is never retried automatically: after an ambiguous result,
// read the chosen ids before preparing a new intent (enroll.ts:69).
import { edVerifyStrict, fromB64, fromB64url, toB64url } from "../crypto.ts";
import {
  Refusal,
  UUID_PATTERN,
  WORD_PATTERN,
  type Clock,
  type ConsentRecord,
  type FetchLike,
  type Origin,
  type Word,
  type YuPresence,
} from "../types.ts";
import type { Signer } from "../signer/signer.ts";
import { presenceValid, proposalDigest, verifyConsent } from "../signer/consent.ts";
import { AgenttoolError, NO_RESPONSE, errorCode, readPublicAgent } from "./client.ts";
import {
  AGENTTOOL_ORIGIN,
  ENROLLMENT_BODY_FORMAT,
  ENROLLMENT_PATH,
  ENROLLMENT_SIGNATURE_HEADER,
  ENROLLMENT_WINDOW_MS,
  didFor,
  enrollmentBodyBytes,
  enrollmentDigest,
  type EnrollmentFields,
} from "./wire.ts";

export interface PreparedEnrollment {
  fields: EnrollmentFields;
  body: Uint8Array;
  digest: Uint8Array;
}

export interface EnrollResult {
  identity_id: string;
  did: string;
  root_kid: string;
  root_public_key_b64: string;
  sequence: number;
  next_sequence: number;
}

export interface EnrollDeps {
  signer: Signer;
  /** Only for a public existence read after an ambiguous result; never for the relay itself. */
  fetch: FetchLike;
  project_id: string;
  /** Presence, consent and the intent's freshness are judged against this clock, never wall time. */
  clock: Clock;
}

/** The ids an ambiguous enrollment chose; read them before preparing a new intent, and never re-send this one. */
export class AmbiguousEnrollment extends Error {
  override readonly name = "AmbiguousEnrollment";
  constructor(
    readonly identity_id: string,
    readonly signing_key_id: string,
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Refuse an intent this close to the server's freshness edge rather than send one that may arrive stale. */
const FRESHNESS_MARGIN_MS = 30_000;

/** The scope Yu confirms and the extent a birth's decision record covers; the signer checks the same string. */
export function birthScope(word: Word): string {
  return `birth ${word}`;
}

/** Yu at the controlling terminal, confirmed for exactly this birth, within the presence window consent.ts sets. */
export function assertYuPresentFor(word: Word, presence: YuPresence | null | undefined, now: Date): void {
  if (!presenceValid(presence ?? null, birthScope(word), now)) {
    throw new Refusal("yu-not-present", `birth of ${word} needs Yu confirmed present at the terminal for "${birthScope(word)}"`);
  }
}

/**
 * The decision record for this birth: it covers the extent "birth <word>",
 * as the signer requires, and verifies under consent.ts (Yu's recorded yes,
 * Ai's voice formed by lazy consensus, not expired). Given the proposal text,
 * the record must also be bound to that text's digest; without it, only to
 * the digest the record itself names. Silence never binds.
 */
export function assertBirthConsent(
  word: Word,
  consent: ConsentRecord | null | undefined,
  now: Date,
  proposal?: { subject: string; body: string; extent: string },
): void {
  if (!consent || typeof consent !== "object") throw new Refusal("consent-missing", `birth of ${word} needs a decision record`);
  if (consent.extent !== birthScope(word)) throw new Refusal("consent-missing", `the decision record does not cover "${birthScope(word)}"`);
  let bound = consent.proposal_sha256;
  if (proposal) {
    if (proposal.extent !== consent.extent) throw new Refusal("consent-missing", "the proposal and the decision record cover different extents");
    bound = proposalDigest(proposal);
  }
  const verdict = verifyConsent(consent, bound, now);
  if (!verdict.ok) throw new Refusal(verdict.code, `birth of ${word}: ${verdict.reason}`);
}

/** ["kingdom-citizen", <lineage>]: the canon word for a canon origin, the last lineage name for an archetype. */
export function citizenCapabilities(origin: Origin): string[] {
  let lineage: string | undefined;
  if (origin.kind === "canon") {
    const file = origin.path.split("/").pop() ?? "";
    lineage = file.replace(/\.[A-Za-z0-9]+$/, "");
  } else if (origin.kind === "archetype") {
    lineage = origin.lineage.at(-1);
  }
  if (!lineage || lineage.includes("\0") || [...lineage].length > 64) throw new Refusal("invalid-request", "the origin names no usable lineage");
  return ["kingdom-citizen", lineage];
}

function uuidV4(random: (n: number) => Uint8Array): string {
  const b = random(16);
  if (b.length !== 16) throw new Refusal("invalid-request", "random source gave the wrong length");
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = Buffer.from(b).toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Build fields, body bytes and digest with fresh ids, nonce and timestamp; display_name is the word. */
export function prepareEnrollment(input: { word: Word; origin: Origin; project_id: string; root_public_b64: string; now: Date; random: (n: number) => Uint8Array }): PreparedEnrollment {
  if (!WORD_PATTERN.test(input.word)) throw new Refusal("invalid-request", "not a citizen word");
  const identity_id = uuidV4(input.random);
  const signing_key_id = uuidV4(input.random);
  if (identity_id === signing_key_id) throw new Refusal("invalid-request", "random source repeated itself");
  const nonce = input.random(32);
  if (nonce.length !== 32) throw new Refusal("invalid-request", "random source gave the wrong length");
  const fields: EnrollmentFields = {
    format: ENROLLMENT_BODY_FORMAT,
    origin: AGENTTOOL_ORIGIN,
    project_id: input.project_id,
    identity_id,
    signing_key_id,
    display_name: input.word,
    capabilities: citizenCapabilities(input.origin),
    public_key: input.root_public_b64,
    nonce: toB64url(nonce),
    timestamp: input.now.toISOString(),
  };
  const body = enrollmentBodyBytes(fields);
  return { fields, body, digest: enrollmentDigest(AGENTTOOL_ORIGIN, input.project_id, body) };
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/** Have the root sign the digest, relay POST /v1/identities/enroll once, and parse the 201; never retried. */
export async function enroll(deps: EnrollDeps, word: Word, prepared: PreparedEnrollment, presence: YuPresence, consent: ConsentRecord): Promise<EnrollResult> {
  const now = deps.clock.now();
  assertYuPresentFor(word, presence, now);
  assertBirthConsent(word, consent, now);

  // The bytes sent must be exactly the bytes these fields serialise to, for this word and this project.
  const f = prepared.fields;
  if (f.display_name !== word || f.project_id !== deps.project_id || f.origin !== AGENTTOOL_ORIGIN) {
    throw new Refusal("invalid-request", "the prepared enrollment is for another word, project or origin");
  }
  if (!sameBytes(enrollmentBodyBytes(f), prepared.body) || !sameBytes(enrollmentDigest(AGENTTOOL_ORIGIN, deps.project_id, prepared.body), prepared.digest)) {
    throw new Refusal("invalid-request", "the prepared body or digest does not match its fields");
  }
  if (Math.abs(now.getTime() - Date.parse(f.timestamp)) > ENROLLMENT_WINDOW_MS - FRESHNESS_MARGIN_MS) {
    throw new Refusal("invalid-request", "the prepared enrollment is too old to send; prepare a new intent");
  }

  const signature = await deps.signer.signEnrollment(word, prepared.digest, presence);
  // Verify locally and strictly, as the server does, so a root that does not match the body never leaves the host.
  let sig: Uint8Array;
  try {
    sig = fromB64url(signature, 64);
  } catch {
    throw new Refusal("invalid-request", "the enrollment signature is not 64 bytes of base64url");
  }
  if (signature.length !== 86 || !edVerifyStrict(sig, prepared.digest, fromB64(f.public_key, 32))) {
    throw new Refusal("invalid-request", "the root's signature does not verify against the enrollment key; nothing was sent");
  }

  let res: { status: number; json: unknown };
  try {
    res = await deps.signer.send({
      op: "enroll",
      // The gardener relays; the citizen has no identity to act as until this succeeds.
      word: null,
      operator: null,
      method: "POST",
      target: ENROLLMENT_PATH,
      body: prepared.body,
      credits: 0,
      consent,
      presence,
      extra_headers: { [ENROLLMENT_SIGNATURE_HEADER]: signature },
    });
  } catch (e) {
    // A wall refused before sending: definite. Anything else may have reached the server.
    if (e instanceof Refusal) throw e;
    throw new AmbiguousEnrollment(f.identity_id, f.signing_key_id, NO_RESPONSE, "enrollment got no response; read the chosen identity before preparing a new intent");
  }
  if (res.status === 201) return parseEnrollResponse(res.json, prepared);
  const code = errorCode(res.json);
  // A 4xx is the server refusing inside one rolled-back transaction; nothing was created.
  if (res.status >= 400 && res.status <= 499) throw new AgenttoolError(res.status, code, `agenttool enroll answered ${res.status}${code ? ` ${code}` : ""}`);
  throw new AmbiguousEnrollment(f.identity_id, f.signing_key_id, res.status, `enrollment answered ${res.status}${code ? ` ${code}` : ""}; read the chosen identity before preparing a new intent`);
}

/** Parse and check a 201 body against what was sent: same identity id, root key, and sequence 0. */
export function parseEnrollResponse(json: unknown, prepared: PreparedEnrollment): EnrollResult {
  const f = prepared.fields;
  const mismatch = (what: string) => new AgenttoolError(201, "enroll_response_mismatch", `agenttool enroll: the 201 ${what} differs from what was sent`);
  const obj = (v: unknown): Record<string, unknown> | null => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
  const top = obj(json);
  const identity = obj(top?.identity);
  const key = obj(top?.key);
  const authority = obj(top?.authority);
  if (!identity || !key || !authority) throw mismatch("shape");
  if (identity.id !== f.identity_id || identity.did !== didFor(f.identity_id)) throw mismatch("identity id");
  if (identity.status !== "active") throw mismatch("status");
  if (identity.display_name !== f.display_name) throw mismatch("display name");
  if (key.kid !== f.signing_key_id || typeof key.kid !== "string" || !UUID_PATTERN.test(key.kid)) throw mismatch("root key id");
  if (key.public_key !== f.public_key || authority.root_public_key !== f.public_key) throw mismatch("root key");
  if (authority.mode !== "agent_root") throw mismatch("authority mode");
  if (authority.sequence !== 0 || authority.next_sequence !== 1) throw mismatch("sequence");
  return {
    identity_id: f.identity_id,
    did: didFor(f.identity_id),
    root_kid: f.signing_key_id,
    root_public_key_b64: f.public_key,
    sequence: 0,
    next_sequence: 1,
  };
}

/**
 * After an ambiguous result: does the chosen identity now exist? Read, never
 * re-send. "absent" is only reported once the intent's freshness window has
 * closed, because a delayed request could still land until then; a public
 * read can confirm existence but never absence (it may be cached).
 */
export async function resolveAmbiguous(deps: EnrollDeps, identityId: string, prepared?: PreparedEnrollment): Promise<"exists" | "absent" | "unknown"> {
  if (typeof identityId !== "string" || !UUID_PATTERN.test(identityId)) throw new Refusal("invalid-request", "identity id must be a lowercase UUID");
  const now = deps.clock.now().getTime();
  const windowOpen = prepared ? now - Date.parse(prepared.fields.timestamp) <= ENROLLMENT_WINDOW_MS : true;
  try {
    const res = await deps.signer.send({
      op: "read",
      word: null,
      operator: null,
      method: "GET",
      target: `/v1/identities/${identityId}/authority`,
      body: new Uint8Array(),
      credits: 0,
      consent: null,
      presence: null,
    });
    const j = res.json as Record<string, unknown> | null;
    if (res.status === 200 && j && j.identity_id === identityId) return "exists";
    if (res.status === 404) return windowOpen ? "unknown" : "absent";
  } catch {
    // Fall through to the public read.
  }
  try {
    const agent = await readPublicAgent(deps, didFor(identityId));
    if (agent.status === "active" || agent.status === "revoked" || agent.status === "memorial") return "exists";
  } catch {
    // No answer is not an answer.
  }
  return "unknown";
}
