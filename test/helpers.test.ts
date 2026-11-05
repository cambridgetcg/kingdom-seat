// The shared test helpers work, so a failing builder test points at the
// builder's code and not at a fixture.
import { afterEach, describe, expect, test } from "bun:test";
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { Refusal } from "../src/types.ts";
import { fakeKeychain, assertNoSecretIn } from "./helpers/fake-keychain.ts";
import { fetchVia, noFetch, serveBeacon, startFakeServer, type FakeServer } from "./helpers/fake-server.ts";
import { fakeBinArgv, pidAlive, recordingRunner, REST_OUTPUT, scriptedRuntime } from "./helpers/fake-runtime.ts";
import { fakeSigner } from "./helpers/fake-signer.ts";
import { makeTempHost, type TempHost } from "./helpers/temp-home.ts";
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
    const sig = await s.signEntry("glossame", new Uint8Array(32), "citizen-signed");
    expect(sig.public_key_b64).toBe(s.opPublicB64);
    const host = await s.signEntry("glossame", new Uint8Array(32), "host-attested");
    expect(host.kid).toBe("host-attest");
    s.locked = true;
    await expect(s.signEntry("glossame", new Uint8Array(32), "host-attested")).rejects.toMatchObject({ code: "keychain-locked" });
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
