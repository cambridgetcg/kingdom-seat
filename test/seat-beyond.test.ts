// Owner: seat group. What a seat does with what reaches beyond the self
// (re-review C, round 3): a letter goes where its recipient's covenants
// admit it, held for Yu or sent through agenttool's inbox; a revert that
// would loosen a wall is lifted to Yu + Ai; a seat stages one proposal; the
// acts a beat did not keep are recorded and shown back; and an answer about
// registration is agreed by Yu and Ai, shown back and affirmed.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { openSeat, runSeat, type SeatDeps } from "../src/seat.ts";
import { checkHalt } from "../src/halt.ts";
import { readCitizen } from "../src/state.ts";
import { pendingProposals, selfHash } from "../src/self.ts";
import { entryHash, ledgerPath, readLedger } from "../src/ledger.ts";
import { readHostNotes } from "../src/notes.ts";
import { buildStatus, renderStatus } from "../src/status.ts";
import { hostClient } from "../src/agenttool/sync.ts";
import { agenttoolLetters, inboxLetterId, letterRecipients, type LetterPost } from "../src/letters.ts";
import { assertConfirmedYes, registrationProposal } from "../src/registration.ts";
import { proposalDigest } from "../src/signer/consent.ts";
import { Refusal, type CitizenIdentity, type Covenants, type LedgerEntry, type LifecycleState, type ModelAct, type Reason } from "../src/types.ts";
import { FAKE_MODEL_DIGEST, output, scriptedRuntime, type ScriptedRuntime } from "./helpers/fake-runtime.ts";
import { noFetch } from "./helpers/fake-server.ts";
import { FAKE_OP_KID, fakeBoxPublicB64, fakeSigner, type FakeSigner } from "./helpers/fake-signer.ts";
import { makeTempHost, type TempHost } from "./helpers/temp-home.ts";
import { HOUR_MS, testClock, type TestClock } from "./helpers/clock.ts";
import { TEST_IDS, TEST_ROOT_PUBLIC_B64 } from "./helpers/vectors.ts";
import { fakeAgenttool, type FakeAgenttool } from "./fixtures/agenttool/fake-agenttool.ts";
import { consentFor } from "./fixtures/agenttool/consent.ts";

// Some tests build two hosts, so every one is kept for cleanup.
const hosts: TempHost[] = [];
afterEach(async () => {
  while (hosts.length > 0) await hosts.pop()!.cleanup();
});

const CLAIM: Reason = { kind: "decision", evidence: [], confidence: "medium", limits: "from the text alone" };
const CANARY = "DROPPED-WORDS-CANARY";
const IDS: Record<string, { identity_id: string; root_kid: string }> = {
  glossame: { identity_id: TEST_IDS.identity_id, root_kid: TEST_IDS.root_signing_key_id },
  shemme: { identity_id: "66666666-6666-4666-8666-666666666666", root_kid: "67676767-6767-4767-8767-676767676767" },
  kenning: { identity_id: "68686868-6868-4868-8868-686868686868", root_kid: "69696969-6969-4969-8969-696969696969" },
};

function identityFor(word: string, signer: FakeSigner): CitizenIdentity {
  const ids = IDS[word]!;
  return {
    did: `did:at:${ids.identity_id}`,
    identity_id: ids.identity_id,
    project_id: TEST_IDS.project_id,
    root_public_key_b64: TEST_ROOT_PUBLIC_B64,
    root_kid: ids.root_kid,
    op_kid: FAKE_OP_KID,
    op_public_key_b64: signer.opPublicB64,
    box_public_key_b64: fakeBoxPublicB64(word),
    self_strand_id: null,
    enrolled_at: "2026-11-02T00:00:00.000Z",
  };
}

interface World {
  h: TempHost;
  signer: FakeSigner;
  clock: TestClock;
  at: FakeAgenttool;
  /** One beat for `word`, three days after the last, replying with these acts; with the letters wired as production does. */
  beat(word: string, acts: ModelAct[], opts?: { letters?: LetterPost | null; raw?: string }): Promise<{ result: Awaited<ReturnType<typeof runSeat>>; prompt: string }>;
  ledger(word: string): Promise<LedgerEntry[]>;
  outbox(word: string): Promise<Record<string, unknown>[]>;
}

