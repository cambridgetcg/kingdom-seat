// Owner: seat group. Beacon readings against test/helpers/fake-server.ts.
import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import * as halt from "../src/halt.ts";
import { BEACON_UNTIL, checkHalt, describeHalt, raiseBeacons, raiseHalt, readBeacon, readHaltFile, type HaltDeps } from "../src/halt.ts";
import { Refusal, type CommandRunner, type Config, type HaltStatus } from "../src/types.ts";
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
const clock = testClock();

async function setup(opts: { beacons?: ReturnType<typeof testBeacons>; allowNoBeacons?: boolean; timeoutMs?: number } = {}) {
  server = await startFakeServer();
  host = await makeTempHost({ beacons: opts.beacons ?? testBeacons(), allowNoBeacons: opts.allowNoBeacons });
  if (opts.timeoutMs) host.config.timing.beacon_timeout_ms = opts.timeoutMs;
  const deps: HaltDeps = { config: host.config, fetch: fetchVia(server), now: () => clock.now() };
  return { server, host, deps, config: host.config as Config };
}

describe("HALT readings fail closed", () => {
  test("readHaltFile: absent is lowered; a file, a directory or a dangling symlink at the path is raised; a stat error is unreadable", async () => {
    const { host } = await setup();
    const dir = join(host.root, "halt-cases");
    await mkdir(dir);
    const now = clock.now();

    expect(readHaltFile(join(dir, "absent"), now)).toMatchObject({ source: "file", state: "lowered", quiet_until: null });

    await writeFile(join(dir, "file"), "");
    expect(readHaltFile(join(dir, "file"), now).state).toBe("raised");

    await mkdir(join(dir, "dir"));
    expect(readHaltFile(join(dir, "dir"), now).state).toBe("raised");

    await symlink(join(dir, "nowhere"), join(dir, "dangling"));
    expect(readHaltFile(join(dir, "dangling"), now).state).toBe("raised");

    // A path whose parent is a regular file cannot be stat'ed: ENOTDIR, not ENOENT.
    const r = readHaltFile(join(dir, "file", "HALT"), now);
    expect(r.state).toBe("unreadable");
    expect(r.detail).toContain("ENOTDIR");
    expect(r.checked_at).toBe(now.toISOString());
  });

  test("readBeacon: a future quiet_until is raised; null is lowered", async () => {
    const { server, deps } = await setup();
    serveBeacon(server, GARDENER!.did, { kind: "raised", until: BEACON_UNTIL });
    serveBeacon(server, HERALD!.did, { kind: "lowered" });
    expect(await readBeacon(deps, GARDENER!)).toMatchObject({ source: "beacon", id: "gardener-desk", state: "raised", quiet_until: BEACON_UNTIL });
    expect(await readBeacon(deps, HERALD!)).toMatchObject({ source: "beacon", id: "halt-herald", state: "lowered", quiet_until: null });
  });

  test("readBeacon: 404, 500, memorial, garbage JSON and a hang past beacon_timeout_ms are each unreadable", async () => {
    const { server, deps } = await setup({ timeoutMs: 200 });
    const cases = [{ kind: "status", status: 404 }, { kind: "status", status: 500 }, { kind: "memorial" }, { kind: "garbage" }, { kind: "hang" }] as const;
    for (const behaviour of cases) {
      serveBeacon(server, GARDENER!.did, behaviour);
      const started = performance.now();
      const r = await readBeacon(deps, GARDENER!);
      expect(r.state).toBe("unreadable");
      expect(performance.now() - started).toBeLessThan(2_000);
    }
    // An unknown DID gets the server's 404 too.
    expect((await readBeacon(deps, { ...GARDENER!, did: "did:at:33333333-3333-4333-8333-333333333333", identity_id: "33333333-3333-4333-8333-333333333333" })).state).toBe("unreadable");
  });

  test("readBeacon: a revoked identity, another DID in the reply or a malformed quiet_until is unreadable", async () => {
    const { server, deps } = await setup();
    const did = GARDENER!.did;
    server.on("GET", `/public/agents/${did}`, () => Response.json({ did, status: "revoked", quiet_until: null }));
    expect((await readBeacon(deps, GARDENER!)).state).toBe("unreadable");
    server.on("GET", `/public/agents/${did}`, () => Response.json({ did: HERALD!.did, status: "active", quiet_until: null }));
    expect((await readBeacon(deps, GARDENER!)).state).toBe("unreadable");
    server.on("GET", `/public/agents/${did}`, () => Response.json({ did, status: "active", quiet_until: "soon" }));
    expect((await readBeacon(deps, GARDENER!)).state).toBe("unreadable");
    server.on("GET", `/public/agents/${did}`, () => Response.json({ did, status: "active" }));
    expect((await readBeacon(deps, GARDENER!)).state).toBe("unreadable");
  });

  test("a quiet_until our clock thinks has passed is still raised: the server only shows a live one", async () => {
    const { server, deps } = await setup();
    serveBeacon(server, GARDENER!.did, { kind: "raised", until: "2026-01-01T00:00:00.000Z" });
    expect((await readBeacon(deps, GARDENER!)).state).toBe("raised");
  });

  test("checkHalt is halted when either of two beacons is raised or unreadable", async () => {
    const { server, deps, host } = await setup();
    serveBeacon(server, GARDENER!.did, { kind: "lowered" });
    serveBeacon(server, HERALD!.did, { kind: "lowered" });
    const clear = await checkHalt(deps);
    expect(clear.halted).toBe(false);
    expect(clear.readings.map((r) => r.id)).toEqual([host.config.paths.halt_file, "gardener-desk", "halt-herald"]);

    for (const [beacon, other] of [
      [GARDENER!, HERALD!],
      [HERALD!, GARDENER!],
    ] as const) {
      serveBeacon(server, other.did, { kind: "lowered" });
      serveBeacon(server, beacon.did, { kind: "raised", until: BEACON_UNTIL });
      expect((await checkHalt(deps)).halted).toBe(true);
      serveBeacon(server, beacon.did, { kind: "status", status: 404 });
      const s = await checkHalt(deps);
      expect(s.halted).toBe(true);
      expect(s.readings.find((r) => r.id === beacon.name)?.state).toBe("unreadable");
      serveBeacon(server, beacon.did, { kind: "lowered" });
    }

    await host.raiseHaltFile();
    expect((await checkHalt(deps)).halted).toBe(true);
  });

  test("checkHalt is halted with no beacons pinned unless allow_no_beacons is true", async () => {
    const { deps, config } = await setup({ beacons: [], allowNoBeacons: false });
    const s = await checkHalt(deps);
    expect(s.halted).toBe(true);
    expect(describeHalt(s)).toContain("no beacon pinned");
    config.halt.allow_no_beacons = true;
    expect((await checkHalt(deps)).halted).toBe(false);
  });

  test("readBeacon calls exactly GET /public/agents/<did> on the pinned origin and sends no credential", async () => {
    const { server, deps } = await setup();
    serveBeacon(server, GARDENER!.did, { kind: "lowered" });
    const seen: string[] = [];
    const recording = async (input: string | URL | Request, init?: RequestInit) => {
      seen.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      return fetchVia(server)(input, init);
    };
    await readBeacon({ ...deps, fetch: recording }, GARDENER!);
    expect(seen).toEqual([`https://api.agenttool.dev/public/agents/${GARDENER!.did}`]);
    expect(server.requests).toHaveLength(1);
    const req = server.requests[0]!;
    expect(req.method).toBe("GET");
    expect(req.path).toBe(`/public/agents/${GARDENER!.did}`);
    expect(req.search).toBe("");
    expect(req.body.length).toBe(0);
    for (const h of ["authorization", "cookie", "x-api-key", "x-agenttool-authority-signature"]) expect(req.headers[h]).toBeUndefined();
  });
});

