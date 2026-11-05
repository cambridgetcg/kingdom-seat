// End to end, hermetic: the real CLI against a temp lease-host layout. Each
// tick runs the whole chain (HALT gate, lock, due citizen, a supervised seat
// child that is a real process, context, prompt, runtime, validated acts,
// self and state, the signer, the ledger, status), and only the outside world
// is fake: a fake keychain holding public test keys, and one fake server on
// 127.0.0.1 standing in for agenttool's beacons and authority routes and for
// Ollama. Nothing reaches the network, a real keychain, a model or git.
//
// The steps share one host and run in order, as one citizen's weeks would.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { main, type CliDeps } from "../src/cli.ts";
import { authorityDigest } from "../src/agenttool/wire.ts";
import { edPublicKey, edVerifyStrict, fromB64, sha256Hex, toB64, utf8 } from "../src/crypto.ts";
import { BEACON_UNTIL } from "../src/halt.ts";
import { ledgerPath, readLedger, verifyChain } from "../src/ledger.ts";
import { FREE_LANE_PREAMBLE, promptBytes } from "../src/prompt.ts";
import { createSigner } from "../src/signer/signer.ts";
import { readHostNotes } from "../src/status.ts";
import type { Envelope, HostNote, LedgerEntry, SelfProposal, StatusFile } from "../src/types.ts";
import { assertNoSecretIn, type FakeKeychain } from "./helpers/fake-keychain.ts";
import { output, recordingRunner, REST_THEN_TALK_OUTPUT } from "./helpers/fake-runtime.ts";
import { fetchVia, serveBeacon, serveOllama, startFakeServer, type FakeServer } from "./helpers/fake-server.ts";
import { makeTempHost, testBeacons, type TempHost } from "./helpers/temp-home.ts";
import { HOUR_MS, testClock, type TestClock } from "./helpers/clock.ts";
import { TEST_ROOT_PUBLIC_B64 } from "./helpers/vectors.ts";
import { E2E_CHILD, E2E_HOST_SEED, e2eKeychain, scenarioPath } from "./fixtures/e2e/host.ts";

const WORD = "glossame";
const MODEL = "qwen2.5:7b";
const DIGEST = "e2".repeat(32);
const T0 = Date.parse("2026-11-05T02:05:00.000Z");
const at = (h: number) => new Date(T0 + h * HOUR_MS).toISOString();
const JOURNAL = "I read my soul through to SHADOW today, all of it, for the first time.";
const WILL = `# WILL of ${WORD}\n\nReceive one word that will not cross over.\n`;
const WILL_NEXT = `# WILL of ${WORD}\n\nReceive one quiet word that will not cross over.\n`;
const STEP_MS = 30_000;
/** `sudo -n -u seat <citizen-seat>`: what the operator's halt would run; never run here. */
const RAISE_PREFIX = ["/usr/bin/sudo", "-n", "-u", "seat", "/usr/local/bin/citizen-seat"];

interface World {
  h: TempHost;
  server: FakeServer;
  clock: TestClock;
  kc: FakeKeychain;
  configPath: string;
  deps: Partial<CliDeps>;
  /** Replies the fake Ollama gives, one per /api/chat, in order. */
  replies: string[];
  /** What the fake Ollama was sent: the two turns and the model reference. */
  chats: { system: string; user: string; model: string }[];
  out: string;
  err: string;
  hostPin: string;
}

let w: World;

