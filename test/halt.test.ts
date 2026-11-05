// Owner: seat group. Beacon readings against test/helpers/fake-server.ts.
import { describe, test } from "bun:test";

describe("HALT readings fail closed", () => {
  test.todo("readHaltFile: absent is lowered; a file, a directory or a dangling symlink at the path is raised; a stat error is unreadable");
  test.todo("readBeacon: a future quiet_until is raised; null is lowered");
  test.todo("readBeacon: 404, 500, memorial, garbage JSON and a hang past beacon_timeout_ms are each unreadable");
  test.todo("checkHalt is halted when either of two beacons is raised or unreadable");
  test.todo("checkHalt is halted with no beacons pinned unless allow_no_beacons is true");
  test.todo("readBeacon calls exactly GET /public/agents/<did> on the pinned origin and sends no credential");
});

describe("raising", () => {
  test.todo("raiseHalt writes the local file first, even when every beacon raise fails");
  test.todo("raiseHalt raises only beacons this host can sign, via signer op quiet.start.beacon with BEACON_UNTIL and an empty reason");
  test.todo("there is no exported function that lowers HALT");
  test.todo("describeHalt says 'halted by beacon <name>' or 'halted by file', never 'down'");
});