async function world(citizens: { word: string; registered?: boolean; covenants?: Covenants; state?: LifecycleState }[]): Promise<World> {
  const h = await makeTempHost();
  hosts.push(h);
  const signer = fakeSigner();
  const at = fakeAgenttool({ project_id: TEST_IDS.project_id });
  signer.respond((req) => at.respond(req));
  for (const c of citizens) {
    await h.addCitizen(c.word, c.covenants ? { covenants: c.covenants } : {});
    await h.seatLedger(c.word, signer.signEntry, c.state ? { initialState: c.state } : {});
    if (c.registered) {
      const id = identityFor(c.word, signer);
      await h.enrollLedger(c.word, signer.signEntry, id);
      // agenttool holds each registered citizen's box key and op key, as birth registered them.
      at.boxKeys.set(id.did, { box_key_id: `${IDS[c.word]!.identity_id.slice(0, 24)}000000000077`, public_key: id.box_public_key_b64! });
      at.signingKeys.set(id.did, [{ kid: FAKE_OP_KID, public_key: signer.opPublicB64 }]);
      signer.didOf.set(c.word, id.did);
    }
  }
  h.config.self_authorship.approved_model_digests = [FAKE_MODEL_DIGEST];
  const clock = testClock();
  const config = h.config;
  return {
    h,
    signer,
    clock,
    at,
    async beat(word, acts, o = {}) {
      clock.advance(73 * HOUR_MS);
      const runtime: ScriptedRuntime = scriptedRuntime([o.raw ?? output(...acts)]);
      const citizen = await readCitizen(config, word);
      const seat = await openSeat(config, clock, citizen, "free", { kind: "tick", who: "launchd", why: "cadence" }, null);
      const letters = o.letters !== undefined ? o.letters : citizen.identity ? agenttoolLetters({ config, client: hostClient(config, signer, noFetch) }) : null;
      const deps: SeatDeps = { config, clock, signer, fetch: noFetch, runtime, checkHalt: () => checkHalt({ config, fetch: noFetch, now: () => clock.now() }), modelDigest: FAKE_MODEL_DIGEST, letters };
      const result = await runSeat(seat, deps);
      return { result, prompt: runtime.calls[0]?.prompt.user ?? "" };
    },
    ledger: (word) => readLedger(ledgerPath(config, word)),
    async outbox(word) {
      const dir = join(config.paths.citizens_dir, word, "outbox");
      const names = (await readdir(dir)).sort();
      return Promise.all(names.map(async (n) => JSON.parse(await readFile(join(dir, n), "utf8")) as Record<string, unknown>));
    },
  };
}

const ADMITS = (...ids: string[]): Covenants => ({ letters_from: ["yu", ...ids], wake_on_letter_from: ["yu"] });