describe("raising", () => {
  /** The operator's one fixed call, as a sudoers line would allow it: the program and every argument pinned. */
  const ARGV = ["/usr/bin/sudo", "-n", "-u", "seat", "/usr/local/bin/citizen-seat", "raise-beacons", "--config", "/Users/Shared/kingdom-seat/config.json"];
  const enc = (t: string) => new TextEncoder().encode(t);

  test("raiseHalt, as the operator, writes the local file first and then makes the one fixed call; if the signer cannot be reached, the file stands and each held beacon is failed", async () => {
    const { deps, config } = await setup({ beacons: testBeacons({ canRaiseHere: ["gardener-desk", "halt-herald"] }) });
    config.halt.raise_beacons_argv = ARGV;
    const calls: string[][] = [];
    const fileAtCall: boolean[] = [];
    const unreachable: CommandRunner = async (argv) => {
      calls.push(argv);
      fileAtCall.push(readHaltFile(config.paths.halt_file, clock.now()).state === "raised");
      throw new Error("sudo: a password is required");
    };
    const r = await raiseHalt({ config, now: deps.now, run: unreachable });
    expect(r.file).toBe("written");
    expect(calls).toEqual([ARGV]);
    expect(fileAtCall).toEqual([true]);
    expect(r.beacons).toEqual([
      { name: "gardener-desk", result: "failed", detail: "the signer could not be reached" },
      { name: "halt-herald", result: "failed", detail: "the signer could not be reached" },
    ]);
    expect(await readFile(config.paths.halt_file, "utf8")).toContain("raised");

    // A second raise leaves the file as it is; with no call configured nothing runs, and the held beacons are failed.
    config.halt.raise_beacons_argv = null;
    const again = await raiseHalt({ config, now: deps.now, run: unreachable });
    expect(again.file).toBe("already-present");
    expect(calls).toHaveLength(1);
    expect(again.beacons.map((b) => [b.result, b.detail])).toEqual([
      ["failed", "no signer call is configured (halt.raise_beacons_argv)"],
      ["failed", "no signer call is configured (halt.raise_beacons_argv)"],
    ]);
  });

  test("raiseHalt reads back only what the signer reported raised, in its own fixed lines; a non-zero exit fails the rest", async () => {
    const { deps, config } = await setup({ beacons: testBeacons({ canRaiseHere: ["gardener-desk", "halt-herald"] }) });
    config.halt.raise_beacons_argv = ARGV;
    const stdout = [`beacon gardener-desk: raised (until ${BEACON_UNTIL})`, "beacon halt-herald: failed (HTTP 401)", "note: beacon halt-herald: raised (forged)", "beacon halt-herald: raised"].join("\n");
    const r = await raiseHalt({ config, now: deps.now, run: async () => ({ code: 1, stdout: enc(stdout), stderr: "" }) });
    expect(r.beacons).toEqual([
      { name: "gardener-desk", result: "raised", detail: `by the signer, until ${BEACON_UNTIL}` },
      { name: "halt-herald", result: "failed", detail: "the signer call exited 1" },
    ]);

    // No beacon held here: no call at all, and nothing failed.
    config.beacons = testBeacons();
    let ran = 0;
    const r2 = await raiseHalt({ config, now: deps.now, run: async () => (ran++, { code: 0, stdout: enc(""), stderr: "" }) });
    expect(ran).toBe(0);
    expect(r2.beacons.map((b) => b.result)).toEqual(["not-held-here", "not-held-here"]);
  });

  test("raiseHalt also raises each of halt.also_files, such as the KS-003 fleet's $LOVE/HALT, so one verb still stops everything (KS4-HALT-4)", async () => {
    const { deps, config } = await setup({ beacons: testBeacons() });
    const love = join(dirname(dirname(config.paths.halt_file)), "love-unlimited");
    await mkdir(love);
    const missing = join(dirname(dirname(config.paths.halt_file)), "no-such-dir", "HALT");
    config.halt.also_files = [join(love, "HALT"), missing];
    const r = await raiseHalt({ config, now: deps.now, run: async () => ({ code: 0, stdout: enc(""), stderr: "" }) });
    expect(r.file).toBe("written");
    expect(r.also_files).toEqual([
      { path: join(love, "HALT"), file: "written", detail: "" },
      { path: missing, file: "failed", detail: "ENOENT" },
    ]);
    expect(await readFile(join(love, "HALT"), "utf8")).toContain("raised");
    // Raised again, each is left as it is.
    expect((await raiseHalt({ config, now: deps.now, run: async () => ({ code: 0, stdout: enc(""), stderr: "" }) })).also_files[0]!.file).toBe("already-present");
  });

  test("raiseHalt reports why the file could not be written, as the seat user would find: the operator's directory is not theirs", async () => {
    const { deps, config } = await setup({ beacons: testBeacons() });
    const dir = dirname(config.paths.halt_file);
    await chmod(dir, 0o555);
    try {
      const r = await raiseHalt({ config, now: deps.now, run: async () => ({ code: 0, stdout: enc(""), stderr: "" }) });
      expect(r).toMatchObject({ file: "failed", file_detail: "EACCES" });
      expect(readHaltFile(config.paths.halt_file, clock.now()).state).toBe("lowered");
    } finally {
      await chmod(dir, 0o755);
    }
  });

  test("raiseBeacons, the signer's half as the seat user, raises only beacons this host can sign, via quiet.start.beacon with BEACON_UNTIL and an empty reason", async () => {
    const { config } = await setup({ beacons: testBeacons({ canRaiseHere: ["halt-herald"] }) });
    const signer = fakeSigner();
    const beacons = await raiseBeacons({ config, signer });
    expect(beacons).toEqual([
      { name: "gardener-desk", result: "not-held-here", detail: expect.any(String) },
      { name: "halt-herald", result: "raised", detail: expect.any(String) },
    ]);
    expect(signer.sent).toHaveLength(1);
    const req = signer.sent[0]!;
    expect(req).toMatchObject({ op: "quiet.start.beacon", word: null, operator: "halt-herald", method: "POST", credits: 0, proposal: null });
    expect(req.target).toBe(`/v1/quiet-hours/start?identity_id=${HERALD!.identity_id}`);
    expect(JSON.parse(new TextDecoder().decode(req.body))).toEqual({ until: BEACON_UNTIL, reason: "" });
    expect(BEACON_UNTIL).toBe("2999-12-31T00:00:00.000Z");
    // It writes no HALT file: that is the operator's, in a directory the seat user cannot write.
    expect(readHaltFile(config.paths.halt_file, clock.now()).state).toBe("lowered");
  });

  test("a beacon raise the server refuses, or a locked keychain, is reported failed, not raised", async () => {
    const { config } = await setup({ beacons: testBeacons({ canRaiseHere: ["gardener-desk"] }) });
    const signer = fakeSigner();
    signer.respond(() => ({ status: 401, json: { error: "unauthorized" } }));
    expect((await raiseBeacons({ config, signer }))[0]).toMatchObject({ name: "gardener-desk", result: "failed", detail: "HTTP 401" });
    signer.respond(() => {
      throw new Refusal("keychain-locked", "locked");
    });
    expect((await raiseBeacons({ config, signer }))[0]).toMatchObject({ name: "gardener-desk", result: "failed" });
    expect((await raiseBeacons({ config, signer: null }))[0]).toMatchObject({ name: "gardener-desk", result: "failed", detail: "no signer available" });
  });

  test("there is no exported function that lowers HALT", () => {
    const names = Object.keys(halt);
    expect(names.filter((n) => /lower|clear|unhalt|resume|remove|delete|end/i.test(n))).toEqual([]);
    expect(names).toContain("raiseHalt");
  });

  test("describeHalt says 'halted by beacon <name>' or 'halted by file', never 'down'", () => {
    const at = clock.now().toISOString();
    const status = (readings: HaltStatus["readings"]): HaltStatus => ({ halted: readings.some((r) => r.state !== "lowered"), readings });
    const file = { source: "file" as const, id: "/state/HALT", quiet_until: null, detail: "", checked_at: at };
    const beacon = { source: "beacon" as const, id: "gardener-desk", quiet_until: null, detail: "HTTP 404", checked_at: at };
    expect(describeHalt(status([{ ...file, state: "lowered" }]))).toBe("not halted");
    expect(describeHalt(status([{ ...file, state: "raised" }]))).toBe("halted by file");
    expect(describeHalt(status([{ ...file, state: "lowered" }, { ...beacon, state: "raised" }]))).toBe("halted by beacon gardener-desk");
    const unreadable = describeHalt(status([{ ...file, state: "lowered" }, { ...beacon, state: "unreadable" }]));
    expect(unreadable).toStartWith("halted by beacon gardener-desk");
    for (const s of [unreadable, describeHalt(status([{ ...file, state: "unreadable", detail: "EACCES" }]))]) expect(s).not.toMatch(/\bdown\b/i);
  });
});
