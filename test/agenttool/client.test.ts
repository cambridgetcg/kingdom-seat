// Owner: agenttool group. fakeSigner records sends; fetchVia for public reads.
import { describe, test } from "bun:test";

describe("requests through the signer", () => {
  test.todo("every per-identity route carries ?identity_id=<citizen uuid> in the signed target");
  test.todo("importOpKey, registerBoxKey, putExpression and quiet routes use the right SignerOp, method, target and exact body");
  test.todo("[S4-5] startCitizenQuiet always sends an explicit until, never hours, and an empty reason");
  test.todo("endCitizenQuiet and revokeKey send an empty body with DELETE");
  test.todo("createStrand binds identity_id; postThought uses signer.sealThought and the strand id in lowercase");
  test.todo("a 409 authority_sequence_conflict re-reads next_sequence once and never sends two root requests at once");
  test.todo("errors become AgenttoolError with status and code, and carry no secret");
});

describe("public reads", () => {
  test.todo("readPublicAgent parses the active shape, the memorial shape (no quiet fields) and 404");
});
