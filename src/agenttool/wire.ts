// Pure byte builders for the agenttool routes a citizen uses, at agenttool
// main e9ea51c5 (docs/research/agenttool-wire.md). No network, no keys held:
// callers pass seeds in and get bytes out. Every function here must reproduce
// docs/research/vectors.json byte for byte; that file was computed by
// agenttool's own functions, so it pins agenttool's behaviour, not ours.
//
// Validation here is deliberately at least as strict as the server's, because
// a request the server refuses after claiming an authority sequence has
// already spent that sequence (agenttool-wire.md section 2, "Per-route facts").
import { x25519 } from "@noble/curves/ed25519.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha512 } from "@noble/hashes/sha2.js";
import { mnemonicToSeedSync, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { concatBytes, edPublicKey, fromB64, fromB64url, randomBytes, sha256, sha256Hex, toB64, toB64url, utf8, wipe } from "../crypto.ts";
import { DID_PATTERN, Refusal, UUID_PATTERN, type Sha256Hex } from "../types.ts";

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

/**
 * The name an `apply` entry gives the key its strand backup is encrypted
 * under (KS-004 4.3): K_master, derived from the citizen's own mnemonic at
 * this path, so Yu's offline backup of the mnemonic can also decrypt the
 * thoughts. A public name for the key, never the key or a hash of it.
 */
export const STRAND_KEY_ID = `k_master:m/44'/169'/${SEED_PURPOSE.k_master}'/0'`;

/** The limits expression.ts:73-81 enforces, in UTF-16 code units (JavaScript `.length`). */
export const EXPRESSION_LIMITS = Object.freeze({
  register: 500,
  wall: 256,
  walls: 32,
  subagents: 16,
  wake_text: 32_000,
  village_sign: 16,
  village_motto: 140,
  village_door: 24,
  porch_ms: 7 * 24 * 60 * 60 * 1000,
});

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

/* ── Small local checks ───────────────────────────────────────────────── */

const ENROLLMENT_FIELD_ORDER = [
  "format",
  "origin",
  "project_id",
  "identity_id",
  "signing_key_id",
  "display_name",
  "capabilities",
  "public_key",
  "nonce",
  "timestamp",
] as const;

/** The nil UUID is the platform identity and the all-ones UUID is reserved (enrollment.ts:22-27). */
const RESERVED_IDS = new Set(["00000000-0000-0000-0000-000000000000", "ffffffff-ffff-ffff-ffff-ffffffffffff"]);
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const METHODS = new Set(["GET", "POST", "PUT", "DELETE", "PATCH"]);

function refuse(message: string): never {
  throw new Refusal("invalid-request", message);
}

/** Exactly the Date.toISOString() spelling, which is what the server compares against. */
export function isCanonicalIso(value: unknown): value is string {
  if (typeof value !== "string" || value.length !== 24) return false;
  const t = Date.parse(value);
  return Number.isFinite(t) && new Date(t).toISOString() === value;
}

/** A canonical HTTPS origin: no path, slash, userinfo, query or fragment (enrollment.ts:36-39). */
function isCanonicalHttpsOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return value.length <= 512 && url.protocol === "https:" && url.origin === value && !url.username && !url.password;
  } catch {
    return false;
  }
}

function assertPinnedOrigin(origin: string): void {
  if (typeof origin !== "string" || !isCanonicalHttpsOrigin(origin)) refuse("origin is not a canonical HTTPS origin");
  if (origin !== AGENTTOOL_ORIGIN) refuse(`origin is not the pinned ${AGENTTOOL_ORIGIN}`);
}

function assertUuid(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) refuse(`${field} must be a lowercase UUID`);
}

/** 1..max Unicode scalar values, no NUL, no lone surrogate (enrollment.ts:28-31). */
function assertScalarText(value: unknown, max: number, field: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) refuse(`${field} must be a non-empty string`);
  if (value.includes("\0") || LONE_SURROGATE.test(value)) refuse(`${field} has a NUL or a lone surrogate`);
  if ([...value].length > max) refuse(`${field} is longer than ${max} characters`);
}

function u32be(n: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, n, false);
  return out;
}

