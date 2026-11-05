// src/crypto.ts against docs/research/vectors.json, which agenttool's own
// functions computed at e9ea51c5. These pass in the skeleton because
// crypto.ts is implemented, not stubbed.
import { describe, expect, test } from "bun:test";
import {
  canonicalJson,
  domainDigest,
  edPublicKey,
  edSign,
  edVerifyStrict,
  EMPTY_SHA256_HEX,
  fromB64,
  fromB64url,
  fromHex,
  sha256,
  sha256Hex,
  toB64,
  toB64url,
  toHex,
  utf8,
} from "../src/crypto.ts";
import { TEST_OP_PUBLIC_B64, TEST_OP_SEED_HEX, TEST_ROOT_PUBLIC_B64, TEST_ROOT_SEED_HEX, vectors } from "./helpers/vectors.ts";

const rootSeed = fromHex(TEST_ROOT_SEED_HEX);
const opSeed = fromHex(TEST_OP_SEED_HEX);

describe("hashing and encodings", () => {
  test("sha256 of the empty body is the value authority binds for bodiless requests", () => {
    expect(sha256Hex(new Uint8Array())).toBe(EMPTY_SHA256_HEX);
  });

  test("base64 decoders refuse non-canonical spellings", () => {
    expect(() => fromB64("YQ")).toThrow();
    expect(() => fromB64("YR==")).toThrow();
    expect(toB64(fromB64("YQ=="))).toBe("YQ==");
    expect(() => fromB64url("YQ==")).toThrow();
    expect(toB64url(fromB64url("YQ"))).toBe("YQ");
    expect(() => fromB64(TEST_OP_PUBLIC_B64, 31)).toThrow();
  });

  test("domainDigest is sha256(domain ‖ NUL ‖ payload)", () => {
    const payload = utf8("x");
    const manual = sha256(new Uint8Array([...utf8("d/v1"), 0, ...payload]));
    expect(toHex(domainDigest("d/v1", payload))).toBe(toHex(manual));
  });
});

describe("Ed25519 against the vectors", () => {
  test("public keys derive from the test seeds", () => {
    expect(toB64(edPublicKey(opSeed))).toBe(TEST_OP_PUBLIC_B64);
    expect(toB64(edPublicKey(rootSeed))).toBe(TEST_ROOT_PUBLIC_B64);
  });

  test("enrollment: body hash, digest and root signature match agenttool", () => {
    for (const v of vectors.enrollment) {
      expect(sha256Hex(utf8(v.body_utf8))).toBe(v.body_sha256_hex);
      const digest = sha256(fromHex(v.preimage_hex));
      expect(toHex(digest)).toBe(v.digest_hex);
      expect(toB64url(edSign(digest, rootSeed))).toBe(v.header_X_Agenttool_Enrollment_Signature);
    }
  });

  test("authority: every digest signs to the header agenttool accepted", () => {
    const rootPub = edPublicKey(rootSeed);
    for (const v of vectors.authority) {
      const digest = sha256(fromHex(v.preimage_hex));
      expect(toHex(digest)).toBe(v.digest_hex);
      const sig = edSign(digest, rootSeed);
      expect(toB64(sig)).toBe(v.headers["X-Agenttool-Authority-Signature"]);
      expect(edVerifyStrict(sig, digest, rootPub)).toBe(true);
    }
  });

  test("thought v2: the op key's signature verifies strictly; a tampered digest does not", () => {
    const t = vectors.thought_v2;
    const digest = fromHex(t.canonical_v2_hex);
    const sig = fromB64(t.signature_b64, 64);
    const pub = fromB64(t.signer_public_key_b64, 32);
    expect(toB64(edSign(digest, opSeed))).toBe(t.signature_b64);
    expect(edVerifyStrict(sig, digest, pub)).toBe(true);
    const tampered = digest.slice();
    tampered[0] = tampered[0]! ^ 1;
    expect(edVerifyStrict(sig, tampered, pub)).toBe(false);
    expect(edVerifyStrict(sig, digest, fromB64(TEST_ROOT_PUBLIC_B64, 32))).toBe(false);
  });

  test("malformed inputs verify as false instead of throwing", () => {
    expect(edVerifyStrict(new Uint8Array(63), new Uint8Array(32), new Uint8Array(32))).toBe(false);
    expect(edVerifyStrict(new Uint8Array(64), new Uint8Array(32), new Uint8Array(31))).toBe(false);
  });
});

describe("canonicalJson", () => {
  test("sorts keys recursively and drops whitespace", () => {
    expect(canonicalJson({ b: 1, a: [true, null, { d: "x", c: 2 }] })).toBe('{"a":[true,null,{"c":2,"d":"x"}],"b":1}');
  });

  test("refuses values that would vanish or change silently", () => {
    expect(() => canonicalJson({ a: undefined })).toThrow();
    expect(() => canonicalJson(Number.NaN)).toThrow();
    expect(() => canonicalJson(new Date(0))).toThrow();
    expect(() => canonicalJson(1n)).toThrow();
  });
});
