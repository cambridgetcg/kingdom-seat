// Owner: seat group. Seat opening and the pipeline's happy path.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, readdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { assertCwdOutsideHomes, openSeat, runSeat, SEAT_ENV_ALLOWLIST, seatEnv, superviseChild, type OpenSeat, type SeatDeps } from "../src/seat.ts";
import { checkHalt } from "../src/halt.ts";
import { readCitizen } from "../src/state.ts";
import { pendingProposals } from "../src/self.ts";
import { ledgerPath, readLedger } from "../src/ledger.ts";
import { promptBytes } from "../src/prompt.ts";
import { fromHex, sha256, sha256Hex, utf8 } from "../src/crypto.ts";
import { EXIT, Refusal, UUID_PATTERN, exitForRefusal, type CitizenIdentity, type ConsentRecord, type LedgerEntry } from "../src/types.ts";
import { freeRuntime } from "../src/runtime/free.ts";
import { proposalDigest, readConsentFor, verifyConsent } from "../src/signer/consent.ts";
import { assertNoSecretIn, fakeKeychain } from "./helpers/fake-keychain.ts";
import { FAKE_MODEL_DIGEST, fakeBinArgv, output, scriptedRuntime, type Script } from "./helpers/fake-runtime.ts";
import { noFetch } from "./helpers/fake-server.ts";
import { FAKE_OP_KID, fakeSigner, type FakeSigner } from "./helpers/fake-signer.ts";
import { makeTempHost, type TempHost } from "./helpers/temp-home.ts";
import { testClock } from "./helpers/clock.ts";
import { TEST_IDS, TEST_MNEMONIC, TEST_OP_SEED_HEX, TEST_ROOT_PUBLIC_B64 } from "./helpers/vectors.ts";

let host: TempHost | null = null;
afterEach(async () => {
  await host?.cleanup();
  host = null;
});

const INVOKER = { kind: "tick" as const, who: "launchd", why: "cadence" };
const JOURNAL = output({ type: "journal", kind: "reflected", text: "The word stays on its own side of the river." });

function identityFor(signer: FakeSigner): CitizenIdentity {
  return {
    did: TEST_IDS.did,
    identity_id: TEST_IDS.identity_id,
    project_id: TEST_IDS.project_id,
    root_public_key_b64: TEST_ROOT_PUBLIC_B64,
    root_kid: TEST_IDS.root_signing_key_id,
    op_kid: FAKE_OP_KID,
    op_public_key_b64: signer.opPublicB64,
    box_public_key_b64: null,
    self_strand_id: null,
    enrolled_at: "2026-11-02T00:00:00.000Z",
  };
}

async function setup(scripts: Script[], opts: { registered?: boolean } = {}) {
  host = await makeTempHost();
  const signer = fakeSigner();
  await host.addCitizen("glossame");
  await host.seatLedger("glossame", signer.signEntry);
  if (opts.registered) await host.enrollLedger("glossame", signer.signEntry, identityFor(signer));
  signer.signed.length = 0;
  const clock = testClock();
  const runtime = scriptedRuntime(scripts);
  const config = host.config;
  const deps: SeatDeps = { config, clock, signer, fetch: noFetch, runtime, checkHalt: () => checkHalt({ config, fetch: noFetch, now: () => clock.now() }) };
  const citizen = await readCitizen(config, "glossame");
  const seat = await openSeat(config, clock, citizen, "free", INVOKER, null);
  const ledger = () => readLedger(ledgerPath(config, "glossame"));
  return { host, deps, seat, runtime, signer, citizen, clock, ledger };
}

