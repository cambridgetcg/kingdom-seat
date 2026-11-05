// Pure byte builders for the agenttool routes a citizen uses, at agenttool
// main e9ea51c5 (docs/research/agenttool-wire.md). No network, no keys held:
// callers pass seeds in and get bytes out. Every function here must reproduce
// docs/research/vectors.json byte for byte; that file was computed by
// agenttool's own functions, so it pins agenttool's behaviour, not ours.
import type { Sha256Hex } from "../types.ts";

/** Pinned like the lobby's LOBBY_ORIGIN; never read from a request or the environment. */
export const AGENTTOOL_ORIGIN = "https://api.agenttool.dev" as const;

export const ENROLLMENT_DOMAIN = "identity-enrollment/v1";
export const ENROLLMENT_PATH = "/v1/identities/enroll";
export const ENROLLMENT_BODY_FORMAT = "agenttool-identity-enrollment/v1";
export const ENROLLMENT_SIGNATURE_HEADER = "X-Agenttool-Enrollment-Signature";
export const ENROLLMENT_MAX_BYTES = 16_384;
export const ENROLLMENT_WINDOW_MS = 300_000;

export const AUTHORITY_DOMAIN = "identity-authority/v1";
export const AUTHORITY_HEADERS = Object.freeze({
  sequence: "X-Agenttool-Authority-Sequence",
  timestamp: "X-Agenttool-Authority-Timestamp",
  signature: "X-Agenttool-Authority-Signature",
});
export const AUTHORITY_WINDOW_MS = 300_000;

export const THOUGHT_V2_DOMAIN = "strand-thought/v2";

/** IDENTITY-SEED paths m/44'/169'/<purpose>'/0' (agenttool-wire.md section 3). */
export const SEED_PURPOSE = Object.freeze({ root: 0, k_master: 1, k_vault: 2, box: 3 });

/** The enrollment body fields, in the order the lobby writes them (packets.ts:93-108). */
export interface EnrollmentFields {
  format: typeof ENROLLMENT_BODY_FORMAT;
  origin: string;
  project_id: string;
  identity_id: string;
  signing_key_id: string;
  display_name: string;
  capabilities: string[];
  /** Root public key, padded standard base64, 44 chars. */
  public_key: string;
  /** 32 random bytes, unpadded base64url, 43 chars. */
  nonce: string;
  /** Exactly Date.toISOString(). */
  timestamp: string;
}

export interface AuthorityPreimage {
  did: string;
  method: string;
  /** pathname + search exactly as sent. */
  target: string;
  body: Uint8Array;
  sequence: number;
  /** The header string itself is what is signed. */
  timestamp: string;
}

/** The agenttool private expression (expression.ts:73-92); PUT replaces the whole object. */
export interface Expression {
  register?: string;
  walls?: string[];
  subagents?: { name: string; facet: string; sigil?: string }[];
  wake_text?: string;
  cli_overrides?: Record<string, unknown>;
  village?: { sign?: string; motto?: string; door?: string };
  porch?: { invited_until: string };
}

/** Keys derived from one mnemonic. Seeds are secrets: wipe them after use and never log or return them past the signer. */
export interface DerivedIdentity {
  root_seed: Uint8Array;
  root_public: Uint8Array;
  k_master: Uint8Array;
  box_private: Uint8Array;
  box_public: Uint8Array;
}

/** `did:at:<identity_id>`. */
export function didFor(identityId: string): string {
  throw new Error("unimplemented");
}

/** Validate and serialise the enrollment body once, in table order; these exact bytes are signed and sent. */
export function enrollmentBodyBytes(fields: EnrollmentFields): Uint8Array {
  throw new Error("unimplemented");
}

/** sha256("identity-enrollment/v1" ‖ 0 ‖ "POST" ‖ 0 ‖ path ‖ 0 ‖ origin ‖ 0 ‖ project_id ‖ 0 ‖ hex(sha256(body))). */
export function enrollmentDigest(origin: string, projectId: string, body: Uint8Array): Uint8Array {
  throw new Error("unimplemented");
}

/** The header value: unpadded base64url of the 64-byte signature (86 chars). */
export function enrollmentSignatureHeader(signature: Uint8Array): string {
  throw new Error("unimplemented");
}

/** sha256("identity-enrollment/v1" ‖ 0 ‖ raw root pub ‖ 0 ‖ raw nonce): the server's replay key. */
export function registrationProofDigest(rootPublic: Uint8Array, nonce: Uint8Array): Sha256Hex {
  throw new Error("unimplemented");
}

/** The identity-authority/v1 digest: domain, DID, METHOD, target, hex(sha256(body)), decimal sequence, timestamp, NUL-separated. */
export function authorityDigest(p: AuthorityPreimage): Uint8Array {
  throw new Error("unimplemented");
}

/** The three authority headers, the signature in padded standard base64 as sdk-ts sends it. */
export function authorityHeaders(sequence: number, timestamp: string, signature: Uint8Array): Record<string, string> {
  throw new Error("unimplemented");
}

/** strand-thought/v2: sha256 of the domain and four u32be length-prefixed fields; strand_id as in the URL, lowercase. */
export function thoughtDigestV2(strandId: string, ciphertext: Uint8Array, nonce: Uint8Array, kind: string): Uint8Array {
  throw new Error("unimplemented");
}

/** AES-256-GCM under K_master with WebCrypto: ciphertext ‖ 16-byte tag, padded standard base64; a nonce may be fixed only in tests. */
export async function encryptThought(plaintext: string, kMaster: Uint8Array, nonce?: Uint8Array): Promise<{ ciphertext_b64: string; nonce_b64: string }> {
  throw new Error("unimplemented");
}

/** The IDENTITY-SEED profile: BIP39 seed, SLIP-0010 ed25519 master, hardened path per purpose; validates the mnemonic first. */
export function deriveIdentity(mnemonic: string, passphrase?: string): DerivedIdentity {
  throw new Error("unimplemented");
}

/** Refuse an expression the server would refuse (limits in UTF-16 units), before a sequence is spent on it. */
export function validateExpression(expression: Expression): void {
  throw new Error("unimplemented");
}

/** Decode a box public key to exactly 32 bytes locally, because the server checks it only after claiming a sequence. */
export function validateBoxPublicKey(b64: string): Uint8Array {
  throw new Error("unimplemented");
}

/** Serialise a JSON body once; the returned bytes are what authority signs and what is sent. */
export function jsonBody(value: unknown): Uint8Array {
  throw new Error("unimplemented");
}