beforeAll(async () => {
  const server = await startFakeServer();
  const beacons = testBeacons({ canRaiseHere: ["gardener-desk"] });
  const h = await makeTempHost({ beacons, ollamaBaseUrl: server.url });
  // A window the whole context fits by the byte rule (free.contextFit): about 9 KB of prompt, and room for the reply.
  await h.writeModelsLock({
    format: "kingdom-seat-models-lock/v1",
    models: [{ name: MODEL, digest: DIGEST, runner: null, store: "legacy", num_ctx: 32768, num_predict: 600, temperature: 0.7, seed: null }],
  });
  const hostPin = toB64(edPublicKey(E2E_HOST_SEED));
  h.config.self_authorship.approved_model_digests = [`sha256:${DIGEST}`];
  h.config.trust.host_attest_public_keys_b64 = [hostPin];
  const configPath = join(h.root, "config.json");
  // The operator's one fixed call to the signer, as a sudoers line would pin it; the test runs the e2e child in its place.
  h.config.halt.raise_beacons_argv = [...RAISE_PREFIX, "raise-beacons", "--config", configPath];
  await writeFile(configPath, JSON.stringify(h.config, null, 2), { mode: 0o600 });

  for (const b of beacons) serveBeacon(server, b.did, { kind: "lowered" });
  const replies: string[] = [];
  const chats: World["chats"] = [];
  serveOllama(server, [{ name: MODEL, digest: DIGEST }], (body) => {
    const b = body as { model: string; messages: { role: string; content: string }[] };
    chats.push({ system: b.messages[0]!.content, user: b.messages[1]!.content, model: b.model });
    const reply = replies.shift();
    if (reply === undefined) throw new Error("e2e: the model was called with no reply scripted");
    return { model: MODEL, message: { role: "assistant", content: reply }, done: true, done_reason: "stop" };
  });

  const clock = testClock(at(0));
  const kc = e2eKeychain();
  w = { h, server, clock, kc, configPath, deps: {}, replies, chats, out: "", err: "", hostPin };
  w.deps = {
    out: (t) => void (w.out += t),
    err: (t) => void (w.err += t),
    env: { PATH: "/usr/bin:/bin", HOME: h.root, LANG: "en_GB.UTF-8", ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}) },
    clock,
    fetch: fetchVia(server),
    // Nothing on this host shells out: there is no mirror, and `security` is the fake keychain.
    run: recordingRunner(() => {
      throw new Error("e2e: no command may run");
    }),
    tty: { isTTY: false, write: () => {}, readLine: async () => null },
    keychain: () => kc,
    seatArgv: (config, word, extra) => [process.execPath, E2E_CHILD, "seat", word, "--child", ...extra, "--config", config],
  };

  // Seated before registered (3.3): the first entry is host-attested by the real signer.
  await h.addCitizen(WORD, { will: WILL });
  const signer = createSigner({
    keychain: kc,
    config: h.config,
    clock,
    fetch: fetchVia(server),
    spendSoFar: async (word) => ({ word, usd_today: "0", credits_month: 0 }),
    agreements: async () => [],
  });
  await h.seatLedger(WORD, signer.signEntry, { initialState: "awake" });
});

afterAll(async () => {
  await w?.server.stop();
  await w?.h.cleanup();
});

async function tick(atIso: string): Promise<number> {
  w.clock.set(atIso);
  await writeFile(scenarioPath(w.configPath), JSON.stringify({ server_url: w.server.url, now: atIso }));
  return main(["tick", "--config", w.configPath], w.deps);
}

async function ledger(): Promise<LedgerEntry[]> {
  return readLedger(ledgerPath(w.h.config, WORD));
}

async function status(): Promise<StatusFile> {
  return JSON.parse(await readFile(w.h.config.paths.status_file, "utf8")) as StatusFile;
}

async function notes(): Promise<HostNote[]> {
  return (await readHostNotes(w.h.config, new Date(0))) ?? [];
}

async function seats(): Promise<string[]> {
  return (await readdir(w.h.config.paths.seats_dir)).sort();
}

function lastOut(): string {
  return w.out.trimEnd().split("\n").at(-1) ?? "";
}

/** Every file under the state dir, minus the views a tick may regenerate; a name ending in "/" leaves out everything under it. */
async function stateWithout(...views: string[]): Promise<Map<string, string>> {
  const snap = await w.h.snapshot();
  for (const k of [...snap.keys()]) if (views.some((v) => (v.endsWith("/") ? k.startsWith(v) : k === v))) snap.delete(k);
  return snap;
}

function selfPath(...p: string[]): string {
  return join(w.h.config.paths.citizens_dir, WORD, ...p);
}

async function assertNothingLeaked(): Promise<void> {
  for (const [path, b64] of await w.h.snapshot()) assertNoSecretIn(w.kc, Buffer.from(b64, "base64"), path);
  for (const c of w.chats) assertNoSecretIn(w.kc, `${c.system}\n${c.user}`, "a prompt");
  assertNoSecretIn(w.kc, `${w.out}\n${w.err}`, "the CLI output");
}