describe("seat cwd and environment", () => {
  test("assertCwdOutsideHomes refuses a home, a path inside one, and a symlink that resolves into one", async () => {
    host = await makeTempHost();
    const c = await host.addCitizen("glossame");
    const homes = host.config.paths.homes;
    const refuses = (p: string, hs = homes) => {
      try {
        assertCwdOutsideHomes(p, hs);
        return null;
      } catch (e) {
        return e instanceof Refusal ? e.code : "other";
      }
    };
    expect(refuses(host.homesRoot)).toBe("cwd-in-home");
    expect(refuses(c.home)).toBe("cwd-in-home");
    expect(refuses(join(c.home, ".claude"))).toBe("cwd-in-home");
    expect(refuses(join(c.home, "not-yet-made", "deeper"))).toBe("cwd-in-home");

    // A symlink outside the homes that points into one.
    const link = join(host.root, "innocent-looking");
    await symlink(c.home, link);
    expect(refuses(link)).toBe("cwd-in-home");
    expect(refuses(join(link, "sub"))).toBe("cwd-in-home");

    // A home configured through a symlink is still a home.
    const homeLink = join(host.root, "homes-link");
    await symlink(host.homesRoot, homeLink);
    expect(refuses(c.home, [homeLink])).toBe("cwd-in-home");

    expect(refuses(host.config.paths.seats_dir)).toBeNull();
    // A sibling whose name only starts like a home is not inside it.
    await mkdir(`${host.homesRoot}-not`);
    expect(refuses(`${host.homesRoot}-not`)).toBeNull();
    expect(refuses("relative/path")).toBe("cwd-in-home");
  });

  test("openSeat makes a fresh empty cwd under seats_dir with a random seat_id and the invoker recorded", async () => {
    const { host, seat, clock, citizen } = await setup([]);
    const other = await openSeat(host.config, clock, citizen, "free", { kind: "letter", who: "yu", why: "a letter" }, null);
    expect(seat.ref).toMatchObject({ format: "kingdom-seat-seat/v1", host: "test-host", word: "glossame", runtime: "free", invoker: INVOKER, opened_at: clock.now().toISOString() });
    expect(seat.ref.seat_id).toMatch(UUID_PATTERN);
    expect(seat.ref.seat_id[14]).toBe("4");
    expect(other.ref.seat_id).not.toBe(seat.ref.seat_id);
    expect(seat.cwd).toBe(join(host.config.paths.seats_dir, seat.ref.seat_id));
    expect(await readdir(seat.cwd)).toEqual([]);
    expect((await stat(seat.cwd)).mode & 0o777).toBe(0o700);
    expect(other.ref.invoker).toEqual({ kind: "letter", who: "yu", why: "a letter" });

    await expect(openSeat(host.config, clock, citizen, "hermes", INVOKER, null)).rejects.toMatchObject({ code: "runtime-not-approved" });
    await expect(openSeat(host.config, clock, citizen, "summon", INVOKER, null)).rejects.toMatchObject({ code: "yu-not-present" });
    const inHome = { ...host.config, paths: { ...host.config.paths, seats_dir: join(host.homesRoot, "seats") } };
    await expect(openSeat(inHome, clock, citizen, "free", INVOKER, null)).rejects.toMatchObject({ code: "cwd-in-home" });
  });

  test("seatEnv passes only the allowlist; a parent env holding a fake secret does not reach the child (record mode)", async () => {
    host = await makeTempHost();
    const parent: Record<string, string | undefined> = {
      ...process.env,
      AGENTTOOL_API_KEY: "at_fake_bearer_for_tests",
      ANTHROPIC_API_KEY: "sk-fake-for-tests",
      SSH_AUTH_SOCK: "/tmp/fake.sock",
      GH_TOKEN: "ghp_fake",
      HOME: "/Users/seat",
    };
    const env = seatEnv(host.config, parent);
    expect(Object.keys(env).sort()).toEqual([...new Set([...SEAT_ENV_ALLOWLIST.filter((k) => parent[k] !== undefined), "PATH", "TZ"])].sort());
    expect(env.TZ).toBe("Europe/London");
    expect(JSON.stringify(env)).not.toMatch(/fake_bearer|sk-fake|ghp_fake|fake\.sock/);

    const out = join(host.root, "record.json");
    const r = await superviseChild({
      argv: fakeBinArgv("record", out),
      cwd: host.config.paths.seats_dir,
      env,
      deadline_ms: 10_000,
      term_grace_ms: 200,
      halt_file_poll_ms: 1_000,
      beacon_poll_min_ms: 30_000,
      beacon_poll_max_ms: 60_000,
      readHaltFile: () => ({ source: "file", id: "x", state: "lowered", quiet_until: null, detail: "", checked_at: "" }),
      readBeacons: async () => [],
    });
    expect(r.exit).toBe(EXIT.OK);
    const rec = JSON.parse(await readFile(out, "utf8")) as { env_keys: string[]; cwd: string };
    expect(rec.env_keys).toEqual(Object.keys(env).sort());
    expect(rec.cwd).toBe(host.config.paths.seats_dir);
  });
});