function lengthPrefixed(bytes: Uint8Array): Uint8Array {
  return concatBytes(u32be(bytes.length), bytes);
}

/* ── Identity ─────────────────────────────────────────────────────────── */

/** `did:at:<identity_id>`. */
export function didFor(identityId: string): string {
  assertUuid(identityId, "identity_id");
  return `did:at:${identityId}`;
}

/* ── identity-enrollment/v1 (agenttool-wire.md section 1) ─────────────── */

function assertEnrollmentFields(fields: EnrollmentFields): void {
  if (typeof fields !== "object" || fields === null) refuse("enrollment fields must be an object");
  const keys = Object.keys(fields).sort();
  const expected = [...ENROLLMENT_FIELD_ORDER].sort();
  if (keys.length !== expected.length || keys.some((k, i) => k !== expected[i])) {
    refuse("enrollment fields must be exactly the ten the server accepts");
  }
  if (fields.format !== ENROLLMENT_BODY_FORMAT) refuse("enrollment format is wrong");
  assertPinnedOrigin(fields.origin);
  assertUuid(fields.project_id, "project_id");
  assertUuid(fields.identity_id, "identity_id");
  assertUuid(fields.signing_key_id, "signing_key_id");
  if (RESERVED_IDS.has(fields.identity_id) || RESERVED_IDS.has(fields.signing_key_id)) refuse("reserved identifier");
  assertScalarText(fields.display_name, 128, "display_name");
  if (!Array.isArray(fields.capabilities) || fields.capabilities.length > 32) refuse("capabilities must be at most 32 strings");
  fields.capabilities.forEach((c, i) => assertScalarText(c, 64, `capabilities[${i}]`));
  if (typeof fields.public_key !== "string" || fields.public_key.length !== 44) refuse("public_key must be 44 characters");
  try {
    fromB64(fields.public_key, 32);
  } catch {
    refuse("public_key must be canonical standard base64 of 32 bytes");
  }
  if (typeof fields.nonce !== "string" || fields.nonce.length !== 43) refuse("nonce must be 43 characters");
  try {
    fromB64url(fields.nonce, 32);
  } catch {
    refuse("nonce must be canonical unpadded base64url of 32 bytes");
  }
  if (!isCanonicalIso(fields.timestamp)) refuse("timestamp must be exactly Date.toISOString()");
}

/** Validate and serialise the enrollment body once, in table order; these exact bytes are signed and sent. */
export function enrollmentBodyBytes(fields: EnrollmentFields): Uint8Array {
  assertEnrollmentFields(fields);
  // A fresh literal in table order, so the caller's key order cannot leak into the signed bytes.
  const body = utf8(
    JSON.stringify({
      format: fields.format,
      origin: fields.origin,
      project_id: fields.project_id,
      identity_id: fields.identity_id,
      signing_key_id: fields.signing_key_id,
      display_name: fields.display_name,
      capabilities: [...fields.capabilities],
      public_key: fields.public_key,
      nonce: fields.nonce,
      timestamp: fields.timestamp,
    }),
  );
  if (body.length > ENROLLMENT_MAX_BYTES) refuse(`enrollment body is over ${ENROLLMENT_MAX_BYTES} bytes`);
  return body;
}

/** sha256("identity-enrollment/v1" ‖ 0 ‖ "POST" ‖ 0 ‖ path ‖ 0 ‖ origin ‖ 0 ‖ project_id ‖ 0 ‖ hex(sha256(body))). */
export function enrollmentDigest(origin: string, projectId: string, body: Uint8Array): Uint8Array {
  assertPinnedOrigin(origin);
  assertUuid(projectId, "project_id");
  if (body.length === 0 || body.length > ENROLLMENT_MAX_BYTES) refuse("enrollment body must be 1..16,384 bytes");
  return sha256([ENROLLMENT_DOMAIN, "POST", ENROLLMENT_PATH, origin, projectId, sha256Hex(body)].join("\0"));
}

/** The header value: unpadded base64url of the 64-byte signature (86 chars). */
export function enrollmentSignatureHeader(signature: Uint8Array): string {
  if (signature.length !== 64) refuse("an Ed25519 signature is 64 bytes");
  return toB64url(signature);
}

