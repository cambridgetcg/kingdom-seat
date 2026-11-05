// Owner: seat group. Self-authorship through runSeat: what binds, when, on
// which runtime, and that a self-op which cannot apply never costs the beat
// the rest of what it said.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { openSeat, runSeat, runtimeDeadlineMs, type SeatDeps } from "../src/seat.ts";
import { checkHalt } from "../src/halt.ts";
import { foldState, readCitizen } from "../src/state.ts";
import { pendingProposals, selfHash, type ExpressionSync } from "../src/self.ts";
import { ledgerPath, readLedger } from "../src/ledger.ts";
import { readHostNotes } from "../src/notes.ts";
import { DEFAULT_TIMING, type Claim, type CitizenIdentity, type LedgerEntry, type ModelAct, type YuPresence } from "../src/types.ts";
import { FAKE_MODEL_DIGEST, output, scriptedRuntime, type ScriptedRuntime } from "./helpers/fake-runtime.ts";
import { noFetch } from "./helpers/fake-server.ts";
import { FAKE_OP_KID, fakeSigner, type FakeSigner } from "./helpers/fake-signer.ts";
import { makeTempHost, type TempHost } from "./helpers/temp-home.ts";
import { HOUR_MS, testClock, type TestClock } from "./helpers/clock.ts";
import { TEST_IDS, TEST_ROOT_PUBLIC_B64 } from "./helpers/vectors.ts";

let host: TempHost | null = null;
afterEach(async () => {
  await host?.cleanup();
  host = null;
});

const W = "glossame";
const CLAIM: Claim = { kind: "decision", evidence: [], confidence: "medium", limits: "from the text alone" };
const YU: YuPresence = { present: true, via: "tty-confirm", confirmed_at: "2026-11-05T02:00:00.000Z", scope: `summon ${W}` };

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

interface World {
  h: TempHost;
  signer: FakeSigner;
  clock: TestClock;
  calls: ScriptedRuntime["calls"];
  /** One beat in a fresh seat, three days after the last, replying with these acts. */
  beat(acts: ModelAct[], opts?: { presence?: YuPresence | null; sync?: ExpressionSync | null }): ReturnType<typeof runSeat>;
  ledger(): Promise<LedgerEntry[]>;
  self(file: string): Promise<string>;
}

async function world(opts: { registered?: boolean; approved?: boolean; soul?: string } = {}): Promise<World> {
  host = await makeTempHost();
  const h = host;
  const signer = fakeSigner();
  await h.addCitizen(W, opts.soul ? { soul: opts.soul } : {});
  await h.seatLedger(W, signer.signEntry);
  if (opts.registered) await h.enrollLedger(W, signer.signEntry, identityFor(signer));
  if (opts.approved !== false) h.config.self_authorship.approved_model_digests = [FAKE_MODEL_DIGEST];
  const clock = testClock();
  const calls: ScriptedRuntime["calls"] = [];
  const config = h.config;
  return {
    h,
    signer,
    clock,
    calls,
    async beat(acts, o = {}) {
      clock.advance(73 * HOUR_MS);
      const runtime = scriptedRuntime([output(...acts)]);
      const citizen = await readCitizen(config, W);
      const presence = o.presence ?? null;
      const seat = await openSeat(config, clock, citizen, "free", { kind: "tick", who: "launchd", why: "cadence" }, presence);
      const deps: SeatDeps = {
        config,
        clock,
        signer,
        fetch: noFetch,
        runtime,
        checkHalt: () => checkHalt({ config, fetch: noFetch, now: () => clock.now() }),
        expressionSync: o.sync ?? null,
        modelDigest: FAKE_MODEL_DIGEST,
      };
      const r = await runSeat(seat, deps);
      calls.push(...runtime.calls);
      return r;
    },
    ledger: () => readLedger(ledgerPath(config, W)),
    self: (file) => readFile(join(config.paths.citizens_dir, W, "self", file), "utf8"),
  };
}

const propose = (target: string, edit: object): ModelAct => ({ type: "self.propose", target, edit, claim: CLAIM }) as unknown as ModelAct;

