// Owner: surface group.
import { describe, test } from "bun:test";

describe("parseArgs", () => {
  test.todo("parses tick, seat <word>, halt, status [--json] and verify <word> with --config");
  test.todo("refuses unknown verbs and flags, a missing word, and a word outside WORD_PATTERN");
  test.todo("there is no verb that lowers HALT");
  test.todo("seat --runtime summon without --yu-present is refused before anything runs");
});

describe("main", () => {
  test.todo("exit codes follow EXIT: HALT and rest 0, refusal 3, error 1");
  test.todo("verify <word> checks the chain offline and exits 1 on a broken chain");
  test.todo("stdout and stderr never contain a fake-keychain secret");
});
