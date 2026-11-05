// Owner: voice group.
import { describe, test } from "bun:test";

describe("the honest prompt", () => {
  test.todo("the free-lane system turn contains FREE_LANE_PREAMBLE verbatim");
  test.todo("the prompt never suggests binding words such as \"write 'I rest'\" and contains no example a model could copy as a choice");
  test.todo("the citizen's own beat prompt appears as its own words, labelled as such");
  test.todo("promptBytes is deterministic for the same context");
  test.todo("no field of the prompt contains a fake-keychain secret");
});