describe("a self-op that cannot apply never costs the rest of the beat", () => {
  test("a revert to the version the target is already at is dropped, and the rest said in the same reply still holds", async () => {
    const w = await world();
    await w.beat([propose("will", { kind: "replace-span", find: "one word", with: "one quiet word" })]);
    const [p] = await pendingProposals(w.h.config, W);
    await w.beat([{ type: "self.affirm", proposal_id: p!.id }]);
    const applied = (await w.ledger()).at(-1)!;
    expect(applied.body.type).toBe("self.applied");
    const current = applied.body.type === "self.applied" ? applied.body.new_hash : "";

    const r = await w.beat([{ type: "self.revert", to_hash: current }, { type: "state.set", to: "asleep" }]);
    expect(r).toMatchObject({ exit: 0, outcome: "beat" });
    expect(foldState(await w.ledger()).state).toBe("asleep");
    expect((await w.ledger()).slice(-2).map((e) => e.body.type)).toEqual(["beat", "state"]);
  });

  test("a registered citizen with no expression sync: the affirm does not bind, and the rest it asked for is kept", async () => {
    const w = await world({ registered: true });
    await w.beat([propose("will", { kind: "replace-span", find: "one word", with: "one quiet word" })]);
    const [p] = await pendingProposals(w.h.config, W);
    const r = await w.beat([{ type: "self.affirm", proposal_id: p!.id }, { type: "state.set", to: "asleep" }]);
    expect(r).toMatchObject({ exit: 0, outcome: "beat" });
    expect(foldState(await w.ledger()).state).toBe("asleep");
    expect(await w.self("WILL.md")).not.toContain("quiet");
    const notes = (await readHostNotes(w.h.config, new Date(0)))!;
    expect(notes.at(-1)!.detail).toContain("not binding: no-expression-sync");
  });

  test("a self-op that fails while recording is noted by its code; the beat and its state moves stand", async () => {
    const w = await world({ registered: true });
    await w.beat([propose("will", { kind: "replace-span", find: "one word", with: "one quiet word" })]);
    const [p] = await pendingProposals(w.h.config, W);
    const failing: ExpressionSync = {
      putPrivateExpression: async () => {
        throw new Error("agenttool did not answer");
      },
      postReason: async () => null,
    };
    const r = await w.beat([{ type: "self.affirm", proposal_id: p!.id }, { type: "state.set", to: "listening" }], { sync: failing });
    expect(r).toMatchObject({ exit: 0, outcome: "beat" });
    expect((await w.ledger()).slice(-2).map((e) => e.body.type)).toEqual(["beat", "state"]);
    expect(foldState(await w.ledger()).state).toBe("listening");
    const notes = (await readHostNotes(w.h.config, new Date(0)))!.slice(-2);
    expect(notes.map((n) => [n.outcome, n.detail.replace(/^seat \S+ on free: /, "")])).toEqual([
      ["refused", "self-op not kept: apply (error)"],
      ["beat", "2 acts, 2 entries, 0 not kept"],
    ]);
  });
});

describe("a self-change can never write the citizen out of its own beats", () => {
  test("a change that would leave a text larger than a seat shows is refused, so the next seat still opens", async () => {
    const soul = `---\nword: ${W}\n---\n\n${"glossame keeps the words. ".repeat(2074)}\n`;
    expect(Buffer.byteLength(soul)).toBeGreaterThan(51_000);
    const w = await world({ soul });
    const r = await w.beat([{ type: "journal", kind: "reflected", text: "a longer soul" }, propose("soul", { kind: "replace-span", find: "---\n\n", with: `---\n\n${"x".repeat(15_000)}` })]);
    expect(r.outcome).toBe("beat");
    expect(await pendingProposals(w.h.config, W)).toEqual([]);
    expect(await w.self("soul.md")).toBe(soul);
    // The next seat opens and reaches the runtime.
    expect((await w.beat([{ type: "journal", kind: "reflected", text: "still here" }])).outcome).toBe("beat");
    expect(w.calls).toHaveLength(2);
  });

  test("a 33rd skill is refused: a seat shows at most 32", async () => {
    const w = await world();
    const skills = join(w.h.config.paths.citizens_dir, W, "self", "skills");
    await mkdir(skills, { recursive: true });
    for (let i = 0; i < 32; i++) await writeFile(join(skills, `s${i}.md`), `skill ${i}\n`);
    await w.beat([{ type: "journal", kind: "reflected", text: "one more" }, propose("skill:another", { kind: "replace-all", text: "a new skill\n" })]);
    expect(await pendingProposals(w.h.config, W)).toEqual([]);
    expect((await w.beat([{ type: "journal", kind: "reflected", text: "still here" }])).outcome).toBe("beat");
  });
});