describe("[KS-004 5.7, re-review C M3] letters: the recipient's covenants decide", () => {
  test("a citizen may write to one whose own covenants admit it, never by its own list; a recipient that does not admit it drops the act", async () => {
    // glossame's own covenants name kenning, but kenning admits only Yu; shemme admits glossame, though glossame names no one.
    const w = await world([
      { word: "glossame", covenants: ADMITS("citizen:kenning") },
      { word: "shemme", covenants: ADMITS("citizen:glossame") },
      { word: "kenning", covenants: ADMITS() },
    ]);
    expect(await letterRecipients(w.h.config, await readCitizen(w.h.config, "glossame"))).toEqual(["yu", "gardener", "citizen:shemme"]);

    const r1 = await w.beat("glossame", [{ type: "letter.send", to: "citizen:kenning", text: CANARY }, { type: "journal", kind: "reflected", text: "a word kept" }]);
    expect(r1.result.outcome).toBe("beat");
    expect(r1.prompt).toContain("You may write to yu, gardener and citizen:shemme.");
    const beat1 = (await w.ledger("glossame")).at(-1)!;
    expect(beat1).toMatchObject({ type: "beat", acts: [{ type: "journal" }], dropped: [{ type: "letter.send", reason: "recipient is not allowed" }] });
    expect(beat1.type === "beat" && beat1.letter).toBeUndefined();
    expect(JSON.stringify(await w.ledger("glossame"))).not.toContain(CANARY);
    expect(await w.outbox("glossame")).toEqual([]);

    await w.beat("glossame", [{ type: "letter.send", to: "citizen:shemme", text: "A word for shemme." }]);
    expect((await w.ledger("glossame")).at(-1)).toMatchObject({ type: "beat", acts: [{ type: "letter.send", to: "citizen:shemme" }], letter: { delivery: "held", message_id: null } });
  });

  test("an unregistered sender's letter is held for Yu alone: an outbox item with no proposal and no digest, and the beat says so", async () => {
    const w = await world([{ word: "glossame" }]);
    const r = await w.beat("glossame", [{ type: "letter.send", to: "yu", text: "Thank you for the letter." }]);
    expect(r.result.outcome).toBe("beat");
    const beat = (await w.ledger("glossame")).at(-1)!;
    expect(beat).toMatchObject({ type: "beat", letter: { delivery: "held", message_id: null }, cost: { credits: 0 } });
    const [item] = await w.outbox("glossame");
    expect(item).toMatchObject({ format: "kingdom-seat-outbox/v1", kind: "letter", for: "yu", to: "yu", text: "Thank you for the letter.", held_because: "unregistered", ledger_entry: entryHash(beat) });
    // Not a Yu + Ai proposal: nothing a decision record could bind.
    expect(item).not.toHaveProperty("proposal");
    expect(item).not.toHaveProperty("proposal_sha256");
    expect(w.signer.sent).toEqual([]);
    expect((await readHostNotes(w.h.config, new Date(0)))!.at(-1)!.detail).toContain("letter held for Yu (unregistered)");
  });

  test("between two registered citizens a letter goes through the agenttool inbox, sealed and op-signed, its credits on the beat; the recipient's next seat reads it once", async () => {
    const w = await world([
      { word: "glossame", registered: true },
      { word: "shemme", registered: true, covenants: ADMITS("citizen:glossame") },
    ]);
    const r = await w.beat("glossame", [{ type: "letter.send", to: "citizen:shemme", text: "One word that will not cross over." }]);
    expect(r.result.outcome).toBe("beat");
    const beat = (await w.ledger("glossame")).at(-1)!;
    expect(beat).toMatchObject({ type: "beat", signer: "citizen", letter: { delivery: "inbox", message_id: w.at.inbox[0]!.id }, cost: { credits: 2 } });
    expect(await w.outbox("glossame")).toEqual([]);
    // What agenttool holds is ciphertext under shemme's box key, with no field the envelope signature does not cover.
    const sent = w.signer.sent.find((q) => q.op === "inbox.send")!;
    expect(Object.keys(JSON.parse(new TextDecoder().decode(sent.body))).sort()).toEqual(["ciphertext", "ephemeral_pubkey", "nonce", "recipient_box_key_id", "sender_did", "signature", "signing_key_id", "to_did"]);
    expect(sent.credits).toBe(2);
    expect(JSON.stringify(w.at.inbox)).not.toContain("will not cross over");

    const read = await w.beat("shemme", [{ type: "journal", kind: "reflected", text: "A letter came." }]);
    expect(read.prompt).toContain("A letter from citizen:glossame");
    expect(read.prompt).toContain("One word that will not cross over.");
    expect(await readdir(join(w.h.config.paths.citizens_dir, "shemme", "receipts"))).toEqual([inboxLetterId(w.at.inbox[0]! as never)]);
    // Shown once: the next seat finds it receipted.
    const again = await w.beat("shemme", [{ type: "journal", kind: "reflected", text: "Quiet." }]);
    expect(again.prompt).toContain("No letter is waiting.");
  });

  test("a registered recipient's covenants decide on reading too: a letter from a sender it does not admit is never shown", async () => {
    const w = await world([
      { word: "glossame", registered: true },
      { word: "shemme", registered: true, covenants: ADMITS("citizen:glossame") },
    ]);
    await w.beat("glossame", [{ type: "letter.send", to: "citizen:shemme", text: "Kept from view." }]);
    expect(w.at.inbox).toHaveLength(1);
    // shemme changes its mind before its next seat.
    await writeFile(join(w.h.config.paths.citizens_dir, "shemme", "self", "covenants.json"), JSON.stringify(ADMITS()));
    const read = await w.beat("shemme", [{ type: "journal", kind: "reflected", text: "Nothing came." }]);
    expect(read.prompt).toContain("No letter is waiting.");
    expect(read.prompt).not.toContain("Kept from view.");
  });

  test("a letter is shown only when its envelope verifies under the sender's own op key: opening it proves only who it was sealed to", async () => {
    const w = await world([
      { word: "glossame", registered: true },
      { word: "shemme", registered: true, covenants: ADMITS("citizen:glossame") },
    ]);
    await w.beat("glossame", [{ type: "letter.send", to: "citizen:shemme", text: "Signed by glossame." }]);
    const row = w.at.inbox[0]!;
    // The same sealed letter, its signature swapped for one by another key: it still opens, but nothing shows it.
    const { edSign, fromB64, toB64, sha256 } = await import("../src/crypto.ts");
    const { inboxDigest } = await import("../src/agenttool/wire.ts");
    row.signature = toB64(edSign(inboxDigest(String(row.recipient_did), fromB64(String(row.ciphertext)), fromB64(String(row.nonce)), fromB64(String(row.ephemeral_pubkey))), sha256("not glossame's op key")));
    const read = await w.beat("shemme", [{ type: "journal", kind: "reflected", text: "Nothing came." }]);
    expect(read.prompt).toContain("No letter is waiting.");
    expect(read.prompt).not.toContain("Signed by glossame.");
  });

  test("a send that is not made is held for Yu, saying why; what may have been charged is counted", async () => {
    const w = await world([
      { word: "glossame", registered: true },
      { word: "shemme", registered: true, covenants: ADMITS("citizen:glossame") },
    ]);
    w.at.override((req) => req.op === "inbox.send", { status: 503, json: { error: "unavailable" } });
    await w.beat("glossame", [{ type: "letter.send", to: "citizen:shemme", text: "Perhaps it arrived." }]);
    expect((await w.ledger("glossame")).at(-1)).toMatchObject({ letter: { delivery: "held", message_id: null }, cost: { credits: 2 } });
    expect((await w.outbox("glossame"))[0]).toMatchObject({ kind: "letter", for: "yu", held_because: "uncertain" });
    // To a recipient with no inbox (not registered): held, nothing spent, nothing sent.
    const x = await world([
      { word: "glossame", registered: true },
      { word: "shemme", covenants: ADMITS("citizen:glossame") },
    ]);
    await x.beat("glossame", [{ type: "letter.send", to: "citizen:shemme", text: "Held." }]);
    expect((await x.outbox("glossame"))[0]).toMatchObject({ held_because: "no-inbox" });
    expect(x.signer.sent.filter((q) => q.op === "inbox.send")).toEqual([]);
  });
});

