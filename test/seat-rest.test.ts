// Owner: seat group. S4 item 6: a rest writes nothing in the citizen's
// voice. Compare TempHost.snapshot() before and after; only host.jsonl and
// status.json may change, and neither may contain any of the model's words.
import { describe, test } from "bun:test";

describe("[S4-6] rest", () => {
  test.todo("[S4-6] REST_OUTPUT: exit 0, outcome rest, no ledger entry, no proposal, no outbox file, no receipt");
  test.todo("[S4-6] REST_THEN_TALK_OUTPUT: same, and REST-LEAK-CANARY appears in no file under the state dir");
  test.todo("[S4-6] an empty acts list is a rest");
  test.todo("[S4-6] a surfaced letter is not marked seen by a rest, so it is shown again next beat");
  test.todo("[S4-6] a rest makes no signer.send call (no thought, no expression PUT) and no mirror stage");
  test.todo("an unparsable reply is outcome invalid-output, not rest, and also writes nothing in the citizen's voice");
});