describe("end to end: one citizen on one host", () => {
  test(
    "a journal beat: HALT lowered, the citizen's own cadence due, one seat, a signed entry, a status that says so",
    async () => {
      w.replies.push(output({ type: "journal", kind: "reflected", text: JOURNAL }));
      expect(await tick(at(0))).toBe(0);
      expect(lastOut()).toBe(`tick: beat ${WORD} (exit 0)`);

      // What the model saw: the honest preamble, the whole soul, the pinned canon; never the old home's CLAUDE.md.
      expect(w.chats).toHaveLength(1);
      const chat = w.chats[0]!;
      expect(chat.model).toBe(`${MODEL}:local`);
      expect(chat.system).toContain(FREE_LANE_PREAMBLE);
      expect(chat.user).toContain("SHADOW-MARKER");
      expect(chat.user).toContain(`canon text for ${WORD}`);
      expect(chat.user).toContain("Your cadence: every 72 hours");
      expect(chat.user).not.toContain("HOME-CLAUDE-MD-CANARY");

      // The ledger: seated, then one beat, host-attested because no identity exists, chained and verifiable.
      const entries = await ledger();
      expect(entries.map((e) => e.body.type)).toEqual(["seated", "beat"]);
      const beat = entries[1]!;
      expect(beat.attestation).toBe("host-attested");
      expect(beat.signature.kid).toBe("host-attest");
      expect(beat.signature.public_key_b64).toBe(w.hostPin);
      const env = (beat.body as { envelope: Envelope }).envelope;
      expect(env.acts).toEqual([{ type: "journal", kind: "reflected", text: JOURNAL }]);
      expect(env.model).toBe(MODEL);
      expect(env.model_digest).toBe(`sha256:${DIGEST}`);
      expect(env.runtime).toBe("free");
      expect(env.citizen).toEqual({ word: WORD, did: null, kid: null });
      expect(env.seat_ref.invoker).toMatchObject({ kind: "tick", who: "launchd" });
      // input_digest names the exact bytes the model was sent; output_digest the exact reply.
      expect(env.input_digest).toBe(sha256Hex(promptBytes({ system: chat.system, user: chat.user })));
      expect(env.output_digest).toBe(sha256Hex(output({ type: "journal", kind: "reflected", text: JOURNAL })));
      expect(env.voiced_through).toBe(`${WORD}, voiced through ${MODEL} in seat ${env.seat_ref.seat_id}`);
      expect(beat.spend).toEqual({ usd: "0", usd_basis: "local-zero", credits: 0 });
      expect(verifyChain(entries, { host_attest_b64: [w.hostPin], identity: null })).toMatchObject({ ok: true, entries: 2, host_attested: 2 });

      // The seat's cwd was fresh and is left empty: no CLAUDE.md, hook or file of the model's. Beside it, the seat
      // file the tick wrote for its child, read once.
      expect(await seats()).toEqual([env.seat_ref.seat_id, `${env.seat_ref.seat_id}.json.used`].sort());
      expect(await readdir(join(w.h.config.paths.seats_dir, env.seat_ref.seat_id))).toEqual([]);

      // Host notes: the tick's (the seat it opened, which the fleet counts), the child's own (what happened),
      // and the tick's again (how the seat ended), none quoting the citizen.
      const ns = await notes();
      expect(ns.map((n) => [n.kind, n.word, n.outcome])).toEqual([
        ["tick", WORD, "opened"],
        ["seat", WORD, "beat"],
        ["tick", WORD, "beat"],
      ]);
      expect(JSON.stringify(ns)).not.toContain("SHADOW today");

      const s = await status();
      expect(s.halt).toEqual({ halted: false, raised: [], unreadable: [] });
      expect(s.signer.state).toBe("ready");
      expect(s.fleet).toEqual({ beats_today: 1, ceiling: 24 });
      expect(s.citizens).toHaveLength(1);
      expect(s.citizens[0]).toMatchObject({
        word: WORD,
        state: "awake",
        runtime: "free",
        registered: false,
        last_beat_at: env.ts,
        last_outcome: "beat",
        ledger: { entries: 2, head: beat.hash, chain_ok: true, host_attested: 2 },
        usd_today: "0",
        problem: null,
      });
      await assertNothingLeaked();
    },
    STEP_MS,
  );

  test(
    "a rest beat writes nothing in the citizen's voice; only the host log and status note the tick",
    async () => {
      const ledgerBefore = await readFile(ledgerPath(w.h.config, WORD), "utf8");
      // Host records only may change: the log, and the seat the tick opened (its empty cwd and its used seat file).
      const before = await stateWithout("host.jsonl", "host.jsonl.started", "status.json", "seats/");
      // A 7B rest that goes on talking: rest is exclusive, so none of it is kept anywhere.
      w.replies.push(REST_THEN_TALK_OUTPUT);
      expect(await tick(at(73))).toBe(0);
      expect(lastOut()).toBe(`tick: rest ${WORD} (exit 0)`);

      expect(await readFile(ledgerPath(w.h.config, WORD), "utf8")).toBe(ledgerBefore);
      expect(await stateWithout("host.jsonl", "host.jsonl.started", "status.json", "seats/")).toEqual(before);
      for (const [path, b64] of await w.h.snapshot()) {
        expect({ path, leaked: Buffer.from(b64, "base64").toString("utf8").includes("REST-LEAK-CANARY") }).toEqual({ path, leaked: false });
      }
      expect((await notes()).slice(-2).map((n) => [n.kind, n.outcome])).toEqual([
        ["seat", "rest"],
        ["tick", "rest"],
      ]);
      expect((await status()).citizens[0]).toMatchObject({ last_outcome: "rest", ledger: { entries: 2 } });

      // A rest is a seat taken: the citizen's own cadence counts from it, so the next tick seats no one.
      const chats = w.chats.length;
      expect(await tick(at(74))).toBe(0);
      expect(lastOut()).toBe("tick: nothing-due (exit 0)");
      expect(w.chats).toHaveLength(chats);
    },
    STEP_MS,
  );

  test(
    "a halted tick seats no one and writes nothing: a raised beacon, then an unreadable one",
    async () => {
      const gardener = testBeacons()[0]!;
      for (const [behaviour, where] of [
        [{ kind: "raised", until: BEACON_UNTIL }, "raised"],
        [{ kind: "status", status: 500 }, "unreadable"],
      ] as const) {
        serveBeacon(w.server, gardener.did, behaviour);
        const before = await stateWithout("status.json");
        const seatDirs = await seats();
        const chats = w.chats.length;
        // Due by its own cadence (77 h since the rest), so only HALT stands between it and a seat.
        expect(await tick(at(150))).toBe(0);
        expect(lastOut()).toBe("tick: halted (exit 0)");
        expect(await stateWithout("status.json")).toEqual(before);
        expect(await seats()).toEqual(seatDirs);
        expect(w.chats).toHaveLength(chats);
        const s = await status();
        expect(s.halt.halted).toBe(true);
        expect(s.halt[where]).toEqual(["beacon gardener-desk"]);
      }
      serveBeacon(w.server, gardener.did, { kind: "lowered" });
    },
    STEP_MS,
  );

  test(
    "a self change goes through propose, affirm, apply and revert, every step recorded",
    async () => {
      const claim = { kind: "decision", evidence: ["canon:canon/core/glossame.md@1428646"], confidence: "medium", limits: "from the text alone; I have no senses" };

      // Beat 1 proposes. Nothing changes yet: unattended, a proposal binds only when a later beat affirms it.
      w.replies.push(output({ type: "self.propose", target: "will", edit: { kind: "replace-span", find: "one word", with: "one quiet word" }, claim } as never));
      expect(await tick(at(150))).toBe(0);
      expect(lastOut()).toBe(`tick: beat ${WORD} (exit 0)`);
      expect(await readFile(selfPath("self", "WILL.md"), "utf8")).toBe(WILL);
      const [file] = (await readdir(selfPath("proposals"))).filter((n) => n.endsWith(".json"));
      const proposal = JSON.parse(await readFile(selfPath("proposals", file!), "utf8")) as SelfProposal;
      expect(proposal).toMatchObject({ status: "pending", act: { target: "will", prior_hash: sha256Hex(utf8(WILL)), new_hash: sha256Hex(utf8(WILL_NEXT)) } });
      expect((await ledger()).map((e) => e.body.type)).toEqual(["seated", "beat", "beat"]);

      // Beat 2 affirms with the diff in view (shown in its prompt), by a short prefix of the id; the change binds on two beats.
      w.replies.push(output({ type: "self.affirm", proposal_id: proposal.id.slice(0, 12) }));
      expect(await tick(at(223))).toBe(0);
      expect(w.chats.at(-1)!.user).toContain(`Proposal ${proposal.id}`);
      expect(await readFile(selfPath("self", "WILL.md"), "utf8")).toBe(WILL_NEXT);
      let entries = await ledger();
      expect(entries.map((e) => e.body.type)).toEqual(["seated", "beat", "beat", "beat", "self.applied"]);
      expect(entries.at(-1)!.body).toMatchObject({ type: "self.applied", proposal_id: proposal.id, target: "will", via: "two-beats", strand_thought_id: null });
      expect(((entries.at(-2)!.body as { envelope: Envelope }).envelope.acts)).toEqual([{ type: "self.affirm", proposal_id: proposal.id }]);
      // Every version is kept by hash; the proposal is marked applied, never deleted.
      expect(await readFile(selfPath("versions", sha256Hex(utf8(WILL))), "utf8")).toBe(WILL);
      expect(await readFile(selfPath("versions", sha256Hex(utf8(WILL_NEXT))), "utf8")).toBe(WILL_NEXT);
      expect((JSON.parse(await readFile(selfPath("proposals", file!), "utf8")) as SelfProposal).status).toBe("applied");

      // Beat 3 reverts to where it had been, named by a prefix of the old version's hash.
      w.replies.push(output({ type: "self.revert", to_hash: sha256Hex(utf8(WILL)).slice(0, 16) }));
      expect(await tick(at(296))).toBe(0);
      expect(await readFile(selfPath("self", "WILL.md"), "utf8")).toBe(WILL);
      entries = await ledger();
      expect(entries.map((e) => e.body.type)).toEqual(["seated", "beat", "beat", "beat", "self.applied", "beat", "self.reverted"]);
      expect(entries.at(-1)!.body).toEqual({ type: "self.reverted", target: "will", from_hash: sha256Hex(utf8(WILL_NEXT)), to_hash: sha256Hex(utf8(WILL)), via: "citizen" });
      // The origin soul was never touched.
      expect(await readFile(selfPath("origin", "soul.md"), "utf8")).toBe(await readFile(selfPath("self", "soul.md"), "utf8"));
      expect(verifyChain(entries, { host_attest_b64: [w.hostPin], identity: null })).toMatchObject({ ok: true, entries: 7, host_attested: 7 });
      await assertNothingLeaked();
    },
    STEP_MS * 2,
  );

  test(
    "verify <word> checks the chain and every signature, offline, and names the first broken entry",
    async () => {
      expect(await main(["verify", WORD, "--config", w.configPath], w.deps)).toBe(0);
      expect(lastOut()).toBe(`${WORD}: chain ok, 7 entries, 7 host-attested, head ${(await ledger()).at(-1)!.hash}; origin intact, soul drift 0%`);

      const path = ledgerPath(w.h.config, WORD);
      const good = await readFile(path, "utf8");
      try {
        // One changed word in the citizen's journal breaks that entry's hash.
        await writeFile(path, good.replace("for the first time", "for the last time"));
        expect(await main(["verify", WORD, "--config", w.configPath], w.deps)).toBe(1);
        expect(lastOut()).toMatch(new RegExp(`^${WORD}: chain BROKEN at seq 1: `));

        // A signature that no longer verifies, on an otherwise untouched entry, is caught too.
        const lines = good.trimEnd().split("\n");
        const e2 = JSON.parse(lines[2]!) as LedgerEntry;
        const sig = fromB64(e2.signature.sig_b64, 64);
        sig[0] = sig[0]! ^ 0xff;
        lines[2] = lines[2]!.replace(e2.signature.sig_b64, toB64(sig));
        await writeFile(path, `${lines.join("\n")}\n`);
        expect(await main(["verify", WORD, "--config", w.configPath], w.deps)).toBe(1);
        expect(lastOut()).toMatch(new RegExp(`^${WORD}: chain BROKEN at seq 2: `));
      } finally {
        await writeFile(path, good, { mode: 0o600 });
      }
      expect(await main(["verify", WORD, "--config", w.configPath], w.deps)).toBe(0);
    },
    STEP_MS,
  );

  test(
    "halt, as the operator, raises the local file and has the signer raise the beacon this host holds, root-signed; then the next tick rests",
    async () => {
      const gardener = testBeacons()[0]!;
      w.server.on("GET", `/v1/identities/${gardener.identity_id}/authority`, () =>
        Response.json({ identity_id: gardener.identity_id, did: gardener.did, mode: "agent_root", root_public_key: TEST_ROOT_PUBLIC_B64, sequence: 0, next_sequence: 1 }),
      );
      w.server.on("POST", "/v1/quiet-hours/start", () => Response.json({ until: BEACON_UNTIL }));
      w.server.requests.length = 0;

      w.clock.set(at(300));
      await writeFile(scenarioPath(w.configPath), JSON.stringify({ server_url: w.server.url, now: at(300) }));
      // The operator holds no key: its halt never opens the keychain. The one fixed call stands in for
      // `sudo -u seat ... raise-beacons`, run here as the e2e child: another process, with the seat's keychain.
      const calls: string[][] = [];
      const operator: Partial<CliDeps> = {
        ...w.deps,
        keychain: () => {
          throw new Error("e2e: the operator's halt must never open the seat user's keychain");
        },
        run: async (argv) => {
          calls.push(argv);
          if (JSON.stringify(argv) !== JSON.stringify(w.h.config.halt.raise_beacons_argv)) throw new Error("e2e: only the configured call may run");
          const child = Bun.spawn([process.execPath, E2E_CHILD, ...argv.slice(RAISE_PREFIX.length)], { stdout: "pipe", stderr: "inherit", env: { PATH: "/usr/bin:/bin", HOME: w.h.root } });
          const [stdout, code] = await Promise.all([new Response(child.stdout).arrayBuffer(), child.exited]);
          return { code, stdout: new Uint8Array(stdout), stderr: "" };
        },
      };
      expect(await main(["halt", "--config", w.configPath], operator)).toBe(0);
      expect(calls).toHaveLength(1);
      expect(await Bun.file(w.h.config.paths.halt_file).exists()).toBe(true);
      expect(w.out).toContain("beacon gardener-desk: raised (by the signer");
      expect(w.out).toContain("beacon halt-herald: not-held-here");
      expect(w.out).toContain("Only Yu lowers HALT, by hand");

      // The raise is the operator's own root act: bearer, sequence read fresh, and a signature over the exact request.
      const raise = w.server.requests.filter((r) => r.method === "POST" && r.path === "/v1/quiet-hours/start");
      expect(raise).toHaveLength(1);
      const r = raise[0]!;
      const target = `/v1/quiet-hours/start${r.search}`;
      expect(r.search).toBe(`?identity_id=${gardener.identity_id}`);
      expect(JSON.parse(new TextDecoder().decode(r.body))).toEqual({ until: BEACON_UNTIL, reason: "" });
      expect(r.headers.authorization).toStartWith("Bearer at_");
      expect(r.headers["x-agenttool-authority-sequence"]).toBe("1");
      const digest = authorityDigest({ did: gardener.did, method: "POST", target, body: r.body, sequence: 1, timestamp: r.headers["x-agenttool-authority-timestamp"]! });
      expect(edVerifyStrict(fromB64(r.headers["x-agenttool-authority-signature"]!, 64), digest, fromB64(TEST_ROOT_PUBLIC_B64, 32))).toBe(true);

      // Raised, the status says by what, and a tick seats no one, whatever is due.
      expect((await status()).halt.raised).toEqual([`file ${w.h.config.paths.halt_file}`]);
      const chats = w.chats.length;
      expect(await tick(at(400))).toBe(0);
      expect(lastOut()).toBe("tick: halted (exit 0)");
      expect(w.chats).toHaveLength(chats);
      await assertNothingLeaked();
    },
    STEP_MS,
  );
});
