// Owner: signer group. The signer is the only Keychain reader; it never lets
// a key or bearer reach argv, env, files, logs or a response.
import { describe, test } from "bun:test";

describe("signing", () => {
  test.todo("signEntry signs citizen-signed entries with the op key and host-attested ones with the host key, never the root");
  test.todo("verifyEntrySignature is strict (RFC 8032) and false for a signature by the root kid");
  test.todo("a locked keychain makes signEntry refuse with keychain-locked and state() report locked");
  test.todo("seeds are wiped after use (the buffer read from the fake keychain is zeroed)");
});

describe("send: ceilings, consent and the quiet cap before any request", () => {
  test.todo("[S4-4] send refuses a paid op when spendSoFar is unknown, and sends nothing");
  test.todo("[S4-4] send refuses a thought.post or strand.create past the monthly credit ceiling, before the request (charge precedes verification)");
  test.todo("[S4-5] send refuses quiet.start.citizen whose body until is more than 30 days ahead, or uses hours instead of until, or carries a reason");
  test.todo("[S4-5] send allows quiet.start.beacon with the far-future until only for an operator identity, never for a citizen");
  test.todo("send refuses a beyond-self op without a verifying consent record, and enroll without Yu present");
  test.todo("send attaches the bearer and authority headers that match vectors.json authority[*] for the same inputs");
  test.todo("send reads next_sequence and keeps one root-authorised request in flight per identity");
});

describe("secrets never leave", () => {
  test.todo("no fake-keychain secret appears in any request URL, header other than Authorization, body, error message or log line");
  test.todo("publicKeys returns public keys only");
});
