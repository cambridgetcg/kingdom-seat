// Owner: seat group. S4 item 2: the watcher kills a running seat. Use
// fakeBinArgv and pidAlive from test/helpers/fake-runtime.ts, with short
// polls (e.g. halt_file_poll_ms 100) so the suite stays fast.
import { describe, test } from "bun:test";

describe("[S4-2] the watcher", () => {
  test.todo("[S4-2] touching the HALT file mid-run sends TERM to the child's group; exit 143, stopped_by file");
  test.todo("[S4-2] a raised beacon mid-run (fake server switched to raised) ends the child; stopped_by is the beacon's name");
  test.todo("[S4-2] a child that ignores TERM is KILLed after term_grace_ms; exit 137");
  test.todo("[S4-2] a grandchild spawned by the child dies too (group kill), unlike the old _bound");
  test.todo("[S4-2] the deadline ends the child; exit 124, stopped_by deadline");
  test.todo("[S4-2] the watcher itself is reaped: no timer or poller outlives superviseChild");
  test.todo("a child that exits on its own returns its own status and no signal");
});