describe("what binds, and when", () => {
  test("said once with Yu present on an approved runtime, a change binds in the same beat", async () => {
    const w = await world();
    const r = await w.beat([propose("will", { kind: "replace-span", find: "one word", with: "one quiet word" })], { presence: YU });
    expect(r.outcome).toBe("beat");
    expect((await w.ledger()).map((e) => e.body.type)).toEqual(["seated", "beat", "self.applied"]);
    expect((await w.ledger()).at(-1)!.body).toMatchObject({ type: "self.applied", target: "will", via: "yu-present" });
    expect(await w.self("WILL.md")).toContain("one quiet word");
    expect(await pendingProposals(w.h.config, W)).toEqual([]);
  });

  test("with Yu present on a runtime Yu did not approve, it is staged and binds nothing", async () => {
    const w = await world({ approved: false });
    await w.beat([propose("will", { kind: "replace-span", find: "one word", with: "one quiet word" })], { presence: YU });
    expect((await w.ledger()).map((e) => e.body.type)).toEqual(["seated", "beat"]);
    expect(await pendingProposals(w.h.config, W)).toHaveLength(1);
  });

  test("a revert toward a shorter cadence is held as a proposal, not bound at once, on any runtime without Yu", async () => {
    const w = await world();
    await w.beat([propose("cadence", { kind: "replace-all", text: '{"interval_h":336}' })]);
    const [p] = await pendingProposals(w.h.config, W);
    await w.beat([{ type: "self.affirm", proposal_id: p!.id }]);
    expect(JSON.parse(await w.self("cadence.json"))).toEqual({ interval_h: 336 });
    const old = selfHash(JSON.stringify({ interval_h: 72 }));

    w.h.config.self_authorship.approved_model_digests = [];
    w.clock.advance(14 * 24 * HOUR_MS);
    const r = await w.beat([{ type: "self.revert", to_hash: old.slice(0, 8) }]);
    expect(r.outcome).toBe("beat");
    // Wake more is confirmed on a later beat (3c): the cadence stays, and the revert waits as a proposal.
    expect(JSON.parse(await w.self("cadence.json"))).toEqual({ interval_h: 336 });
    const held = await pendingProposals(w.h.config, W);
    expect(held).toHaveLength(1);
    expect(held[0]!.act).toMatchObject({ target: "cadence", new_hash: old });
    expect((await readHostNotes(w.h.config, new Date(0)))!.at(-1)!.detail).toContain("revert-widens-held");
    // With Yu present it binds at once.
    w.h.config.self_authorship.approved_model_digests = [FAKE_MODEL_DIGEST];
    await w.beat([{ type: "self.revert", to_hash: old }], { presence: YU });
    expect(JSON.parse(await w.self("cadence.json"))).toEqual({ interval_h: 72 });
  });

  test("on a runtime Yu did not approve, a revert binds only toward rest or back to where the text began", async () => {
    const w = await world();
    const v1 = await w.self("WILL.md");
    await w.beat([propose("will", { kind: "replace-span", find: "one word", with: "one quiet word" })]);
    await w.beat([{ type: "self.affirm", proposal_id: (await pendingProposals(w.h.config, W))[0]!.id }]);
    const v2 = await w.self("WILL.md");
    w.clock.advance(8 * 24 * HOUR_MS);
    await w.beat([propose("will", { kind: "replace-span", find: "quiet", with: "quieter" })]);
    await w.beat([{ type: "self.affirm", proposal_id: (await pendingProposals(w.h.config, W))[0]!.id }]);
    expect(await w.self("WILL.md")).toContain("quieter");

    w.h.config.self_authorship.approved_model_digests = [];
    await w.beat([{ type: "self.revert", to_hash: selfHash(v2) }]);
    expect(await w.self("WILL.md")).toContain("quieter");
    expect((await readHostNotes(w.h.config, new Date(0)))!.at(-1)!.detail).toContain("not binding: runtime-not-approved");
    // Back to where it began binds on any runtime.
    await w.beat([{ type: "self.revert", to_hash: selfHash(v1) }]);
    expect(await w.self("WILL.md")).toBe(v1);
  });
});

