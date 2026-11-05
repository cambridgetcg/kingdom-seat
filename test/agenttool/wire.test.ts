// Owner: agenttool group. Every byte must equal docs/research/vectors.json,
// which agenttool's own functions computed at e9ea51c5.
import { describe, expect, test } from "bun:test";
import {
  AGENTTOOL_ORIGIN,
  authorityDigest,
  authorityHeaders,
  deriveIdentity,
  didFor,
  encryptThought,
  enrollmentBodyBytes,
  enrollmentDigest,
  enrollmentSignatureHeader,
  jsonBody,
  registrationProofDigest,
  thoughtDigestV2,
  validateBoxPublicKey,
  validateExpression,
  type EnrollmentFields,
  type Expression,
} from "../../src/agenttool/wire.ts";
import { edSign, fromB64, fromB64url, fromHex, sha256, toB64, toB64url, toHex, utf8 } from "../../src/crypto.ts";
import { Refusal } from "../../src/types.ts";
import { TEST_MNEMONIC, TEST_OP_SEED_HEX, TEST_ROOT_SEED_HEX, vectors } from "../helpers/vectors.ts";

const rootSeed = fromHex(TEST_ROOT_SEED_HEX);
const opSeed = fromHex(TEST_OP_SEED_HEX);
const text = (b: Uint8Array) => new TextDecoder().decode(b);
// The vector ids are all digits, so upper-casing them changes nothing; this one has letters.
const MIXED_UUID = "abcdef01-2345-4678-9abc-def012345678";

function refusal(fn: () => unknown): Refusal {
  try {
    fn();
  } catch (e) {
    if (e instanceof Refusal) return e;
    throw new Error(`expected a Refusal, got ${String(e)}`);
  }
  throw new Error("expected a Refusal, nothing was thrown");
}

function vectorFields(i: 0 | 1): EnrollmentFields {
  return JSON.parse(vectors.enrollment[i]!.body_utf8) as EnrollmentFields;
}