/** sha256("identity-enrollment/v1" ‖ 0 ‖ raw root pub ‖ 0 ‖ raw nonce): the server's replay key. */
export function registrationProofDigest(rootPublic: Uint8Array, nonce: Uint8Array): Sha256Hex {
  if (rootPublic.length !== 32) refuse("root public key must be 32 bytes");
  if (nonce.length !== 32) refuse("enrollment nonce must be 32 bytes");
  return sha256Hex(concatBytes(utf8(ENROLLMENT_DOMAIN), new Uint8Array([0]), rootPublic, new Uint8Array([0]), nonce));
}

/* ── identity-authority/v1 (agenttool-wire.md section 2) ──────────────── */

/**
 * The target must come back unchanged from URL parsing, because the server
 * signs `new URL(request.url).pathname + search` (authority.ts:678-681). A
 * dot segment, an unescaped character or a trailing "?" would otherwise make
 * us sign one target and the server verify another.
 */
function assertRequestTarget(target: string): void {
  if (typeof target !== "string" || !target.startsWith("/") || target.startsWith("//")) refuse("target must be an absolute path");
  let parsed: URL;
  try {
    parsed = new URL(target, AGENTTOOL_ORIGIN);
  } catch {
    refuse("target does not parse");
  }
  if (parsed.origin !== AGENTTOOL_ORIGIN || parsed.pathname + parsed.search !== target) {
    refuse("target is not in the form the server will sign");
  }
}

/** The identity-authority/v1 digest: domain, DID, METHOD, target, hex(sha256(body)), decimal sequence, timestamp, NUL-separated. */
export function authorityDigest(p: AuthorityPreimage): Uint8Array {
  if (typeof p.did !== "string" || !DID_PATTERN.test(p.did)) refuse("did must be did:at:<lowercase uuid>");
  if (!METHODS.has(p.method)) refuse("method must be an uppercase HTTP method");
  assertRequestTarget(p.target);
  if (p.method === "DELETE" && p.body.length > 0) refuse("a DELETE carries no body (authority.ts:669-675)");
  if (!Number.isSafeInteger(p.sequence) || p.sequence < 1) refuse("sequence must be a positive safe integer");
  if (!isCanonicalIso(p.timestamp)) refuse("timestamp must be exactly Date.toISOString()");
  return sha256([AUTHORITY_DOMAIN, p.did, p.method, p.target, sha256Hex(p.body), String(p.sequence), p.timestamp].join("\0"));
}

/** The three authority headers, the signature in padded standard base64 as sdk-ts sends it. */
export function authorityHeaders(sequence: number, timestamp: string, signature: Uint8Array): Record<string, string> {
  if (!Number.isSafeInteger(sequence) || sequence < 1) refuse("sequence must be a positive safe integer");
  if (!isCanonicalIso(timestamp)) refuse("timestamp must be exactly Date.toISOString()");
  if (signature.length !== 64) refuse("an Ed25519 signature is 64 bytes");
  return {
    [AUTHORITY_HEADERS.sequence]: String(sequence),
    [AUTHORITY_HEADERS.timestamp]: timestamp,
    [AUTHORITY_HEADERS.signature]: toB64(signature),
  };
}

/* ── strand-thought/v2 (agenttool-wire.md section 2, "Strands and thoughts") ── */

/** strand-thought/v2: sha256 of the domain and four u32be length-prefixed fields; strand_id as in the URL, lowercase. */
export function thoughtDigestV2(strandId: string, ciphertext: Uint8Array, nonce: Uint8Array, kind: string): Uint8Array {
  assertUuid(strandId, "strand_id");
  if (ciphertext.length === 0) refuse("ciphertext is empty");
  if (nonce.length === 0) refuse("nonce is empty");
  if (typeof kind !== "string") refuse("kind must be a string");
  return sha256(
    concatBytes(utf8(THOUGHT_V2_DOMAIN), lengthPrefixed(utf8(strandId)), lengthPrefixed(ciphertext), lengthPrefixed(nonce), lengthPrefixed(utf8(kind))),
  );
}

