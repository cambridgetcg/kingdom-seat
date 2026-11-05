// Owner: voice group. Letters and souls are read only as regular files.
import { describe, test } from "bun:test";

describe("[S4-3] regular files only", () => {
  test.todo("[S4-3] a symlinked letter is never read: its target's OUTSIDE-SECRET-CANARY reaches no context");
  test.todo("[S4-3] a symlinked soul refuses the seat (not-regular-file) instead of following it");
  test.todo("[S4-3] a dangling symlink in letters/ is not counted as mail by hasAllowedLetter");
  test.todo("readRegularText refuses directories, FIFOs and files over the limit");
});

describe("what the citizen is shown", () => {
  test.todo("the whole soul, past 2,600 characters, including SHADOW-MARKER");
  test.todo("at most one letter, the oldest unseen from an allowed sender; a letter with no From line is not allowed");
  test.todo("describeNow gives local time, zone and part of day, e.g. 02:05 GMT night");
  test.todo("the last k ledger entries, the state, pending proposals, canon path@commit and the invoker");
  test.todo("readCanon refuses a snapshot whose sha256 does not match origin.sha256");
  test.todo("nothing from the home directory (HOME-CLAUDE-MD-CANARY, HOOK-CANARY) ever appears");
});
