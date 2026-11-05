// Owner: seat group. S4 item 1: HALT checked before and after inference,
// for the local file and both beacons. Use two beacons on the fake server
// (gardener-desk and halt-herald), scriptedRuntime, and fakeSigner.
import { describe, test } from "bun:test";

describe("[S4-1] HALT before inference", () => {
  test.todo("[S4-1] local HALT file raised: runSeat exits 0 with outcome halted, the runtime is never called, nothing is written");
  test.todo("[S4-1] gardener-desk beacon raised: same");
  test.todo("[S4-1] halt-herald beacon raised: same");
  test.todo("[S4-1] a beacon unreadable (404 or timeout): same, and status says halted by beacon, not down");
});

describe("[S4-1] HALT after inference", () => {
  test.todo("[S4-1] the local file raised while the runtime runs: the reply is discarded, exit 0, ledger and state dir unchanged");
  test.todo("[S4-1] the gardener-desk beacon raised while the runtime runs: same");
  test.todo("[S4-1] the halt-herald beacon raised while the runtime runs: same");
});