/** AES-256-GCM under K_master with WebCrypto: ciphertext ‖ 16-byte tag, padded standard base64; a nonce may be fixed only in tests. */
export async function encryptThought(plaintext: string, kMaster: Uint8Array, nonce?: Uint8Array): Promise<{ ciphertext_b64: string; nonce_b64: string }> {
  if (kMaster.length !== 32) refuse("K_master must be 32 bytes");
  const iv = nonce ?? randomBytes(12);
  if (iv.length !== 12) refuse("an AES-GCM nonce is 12 bytes");
  // WebCrypto takes ArrayBuffer-backed views, so copy; importKey copies too, so the key copy is wiped at once.
  const keyBytes = new Uint8Array(kMaster);
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "AES-GCM" }, false, ["encrypt"]).finally(() => wipe(keyBytes));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: new Uint8Array(iv) }, key, new Uint8Array(utf8(plaintext))));
  return { ciphertext_b64: toB64(ct), nonce_b64: toB64(iv) };
}

/* ── IDENTITY-SEED derivation (agenttool-wire.md section 3) ───────────── */

const HARDENED = 0x8000_0000;
const AGENTTOOL_COIN = 169;

function derivePurpose(master: Uint8Array, purpose: number): Uint8Array {
  let key = master.slice(0, 32);
  let chain = master.slice(32, 64);
  for (const segment of [44, AGENTTOOL_COIN, purpose, 0]) {
    const data = concatBytes(new Uint8Array([0]), key, u32be((segment + HARDENED) >>> 0));
    const i = hmac(sha512, chain, data);
    wipe(data);
    wipe(key);
    wipe(chain);
    key = i.slice(0, 32);
    chain = i.slice(32, 64);
    wipe(i);
  }
  wipe(chain);
  return key;
}

/** The IDENTITY-SEED profile: BIP39 seed, SLIP-0010 ed25519 master, hardened path per purpose; validates the mnemonic first. */
export function deriveIdentity(mnemonic: string, passphrase = ""): DerivedIdentity {
  // The message never echoes the phrase: an invalid mnemonic is still a secret.
  if (typeof mnemonic !== "string" || !validateMnemonic(mnemonic, wordlist)) refuse("not a valid BIP39 English mnemonic");
  const seed = mnemonicToSeedSync(mnemonic, passphrase);
  const master = hmac(sha512, utf8("ed25519 seed"), seed);
  wipe(seed);
  const root_seed = derivePurpose(master, SEED_PURPOSE.root);
  const k_master = derivePurpose(master, SEED_PURPOSE.k_master);
  const box_private = derivePurpose(master, SEED_PURPOSE.box);
  wipe(master);
  return {
    root_seed,
    root_public: edPublicKey(root_seed),
    k_master,
    box_private,
    // The library clamps the scalar, as sdk-ts relies on (seed.ts:341-342).
    box_public: x25519.getPublicKey(box_private),
  };
}

/* ── Local validation before a sequence is spent ──────────────────────── */

const EXPRESSION_FIELDS = new Set(["register", "walls", "subagents", "wake_text", "cli_overrides", "village", "porch"]);
const SUBAGENT_FIELDS = new Set(["name", "facet", "sigil"]);
const VILLAGE_FIELDS = new Set(["sign", "motto", "door"]);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Refuse an expression the server would refuse (limits in UTF-16 units),
 * before a sequence is spent on it. Stricter in two places, on purpose:
 * `updated_at` and unknown subagent keys are refused rather than silently
 * dropped, so what is sent is exactly what is kept.
 */