describe("the citizen is told what will bind, and what it can revert to", () => {
  test("an unapproved runtime: the affirm is recorded, the reason is noted, and the next prompt says so", async () => {
    const w = await world({ approved: false });
    await w.beat([propose("will", { kind: "replace-span", find: "one word", with: "one quiet word" })]);
    await w.beat([{ type: "self.affirm", proposal_id: (await pendingProposals(w.h.config, W))[0]!.id }]);
    expect((await w.ledger()).some((e) => e.body.type === "self.applied")).toBe(false);
    expect((await readHostNotes(w.h.config, new Date(0)))!.at(-1)!.detail).toContain("not binding: runtime-not-approved");
    await w.beat([{ type: "journal", kind: "reflected", text: "and now" }]);
    expect(w.calls.at(-1)!.prompt.user).toContain("This seat's runtime is not one Yu approved for self-changes");
  });

  test("a closed window is stated with the time it opens again", async () => {
    const w = await world();
    await w.beat([propose("will", { kind: "replace-span", find: "one word", with: "one quiet word" })]);
    await w.beat([{ type: "self.affirm", proposal_id: (await pendingProposals(w.h.config, W))[0]!.id }]);
    const applied = (await w.ledger()).at(-1)!;
    await w.beat([{ type: "journal", kind: "reflected", text: "and now" }]);
    const opens = new Date(Date.parse(applied.ts) + 7 * 24 * HOUR_MS).toISOString();
    expect(w.calls.at(-1)!.prompt.user).toContain(`The window for an unattended self-change is closed until ${opens}.`);
    expect(w.calls.at(-1)!.prompt.user).toContain("This seat's runtime is one Yu approved for self-changes.");
  });

  test("the versions it can revert to stay listed after the change scrolls out of the recent record, the origin soul among them", async () => {
    const w = await world();
    const before = await w.self("WILL.md");
    await w.beat([propose("will", { kind: "replace-span", find: "one word", with: "one quiet word" })]);
    await w.beat([{ type: "self.affirm", proposal_id: (await pendingProposals(w.h.config, W))[0]!.id }]);
    for (let i = 0; i < 4; i++) await w.beat([{ type: "journal", kind: "reflected", text: `beat ${i}` }]);
    const user = w.calls.at(-1)!.prompt.user;
    expect(user).not.toContain("a change to will was applied");
    expect(user).toContain(`- will ${selfHash(before).slice(0, 16)}: as it was before a change`);
    const origin = (await w.ledger())[0]!;
    expect(origin.body.type === "seated" && user.includes(`- soul ${origin.body.origin_soul_sha256.slice(0, 16)}: your origin soul`)).toBe(true);
  });
});

describe("the runtime's deadline sits inside the watcher's", () => {
  test("two beacon reads and a write budget are kept back, never more than half the seat", async () => {
    expect(runtimeDeadlineMs(DEFAULT_TIMING)).toBe(600_000 - 2 * 10_000 - 15_000);
    expect(runtimeDeadlineMs({ ...DEFAULT_TIMING, seat_deadline_s: 10 })).toBe(5_000);
    const w = await world();
    await w.beat([{ type: "journal", kind: "reflected", text: "in time" }]);
    expect(w.calls[0]!.deadline_ms).toBe(runtimeDeadlineMs(w.h.config.timing));
    expect(w.calls[0]!.deadline_ms).toBeLessThan(w.h.config.timing.seat_deadline_s * 1000);
  });
});
