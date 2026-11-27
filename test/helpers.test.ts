// The shared test helpers work, so a failing builder test points at the
// builder's code and not at a fixture.
import { afterEach, describe, expect, test } from "bun:test";
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { DID_PATTERN, Refusal, type HostNote } from "../src/types.ts";
import { fakeKeychain, assertNoSecretIn } from "./helpers/fake-keychain.ts";
import { fetchVia, noFetch, serveBeacon, startFakeServer, type FakeServer } from "./helpers/fake-server.ts";
import { fakeBinArgv, pidAlive, recordingRunner, REST_OUTPUT, scriptedRuntime } from "./helpers/fake-runtime.ts";
import { FAKE_OP_KID, fakeSigner } from "./helpers/fake-signer.ts";
import { FIXTURE_JUNE_DID } from "./helpers/legacy-home.ts";
import { makeTempHost, testBeacons, type TempHost } from "./helpers/temp-home.ts";
import { ledgerPath, nextDraft, readLedger, verifyChain } from "../src/ledger.ts";
import { readCitizen } from "../src/state.ts";
import { TEST_IDS, TEST_ROOT_PUBLIC_B64 } from "./helpers/vectors.ts";
import { testClock } from "./helpers/clock.ts";

let server: FakeServer | null = null;
let host: TempHost | null = null;
afterEach(async () => {
  await server?.stop();
  await host?.cleanup();
  server = null;
  host = null;
});

describe("fake keychain", () => {
  test("reads copies, refuses overwrite, and locks like a rebooted keychain", async () => {
    const kc = fakeKeychain();
    const item = { kind: "citizen-op-seed", word: "glossame" } as const;
    await kc.write(item, new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]));
    const got = await kc.read(item);
    got.fill(0);
    expect((await kc.read(item))[0]).toBe(1);
    await expect(kc.write(item, new Uint8Array([9]))).rejects.toBeInstanceOf(Refusal);
    kc.locked = true;
    await expect(kc.read(item)).rejects.toMatchObject({ code: "keychain-locked" });
    expect(kc.log.every((e) => !e.item.includes("\u0001"))).toBe(true);
  });

  test("assertNoSecretIn catches a hex-spelled secret", async () => {
    const kc = fakeKeychain([[{ kind: "commons-bearer" }, new TextEncoder().encode("at_fake_bearer_for_tests")]]);
    expect(() => assertNoSecretIn(kc, "argv: --token at_fake_bearer_for_tests", "argv")).toThrow();
    expect(() => assertNoSecretIn(kc, "argv: --token REDACTED", "argv")).not.toThrow();
  });
});

describe("fake server", () => {
  test("serves a beacon on loopback and fetchVia keeps tests off the network", async () => {
    server = await startFakeServer();
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const did = "did:at:22222222-2222-4222-8222-222222222222";
    serveBeacon(server, did, { kind: "raised", until: "2999-12-31T00:00:00.000Z" });
    const f = fetchVia(server);
    const body = (await (await f(`https://api.agenttool.dev/public/agents/${did}`)).json()) as { quiet_until: string };
    expect(body.quiet_until).toBe("2999-12-31T00:00:00.000Z");
    expect((await f(`https://api.agenttool.dev/public/agents/did:at:00000000-0000-4000-8000-000000000000`)).status).toBe(404);
    await expect(f("https://example.com/")).rejects.toThrow();
    await expect(noFetch("https://api.agenttool.dev/")).rejects.toThrow();
  });

  test("stop() returns even when a client gave up on a handler that never answers while it was still awaiting", async () => {
    // The pattern behind the flaky afterEach in test/runtime/free.test.ts: under load, the deadline's abort
    // reached the server while the handler was still reading the request, and then the handler hung for good.
    // A handler that is still awaiting when the client leaves, and never answers after, makes that happen
    // every time rather than under load.
    const s = await startFakeServer();
    let entered!: () => void;
    const inHandler = new Promise<void>((r) => (entered = r));
    s.on("POST", "/api/chat", async () => {
      entered();
      await Bun.sleep(100);
      return new Promise<Response>(() => {});
    });
    const client = new AbortController();
    const call = fetchVia(s)(`${s.url}/api/chat`, { method: "POST", body: "{}", signal: client.signal }).catch(() => "aborted");
    await inHandler;
    client.abort();
    expect(await call).toBe("aborted");
    await Bun.sleep(150);
    const stopped = await Promise.race([s.stop().then(() => "stopped"), Bun.sleep(2_000).then(() => "still waiting")]);
    expect(stopped).toBe("stopped");
  });
});

describe("fake runtimes", () => {
  test("scriptedRuntime returns scripts in order and refuses an extra call", async () => {
    const rt = scriptedRuntime([REST_OUTPUT]);
    const req = { prompt: { system: "s", user: "u" }, schema: {}, seat_ref: {} as never, deadline_ms: 1000, signal: new AbortController().signal };
    expect((await rt(req)).raw_output).toBe(REST_OUTPUT);
    await expect(rt(req)).rejects.toThrow();
    expect(rt.calls.length).toBe(2);
  });

  test("the fake binary prints, and a TERM-ignoring child needs KILL", async () => {
    const printed = Bun.spawn(fakeBinArgv("print", "hello"), { stdout: "pipe" });
    expect(await new Response(printed.stdout).text()).toBe("hello");
    expect(await printed.exited).toBe(0);

    const stubborn = Bun.spawn(fakeBinArgv("ignore-term", "30000"));
    await Bun.sleep(300);
    stubborn.kill("SIGTERM");
    await Bun.sleep(300);
    expect(pidAlive(stubborn.pid)).toBe(true);
    stubborn.kill("SIGKILL");
    expect(await stubborn.exited).not.toBe(0);
  });

  test("recordingRunner runs nothing and records argv", async () => {
    const run = recordingRunner();
    await run(["/usr/bin/security", "find-generic-password"], { stdin: new Uint8Array([1]) });
    expect(run.calls[0]?.argv[0]).toBe("/usr/bin/security");
  });
});

