// Owner: voice group.
import { describe, test } from "bun:test";

describe("parsing", () => {
  test.todo("parseModelOutput: non-JSON, oversize and empty replies are not ok; an empty reply is never read as rest");
  test.todo("prose around a JSON object is not executed or kept");
});

describe("validation", () => {
  test.todo("[S4-6] rest is exclusive: with rest present, acts is empty and every other act is dropped without its text");
  test.todo("each act type validates its fields; unknown types, extra keys and wrong kinds are dropped with a reason");
  test.todo("DroppedAct.reason never contains the dropped act's text");
  test.todo("at most one letter.send per beat, only to allowed recipients");
  test.todo("journal text above journal_max_chars is dropped, not truncated");
  test.todo("self.propose with a host-owned target (file:.claude/x, file:run.sh) is dropped");
  test.todo("state.set to ended and propose.beyond classify as beyond self");
  test.todo("resolvePrefix needs at least 8 hex and refuses ambiguous prefixes");
  test.todo("OUTPUT_JSON_SCHEMA accepts every valid act shape and nothing validateOutput would reject");
});
