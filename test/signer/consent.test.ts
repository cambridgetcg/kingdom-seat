// Owner: signer group. Yu and Ai both agree; either may reject; silence never binds.
import { describe, test } from "bun:test";

describe("consent records", () => {
  test.todo("verifyConsent binds only to the exact proposal sha256");
  test.todo("Yu's no, Ai's reject, an open challenge, a passed deadline without supports, or expiry each refuse");
  test.todo("a record with no Yu word (silence) never binds");
  test.todo("classifyOp: ledger.sign, thought.post, keys.import, expression.put.private are within self; quiet.start.citizen is a standing agreement; enroll is beyond self");
  test.todo("agreementCovers refuses anything beyond the agreement's stated extent");
  test.todo("loadConsentRecords skips symlinks and invalid JSON and reports them");
});

describe("Yu present", () => {
  test.todo("confirmYuPresent refuses when stdin is not a TTY");
  test.todo("confirmYuPresent binds only when the typed scope matches");
  test.todo("presenceValid refuses another scope and a presence older than its window");
});