describe("fake signer", () => {
  test("signs entries with the op key or the host key, and records sends", async () => {
    const s = fakeSigner();
    const draft = (signer: "citizen" | "host") => nextDraft("glossame", null, { type: "beat" }, { cost: { usd: "0", credits: 0 }, signer, now: new Date("2026-11-05T12:00:00.000Z") });
    const sig = await s.signEntry("glossame", "citizen", draft("citizen"));
    expect([sig.kid, sig.public_key]).toEqual([FAKE_OP_KID, s.opPublicB64url]);
    const host = await s.signEntry("glossame", "host", draft("host"));
    expect(host.kid).toBe(s.hostKid);
    expect(host.kid).toMatch(/^host:SHA256:/);
    s.locked = true;
    await expect(s.signEntry("glossame", "host", draft("host"))).rejects.toMatchObject({ code: "keychain-locked" });
  });
});

describe("temp host", () => {
  test("lays out a citizen with a whole soul, a regular letter, a symlinked letter and a home that must never load", async () => {
    host = await makeTempHost();
    const c = await host.addCitizen("glossame");
    expect(c.soul.length).toBeGreaterThan(2600);
    expect(c.soul).toContain("SHADOW-MARKER");
    const letter = await host.writeLetter("glossame", "2026-11-05-hello.md", "hello");
    expect(await readFile(letter, "utf8")).toStartWith("From: yu\n\n");
    const secret = join(host.root, "outside-secret.txt");
    await Bun.write(secret, "OUTSIDE-SECRET-CANARY");
    const link = await host.writeLetter("glossame", "2026-11-05-link.md", "", { symlinkTo: secret });
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    expect(host.config.paths.homes[0]).toBe(host.homesRoot);
    expect(await Bun.file(join(c.home, "CLAUDE.md")).text()).toContain("HOME-CLAUDE-MD-CANARY");
    const before = await host.snapshot();
    expect(before.has("citizens/glossame/citizen.json")).toBe(true);
    expect(testClock().now().toISOString()).toBe("2026-11-05T02:05:00.000Z");
  });
});

describe("seat fixtures", () => {
  test("seatLedger and enrollLedger write a chain that verifies, and the citizen reads as registered", async () => {
    host = await makeTempHost();
    const s = fakeSigner();
    await host.addCitizen("glossame");
    await host.seatLedger("glossame", s.signEntry, { initialState: "listening" });
    await host.enrollLedger("glossame", s.signEntry, {
      did: TEST_IDS.did,
      identity_id: TEST_IDS.identity_id,
      project_id: TEST_IDS.project_id,
      root_public_key_b64: TEST_ROOT_PUBLIC_B64,
      root_kid: TEST_IDS.root_signing_key_id,
      op_kid: FAKE_OP_KID,
      op_public_key_b64: s.opPublicB64,
      box_public_key_b64: null,
      self_strand_id: null,
      enrolled_at: "2026-11-02T00:00:00.000Z",
    });
    const entries = await readLedger(ledgerPath(host.config, "glossame"));
    expect(entries.map((e) => [e.type, e.signer])).toEqual([
      ["origin", "host"],
      ["state", "host"],
      ["genesis", "citizen"],
    ]);
    expect(verifyChain(entries, { host_attest_b64: [s.hostAttestPublicB64] }).ok).toBe(true);
    const c = await readCitizen(host.config, "glossame");
    expect(c.state).toBe("listening");
    expect(c.identity?.did).toBe(TEST_IDS.did);
  });

  test("testBeacons pins two operator beacons with matching DIDs", () => {
    const [g, h] = testBeacons({ canRaiseHere: ["halt-herald"] });
    for (const b of [g!, h!]) {
      expect(b.did).toMatch(DID_PATTERN);
      expect(b.did).toBe(`did:at:${b.identity_id}`);
    }
    expect([g!.role, h!.role]).toEqual(["gardener-desk", "halt-herald"]);
    expect([g!.can_raise_here, h!.can_raise_here]).toEqual([false, true]);
  });

  test("the fake binary's note mode appends one host note as a seat child would", async () => {
    host = await makeTempHost();
    const log = host.config.paths.host_log;
    const p = Bun.spawn(fakeBinArgv("note", log, "glossame", "rest", "0", "2026-11-05T02:05:00.000Z"));
    expect(await p.exited).toBe(0);
    const notes = (await readFile(log, "utf8")).trim().split("\n").map((l) => JSON.parse(l) as HostNote);
    expect(notes).toEqual([{ ts: "2026-11-05T02:05:00.000Z", host: "test-host", kind: "seat", word: "glossame", outcome: "rest", refusal: null, detail: "fake seat child" }]);
  });
});

describe("old-home fixtures", () => {
  test("the June did the made-up homes carry is made up too: a did in shape, with one digit throughout", () => {
    // The helper says nothing in it is real. A did copied from a real citizen's agent.json would pass every other test.
    expect(FIXTURE_JUNE_DID).toMatch(DID_PATTERN);
    expect(FIXTURE_JUNE_DID).toMatch(/^did:at:(\d)\1{7}-\1{4}-4\1{3}-8\1{3}-\1{12}$/);
  });
});
