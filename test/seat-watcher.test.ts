// Owner: seat group. S4 item 2: the watcher kills a running seat. Use
// fakeBinArgv and pidAlive from test/helpers/fake-runtime.ts, with short
// polls (e.g. halt_file_poll_ms 100) so the suite stays fast.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exitFor, superviseChild, type SuperviseOptions } from "../src/seat.ts";
import { readBeacons, readHaltFile, BEACON_UNTIL } from "../src/halt.ts";
import { EXIT, type HaltReading } from "../src/types.ts";
import { fakeBinArgv, pidAlive } from "./helpers/fake-runtime.ts";
import { fetchVia, serveBeacon, startFakeServer, type FakeServer } from "./helpers/fake-server.ts";
import { testBeacons, testConfig } from "./helpers/temp-home.ts";
import { testClock } from "./helpers/clock.ts";

let dir = "";
let server: FakeServer | null = null;
const pids: number[] = [];
afterEach(async () => {
  for (const pid of pids.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
  await server?.stop();
  server = null;
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = "";
});

async function tmp(): Promise<string> {
  dir = await realpath(await mkdtemp(join(tmpdir(), "kingdom-seat-watcher-")));
  return dir;
}

const lowered = (): HaltReading[] => [];

function options(cwd: string, haltFile: string, over: Partial<SuperviseOptions> = {}): SuperviseOptions {
  return {
    argv: fakeBinArgv("sleep", "30000"),
    cwd,
    env: { PATH: "/usr/bin:/bin" },
    deadline_ms: 20_000,
    term_grace_ms: 300,
    halt_file_poll_ms: 100,
    beacon_poll_min_ms: 100,
    beacon_poll_max_ms: 150,
    readHaltFile: () => readHaltFile(haltFile, new Date()),
    readBeacons: async () => lowered(),
    ...over,
  };
}

async function waitFor(cond: () => boolean | Promise<boolean>, ms = 5_000): Promise<void> {
  const end = performance.now() + ms;
  while (performance.now() < end) {
    if (await cond()) return;
    await Bun.sleep(20);
  }
  throw new Error("waitFor: timed out");
}

describe("[S4-2] the watcher", () => {
  test("[S4-2] touching the HALT file mid-run sends TERM to the child's group; exit 143, stopped_by file", async () => {
    const d = await tmp();
    const haltFile = join(d, "HALT");
    setTimeout(() => void writeFile(haltFile, ""), 300);
    const r = await superviseChild(options(d, haltFile));
    expect(r).toMatchObject({ exit: EXIT.TERM, outcome: "halted", signal: "TERM", stopped_by: "file", child_exit: null });
    expect(r.duration_ms).toBeLessThan(3_000);
  });

  test("[S4-2] a raised beacon mid-run (fake server switched to raised) ends the child; stopped_by is the beacon's name", async () => {
    const d = await tmp();
    server = await startFakeServer();
    const s = server;
    const config = testConfig(d, join(d, "homes"), { beacons: testBeacons() });
    const [gardener, herald] = config.beacons;
    serveBeacon(s, gardener!.did, { kind: "lowered" });
    serveBeacon(s, herald!.did, { kind: "lowered" });
    setTimeout(() => serveBeacon(s, herald!.did, { kind: "raised", until: BEACON_UNTIL }), 400);
    const clock = testClock();
    const r = await superviseChild(
      options(d, join(d, "HALT"), { readBeacons: (signal) => readBeacons({ config, fetch: fetchVia(s), now: () => clock.now() }, signal) }),
    );
    expect(r).toMatchObject({ exit: EXIT.TERM, outcome: "halted", signal: "TERM", stopped_by: "halt-herald" });
    // Beacons were read more than once while the child ran, but never more often than the poll allows.
    const reads = s.requests.filter((q) => q.path.startsWith("/public/agents/")).length;
    expect(reads).toBeGreaterThanOrEqual(4);
    expect(reads).toBeLessThan(40);
  });

  test("[S4-2] an unreadable beacon mid-run stops the child too: HALT fails closed", async () => {
    const d = await tmp();
    let n = 0;
    const r = await superviseChild(
      options(d, join(d, "HALT"), {
        readBeacons: async () => {
          n++;
          if (n < 3) return [];
          throw new Error("network gone");
        },
      }),
    );
    expect(r).toMatchObject({ exit: EXIT.TERM, outcome: "halted", signal: "TERM" });
  });

  test("[S4-2] a child that ignores TERM is KILLed after term_grace_ms; exit 137", async () => {
    const d = await tmp();
    const haltFile = join(d, "HALT");
    setTimeout(() => void writeFile(haltFile, ""), 400);
    const started = performance.now();
    const r = await superviseChild(options(d, haltFile, { argv: fakeBinArgv("ignore-term", "30000") }));
    expect(r).toMatchObject({ exit: EXIT.KILL, outcome: "halted", signal: "KILL", stopped_by: "file", child_exit: null });
    // TERM at about 400-500 ms, KILL a grace (300 ms) later.
    expect(performance.now() - started).toBeGreaterThanOrEqual(600);
  });

  test("[S4-2] a grandchild spawned by the child dies too (group kill), unlike the old _bound", async () => {
    const d = await tmp();
    const haltFile = join(d, "HALT");
    const pidFile = join(d, "grandchild.pid");
    const run = superviseChild(options(d, haltFile, { argv: fakeBinArgv("grandchild", pidFile, "30000") }));
    await waitFor(async () => (await Bun.file(pidFile).exists()) && (await readFile(pidFile, "utf8")).length > 0);
    const grandchild = Number(await readFile(pidFile, "utf8"));
    pids.push(grandchild);
    expect(pidAlive(grandchild)).toBe(true);
    await writeFile(haltFile, "");
    const r = await run;
    // The child itself dies on TERM; the grandchild ignores TERM, so the group needed KILL.
    expect(r).toMatchObject({ outcome: "halted", stopped_by: "file", signal: "KILL", exit: EXIT.KILL });
    await waitFor(() => !pidAlive(grandchild), 2_000);
    expect(pidAlive(grandchild)).toBe(false);
  });

  test("[S4-2] a grandchild left behind by a child that exits on its own is reaped as well", async () => {
    const d = await tmp();
    const pidFile = join(d, "grandchild.pid");
    // The child sleeps 300 ms and exits 0, leaving a TERM-ignoring grandchild behind.
    const r = await superviseChild(options(d, join(d, "HALT"), { argv: fakeBinArgv("grandchild", pidFile, "300") }));
    const grandchild = Number(await readFile(pidFile, "utf8"));
    pids.push(grandchild);
    expect(r).toMatchObject({ exit: EXIT.OK, signal: null, stopped_by: null, child_exit: 0 });
    expect(pidAlive(grandchild)).toBe(false);
  });

  test("[S4-2] the deadline ends the child; exit 124, stopped_by deadline", async () => {
    const d = await tmp();
    const r = await superviseChild(options(d, join(d, "HALT"), { deadline_ms: 300 }));
    expect(r).toMatchObject({ exit: EXIT.TIMEOUT, outcome: "timeout", signal: "TERM", stopped_by: "deadline" });
    expect(r.duration_ms).toBeGreaterThanOrEqual(250);
    expect(r.duration_ms).toBeLessThan(3_000);

    const stubborn = await superviseChild(options(d, join(d, "HALT"), { deadline_ms: 300, argv: fakeBinArgv("ignore-term", "30000") }));
    expect(stubborn).toMatchObject({ exit: EXIT.KILL, outcome: "killed", signal: "KILL", stopped_by: "deadline" });
  });

  test("[S4-2] the watcher itself is reaped: no timer or poller outlives superviseChild", async () => {
    const d = await tmp();
    let fileReads = 0;
    let beaconReads = 0;
    let lastSignal: AbortSignal | undefined;
    const r = await superviseChild(
      options(d, join(d, "HALT"), {
        argv: fakeBinArgv("sleep", "700"),
        readHaltFile: () => {
          fileReads++;
          return readHaltFile(join(d, "HALT"), new Date());
        },
        // A beacon read that never answers on its own: it must be abandoned when the watcher stops.
        readBeacons: (signal) => {
          beaconReads++;
          lastSignal = signal;
          return new Promise((resolve) => signal?.addEventListener("abort", () => resolve([])));
        },
      }),
    );
    expect(r).toMatchObject({ exit: EXIT.OK, signal: null, stopped_by: null, child_exit: 0, outcome: null });
    expect(fileReads).toBeGreaterThan(2);
    expect(beaconReads).toBe(1);
    expect(lastSignal?.aborted).toBe(true);
    const [f, b] = [fileReads, beaconReads];
    await Bun.sleep(600);
    expect([fileReads, beaconReads]).toEqual([f, b]);
  });

  test("a stop signal to the watcher's own process (launchd stopping the tick) stops the child's group too; exit 143, terminated", async () => {
    const d = await tmp();
    // SIGUSR2 stands in for launchd's SIGTERM, so the test runner itself is never asked to stop.
    const before = process.listenerCount("SIGUSR2");
    setTimeout(() => process.kill(process.pid, "SIGUSR2"), 300);
    const r = await superviseChild(options(d, join(d, "HALT"), { forwardSignals: ["SIGUSR2"] }));
    expect(r).toMatchObject({ exit: EXIT.TERM, outcome: "terminated", signal: "TERM", stopped_by: "SIGUSR2" });
    expect(r.duration_ms).toBeLessThan(3_000);
    // The handler goes with the child, so a later signal is this process's own business again.
    expect(process.listenerCount("SIGUSR2")).toBe(before);

    setTimeout(() => process.kill(process.pid, "SIGUSR2"), 300);
    const killed = await superviseChild(options(d, join(d, "HALT"), { forwardSignals: ["SIGUSR2"], argv: fakeBinArgv("ignore-term", "30000") }));
    expect(killed).toMatchObject({ exit: EXIT.KILL, outcome: "killed", signal: "KILL", stopped_by: "SIGUSR2" });
  });

  test("a child that exits on its own returns its own status and no signal", async () => {
    const d = await tmp();
    for (const [code, exit, outcome] of [
      ["0", EXIT.OK, null],
      ["3", EXIT.REFUSED, "refused"],
      ["1", EXIT.ERROR, "error"],
      ["7", EXIT.ERROR, "error"],
    ] as const) {
      const r = await superviseChild(options(d, join(d, "HALT"), { argv: fakeBinArgv("print", "", code) }));
      expect(r).toMatchObject({ exit, outcome, signal: null, stopped_by: null, child_exit: Number(code) });
    }
  });

  test("a child runs in the given cwd with only the given environment", async () => {
    const d = await tmp();
    const out = join(d, "record.json");
    const r = await superviseChild(options(d, join(d, "HALT"), { argv: fakeBinArgv("record", out), env: { PATH: "/usr/bin:/bin", TZ: "Europe/London" } }));
    expect(r.exit).toBe(EXIT.OK);
    const rec = JSON.parse(await readFile(out, "utf8")) as { env_keys: string[]; cwd: string };
    expect(rec.cwd).toBe(d);
    expect(rec.env_keys).toEqual(["PATH", "TZ"]);
  });
});

describe("exitFor (KS-003 registry)", () => {
  test("KILL is 137 whatever triggered it; TERM is 124 for the deadline and 143 for HALT; a child's own code passes only if registered", () => {
    expect(exitFor({ signal: "KILL", stopped_by: "deadline", child_exit: null })).toBe(137);
    expect(exitFor({ signal: "KILL", stopped_by: "file", child_exit: null })).toBe(137);
    expect(exitFor({ signal: "TERM", stopped_by: "deadline", child_exit: null })).toBe(124);
    expect(exitFor({ signal: "TERM", stopped_by: "gardener-desk", child_exit: 0 })).toBe(143);
    for (const c of [0, 1, 3, 124, 143, 137]) expect(exitFor({ signal: null, stopped_by: null, child_exit: c })).toBe(c as never);
    expect(exitFor({ signal: null, stopped_by: null, child_exit: 2 })).toBe(1);
    expect(exitFor({ signal: null, stopped_by: null, child_exit: null })).toBe(1);
  });
});