describe("vectors.json, byte for byte", () => {
  test("deriveIdentity(abandon … about) gives every derivation value, root, box and K_master", () => {
    const d = deriveIdentity(TEST_MNEMONIC);
    const v = vectors.derivation;
    expect(toHex(d.root_seed)).toBe(v.signing_seed_hex);
    expect(toB64(d.root_seed)).toBe(v.signing_seed_b64);
    expect(toB64(d.root_public)).toBe(v.signing_pub_b64);
    expect(toB64(d.box_private)).toBe(v.box_priv_b64);
    expect(toB64(d.box_public)).toBe(v.box_pub_b64);
    expect(toB64(d.k_master)).toBe(v.k_master_b64);
    expect(v.passphrase).toBe("");
  });

  test("deriveIdentity refuses an invalid mnemonic without echoing it", () => {
    const bad = TEST_MNEMONIC.replace(/about$/, "abandon");
    const r = refusal(() => deriveIdentity(bad));
    expect(r.code).toBe("invalid-request");
    expect(r.message).not.toContain("abandon");
  });

  test("enrollmentBodyBytes reproduces both enrollment[*].body_utf8 exactly, field order included", () => {
    for (const i of [0, 1] as const) {
      const v = vectors.enrollment[i]!;
      const fields = vectorFields(i);
      expect(text(enrollmentBodyBytes(fields))).toBe(v.body_utf8);
      expect(toHex(sha256(enrollmentBodyBytes(fields)))).toBe(v.body_sha256_hex);
      // The caller's key order never reaches the signed bytes.
      const shuffled = Object.fromEntries(Object.entries(fields).reverse()) as unknown as EnrollmentFields;
      expect(text(enrollmentBodyBytes(shuffled))).toBe(v.body_utf8);
    }
  });

  test("enrollmentDigest and enrollmentSignatureHeader reproduce both enrollment vectors", () => {
    for (const v of vectors.enrollment) {
      const body = utf8(v.body_utf8);
      const digest = enrollmentDigest(v.inputs.origin, v.inputs.project_id, body);
      expect(toHex(digest)).toBe(v.digest_hex);
      expect(toHex(sha256(fromHex(v.preimage_hex)))).toBe(v.digest_hex);
      const header = enrollmentSignatureHeader(edSign(digest, fromHex(v.inputs.root_seed_hex)));
      expect(header).toBe(v.header_X_Agenttool_Enrollment_Signature);
      expect(header).toHaveLength(86);
    }
  });

  test("registrationProofDigest reproduces registration_proof_digest_hex", () => {
    for (const v of vectors.enrollment) {
      const fields = JSON.parse(v.body_utf8) as EnrollmentFields;
      const nonce = fromHex(v.inputs.nonce_bytes_hex);
      expect(toB64url(nonce)).toBe(fields.nonce);
      expect(registrationProofDigest(fromB64(fields.public_key, 32), nonce)).toBe(v.registration_proof_digest_hex);
    }
  });

  test("authorityDigest and authorityHeaders reproduce all six authority vectors", () => {
    expect(vectors.authority.map((a) => a.label)).toEqual(["keys-import", "box-keys-register", "expression-put", "quiet-start", "quiet-end", "keys-revoke"]);
    for (const a of vectors.authority) {
      const body = utf8(a.body_utf8);
      expect(new URL(a.url).origin).toBe(AGENTTOOL_ORIGIN);
      const digest = authorityDigest({ did: a.identity_did, method: a.method, target: a.request_target, body, sequence: a.sequence, timestamp: a.timestamp });
      expect(toHex(digest)).toBe(a.digest_hex);
      expect(toHex(sha256(fromHex(a.preimage_hex)))).toBe(a.digest_hex);
      const headers = authorityHeaders(a.sequence, a.timestamp, edSign(digest, rootSeed));
      expect(headers).toEqual(a.headers);
      expect(Object.keys(headers)).toEqual(Object.keys(a.headers));
    }
  });

  test("jsonBody reproduces every non-empty authority body from its value", () => {
    for (const a of vectors.authority.filter((x) => x.body_utf8 !== "")) {
      expect(text(jsonBody(JSON.parse(a.body_utf8)))).toBe(a.body_utf8);
    }
  });

  test("thoughtDigestV2 reproduces canonical_v2_hex; encryptThought with the fixed nonce reproduces the ciphertext", async () => {
    const t = vectors.thought_v2;
    const kMaster = fromB64(vectors.derivation.k_master_b64, 32);
    const nonce = fromHex(t.aes_256_gcm.nonce_hex);
    const sealed = await encryptThought(t.plaintext_utf8, kMaster, nonce);
    expect(sealed.ciphertext_b64).toBe(t.aes_256_gcm.ciphertext_with_tag_b64);
    expect(sealed.nonce_b64).toBe(t.request_body_fields.nonce);
    const digest = thoughtDigestV2(t.strand_id, fromB64(sealed.ciphertext_b64), nonce, t.kind);
    expect(toHex(digest)).toBe(t.canonical_v2_hex);
    expect(toB64(edSign(digest, opSeed))).toBe(t.signature_b64);
  });

  test("didFor names the identity and refuses anything but a lowercase UUID", () => {
    expect(didFor(vectors.ids.identity_id)).toBe(vectors.ids.did);
    expect(refusal(() => didFor(MIXED_UUID.toUpperCase())).code).toBe("invalid-request");
  });
});

