// Byte, hash, base64 and Ed25519 primitives shared by the signer, the ledger
// and the agenttool wire. Implemented in the skeleton, not stubbed, because
// every other module depends on it and it is checked against vectors.json.
//
// The libraries and versions match agenttool's sdk-ts lockfile at e9ea51c5
// (agenttool-wire.md section 3), so our bytes equal the SDK's bytes.
import * as ed from "@noble/ed25519";
import { sha256 as nobleSha256, sha512 } from "@noble/hashes/sha2.js";

// @noble/ed25519 2.x needs a synchronous SHA-512 wired in, as sdk-ts does (seed.ts:85-90).
ed.etc.sha512Sync = (...messages: Uint8Array[]) => {
  const h = sha512.create();
  for (const m of messages) h.update(m);
  return h.digest();
};

const encoder = new TextEncoder();
const fatalDecoder = new TextDecoder("utf-8", { fatal: true });

export const EMPTY_SHA256_HEX = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

/** UTF-8 bytes of a string. */
export function utf8(s: string): Uint8Array {
  return encoder.encode(s);
}

/** Decode UTF-8 strictly; malformed bytes throw instead of becoming U+FFFD. */
export function fromUtf8(bytes: Uint8Array): string {
  return fatalDecoder.decode(bytes);
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  let length = 0;
  for (const p of parts) length += p.length;
  const out = new Uint8Array(length);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

export function sha256(data: Uint8Array | string): Uint8Array {
  return nobleSha256(typeof data === "string" ? utf8(data) : data);
}

export function sha256Hex(data: Uint8Array | string): string {
  return toHex(sha256(data));
}

/** sha256(utf8(domain) ‖ 0x00 ‖ payload): a tag keeps one kind of signature from passing as another. */
export function domainDigest(domain: string, payload: Uint8Array): Uint8Array {
  return sha256(concatBytes(utf8(domain), new Uint8Array([0]), payload));
}

export function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

export function fromHex(hex: string): Uint8Array {
  if (!/^(?:[0-9a-f]{2})*$/.test(hex)) throw new Error("fromHex: expected lowercase hex of even length");
  return new Uint8Array(Buffer.from(hex, "hex"));
}

/** Padded standard base64, the spelling sdk-ts sends for keys and signatures. */
export function toB64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

/**
 * Decode padded standard base64 and require the canonical spelling, because
 * Node's decoder is lenient and agenttool refuses non-canonical keys
 * (keys.ts:269-281). Pass `length` to require an exact byte count.
 */
export function fromB64(s: string, length?: number): Uint8Array {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(s)) {
    throw new Error("fromB64: not padded standard base64");
  }
  const bytes = new Uint8Array(Buffer.from(s, "base64"));
  if (toB64(bytes) !== s) throw new Error("fromB64: not canonical");
  if (length !== undefined && bytes.length !== length) {
    throw new Error(`fromB64: expected ${length} bytes, got ${bytes.length}`);
  }
  return bytes;
}

/** Unpadded base64url, the spelling of the enrollment nonce and signature header. */
export function toB64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

export function fromB64url(s: string, length?: number): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new Error("fromB64url: not unpadded base64url");
  const bytes = new Uint8Array(Buffer.from(s, "base64url"));
  if (toB64url(bytes) !== s) throw new Error("fromB64url: not canonical");
  if (length !== undefined && bytes.length !== length) {
    throw new Error(`fromB64url: expected ${length} bytes, got ${bytes.length}`);
  }
  return bytes;
}

export function randomBytes(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n));
}

/** Best-effort wipe of a secret buffer once it is no longer needed. */
export function wipe(bytes: Uint8Array): void {
  bytes.fill(0);
}

/** Ed25519 public key for a 32-byte seed. */
export function edPublicKey(seed: Uint8Array): Uint8Array {
  if (seed.length !== 32) throw new Error("edPublicKey: seed must be 32 bytes");
  return ed.getPublicKey(seed);
}

/** Deterministic RFC 8032 signature; identical to any conforming signer's. */
export function edSign(message: Uint8Array, seed: Uint8Array): Uint8Array {
  if (seed.length !== 32) throw new Error("edSign: seed must be 32 bytes");
  return ed.sign(message, seed);
}

/**
 * RFC 8032 strict verification (zip215: false), as agenttool's enrollment
 * uses. It refuses nothing a conforming signer produces, so the ledger
 * verifies its own envelopes this way. Any malformed input is `false`.
 */
export function edVerifyStrict(signature: Uint8Array, message: Uint8Array, publicKey: Uint8Array): boolean {
  if (signature.length !== 64 || publicKey.length !== 32) return false;
  try {
    return ed.verify(signature, message, publicKey, { zip215: false });
  } catch {
    return false;
  }
}

/**
 * Canonical JSON for hashing: object keys sorted by UTF-16 code units, no
 * whitespace, finite numbers only. It throws on undefined, functions, bigint
 * and non-plain objects, so an optional field can never silently vanish from
 * a hash. Use null for "absent".
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "string":
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value)) throw new Error("canonicalJson: non-finite number");
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) throw new Error("canonicalJson: not a plain object");
      const keys = Object.keys(value as Record<string, unknown>).sort();
      const parts = keys.map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`);
      return `{${parts.join(",")}}`;
    }
    default:
      throw new Error(`canonicalJson: cannot encode ${typeof value}`);
  }
}