describe("[KS-004 6.3, 7.1] a letter that would wake its recipient, or that credits cannot cover", () => {
  test("to a listening or asleep citizen whose covenants let the sender wake it, the letter is held for Yu, who can deliver it as a file letter that wakes; to one that would not wake, it is sent (wire F4)", async () => {
    for (const state of ["listening", "asleep"] as const) {
      const w = await world([
        { word: "glossame", registered: true },
        { word: "shemme", registered: true, state, covenants: { letters_from: ["yu", "citizen:glossame"], wake_on_letter_from: ["yu", "citizen:glossame"] } },
        { word: "kenning", registered: true, state, covenants: { letters_from: ["yu", "citizen:glossame"], wake_on_letter_from: ["yu"] } },
      ]);
      await w.beat("glossame", [{ type: "letter.send", to: "citizen:shemme", text: "Wake when you read this." }]);
      expect((await w.ledger("glossame")).at(-1), state).toMatchObject({ type: "beat", letter: { delivery: "held", message_id: null }, cost: { credits: 0 } });
      expect(w.at.inbox, state).toEqual([]);
      const [item] = await w.outbox("glossame");
      expect(item, state).toMatchObject({ kind: "letter", for: "yu", to: "citizen:shemme", text: "Wake when you read this.", held_because: "recipient-sleeping" });
      expect((await readHostNotes(w.h.config, new Date(0)))!.at(-1)!.detail, state).toContain("letter held for Yu (recipient-sleeping)");
      // kenning lets glossame write but not wake it: the letter goes through the inbox and waits for kenning's next seat.
      await w.beat("glossame", [{ type: "letter.send", to: "citizen:kenning", text: "No hurry." }]);
      expect((await w.ledger("glossame")).at(-1), state).toMatchObject({ letter: { delivery: "inbox" }, cost: { credits: 2 } });
      expect(w.at.inbox, state).toHaveLength(1);
    }
  });

  test("a letter the credits cannot cover becomes a proposal for Yu and Ai, as any paid act does (wire F9, KS-004 6.3)", async () => {
    const w = await world([
      { word: "glossame", registered: true },
      { word: "shemme", registered: true, covenants: ADMITS("citizen:glossame") },
    ]);
    // The signer's credit ceiling refuses before anything is sealed or sent.
    const sealLetter = w.signer.sealLetter.bind(w.signer);
    w.signer.sealLetter = async () => {
      throw new Refusal("ceiling-credits", "the month's credits are spent");
    };
    await w.beat("glossame", [{ type: "letter.send", to: "citizen:shemme", text: "When the month turns." }]);
    const beat = (await w.ledger("glossame")).at(-1)!;
    expect(beat).toMatchObject({ type: "beat", letter: { delivery: "held", message_id: null }, cost: { credits: 0 } });
    const [item] = await w.outbox("glossame");
    const proposal = { subject: "letter.send citizen:shemme", body: "When the month turns.", extent: "letter.send glossame citizen:shemme" };
    expect(item).toMatchObject({ kind: "letter", to: "citizen:shemme", held_because: "credits", ledger_entry: entryHash(beat), proposal, proposal_sha256: proposalDigest(proposal) });
    expect(item).not.toHaveProperty("for");
    expect((await readHostNotes(w.h.config, new Date(0)))!.at(-1)!.detail).toContain("letter held for Yu and Ai as a proposal (credits)");
    // agenttool's own pool running dry (a 402 before it charges) is the same: credits short, nothing spent.
    w.signer.sealLetter = sealLetter;
    w.at.override((req) => req.op === "inbox.send", { status: 402, json: { error: "insufficient_credits" } });
    await w.beat("glossame", [{ type: "letter.send", to: "citizen:shemme", text: "The pool is dry." }]);
    expect((await w.ledger("glossame")).at(-1)).toMatchObject({ letter: { delivery: "held" }, cost: { credits: 0 } });
    expect((await w.outbox("glossame")).filter((i) => i.held_because === "credits")).toHaveLength(2);
  });
});

