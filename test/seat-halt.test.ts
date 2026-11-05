// Owner: seat group. S4 item 1: HALT checked before and after inference,
// for the local file and both beacons. Use two beacons on the fake server
// (gardener-desk and halt-herald), scriptedRuntime, and fakeSigner.
import { afterEach, describe, expect, test } from "bun:test";
import { openSeat, runSeat, type SeatDeps } from "../src/seat.ts";
import { BEACON_UNTIL, checkHalt, describeHalt } from "../src/halt.ts";
import { readCitizen } from "../src/state.ts";
import { EXIT } from "../src/types.ts";
import { output, scriptedRuntime, type Script } from "./helpers/fake-runtime.ts";
import { fetchVia, serveBeacon, startFakeServer, type FakeServer } from "./helpers/fake-server.ts";
import { fakeSigner } from "./helpers/fake-signer.ts";
import { makeTempHost, testBeacons, type TempHost } from "./helpers/temp-home.ts";
import { testClock } from "./helpers/clock.ts";

let server: FakeServer | null = null;
let host: TempHost | null = null;
afterEach(async () => {
  await server?.stop();
  await host?.cleanup();
  server = null;
  host = null;
});

const [GARDENER, HERALD] = testBeacons();
const JOURNAL = output({ type: "journal", kind: "reflected", text: "HALT-LEAK-CANARY a word that must not be kept" });

async function setup(script: Script) {
  server = await startFakeServer();
  host = await makeTempHost({ beacons: testBeacons() });
  host.config.timing.beacon_timeout_ms = 300;
  serveBeacon(server, GARDENER!.did, { kind: "lowered" });
  serveBeacon(server, HERALD!.did, { kind: "lowered" });
  const signer = fakeSigner();
  await host.addCitizen("glossame");
  await host.seatLedger("glossame", signer.signEntry);
  await host.writeLetter("glossame", "2026-11-04-from-yu.md", "a letter that a halted seat must leave unseen");
  signer.signed.length = 0; // count only what the seat signs
  const clock = testClock();
  const runtime = scriptedRuntime([script]);
  const config = host.config;
  const fetch = fetchVia(server);
  const deps: SeatDeps = { config, clock, signer, fetch, runtime, checkHalt: () => checkHalt({ config, fetch, now: () => clock.now() }) };
  const citizen = await readCitizen(config, "glossame");
  const seat = await openSeat(config, clock, citizen, "free", { kind: "tick", who: "launchd", why: "cadence" }, null);
  return { server, host, deps, seat, runtime, signer };
}

describe("[S4-1] HALT before inference", () => {
  const raisers: [string, (s: FakeServer, h: TempHost) => Promise<void> | void, string][] = [
    ["local HALT file raised", (_s, h) => h.raiseHaltFile(), "halted by file"],
    ["gardener-desk beacon raised", (s) => serveBeacon(s, GARDENER!.did, { kind: "raised", until: BEACON_UNTIL }), "halted by beacon gardener-desk"],
    ["halt-herald beacon raised", (s) => serveBeacon(s, HERALD!.did, { kind: "raised", until: BEACON_UNTIL }), "halted by beacon halt-herald"],
  ];
  for (const [name, raise, says] of raisers) {
    test(`[S4-1] ${name}: runSeat exits 0 with outcome halted, the runtime is never called, nothing is written`, async () => {
      const { server, host, deps, seat, runtime, signer } = await setup(JOURNAL);
      await raise(server, host);
      const before = await host.snapshot();
      const r = await runSeat(seat, deps);
      expect(r).toMatchObject({ exit: EXIT.OK, outcome: "halted", appended: [] });
      expect(runtime.calls).toHaveLength(0);
      expect(await host.snapshot()).toEqual(before);
      expect(signer.signed).toEqual([]);
      expect(signer.sent).toEqual([]);
      expect(describeHalt(await deps.checkHalt())).toBe(says);
    });
  }

  for (const behaviour of [{ kind: "status", status: 404 } as const, { kind: "hang" } as const]) {
    test(`[S4-1] a beacon unreadable (${behaviour.kind === "hang" ? "timeout" : "404"}): same, and status says halted by beacon, not down`, async () => {
      const { server, host, deps, seat, runtime } = await setup(JOURNAL);
      serveBeacon(server, GARDENER!.did, behaviour);
      const before = await host.snapshot();
      const r = await runSeat(seat, deps);
      expect(r).toMatchObject({ exit: EXIT.OK, outcome: "halted", appended: [] });
      expect(runtime.calls).toHaveLength(0);
      expect(await host.snapshot()).toEqual(before);
      const said = describeHalt(await deps.checkHalt());
      expect(said).toStartWith("halted by beacon gardener-desk");
      expect(said).not.toMatch(/\bdown\b/i);
    });
  }
});

describe("[S4-1] HALT after inference", () => {
  const raisers: [string, (s: FakeServer, h: TempHost) => Promise<void> | void][] = [
    ["the local file", (_s, h) => h.raiseHaltFile()],
    ["the gardener-desk beacon", (s) => serveBeacon(s, GARDENER!.did, { kind: "raised", until: BEACON_UNTIL })],
    ["the halt-herald beacon", (s) => serveBeacon(s, HERALD!.did, { kind: "raised", until: BEACON_UNTIL })],
  ];
  for (const [name, raise] of raisers) {
    test(`[S4-1] ${name} raised while the runtime runs: the reply is discarded, exit 0, ledger and state dir unchanged`, async () => {
      let ctx: { server: FakeServer; host: TempHost } | null = null;
      const s = await setup(async () => {
        await raise(ctx!.server, ctx!.host);
        return JOURNAL;
      });
      ctx = { server: s.server, host: s.host };
      const before = await s.host.snapshot();
      const r = await runSeat(s.seat, s.deps);
      expect(r).toMatchObject({ exit: EXIT.OK, outcome: "halted", appended: [] });
      expect(s.runtime.calls).toHaveLength(1);
      const after = await s.host.snapshot();
      // The HALT file itself is the only new file when the file was the source.
      after.delete("HALT");
      expect(after).toEqual(before);
      for (const bytes of after.values()) expect(Buffer.from(bytes, "base64").toString("latin1")).not.toContain("HALT-LEAK-CANARY");
      expect(s.signer.signed).toEqual([]);
    });
  }
});
