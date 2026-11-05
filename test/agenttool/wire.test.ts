// Owner: agenttool group. Every byte must equal docs/research/vectors.json.
import { describe, test } from "bun:test";

describe("vectors.json, byte for byte", () => {
  test.todo("deriveIdentity(abandon … about) gives every derivation value, root, box and K_master");
  test.todo("enrollmentBodyBytes reproduces both enrollment[*].body_utf8 exactly, field order included");
  test.todo("enrollmentDigest and enrollmentSignatureHeader reproduce both enrollment vectors");
  test.todo("registrationProofDigest reproduces registration_proof_digest_hex");
  test.todo("authorityDigest and authorityHeaders reproduce all six authority vectors");
  test.todo("thoughtDigestV2 reproduces canonical_v2_hex; encryptThought with the fixed nonce reproduces the ciphertext");
});

describe("local validation before a sequence is spent", () => {
  test.todo("enrollment refuses a non-HTTPS origin, a non-lowercase UUID, an empty or overlong display_name, and a body over 16,384 bytes");
  test.todo("validateExpression enforces register ≤500, walls ≤32×256, wake_text ≤32,000 UTF-16 units, village and porch limits, unknown fields");
  test.todo("validateBoxPublicKey refuses anything that is not 32 bytes");
  test.todo("jsonBody serialises once; re-serialising with other whitespace changes the authority digest");
});