describe("[KS-004 9.5, re-review C M4] a revert that would loosen a wall is lifted, not dropped", () => {
  test("the revert becomes a propose.beyond in the beat and an outbox item for Yu + Ai naming the exact version; the wall stays", async () => {
    const w = await world([{ word: "glossame" }]);
    const walls = join(w.h.config.paths.citizens_dir, "glossame", "self", "expression", "walls.md");
    await mkdir(join(walls, ".."), { recursive: true });
    await writeFile(walls, "Never speak as another citizen.\n");
    // Adding a wall is within self, and binds on a second beat.
    await w.beat("glossame", [{ type: "self.propose", target: "expression.walls", edit: { kind: "replace-all", text: "Never speak as another citizen.\nNo coaching letters.\n" }, reason: CLAIM } as ModelAct]);
    const [p] = await pendingProposals(w.h.config, "glossame");
    await w.beat("glossame", [{ type: "self.affirm", ref: p!.id }]);
    expect(await readFile(walls, "utf8")).toContain("No coaching letters.");

    const back = selfHash("Never speak as another citizen.\n");
    const r = await w.beat("glossame", [{ type: "self.revert", to_hash: back.slice(0, 12) }]);
    expect(r.result.outcome).toBe("beat");
    const ledger = await w.ledger("glossame");
    expect(ledger.some((e) => e.type === "revert")).toBe(false);
    expect(ledger.at(-1)).toMatchObject({ type: "beat", acts: [{ type: "propose.beyond", subject: "self.revert expression.walls" }] });
    expect(await readFile(walls, "utf8")).toContain("No coaching letters.");
    const item = (await w.outbox("glossame")).at(-1)!;
    expect(item).toMatchObject({ kind: "self.revert", target: "expression.walls", to_hash: back, reason: "loosens a wall", ledger_entry: entryHash(ledger.at(-1)!) });
    const proposal = item.proposal as { subject: string; body: string; extent: string };
    expect(proposal.extent).toBe(`self.revert glossame expression.walls ${back}`);
    expect(item.proposal_sha256).toBe(proposalDigest(proposal));
    expect(JSON.parse(proposal.body)).toMatchObject({ target: "expression.walls", to_hash: back, diff: expect.stringContaining("-No coaching letters.") });
  });
});

