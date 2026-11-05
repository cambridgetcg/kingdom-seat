// Owner: agenttool group.
import { describe, test } from "bun:test";

describe("enrollment", () => {
  test.todo("citizenCapabilities is ['kingdom-citizen', <lineage>] for canon and archetype origins");
  test.todo("prepareEnrollment uses the word as display_name, fresh lowercase UUIDs, a 32-byte base64url nonce and toISOString");
  test.todo("enroll sends the prepared body bytes unchanged with the signature header, through the signer as op enroll");
  test.todo("enroll refuses without Yu present or without a verifying consent record");
  test.todo("an ambiguous result (network error, 5xx) is never retried; resolveAmbiguous reads instead");
  test.todo("parseEnrollResponse refuses a 201 whose identity id, root key or sequence differs from what was sent");
});