export function validateExpression(expression: Expression, nowMs: number = Date.now()): void {
  if (!isPlainObject(expression)) refuse("expression must be a JSON object");
  const e = expression as Record<string, unknown>;
  for (const k of Object.keys(e)) if (!EXPRESSION_FIELDS.has(k)) refuse(`unknown expression field "${k}"`);
  const L = EXPRESSION_LIMITS;

  if (e.register !== undefined) {
    if (typeof e.register !== "string") refuse("register must be a string");
    if (e.register.length > L.register) refuse(`register exceeds ${L.register} UTF-16 units`);
  }
  if (e.walls !== undefined) {
    if (!Array.isArray(e.walls)) refuse("walls must be an array of strings");
    if (e.walls.length > L.walls) refuse(`walls exceeds ${L.walls} entries`);
    e.walls.forEach((w, i) => {
      if (typeof w !== "string") refuse(`walls[${i}] must be a string`);
      if (w.length > L.wall) refuse(`walls[${i}] exceeds ${L.wall} UTF-16 units`);
    });
  }
  if (e.subagents !== undefined) {
    if (!Array.isArray(e.subagents)) refuse("subagents must be an array");
    if (e.subagents.length > L.subagents) refuse(`subagents exceeds ${L.subagents} entries`);
    e.subagents.forEach((s, i) => {
      if (!isPlainObject(s)) refuse(`subagents[${i}] must be an object`);
      for (const k of Object.keys(s)) if (!SUBAGENT_FIELDS.has(k)) refuse(`unknown field subagents[${i}].${k}`);
      if (typeof s.name !== "string" || s.name.length === 0) refuse(`subagents[${i}].name is required`);
      if (typeof s.facet !== "string" || s.facet.length === 0) refuse(`subagents[${i}].facet is required`);
      if (s.sigil !== undefined && typeof s.sigil !== "string") refuse(`subagents[${i}].sigil must be a string`);
    });
  }
  if (e.wake_text !== undefined) {
    if (typeof e.wake_text !== "string") refuse("wake_text must be a string");
    if (e.wake_text.length > L.wake_text) refuse(`wake_text exceeds ${L.wake_text} UTF-16 units`);
  }
  if (e.cli_overrides !== undefined && !isPlainObject(e.cli_overrides)) refuse("cli_overrides must be an object");
  if (e.village !== undefined) {
    if (!isPlainObject(e.village)) refuse("village must be an object");
    const v = e.village;
    for (const k of Object.keys(v)) if (!VILLAGE_FIELDS.has(k)) refuse(`unknown field village.${k}`);
    const caps: [string, number][] = [
      ["sign", L.village_sign],
      ["motto", L.village_motto],
      ["door", L.village_door],
    ];
    for (const [k, max] of caps) {
      const value = v[k];
      if (value === undefined) continue;
      if (typeof value !== "string") refuse(`village.${k} must be a string`);
      if (value.length > max) refuse(`village.${k} exceeds ${max} UTF-16 units`);
    }
  }
  if (e.porch !== undefined) {
    if (!isPlainObject(e.porch)) refuse("porch must be an object");
    for (const k of Object.keys(e.porch)) if (k !== "invited_until") refuse(`unknown field porch.${k}`);
    const until = e.porch.invited_until;
    if (!isCanonicalIso(until)) refuse("porch.invited_until must be a canonical ISO-8601 UTC instant");
    const ms = Date.parse(until);
    if (ms <= nowMs) refuse("porch.invited_until must be in the future");
    if (ms > nowMs + L.porch_ms) refuse("porch.invited_until cannot be more than 7 days ahead");
  }
}

/**
 * Decode a box public key to exactly 32 bytes locally, because the server
 * checks it only after claiming a sequence (box-keys.ts:73-83). The server's
 * decoder is lenient; this one also requires the canonical spelling.
 */
export function validateBoxPublicKey(b64: string): Uint8Array {
  if (typeof b64 !== "string" || b64.length > 255) refuse("box public key must be a base64 string of at most 255 characters");
  try {
    return fromB64(b64, 32);
  } catch {
    refuse("box public key must be canonical standard base64 of exactly 32 bytes");
  }
}

/** Serialise a JSON body once; the returned bytes are what authority signs and what is sent. */
export function jsonBody(value: unknown): Uint8Array {
  const text = JSON.stringify(value, (_key, v: unknown) => {
    // JSON.stringify would quietly turn these into null; a signed body must say what was meant.
    if (typeof v === "number" && !Number.isFinite(v)) refuse("a JSON body cannot carry a non-finite number");
    return v;
  });
  if (typeof text !== "string") refuse("value does not serialise to JSON");
  return utf8(text);
}