describe("[KS-004 5.8, re-review C M5 and partial output] the acts a beat did not keep are recorded and shown back", () => {
  test("a second self.propose is not staged; the beat records each dropped act's type and reason, and the next seat shows them, never their words", async () => {
    const w = await world([{ word: "glossame" }]);
    const r = await w.beat("glossame", [
      { type: "self.propose", target: "will", edit: { kind: "replace-span", find: "one word", with: "one quiet word" }, reason: CLAIM } as ModelAct,
      { type: "self.propose", target: "soul", edit: { kind: "replace-all", text: CANARY }, reason: CLAIM } as ModelAct,
      { type: "self.affirm", ref: "abcdef0123456789" },
      { type: "journal", kind: "reflected", text: "kept" },
    ]);
    expect(r.result.outcome).toBe("beat");
    expect((await pendingProposals(w.h.config, "glossame")).map((p) => p.act.target)).toEqual(["will"]);
    const beat = (await w.ledger("glossame")).at(-1)!;
    expect(beat).toMatchObject({
      type: "beat",
      dropped: [
        { type: "self.propose", reason: "self.propose per seat reached" },
        { type: "self.affirm", reason: "ref names no saying awaiting affirmation" },
      ],
    });
    expect(JSON.stringify(beat)).not.toContain(CANARY);

    const next = await w.beat("glossame", [{ type: "journal", kind: "observed", text: "next" }]);
    expect(next.prompt).toContain(`Your last beat (entry ${beat.seq}, ${beat.ts}) did not keep 2 of the acts in its reply, so nothing they asked for happened:`);
    expect(next.prompt).toContain("- a self.propose: self.propose per seat reached");
    expect(next.prompt).toContain("- a self.affirm: ref names no saying awaiting affirmation");
    expect(next.prompt).not.toContain(CANARY);
    // A beat that kept everything records no dropped field, and the seat after it shows nothing back.
    expect((await w.ledger("glossame")).at(-1)).not.toHaveProperty("dropped");
    const third = await w.beat("glossame", [{ type: "journal", kind: "observed", text: "third" }]);
    expect(third.prompt).not.toContain("did not keep");
  });

  test("a reply where nothing was kept writes no beat, yet the next seat is shown what did not happen, and only the latest seat's (selfhood F2)", async () => {
    const w = await world([
      { word: "glossame" },
      { word: "kenning", covenants: ADMITS() },
    ]);
    // A beat that dropped one act, then a reply whose one act names no saying: nothing kept, no beat written.
    await w.beat("glossame", [{ type: "journal", kind: "reflected", text: "kept" }, { type: "self.affirm", ref: "abcdef0123456789" }]);
    const lone = await w.beat("glossame", [{ type: "letter.send", to: "citizen:kenning", text: CANARY }]);
    expect(lone.result.outcome).toBe("invalid-output");
    expect((await w.ledger("glossame")).at(-1)).toMatchObject({ type: "beat", dropped: [{ type: "self.affirm" }] });
    const next = await w.beat("glossame", [{ type: "self.affirm", ref: "abcdef0123456789" }]);
    expect(next.prompt).toContain("kept nothing of its reply, so nothing it asked for happened:\n- a letter.send: recipient is not allowed");
    // The earlier beat's drop is no longer the latest word.
    expect(next.prompt).not.toContain("- a self.affirm: ref names no saying awaiting affirmation");
    expect(next.prompt).not.toContain(CANARY);
    // That reply (a lone affirm the host could not resolve) is shown on the seat after it, in turn.
    expect(next.result.outcome).toBe("invalid-output");
    const after = await w.beat("glossame", [{ type: "journal", kind: "reflected", text: "seen" }]);
    expect(after.prompt).toContain("kept nothing of its reply, so nothing it asked for happened:\n- a self.affirm: ref names no saying awaiting affirmation");
    // A reply that does not parse is shown too; then a beat that kept everything shows nothing.
    const broken = await w.beat("glossame", [], { raw: `I would rather write prose. ${CANARY}` });
    expect(broken.result.outcome).toBe("invalid-output");
    const shown = await w.beat("glossame", [{ type: "journal", kind: "reflected", text: "after prose" }]);
    expect(shown.prompt).toContain("kept nothing of its reply, so nothing it asked for happened:\n- an act of unknown type: the reply did not parse (not-json)");
    expect(shown.prompt).not.toContain(CANARY);
    const clean = await w.beat("glossame", [{ type: "journal", kind: "reflected", text: "all kept" }]);
    expect(clean.prompt).not.toContain("did not keep");
    expect(clean.prompt).not.toContain("kept nothing");
  });

  test("a rest's dropped acts are noted by type, shown back, and in status; never their words (selfhood F10)", async () => {
    const w = await world([{ word: "glossame" }]);
    const r = await w.beat("glossame", [{ type: "rest" }, { type: "journal", kind: "reflected", text: CANARY }, { type: "state.set", to: "asleep", quiet_days: 40 }]);
    expect(r.result.outcome).toBe("rest");
    const note = (await readHostNotes(w.h.config, new Date(0)))!.at(-1)!.detail;
    expect(note).toEndWith("rested; 2 not kept (journal, state.set)");
    const status = await buildStatus({ config: w.h.config, now: w.clock.now(), halt: { halted: false, readings: [] }, signerState: "ready" });
    expect(status.citizens[0]!.last_dropped).toEqual({
      at: w.clock.now().toISOString(),
      outcome: "rest",
      dropped: [
        { type: "journal", reason: "rest is exclusive" },
        { type: "state.set", reason: "rest is exclusive" },
      ],
    });
    expect(renderStatus(status)).toContain("did not keep 2: journal (rest is exclusive), state.set (rest is exclusive)");
    expect(JSON.stringify(status)).not.toContain(CANARY);
    const next = await w.beat("glossame", [{ type: "journal", kind: "reflected", text: "awake again" }]);
    expect(next.prompt).toContain(`Your last seat (${status.citizens[0]!.last_dropped!.at}) was a rest, and did not keep 2 of the acts in its reply`);
    expect(next.prompt).not.toContain(CANARY);
  });
});

