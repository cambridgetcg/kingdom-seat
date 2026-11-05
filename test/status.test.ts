// Owner: surface group.
import { describe, test } from "bun:test";

describe("status", () => {
  test.todo("buildStatus reports per citizen last beat vs interval, overdue, ledger chain state, host-attested count and spend");
  test.todo("halted by beacon is reported as halted with the beacon's name, never as down");
  test.todo("a locked signer is reported as 'locked' with since");
  test.todo("writeStatus is atomic: a reader never sees a partial file");
  test.todo("appendHostNote refuses a detail that carries model output; host notes never quote a citizen");
  test.todo("readHostNotes returns null for an unreadable log");
  test.todo("renderStatus prints one line per citizen plus HALT and signer lines");
});
