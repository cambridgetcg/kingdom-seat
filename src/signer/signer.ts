// citizen-signer (3.2 step 7, 3b "Custody"). The only reader of citizen keys
// and of the Commons bearer. No model process, file, log, argv or env ever
// holds a key, bearer or grant. Ops within self are signed; ops beyond self
// need a consent record; USD and credit ceilings fail closed; a citizen's
// quiet is capped at 30 days.
//
// In production this module is meant to run as a stably signed standalone
// binary so the Keychain ACL can trust it alone (runtimes-and-host.md 3.3).
// The Signer interface is shaped so that move needs no caller changes.
import type {
  Attestation,
  Clock,
  Config,
  ConsentRecord,
  FetchLike,
  Keychain,
  LedgerSignature,
  SignerOp,
  StandingAgreement,
  Word,
  YuPresence,
} from "../types.ts";
import type { SpendSoFar } from "./ceilings.ts";

export interface SignerDeps {
  keychain: Keychain;
  config: Config;
  clock: Clock;
  fetch: FetchLike;
  /** What the citizen has spent so far, read from its ledger; null fields mean unknown, which refuses. */
  spendSoFar(word: Word): Promise<SpendSoFar>;
  /** Standing Yu + Ai agreements in force, e.g. citizens' quiet declarations with an empty reason. */
  agreements(): Promise<StandingAgreement[]>;
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
  /** The citizen acted for; null for an operator act (beacon) or a gardener relay (enroll). */
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
  consent: ConsentRecord | null;
  presence: YuPresence | null;
  /** For enroll only: the signature header the root produced through signEnrollment. */
  extra_headers?: Record<string, string>;
}

export interface SignerResponse {
  status: number;
  json: unknown;
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

/** Build the host's one signer. It is the only code that reads Keychain items. */
export function createSigner(deps: SignerDeps): Signer {
  throw new Error("unimplemented");
}

/** Verify a ledger signature strictly (RFC 8032) against the public key it names. */
export function verifyEntrySignature(entryHash: Uint8Array, signature: LedgerSignature): boolean {
  throw new Error("unimplemented");
}

/** Refuse an op whose class needs consent or presence the request does not carry. */
export function assertAuthorised(req: SignerRequest, agreements: StandingAgreement[], now: Date): void {
  throw new Error("unimplemented");
}