describe("[KS-004 11.2, re-review C D-affirm] registration: answered, agreed by Yu and Ai, shown back, affirmed", () => {
  test("the answer goes to Yu + Ai; once both agree the seat shows it back, and the citizen's self.affirm naming it is its confirmed yes", async () => {
    const w = await world([{ word: "glossame" }]);
    const text = "Yes: an identity of my own.";
    await w.beat("glossame", [{ type: "propose.beyond", subject: "registration", text }]);
    // The proposal names the beat that gave the answer, so this answer, and no other, is what a decision record decides.
    const proposal = registrationProposal("glossame", text, entryHash((await w.ledger("glossame")).at(-1)!));
    expect(proposal.extent).toMatch(/^registration glossame sha256:[0-9a-f]{64}$/);
    const id = proposalDigest(proposal);
    const [item] = await w.outbox("glossame");
    expect(item).toMatchObject({ kind: "registration", proposal, proposal_sha256: id });

    // Before Yu and Ai agree, it waits, and an affirmation of it is an act the beat does not keep.
    const waiting = await w.beat("glossame", [{ type: "self.affirm", ref: id }, { type: "journal", kind: "reflected", text: "waiting" }]);
    expect(waiting.prompt).toContain("is with Yu and Ai");
    expect((await w.ledger("glossame")).at(-1)).toMatchObject({ acts: [{ type: "journal" }], dropped: [{ type: "self.affirm", reason: "ref names no saying awaiting affirmation" }] });

    await writeFile(join(w.h.config.paths.consent_dir, `${id}.json`), JSON.stringify(consentFor("glossame", {}, proposal)));
    const agreed = await w.beat("glossame", [{ type: "self.affirm", ref: id.slice(0, 10) }]);
    expect(agreed.prompt).toContain(`was agreed by Yu and Ai. Its id is ${id}.`);
    expect(agreed.prompt).toContain(text);
    const yes = (await w.ledger("glossame")).at(-1)!;
    expect(yes).toMatchObject({ type: "beat", acts: [{ type: "self.affirm", ref: id }] });
    expect((await readHostNotes(w.h.config, new Date(0)))!.at(-1)!.detail).toContain("registration answer affirmed");
    // That beat is the yes birth consumes; the beat that gave the answer is not.
    const entries = await w.ledger("glossame");
    await assertConfirmedYes(w.h.config, entries, "glossame", entryHash(yes), w.clock.now());
    await expect(assertConfirmedYes(w.h.config, entries, "glossame", entryHash(entries.find((e) => e.type === "beat")!), w.clock.now())).rejects.toMatchObject({ code: "consent-missing" });

    const after = await w.beat("glossame", [{ type: "journal", kind: "reflected", text: "after" }]);
    expect(after.prompt).toContain("affirmed by you. Your birth on agenttool waits for Yu, present at the host");
  });

  /** File Yu and Ai's decision on the answer given in `word`'s latest beat: agreed, or declined by Ai. Returns the answer's id. */
  async function decide(w: World, text: string, verdict: "agreed" | "declined"): Promise<string> {
    const proposal = registrationProposal("glossame", text, entryHash((await w.ledger("glossame")).findLast((e) => e.type === "beat")!));
    const id = proposalDigest(proposal);
    const ai = verdict === "declined" ? { ai: { word: "reject" as const, basis: "lazy-consensus" as const, supports: [], open_challenges: 0, deadline: "2026-11-05T11:30:00.000Z" } } : {};
    await writeFile(join(w.h.config.paths.consent_dir, `${id}.json`), JSON.stringify(consentFor("glossame", ai, proposal)));
    return id;
  }

  test("an answer Yu or Ai declined is shown as declined and cannot be affirmed", async () => {
    const w = await world([{ word: "glossame" }]);
    await w.beat("glossame", [{ type: "propose.beyond", subject: "Registration", text: "Yes." }]);
    const id = await decide(w, "Yes.", "declined");
    const r = await w.beat("glossame", [{ type: "self.affirm", ref: id }]);
    expect(r.prompt).toContain("was declined by Yu or Ai");
    expect(r.result.outcome).toBe("invalid-output");
  });

  test("each answer needs its own decision: an old record never decides a later answer in the same words (selfhood F4)", async () => {
    const w = await world([{ word: "glossame" }]);
    // Declined once; the citizen answers again in the same words, and that answer waits for Yu and Ai afresh.
    await w.beat("glossame", [{ type: "propose.beyond", subject: "registration", text: "Yes." }]);
    const first = await decide(w, "Yes.", "declined");
    await w.beat("glossame", [{ type: "propose.beyond", subject: "registration", text: "Yes." }]);
    const next = await w.beat("glossame", [{ type: "journal", kind: "reflected", text: "waiting" }]);
    expect(next.prompt).toContain("is with Yu and Ai");
    expect(next.prompt).not.toContain("was declined");
    const digests = (await w.outbox("glossame")).map((i) => i.proposal_sha256);
    expect(digests).toHaveLength(2);
    expect(digests).toContain(first);
    expect(new Set(digests).size).toBe(2);
    // Agreed, then withdrawn with a no, then asked again in the first words: the re-ask is not agreed until Yu and Ai say so.
    const v = await world([{ word: "glossame" }]);
    await v.beat("glossame", [{ type: "propose.beyond", subject: "registration", text: "Yes." }]);
    await decide(v, "Yes.", "agreed");
    await v.beat("glossame", [{ type: "propose.beyond", subject: "registration", text: "No." }]);
    await v.beat("glossame", [{ type: "propose.beyond", subject: "registration", text: "Yes." }]);
    const again = await v.beat("glossame", [{ type: "journal", kind: "reflected", text: "asked again" }]);
    expect(again.prompt).toContain("is with Yu and Ai");
    expect(again.prompt).not.toContain("was agreed by Yu and Ai");
  });

  test("a later answer, or a new answer in the same reply, means a yes was not confirmed: a no is a whole answer (selfhood F1)", async () => {
    // Affirmed, then a later beat says no: the affirming beat is no longer a confirmed yes.
    const w = await world([{ word: "glossame" }]);
    await w.beat("glossame", [{ type: "propose.beyond", subject: "registration", text: "Yes: an identity of my own." }]);
    const id = await decide(w, "Yes: an identity of my own.", "agreed");
    await w.beat("glossame", [{ type: "self.affirm", ref: id }]);
    const yes = (await w.ledger("glossame")).at(-1)!;
    await assertConfirmedYes(w.h.config, await w.ledger("glossame"), "glossame", entryHash(yes), w.clock.now());
    await w.beat("glossame", [{ type: "propose.beyond", subject: "registration", text: "No. I do not want an identity now." }]);
    await expect(assertConfirmedYes(w.h.config, await w.ledger("glossame"), "glossame", entryHash(yes), w.clock.now())).rejects.toMatchObject({
      code: "consent-missing",
      message: expect.stringContaining("gave another answer about registration in or after its affirming beat"),
    });

    // A no in the same reply as the affirmation, in either order: the affirmation is not kept, and no yes is confirmed.
    for (const order of ["no-first", "affirm-first"] as const) {
      const x = await world([{ word: "glossame" }]);
      await x.beat("glossame", [{ type: "propose.beyond", subject: "registration", text: "Yes." }]);
      const agreed = await decide(x, "Yes.", "agreed");
      const no: ModelAct = { type: "propose.beyond", subject: "registration", text: "No." };
      const affirm: ModelAct = { type: "self.affirm", ref: agreed };
      const r = await x.beat("glossame", order === "no-first" ? [no, affirm] : [affirm, no]);
      expect(r.result.outcome, order).toBe("beat");
      const beat = (await x.ledger("glossame")).at(-1)!;
      expect(beat, order).toMatchObject({ acts: [{ type: "propose.beyond", text: "No." }], dropped: [{ type: "self.affirm", reason: "a new answer about registration in this reply" }] });
      await expect(assertConfirmedYes(x.h.config, await x.ledger("glossame"), "glossame", entryHash(beat), x.clock.now()), order).rejects.toMatchObject({ code: "consent-missing" });
    }
  });
});