describe("local validation before a sequence is spent", () => {
  test("enrollment refuses a non-HTTPS origin, a non-lowercase UUID, an empty or overlong display_name, and a body over 16,384 bytes", () => {
    const f = vectorFields(0);
    const body = (patch: Partial<Record<keyof EnrollmentFields, unknown>>) => () => enrollmentBodyBytes({ ...f, ...patch } as EnrollmentFields);

    expect(refusal(body({ origin: "http://api.agenttool.dev" })).message).toContain("HTTPS");
    expect(refusal(body({ origin: "https://api.agenttool.dev/" })).code).toBe("invalid-request");
    expect(refusal(body({ origin: "https://elsewhere.example" })).message).toContain("pinned");
    expect(() => enrollmentDigest("https://elsewhere.example", f.project_id, utf8("{}"))).toThrow(Refusal);

    expect(refusal(body({ identity_id: MIXED_UUID.toUpperCase() })).message).toContain("identity_id");
    expect(refusal(body({ project_id: "not-a-uuid" })).message).toContain("project_id");
    expect(refusal(body({ signing_key_id: "00000000-0000-0000-0000-000000000000" })).message).toContain("reserved");
    expect(() => enrollmentDigest(AGENTTOOL_ORIGIN, MIXED_UUID.toUpperCase(), utf8("{}"))).toThrow(Refusal);

    expect(refusal(body({ display_name: "" })).message).toContain("display_name");
    expect(refusal(body({ display_name: "x".repeat(129) })).message).toContain("display_name");
    expect(refusal(body({ display_name: "a\0b" })).message).toContain("NUL");
    expect(refusal(body({ display_name: "lone \uD800 surrogate" })).message).toContain("surrogate");
    // 128 scalars is the limit even when each is several UTF-8 bytes or two UTF-16 units.
    expect(() => enrollmentBodyBytes({ ...f, display_name: "😀".repeat(128) })).not.toThrow();
    expect(() => enrollmentBodyBytes({ ...f, display_name: "😀".repeat(129) })).toThrow(Refusal);

    expect(refusal(body({ capabilities: Array.from({ length: 33 }, (_, i) => `c${i}`) })).code).toBe("invalid-request");
    expect(refusal(body({ capabilities: ["x".repeat(65)] })).message).toContain("capabilities[0]");
    expect(refusal(body({ nonce: f.nonce + "A" })).message).toContain("nonce");
    expect(refusal(body({ public_key: f.public_key.replace(/=$/, "") })).message).toContain("public_key");
    expect(refusal(body({ timestamp: "2026-11-05T12:00:00Z" })).message).toContain("timestamp");
    expect(refusal(() => enrollmentBodyBytes({ ...f, extra: 1 } as unknown as EnrollmentFields)).message).toContain("exactly");
    const { nonce: _dropped, ...missing } = f;
    expect(refusal(() => enrollmentBodyBytes(missing as unknown as EnrollmentFields)).message).toContain("exactly");

    // The field limits keep a valid body well under the cap, so the cap is proved on the digest builder.
    expect(refusal(() => enrollmentDigest(AGENTTOOL_ORIGIN, f.project_id, new Uint8Array(16_385))).message).toContain("16,384");
    expect(() => enrollmentDigest(AGENTTOOL_ORIGIN, f.project_id, new Uint8Array(16_384))).not.toThrow();
  });

  test("validateExpression enforces register ≤500, walls ≤32×256, wake_text ≤32,000 UTF-16 units, village and porch limits, unknown fields", () => {
    const ok = (e: unknown, now?: number) => expect(() => validateExpression(e as Expression, now)).not.toThrow();
    const no = (e: unknown, now?: number) => refusal(() => validateExpression(e as Expression, now));

    ok({});
    ok({ register: "x".repeat(500) });
    no({ register: "x".repeat(501) });
    // UTF-16 units, not code points: 250 emoji are 500 units, 251 are 502.
    ok({ register: "😀".repeat(250) });
    expect(no({ register: "😀".repeat(251) }).message).toContain("register");
    ok({ walls: Array.from({ length: 32 }, () => "w".repeat(256)) });
    no({ walls: Array.from({ length: 33 }, () => "w") });
    no({ walls: ["w".repeat(257)] });
    no({ walls: [1] });
    ok({ wake_text: "t".repeat(32_000) });
    expect(no({ wake_text: "t".repeat(32_001) }).message).toContain("wake_text");
    ok({ subagents: Array.from({ length: 16 }, (_, i) => ({ name: `n${i}`, facet: "f" })) });
    no({ subagents: Array.from({ length: 17 }, (_, i) => ({ name: `n${i}`, facet: "f" })) });
    no({ subagents: [{ name: "n" }] });
    no({ subagents: [{ name: "n", facet: "f", colour: "red" }] });
    ok({ cli_overrides: { a: 1 } });
    no({ cli_overrides: null });
    ok({ village: { sign: "s".repeat(16), motto: "m".repeat(140), door: "d".repeat(24) } });
    no({ village: { sign: "s".repeat(17) } });
    no({ village: { motto: "m".repeat(141) } });
    no({ village: { door: "d".repeat(25) } });
    no({ village: { roof: "red" } });

    const now = Date.parse("2026-11-05T12:00:00.000Z");
    ok({ porch: { invited_until: "2026-11-06T12:00:00.000Z" } }, now);
    no({ porch: { invited_until: "2026-11-05T11:59:59.999Z" } }, now);
    no({ porch: { invited_until: "2026-11-12T12:00:00.001Z" } }, now);
    no({ porch: { invited_until: "2026-11-06T12:00:00Z" } }, now);
    no({ porch: { invited_until: "2026-11-06T12:00:00.000Z", extra: 1 } }, now);

    expect(no({ declared: "x" }).message).toContain("declared");
    no({ updated_at: "2026-11-05T12:00:00.000Z" });
    no([]);
    no(null);
  });

  test("validateBoxPublicKey refuses anything that is not 32 bytes", () => {
    expect(toB64(validateBoxPublicKey(vectors.derivation.box_pub_b64))).toBe(vectors.derivation.box_pub_b64);
    expect(validateBoxPublicKey(vectors.derivation.box_pub_b64)).toHaveLength(32);
    expect(refusal(() => validateBoxPublicKey(toB64(new Uint8Array(31)))).code).toBe("invalid-request");
    expect(refusal(() => validateBoxPublicKey(toB64(new Uint8Array(33)))).code).toBe("invalid-request");
    expect(refusal(() => validateBoxPublicKey(vectors.derivation.box_pub_b64.replace(/=$/, ""))).code).toBe("invalid-request");
    expect(refusal(() => validateBoxPublicKey(Buffer.from(fromB64(vectors.derivation.box_pub_b64)).toString("base64url"))).code).toBe("invalid-request");
    expect(refusal(() => validateBoxPublicKey("A".repeat(300))).code).toBe("invalid-request");
  });

  test("jsonBody serialises once; re-serialising with other whitespace changes the authority digest", () => {
    const a = vectors.authority.find((x) => x.label === "expression-put")!;
    const value = { register: "Plain.", wake_text: "A test wake text." };
    const once = jsonBody(value);
    expect(text(once)).toBe(a.body_utf8);
    const base = { did: a.identity_did, method: a.method, target: a.request_target, sequence: a.sequence, timestamp: a.timestamp };
    expect(toHex(authorityDigest({ ...base, body: once }))).toBe(a.digest_hex);
    const reformatted = utf8(JSON.stringify(value, null, 1));
    expect(toHex(authorityDigest({ ...base, body: reformatted }))).not.toBe(a.digest_hex);
    expect(() => jsonBody({ n: Number.NaN })).toThrow(Refusal);
    expect(() => jsonBody(undefined)).toThrow(Refusal);
  });

  test("authorityDigest refuses what the server would sign differently or refuse", () => {
    const a = vectors.authority[0]!;
    const base = { did: a.identity_did, method: a.method, target: a.request_target, body: utf8(a.body_utf8), sequence: a.sequence, timestamp: a.timestamp };
    const no = (patch: Partial<typeof base>) => refusal(() => authorityDigest({ ...base, ...patch }));
    expect(no({ method: "DELETE" }).message).toContain("DELETE");
    expect(no({ method: "post" }).code).toBe("invalid-request");
    expect(no({ target: "/v1/identities/x/../keys" }).message).toContain("target");
    expect(no({ target: `${a.request_target}?` }).message).toContain("target");
    expect(no({ target: "v1/identities" }).message).toContain("target");
    expect(no({ target: "//evil.example/v1" }).message).toContain("target");
    expect(no({ sequence: 0 }).message).toContain("sequence");
    expect(no({ sequence: 1.5 }).message).toContain("sequence");
    expect(no({ timestamp: "yesterday" }).message).toContain("timestamp");
    expect(no({ did: `did:at:${MIXED_UUID.toUpperCase()}` }).message).toContain("did");
    expect(() => authorityHeaders(1, a.timestamp, new Uint8Array(63))).toThrow(Refusal);
    expect(() => thoughtDigestV2(MIXED_UUID.toUpperCase(), new Uint8Array(1), new Uint8Array(12), "x")).toThrow(Refusal);
    expect(() => thoughtDigestV2(MIXED_UUID, new Uint8Array(1), new Uint8Array(12), "x")).not.toThrow();
    expect(fromB64url(vectors.enrollment[0]!.header_X_Agenttool_Enrollment_Signature, 64)).toHaveLength(64);
  });
});