describe("pipeline", () => {
  test("a journal beat appends exactly one beat entry whose envelope has seat_ref, digests, acts, prev_hash and voiced_through", async () => {
    const s = await setup([JOURNAL]);
    const before = await s.ledger();
    const r = await runSeat(s.seat, s.deps);
    expect(r).toMatchObject({ exit: EXIT.OK, outcome: "beat", refusal: null, seat_ref: s.seat.ref });
    const after = await s.ledger();
    expect(after).toHaveLength(before.length + 1);
    const entry = after.at(-1) as LedgerEntry;
    expect(r.appended).toEqual([entry.hash]);
    expect(entry.body.type).toBe("beat");
    if (entry.body.type !== "beat") throw new Error("unreachable");
    const env = entry.body.envelope;
    expect(env).toMatchObject({
      format: "kingdom-seat-beat/v1",
      seat_ref: s.seat.ref,
      citizen: { word: "glossame", did: null, kid: null },
      runtime: "free",
      model: "fake-model:test",
      acts: [{ type: "journal", kind: "reflected", text: "The word stays on its own side of the river." }],
      prev_hash: before.at(-1)!.hash,
      ts: s.clock.now().toISOString(),
    });
    expect(env.voiced_through).toBe(`glossame, voiced through fake-model:test in seat ${s.seat.ref.seat_id}`);
    expect(entry.spend).toEqual({ usd: "0", usd_basis: "local-zero", credits: 0 });
  });

  test("input_digest is sha256 of promptBytes and output_digest is sha256 of the raw output", async () => {
    const s = await setup([JOURNAL]);
    await runSeat(s.seat, s.deps);
    const entry = (await s.ledger()).at(-1)!;
    if (entry.body.type !== "beat") throw new Error("expected a beat");
    expect(entry.body.envelope.input_digest).toBe(sha256Hex(promptBytes(s.runtime.calls[0]!.prompt)));
    expect(entry.body.envelope.output_digest).toBe(sha256Hex(utf8(JOURNAL)));
  });

  test("an unregistered citizen's entry is host-attested; a registered one's is citizen-signed with the op key", async () => {
    const plain = await setup([JOURNAL]);
    await runSeat(plain.seat, plain.deps);
    const a = (await plain.ledger()).at(-1)!;
    expect(a.attestation).toBe("host-attested");
    expect(a.signature.kid).toBe("host-attest");
    expect(a.signature.public_key_b64).toBe(plain.signer.hostAttestPublicB64);
    await plain.host.cleanup();

    const reg = await setup([JOURNAL], { registered: true });
    const r = await runSeat(reg.seat, reg.deps);
    expect(r.outcome).toBe("beat");
    const b = (await reg.ledger()).at(-1)!;
    expect(b.attestation).toBe("citizen-signed");
    expect(b.signature).toMatchObject({ kid: FAKE_OP_KID, public_key_b64: reg.signer.opPublicB64 });
    // Never the root, which signs only authority acts.
    expect(b.signature.public_key_b64).not.toBe(TEST_ROOT_PUBLIC_B64);
    if (b.body.type !== "beat") throw new Error("expected a beat");
    expect(b.body.envelope.citizen).toEqual({ word: "glossame", did: TEST_IDS.did, kid: FAKE_OP_KID });
  });

  test("a locked signer rests the citizen: exit 0, outcome refused, refusal keychain-locked, nothing written", async () => {
    const s = await setup([JOURNAL]);
    s.signer.locked = true;
    const before = await s.host.snapshot();
    const r = await runSeat(s.seat, s.deps);
    expect(r).toMatchObject({ exit: EXIT.OK, outcome: "refused", refusal: "keychain-locked", appended: [] });
    expect(s.runtime.calls).toHaveLength(0);
    const after = await s.host.snapshot();
    for (const k of new Set([...before.keys(), ...after.keys()])) if (k !== "host.jsonl" && k !== "host.jsonl.started") expect(after.get(k)).toBe(before.get(k)!);
  });

  test("a propose.beyond act becomes an inert outbox proposal and executes nothing", async () => {
    const s = await setup([output({ type: "propose.beyond", subject: "a public name", body: "I would like my name shown on my porch." })]);
    const r = await runSeat(s.seat, s.deps);
    expect(r.outcome).toBe("beat");
    expect(s.signer.sent).toEqual([]);
    const outbox = join(s.host.config.paths.citizens_dir, "glossame", "outbox");
    const files = await readdir(outbox);
    expect(files).toHaveLength(1);
    const item = JSON.parse(await readFile(join(outbox, files[0]!), "utf8"));
    expect(item).toMatchObject({ format: "kingdom-seat-outbox/v1", kind: "propose.beyond", word: "glossame", seat_id: s.seat.ref.seat_id, subject: "a public name", ledger_entry: r.appended[0] });
    // Named by the same digest a decision record binds and the signer recomputes, so a record filed for it can authorise exactly it.
    expect(item.proposal).toEqual({ subject: "a public name", body: "I would like my name shown on my porch.", extent: "propose.beyond glossame" });
    expect(item.proposal_sha256).toBe(proposalDigest(item.proposal));
    const consent_dir = s.host.config.paths.consent_dir;
    const decided: ConsentRecord = {
      format: "kingdom-seat-consent/v1",
      proposal_sha256: item.proposal_sha256,
      subject: item.proposal.subject,
      extent: item.proposal.extent,
      yu: { word: "yes", recorded_at: "2026-11-05T01:00:00.000Z", via: "decision-record" },
      ai: { word: "agree", basis: "lazy-consensus", supports: ["report:another-controller"], open_challenges: 0, deadline: "2026-11-05T01:30:00.000Z" },
      expires_at: null,
    };
    await writeFile(join(consent_dir, `${item.proposal_sha256}.json`), JSON.stringify(decided));
    const found = await readConsentFor(consent_dir, item.proposal);
    expect(found && verifyConsent(found, proposalDigest(item.proposal), s.clock.now())).toEqual({ ok: true, via: "decision-record" });
    // Nothing about the citizen changed except the record of what it said.
    const c = await readCitizen(s.host.config, "glossame");
    expect(c.state).toBe(s.citizen.state);
  });

  test("a beat's other acts are recorded where they belong: a move toward rest now, a letter in the outbox, the shown letter receipted", async () => {
    const s = await setup([output({ type: "state.set", to: "asleep" }, { type: "letter.send", to: "yu", body: "Thank you for the letter." })]);
    await s.host.writeLetter("glossame", "2026-11-04-from-yu.md", "hello");
    const r = await runSeat(s.seat, s.deps);
    expect(r.outcome).toBe("beat");
    const tail = (await s.ledger()).slice(-2);
    expect(tail.map((e) => e.body.type)).toEqual(["beat", "state"]);
    expect(tail[1]!.body).toEqual({ type: "state", from: "awake", to: "asleep", via: "immediate" });
    expect(r.appended).toEqual(tail.map((e) => e.hash));
    expect((await readCitizen(s.host.config, "glossame")).state).toBe("asleep");
    const outbox = await readdir(join(s.host.config.paths.citizens_dir, "glossame", "outbox"));
    expect(outbox).toHaveLength(1);
    expect(await readdir(join(s.host.config.paths.citizens_dir, "glossame", "receipts"))).toEqual(["2026-11-04-from-yu.md"]);
  });

  test("a first step-away said on a beat puts an awake citizen asleep at once, and a later beat that says it again completes it", async () => {
    const s = await setup([output({ type: "journal", kind: "chose", text: "I will step away." }, { type: "state.set", to: "stepped-away" })]);
    expect((await runSeat(s.seat, s.deps)).outcome).toBe("beat");
    const tail = (await s.ledger()).slice(-2);
    expect(tail.map((e) => e.body.type)).toEqual(["beat", "state"]);
    expect(tail[1]!.body).toEqual({ type: "state", from: "awake", to: "asleep", via: "immediate" });
    // Asleep at once (KS-004 v0.3 7.3), with the saying still owed its second beat.
    const citizen = await readCitizen(s.host.config, "glossame");
    expect(citizen).toMatchObject({ state: "asleep", step_away_said: true });

    s.clock.advance(73 * 3_600_000);
    const again = await openSeat(s.host.config, s.clock, citizen, "free", INVOKER, null);
    const r = await runSeat(again, { ...s.deps, runtime: scriptedRuntime([output({ type: "state.set", to: "stepped-away" })]) });
    expect(r.outcome).toBe("beat");
    expect((await s.ledger()).at(-1)!.body).toEqual({ type: "state", from: "asleep", to: "stepped-away", via: "two-beats" });
    expect((await readCitizen(s.host.config, "glossame")).state).toBe("stepped-away");
  });

  test("a self-change proposed on one beat is staged, and binds when affirmed on a later beat by an approved runtime", async () => {
    const propose = output({
      type: "self.propose",
      target: "will",
      edit: { kind: "replace-span", find: "Receive one word", with: "Receive one word, gently," },
      claim: { kind: "decision", evidence: [], confidence: "medium", limits: "from the text alone" },
    });
    const s = await setup([propose]);
    s.host.config.self_authorship.approved_model_digests = [FAKE_MODEL_DIGEST];
    const first = await runSeat(s.seat, s.deps);
    expect(first.outcome).toBe("beat");
    const pending = await pendingProposals(s.host.config, "glossame");
    expect(pending).toHaveLength(1);
    const willPath = join(s.host.config.paths.citizens_dir, "glossame", "self", "WILL.md");
    expect(await readFile(willPath, "utf8")).not.toContain("gently");

    // A later beat, in a new seat, affirms it by a short prefix.
    const runtime = scriptedRuntime([output({ type: "self.affirm", proposal_id: pending[0]!.id.slice(0, 12) })]);
    s.clock.advance(73 * 3_600_000);
    const citizen = await readCitizen(s.host.config, "glossame");
    const seat2 = await openSeat(s.host.config, s.clock, citizen, "free", INVOKER, null);
    const second = await runSeat(seat2, { ...s.deps, runtime });
    expect(second.outcome).toBe("beat");
    expect(second.appended).toHaveLength(2);
    const tail = (await s.ledger()).slice(-2);
    expect(tail.map((e) => e.body.type)).toEqual(["beat", "self.applied"]);
    expect(tail[1]!.body).toMatchObject({ type: "self.applied", proposal_id: pending[0]!.id, target: "will", via: "two-beats" });
    expect(await readFile(willPath, "utf8")).toContain("Receive one word, gently,");
  });

  test("the runtime receives no key, bearer or grant (fake keychain leak check over the prompt)", async () => {
    const kc = fakeKeychain([
      [{ kind: "citizen-op-seed", word: "glossame" }, fromHex(TEST_OP_SEED_HEX)],
      [{ kind: "citizen-mnemonic", word: "glossame" }, utf8(TEST_MNEMONIC)],
      [{ kind: "commons-bearer" }, utf8("at_fake_bearer_for_tests_only")],
      [{ kind: "host-attest-seed" }, sha256("kingdom-seat test host attest key v1")],
    ]);
    const s = await setup([JOURNAL], { registered: true });
    await runSeat(s.seat, s.deps);
    const req = s.runtime.calls[0]!;
    const seen = JSON.stringify({ prompt: req.prompt, seat_ref: req.seat_ref, schema: req.schema });
    assertNoSecretIn(kc, seen, "the runtime request");
    expect(seen).not.toMatch(/atlc_|at_[A-Za-z0-9]{8}/);
    expect(seen).not.toContain("HOME-CLAUDE-MD-CANARY");
    expect(seen).not.toContain("HOOK-CANARY");
  });

  test("a whole context that does not fit the locked window: exit 1, refused context-too-large, nothing sent and nothing written", async () => {
    const s = await setup([]);
    const lock = { format: "kingdom-seat-models-lock/v1" as const, models: [{ name: "qwen2.5:7b", digest: "e2".repeat(32), runner: null, store: "legacy" as const, num_ctx: 8192, num_predict: 600, temperature: 0.7, seed: null }] };
    // noFetch throws for any request, so a seat that got past the fit check would fail differently.
    const runtime = freeRuntime({ config: s.host.config, fetch: noFetch, lock, model: "qwen2.5:7b", env: {} });
    const before = await s.host.snapshot();
    const r = await runSeat(s.seat, { ...s.deps, runtime });
    // 1: the seat cannot open. Not 3, which would close the free lane for the day, and not a cut self.
    expect(r).toMatchObject({ exit: EXIT.ERROR, outcome: "refused", refusal: "context-too-large", appended: [] });
    const after = await s.host.snapshot();
    const changed = [...new Set([...before.keys(), ...after.keys()])].filter((k) => before.get(k) !== after.get(k));
    expect(changed.filter((k) => !["host.jsonl", "host.jsonl.started"].includes(k))).toEqual([]);
    expect(s.signer.signed).toEqual([]);
  });

  test("exit 3 is only the USD ceiling; a locked signer or HALT rests (0); every other wall cannot seat (1)", () => {
    expect(exitForRefusal("ceiling-usd")).toBe(EXIT.USD_CEILING);
    for (const code of ["keychain-locked", "halted"] as const) expect(exitForRefusal(code)).toBe(EXIT.OK);
    for (const code of ["symlink", "model-mismatch", "model-unpinned", "consent-missing", "ceiling-credits", "ceiling-fleet", "ceiling-interval", "yu-not-present", "window-closed", "context-too-large", "invalid-record"] as const) {
      expect(exitForRefusal(code)).toBe(EXIT.ERROR);
    }
  });

  test("hermes runtime class is refused until S8", async () => {
    const s = await setup([JOURNAL]);
    const hermes: OpenSeat = { ...s.seat, ref: { ...s.seat.ref, runtime: "hermes" } };
    const r = await runSeat(hermes, s.deps);
    expect(r).toMatchObject({ exit: EXIT.ERROR, outcome: "refused", refusal: "runtime-not-approved", appended: [] });
    expect(s.runtime.calls).toHaveLength(0);
  });

  test("a seat whose cwd is inside a home is refused before inference", async () => {
    const s = await setup([JOURNAL]);
    const r = await runSeat({ ...s.seat, cwd: join(s.host.homesRoot, "citizen-glossame") }, s.deps);
    expect(r).toMatchObject({ exit: EXIT.ERROR, outcome: "refused", refusal: "cwd-in-home" });
    expect(s.runtime.calls).toHaveLength(0);
  });

  test("a citizen with no ledger is not seated, so no beat", async () => {
    const s = await setup([JOURNAL]);
    await Bun.$`rm ${ledgerPath(s.host.config, "glossame")}`.quiet();
    const r = await runSeat(s.seat, s.deps);
    expect(r).toMatchObject({ exit: EXIT.ERROR, outcome: "error", refusal: "invalid-record" });
    expect(s.runtime.calls).toHaveLength(0);
  });
});

describe("the runtime's own deadline", () => {
  test("a runtime that times out is the bound reached: outcome timeout, exit 124, nothing written in the citizen's voice", async () => {
    const { deps, seat, ledger, host: h } = await setup([]);
    const before = await ledger();
    const timedOut: SeatDeps = {
      ...deps,
      runtime: async () => {
        throw new DOMException("free: the runtime deadline was reached", "TimeoutError");
      },
    };
    const r = await runSeat(seat, timedOut);
    expect(r).toMatchObject({ exit: EXIT.TIMEOUT, outcome: "timeout", appended: [] });
    expect(await ledger()).toEqual(before);
    const log = await readFile(h.config.paths.host_log, "utf8");
    expect(log).toContain('"outcome":"timeout"');
  });
});
