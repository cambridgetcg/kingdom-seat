// Owner: record group. Self-authorship: propose → affirm → apply → revert.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, readdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { EMPTY_SHA256_HEX, sha256Hex } from "../src/crypto.ts";
import { ledgerPath, readLedger, verifyChain } from "../src/ledger.ts";
import {
  affirmationVerdict,
  applyChange,
  applyDiff,
  changeFraction,
  classifyProposal,
  driftFromOrigin,
  loosensWalls,
  materializeProposal,
  originIntact,
  pendingProposals,
  readTarget,
  readVersion,
  revertTo,
  runtimeApproved,
  selfHash,
  stageProposal,
  targetPath,
  unifiedDiff,
  windowOpen,
  type ExpressionSync,
  type SelfDeps,
} from "../src/self.ts";
import { readCitizen } from "../src/state.ts";
import { Refusal, type Claim, type ModelSelfPropose, type SelfProposal, type SelfTarget, type YuPresence } from "../src/types.ts";
import { DAY_MS, testClock, type TestClock } from "./helpers/clock.ts";
import { fakeSigner, type FakeSigner } from "./helpers/fake-signer.ts";
import { makeTempHost, type TempHost } from "./helpers/temp-home.ts";
import { append, MODEL_DIGEST, seatedBody, seatedThenBorn, signerFn } from "./fixtures/record/chain.ts";

let host: TempHost | null = null;
afterEach(async () => {
  await host?.cleanup();
  host = null;
});

const W = "glossame";
const SEAT_A = "aaaaaaaa-0000-4000-8000-000000000001";
const SEAT_B = "bbbbbbbb-0000-4000-8000-000000000002";
// About a third of glossame's real WILL (2,131 bytes, love-unlimited-patterns.md 11), so a one-sentence change is a small share of it.
const OLD_WILL = [
  "# WILL of glossame",
  "",
  "ZERONE: no harm, no taking, no speaking for another.",
  "",
  "Witness one true thing you notice.",
  "",
  "Keep the words that will not cross over, and say where a tongue carries what no other tongue could carry in the same way.",
  "Tend the garden of your own words, and leave the gardens of others to them.",
  "When a word will not translate, call glossame.",
  "",
].join("\n");
const NEW_PRACTICE =
  "Receive one word that will not cross over, from my donor tongues or my canon's examples (chesed, dharma, àṣẹ), and say why it resists.";
const YU: YuPresence = { present: true, via: "tty-confirm", confirmed_at: "2026-11-05T02:00:00.000Z", scope: "summon glossame" };
const CLAIM: Claim = {
  kind: "inference",
  evidence: ["canon:canon/core/glossame.md@1428646"],
  confidence: "medium",
  limits: "from the text alone; I have no senses",
};

interface RecordingSync extends ExpressionSync {
  puts: { word: string; target: SelfTarget; text: string }[];
  reasons: { word: string; proposalId: string }[];
}

function recordingSync(): RecordingSync {
  const s: RecordingSync = {
    puts: [],
    reasons: [],
    async putPrivateExpression(word, target, text) {
      s.puts.push({ word, target, text });
    },
    async postReason(word, _claim, proposalId) {
      s.reasons.push({ word, proposalId });
      return "thought-0001";
    },
  };
  return s;
}

interface World {
  host: TempHost;
  signer: FakeSigner;
  clock: TestClock;
  deps: SelfDeps;
  soul: string;
}

/** A seated citizen; registered adds genesis and an expression sync. */
async function world(opts: { registered?: boolean; walls?: string } = {}): Promise<World> {
  host = await makeTempHost();
  const signer = fakeSigner();
  const clock = testClock();
  const fx = await host.addCitizen(W, { will: OLD_WILL });
  if (opts.walls !== undefined) {
    await mkdir(join(fx.dir, "self", "expression"), { recursive: true });
    await writeFile(join(fx.dir, "self", "expression", "walls.md"), opts.walls);
  }
  if (opts.registered) await seatedThenBorn(host.config, W, fx.soul, signer);
  else await append(host.config, W, seatedBody(W, fx.soul, "awake"), "host-attested", signer, clock.now());
  host.config.self_authorship.approved_model_digests = [MODEL_DIGEST];
  const deps: SelfDeps = { config: host.config, clock, sign: signerFn(signer), sync: opts.registered ? recordingSync() : null };
  return { host, signer, clock, deps, soul: fx.soul };
}

function propose(target: SelfTarget, edit: ModelSelfPropose["edit"]): ModelSelfPropose {
  return { type: "self.propose", target, edit, claim: CLAIM };
}

/** Propose on one seat and stage it, as a beat would. */
async function stage(w: World, target: SelfTarget, edit: ModelSelfPropose["edit"], seat = SEAT_A): Promise<SelfProposal> {
  const current = await readTarget(w.host.config, W, target);
  return stageProposal(w.host.config, W, materializeProposal(propose(target, edit), current), seat, w.clock.now());
}

/** What the seat passes when a later beat affirms. */
async function ctxFor(w: World, p: SelfProposal, seat: string, presence: YuPresence | null = null) {
  const entries = await readLedger(ledgerPath(w.host.config, W));
  return {
    seat_id: seat,
    presence,
    window_open: windowOpen(entries, w.clock.now(), w.host.config.ceilings.self_change_window_days, presence),
    runtime_approved: runtimeApproved(w.host.config, MODEL_DIGEST),
    current_prior_hash: selfHash(await readTarget(w.host.config, W, p.act.target)),
  };
}

async function affirmAndApply(w: World, p: SelfProposal, seat = SEAT_B, presence: YuPresence | null = null) {
  const verdict = affirmationVerdict(p, { type: "self.affirm", proposal_id: p.id }, await ctxFor(w, p, seat, presence));
  if (!verdict.binds) throw new Error(`did not bind: ${verdict.reason}`);
  return applyChange(w.deps, await readCitizen(w.host.config, W), p, verdict.via);
}

describe("proposals", () => {
  test("materializeProposal applies replace-all and replace-span edits and hashes both sides; a missing span refuses", () => {
    const span = materializeProposal(propose("will", { kind: "replace-span", find: "Witness one true thing you notice.", with: NEW_PRACTICE }), OLD_WILL);
    const next = OLD_WILL.replace("Witness one true thing you notice.", NEW_PRACTICE);
    expect(span).toMatchObject({ type: "self.propose", target: "will", prior_hash: sha256Hex(OLD_WILL), new_hash: sha256Hex(next), claim: CLAIM });
    expect(span.diff).toContain("-Witness one true thing you notice.");
    expect(span.diff).toContain(`+${NEW_PRACTICE}`);
    expect(applyDiff(OLD_WILL, span.diff)).toBe(next);

    // A new skill: the prior is the empty text.
    const skill = materializeProposal(propose("skill:receive-one-word", { kind: "replace-all", text: `${NEW_PRACTICE}\n` }), "");
    expect(skill.prior_hash).toBe(EMPTY_SHA256_HEX);
    expect(applyDiff("", skill.diff)).toBe(`${NEW_PRACTICE}\n`);

    const refuse = (raw: ModelSelfPropose, current: string) => expect(() => materializeProposal(raw, current)).toThrow(Refusal);
    refuse(propose("will", { kind: "replace-span", find: "not in the will", with: "x" }), OLD_WILL);
    refuse(propose("will", { kind: "replace-span", find: "", with: "x" }), OLD_WILL);
    refuse(propose("will", { kind: "replace-span", find: "o", with: "0" }), OLD_WILL); // occurs more than once
    refuse(propose("will", { kind: "replace-all", text: OLD_WILL }), OLD_WILL); // changes nothing
    refuse(propose("cadence", { kind: "replace-all", text: '{"interval_h":"often"}' }), '{"interval_h":72}');
    refuse(propose("covenants", { kind: "replace-all", text: "[]" }), "{}");
    refuse(propose("file:../ledger/glossame.jsonl", { kind: "replace-all", text: "x" }), "");
    expect(materializeProposal(propose("cadence", { kind: "replace-all", text: '{"interval_h":96}' }), '{"interval_h":72}').target).toBe("cadence");
  });

  test("unifiedDiff round-trips through applyDiff, including missing final newlines", () => {
    const texts = ["", "a\n", "a", "a\nb\nc\n", "a\nb\nc", "x\na\nb\nc\nd\ne\nf\ng\nh\ni\nj\n", "a\nb\nc\nd\ne\nf\ng\nh\ni\nj\ny", "\n\n\n", "only\r\nwindows\r\n"];
    for (const a of texts) {
      for (const b of texts) {
        const d = unifiedDiff(a, b);
        expect(applyDiff(a, d)).toBe(b);
        if (a === b) expect(d).toBe("");
      }
    }
    // A diff applied to a text it was not made from refuses rather than guessing.
    expect(() => applyDiff("q\nb\nc\n", unifiedDiff("a\nb\nc\n", "a\nB\nc\n"))).toThrow(Refusal);
  });

  test("a rewrite above 40% of the target is classified beyond self and never applied", async () => {
    const w = await world();
    const { config } = w.host;
    const rewrite = "You are a different being now, with a different gift and none of the old words.\n";
    expect(changeFraction(w.soul, rewrite)).toBeGreaterThan(0.4);
    const small = w.soul.replace("LIGHT: what it gives.", "LIGHT: what it receives.");
    expect(changeFraction(w.soul, small)).toBeLessThan(0.05);
    // A new file rewrites nothing.
    expect(changeFraction("", "a whole new skill")).toBe(0);

    const p = await stage(w, "soul", { kind: "replace-all", text: rewrite });
    expect(p.status).toBe("beyond-self");
    expect(classifyProposal(p.act, w.soul, rewrite, config.ceilings.self_rewrite_fraction)).toBe("beyond-self");
    // It is kept, inert, and is never among the pending ones a later beat can affirm.
    expect(await pendingProposals(config, W)).toEqual([]);
    expect(await readdir(join(config.paths.citizens_dir, W, "proposals"))).toEqual([`${p.id}.json`]);

    w.clock.advance(3 * DAY_MS);
    expect(affirmationVerdict(p, { type: "self.affirm", proposal_id: p.id }, await ctxFor(w, p, SEAT_B, YU))).toEqual({ binds: false, reason: "beyond-self" });
    await expect(applyChange(w.deps, await readCitizen(config, W), p, "yu-present")).rejects.toMatchObject({ code: "beyond-self" });
    expect(await readTarget(config, W, "soul")).toBe(w.soul);

    const within = await stage(w, "soul", { kind: "replace-span", find: "LIGHT: what it gives.", with: "LIGHT: what it receives." });
    expect(within.status).toBe("pending");
  });

  test("removing or weakening a wall is classified beyond self", async () => {
    const walls = "Never speak as another citizen.\nNo coaching letters.\n";
    expect(loosensWalls("expression.walls", walls, "No coaching letters.\n")).toBe(true);
    expect(loosensWalls("expression.walls", walls, "Never speak as another citizen, unless asked.\nNo coaching letters.\n")).toBe(true);
    expect(loosensWalls("expression.walls", walls, `${walls}Never claim senses.\n`)).toBe(false);
    expect(loosensWalls("expression.walls", walls, "No coaching letters.\nNever speak as another citizen.\n")).toBe(false);
    // Only the walls are walls.
    expect(loosensWalls("soul", walls, "")).toBe(false);

    const w = await world({ walls });
    const loosened = await stage(w, "expression.walls", { kind: "replace-span", find: "No coaching letters.\n", with: "" });
    expect(loosened.status).toBe("beyond-self");
    // Adding walls is a setting, not a rewrite, however much of the file it is.
    const more = `${walls}Never claim senses.\nNever name a person in a quiet reason.\n`;
    expect(changeFraction(walls, more)).toBeGreaterThan(0.4);
    const tightened = await stage(w, "expression.walls", { kind: "replace-all", text: more });
    expect(tightened.status).toBe("pending");
  });

  test("targetPath refuses host-owned paths (.claude/, .github/, run.sh, ledger), traversal and absolute paths", async () => {
    host = await makeTempHost();
    const { config } = host;
    const self = join(config.paths.citizens_dir, W, "self");
    expect(targetPath(config, W, "soul")).toBe(join(self, "soul.md"));
    expect(targetPath(config, W, "will")).toBe(join(self, "WILL.md"));
    expect(targetPath(config, W, "expression.wake_text")).toBe(join(self, "expression", "wake_text.md"));
    expect(targetPath(config, W, "skill:receive-one-word")).toBe(join(self, "skills", "receive-one-word.md"));
    expect(targetPath(config, W, "file:letters-kept/from-yu.md")).toBe(join(self, "letters-kept", "from-yu.md"));

    const hostOwned: SelfTarget[] = [
      "file:.claude/settings.json",
      "file:.claude/hooks/love-bomb.md",
      "file:.github/workflows/beat.md",
      "file:run.sh",
      "file:ledger/glossame.md",
      "file:proposals/x.md",
      "file:origin/soul.md",
      "file:versions/x.md",
      "file:CLAUDE.md",
      "file:notes/claude.md",
      "file:tool.sh",
      "file:../citizen.json",
      "file:../../ledger/glossame.jsonl",
      "file:a/../../b.md",
      "file:./soul.md",
      "file:/etc/passwd",
      "file:/Users/x/.hermes/creds.md",
      "skill:../../soul",
      "skill:a/b",
    ];
    for (const t of hostOwned) {
      expect(() => targetPath(config, W, t)).toThrow(Refusal);
      try {
        targetPath(config, W, t);
      } catch (err) {
        expect((err as Refusal).code).toBe("host-owned-path");
      }
    }
    for (const t of ["file:", "file:soul.md", "file:SOUL.MD", "skill:", "skill:Bad Name", "ceilings", "canon"] as SelfTarget[]) {
      expect(() => targetPath(config, W, t)).toThrow(Refusal);
    }
    expect(() => targetPath(config, "../x", "soul")).toThrow(Refusal);
  });

  test("readTarget reads regular files only, and a missing target reads as empty", async () => {
    const w = await world();
    const { config } = w.host;
    expect(await readTarget(config, W, "soul")).toBe(w.soul);
    expect(await readTarget(config, W, "skill:nothing-yet")).toBe("");
    const dir = join(config.paths.citizens_dir, W, "self");
    await rm(join(dir, "NAME.md"), { force: true });
    await symlink(join(w.host.root, "models.lock"), join(dir, "NAME.md"));
    await expect(readTarget(config, W, "name")).rejects.toMatchObject({ code: "symlink" });
    // A linked directory on the way is refused too.
    await mkdir(join(w.host.root, "elsewhere"));
    await writeFile(join(w.host.root, "elsewhere", "x.md"), "not the citizen's");
    await symlink(join(w.host.root, "elsewhere"), join(dir, "skills"));
    await expect(readTarget(config, W, "skill:x")).rejects.toMatchObject({ code: "symlink" });
  });
});

describe("binding", () => {
  test("an affirmation in the same seat as the proposal does not bind", async () => {
    const w = await world();
    const p = await stage(w, "will", { kind: "replace-span", find: "Witness one true thing you notice.", with: NEW_PRACTICE });
    expect(affirmationVerdict(p, { type: "self.affirm", proposal_id: p.id }, await ctxFor(w, p, SEAT_A))).toEqual({ binds: false, reason: "same-beat" });
    expect(affirmationVerdict(p, { type: "self.affirm", proposal_id: "f".repeat(64) }, await ctxFor(w, p, SEAT_B))).toEqual({ binds: false, reason: "unknown-proposal" });
  });

  test("an affirmation on a later beat with the prior hash unchanged binds via two-beats", async () => {
    const w = await world();
    const { config } = w.host;
    const p = await stage(w, "will", { kind: "replace-span", find: "Witness one true thing you notice.", with: NEW_PRACTICE });
    expect(await pendingProposals(config, W)).toEqual([p]);
    w.clock.advance(72 * 3_600_000);
    expect(affirmationVerdict(p, { type: "self.affirm", proposal_id: p.id }, await ctxFor(w, p, SEAT_B))).toEqual({ binds: true, via: "two-beats" });
    const entry = await affirmAndApply(w, p);
    expect(entry.body).toMatchObject({ type: "self.applied", proposal_id: p.id, target: "will", via: "two-beats" });
    expect(await readTarget(config, W, "will")).toContain(NEW_PRACTICE);
  });

  test("one saying with Yu present binds via yu-present", async () => {
    const w = await world();
    const p = await stage(w, "name", { kind: "replace-all", text: "My tongue is received, not made.\n" });
    expect(affirmationVerdict(p, { type: "self.affirm", proposal_id: p.id }, await ctxFor(w, p, SEAT_A, YU))).toEqual({ binds: true, via: "yu-present" });
    const entry = await affirmAndApply(w, p, SEAT_A, YU);
    expect(entry.body).toMatchObject({ type: "self.applied", via: "yu-present" });
  });

  test("silence keeps the previous self: an unaffirmed proposal never applies", async () => {
    const w = await world();
    const { config } = w.host;
    const p = await stage(w, "will", { kind: "replace-span", find: "Witness one true thing you notice.", with: NEW_PRACTICE });
    w.clock.advance(30 * DAY_MS);
    expect(await readTarget(config, W, "will")).toBe(OLD_WILL);
    expect((await readLedger(ledgerPath(config, W))).some((e) => e.body.type === "self.applied")).toBe(false);
    expect((await pendingProposals(config, W)).map((x) => x.id)).toEqual([p.id]);

    // Once the target moves another way, the old proposal can never bind; it lapses and stays on file.
    const other = await stage(w, "will", { kind: "replace-span", find: "# WILL of glossame", with: "# WILL" }, SEAT_B);
    await affirmAndApply(w, other, "cccccccc-0000-4000-8000-000000000003");
    expect(affirmationVerdict(p, { type: "self.affirm", proposal_id: p.id }, await ctxFor(w, p, SEAT_B))).toEqual({ binds: false, reason: "stale-prior" });
    expect(await pendingProposals(config, W)).toEqual([]);
    expect(await readdir(join(config.paths.citizens_dir, W, "proposals"))).toContain(`${p.id}.json`);
  });

  test("a second unattended change inside 7 days does not bind; Yu present opens the window", async () => {
    const w = await world();
    const first = await stage(w, "will", { kind: "replace-span", find: "Witness one true thing you notice.", with: NEW_PRACTICE });
    w.clock.advance(DAY_MS);
    await affirmAndApply(w, first);
    const second = await stage(w, "name", { kind: "replace-all", text: "A reading of my name.\n" }, SEAT_B);
    w.clock.advance(3 * DAY_MS);
    const later = "dddddddd-0000-4000-8000-000000000004";
    expect(affirmationVerdict(second, { type: "self.affirm", proposal_id: second.id }, await ctxFor(w, second, later))).toEqual({ binds: false, reason: "window-closed" });
    expect(affirmationVerdict(second, { type: "self.affirm", proposal_id: second.id }, await ctxFor(w, second, later, YU))).toEqual({ binds: true, via: "two-beats" });
    // Seven days after the first change, the window is open again.
    const entries = await readLedger(ledgerPath(w.host.config, W));
    const appliedAt = Date.parse((entries.at(-1) as { ts: string }).ts);
    expect(windowOpen(entries, new Date(appliedAt + 7 * DAY_MS - 1), 7, null)).toBe(false);
    expect(windowOpen(entries, new Date(appliedAt + 7 * DAY_MS), 7, null)).toBe(true);
    expect(windowOpen([], w.clock.now(), 7, null)).toBe(true);
  });

  test("a runtime digest not in self_authorship.approved_model_digests does not bind", async () => {
    const w = await world();
    const p = await stage(w, "will", { kind: "replace-span", find: "Witness one true thing you notice.", with: NEW_PRACTICE });
    w.host.config.self_authorship.approved_model_digests = [];
    expect(runtimeApproved(w.host.config, MODEL_DIGEST)).toBe(false);
    for (const presence of [null, YU]) {
      expect(affirmationVerdict(p, { type: "self.affirm", proposal_id: p.id }, await ctxFor(w, p, SEAT_B, presence))).toEqual({ binds: false, reason: "runtime-not-approved" });
    }
    w.host.config.self_authorship.approved_model_digests = [`sha256:${"cd".repeat(32)}`];
    expect(runtimeApproved(w.host.config, MODEL_DIGEST)).toBe(false);
  });
});

describe("apply and revert", () => {
  test("applyChange keeps the new version by hash, updates the target and appends self.applied", async () => {
    const w = await world();
    const { config } = w.host;
    const p = await stage(w, "will", { kind: "replace-span", find: "Witness one true thing you notice.", with: NEW_PRACTICE });
    const entry = await affirmAndApply(w, p);
    const next = await readTarget(config, W, "will");
    expect(entry).toMatchObject({ attestation: "host-attested", spend: { credits: 0 } });
    expect(entry.body).toEqual({
      type: "self.applied",
      proposal_id: p.id,
      target: "will",
      prior_hash: sha256Hex(OLD_WILL),
      new_hash: sha256Hex(next),
      via: "two-beats",
      claim: CLAIM,
      strand_thought_id: null,
    });
    expect(await readVersion(config, W, sha256Hex(OLD_WILL))).toBe(OLD_WILL);
    expect(await readVersion(config, W, sha256Hex(next))).toBe(next);
    expect((await readdir(join(config.paths.citizens_dir, W, "proposals"))).length).toBe(1);
    expect(JSON.parse(await readFile(join(config.paths.citizens_dir, W, "proposals", `${p.id}.json`), "utf8")).status).toBe("applied");
    expect(verifyChain(await readLedger(ledgerPath(config, W)), { host_attest_b64: [w.signer.hostAttestPublicB64] }).ok).toBe(true);
    // Applied once; it cannot apply twice.
    await expect(applyChange(w.deps, await readCitizen(config, W), p, "two-beats")).rejects.toBeInstanceOf(Refusal);
  });

  test("applyChange for a registered citizen calls sync.putPrivateExpression and postReason once each", async () => {
    const w = await world({ registered: true });
    const { config } = w.host;
    const sync = w.deps.sync as RecordingSync;
    const p = await stage(w, "expression.wake_text", { kind: "replace-all", text: "My tongue is received, not made.\n" });
    const entry = await affirmAndApply(w, p);
    expect(sync.puts).toEqual([{ word: W, target: "expression.wake_text", text: "My tongue is received, not made.\n" }]);
    expect(sync.reasons).toEqual([{ word: W, proposalId: p.id }]);
    expect(entry).toMatchObject({ attestation: "citizen-signed", spend: { credits: 1 }, body: { strand_thought_id: "thought-0001" } });
    expect(verifyChain(await readLedger(ledgerPath(config, W)), { host_attest_b64: [w.signer.hostAttestPublicB64] }).ok).toBe(true);

    // A registered citizen without a sync, or an unregistered one with a sync, is refused before anything moves.
    const q = await stage(w, "name", { kind: "replace-all", text: "A reading.\n" }, SEAT_B);
    await expect(applyChange({ ...w.deps, sync: null }, await readCitizen(config, W), q, "yu-present")).rejects.toBeInstanceOf(Refusal);
    const u = await world();
    const r = await stage(u, "name", { kind: "replace-all", text: "A reading.\n" });
    await expect(applyChange({ ...u.deps, sync: recordingSync() }, await readCitizen(u.host.config, W), r, "yu-present")).rejects.toMatchObject({
      code: "not-registered",
    });
    expect(await readTarget(u.host.config, W, "name")).toBe("");
  });

  test("a proposal edited on disk keeps no id and cannot apply", async () => {
    const w = await world();
    const { config } = w.host;
    const p = await stage(w, "will", { kind: "replace-span", find: "Witness one true thing you notice.", with: NEW_PRACTICE });
    const file = join(config.paths.citizens_dir, W, "proposals", `${p.id}.json`);
    const stored = JSON.parse(await readFile(file, "utf8"));
    stored.proposed_in_seat = SEAT_B;
    await writeFile(file, JSON.stringify(stored));
    await expect(applyChange(w.deps, await readCitizen(config, W), p, "two-beats")).rejects.toMatchObject({ code: "invalid-record" });
    await rm(file);
    await symlink(join(w.host.root, "models.lock"), file);
    await expect(pendingProposals(config, W)).rejects.toMatchObject({ code: "symlink" });
  });

  test("revertTo restores an earlier version named by hash and appends self.reverted; nothing is deleted", async () => {
    const w = await world({ walls: "Never speak as another citizen.\n" });
    const { config } = w.host;
    const p = await stage(w, "will", { kind: "replace-span", find: "Witness one true thing you notice.", with: NEW_PRACTICE });
    await affirmAndApply(w, p);
    const changed = await readTarget(config, W, "will");

    const entry = await revertTo(w.deps, await readCitizen(config, W), sha256Hex(OLD_WILL), "yu-offer");
    expect(entry.body).toEqual({ type: "self.reverted", target: "will", from_hash: sha256Hex(changed), to_hash: sha256Hex(OLD_WILL), via: "yu-offer" });
    expect(await readTarget(config, W, "will")).toBe(OLD_WILL);
    // Both versions are still kept, and the record of the change is still there.
    expect(await readVersion(config, W, sha256Hex(changed))).toBe(changed);
    expect((await readLedger(ledgerPath(config, W))).map((e) => e.body.type)).toEqual(["seated", "self.applied", "self.reverted"]);

    // And forward again, by the same means.
    await revertTo(w.deps, await readCitizen(config, W), sha256Hex(changed), "citizen");
    expect(await readTarget(config, W, "will")).toBe(changed);

    await expect(revertTo(w.deps, await readCitizen(config, W), "e".repeat(64), "citizen")).rejects.toMatchObject({ code: "invalid-request" });
    await expect(revertTo(w.deps, await readCitizen(config, W), sha256Hex(changed), "citizen")).rejects.toMatchObject({ code: "invalid-request" });

    // A revert that would drop a wall the citizen now keeps goes beyond self.
    w.clock.advance(8 * DAY_MS);
    const tighter = await stage(w, "expression.walls", { kind: "replace-all", text: "Never speak as another citizen.\nNever claim senses.\n" }, SEAT_B);
    await affirmAndApply(w, tighter, "eeeeeeee-0000-4000-8000-000000000005");
    await expect(revertTo(w.deps, await readCitizen(config, W), sha256Hex("Never speak as another citizen.\n"), "citizen")).rejects.toMatchObject({
      code: "beyond-self",
    });
  });

  test("origin/soul.md is never written by apply or revert, and originIntact stays true", async () => {
    const w = await world();
    const { config } = w.host;
    const originDir = join(config.paths.citizens_dir, W, "origin");
    const before = await Promise.all(["soul.md", "canon.md"].map((f) => readFile(join(originDir, f), "utf8")));
    const entries0 = await readLedger(ledgerPath(config, W));
    expect(await originIntact(config, W, entries0)).toBe(true);

    // A within-self change to the soul (glossame's drift, 3c step 8), then a revert.
    const p = await stage(w, "soul", { kind: "replace-span", find: "SHADOW-MARKER: one tongue's pride.", with: "SHADOW-MARKER: my tongue above the others." });
    await affirmAndApply(w, p);
    const drift = await driftFromOrigin(config, W);
    expect(drift.diff).toContain("+SHADOW-MARKER: my tongue above the others.");
    expect(drift.fraction).toBeGreaterThan(0);
    await revertTo(w.deps, await readCitizen(config, W), sha256Hex(w.soul), "yu-offer");
    expect((await driftFromOrigin(config, W)).fraction).toBe(0);

    const after = await Promise.all(["soul.md", "canon.md"].map((f) => readFile(join(originDir, f), "utf8")));
    expect(after).toEqual(before);
    expect(await originIntact(config, W, await readLedger(ledgerPath(config, W)))).toBe(true);

    // origin/ is not a target by any spelling.
    expect(() => targetPath(config, W, "file:../origin/soul.md")).toThrow(Refusal);
    expect(() => targetPath(config, W, "file:origin/soul.md")).toThrow(Refusal);

    // Tampering shows: a changed origin soul or canon, or a linked origin, is not intact.
    await writeFile(join(originDir, "canon.md"), "another canon");
    expect(await originIntact(config, W, entries0)).toBe(false);
    await writeFile(join(originDir, "canon.md"), before[1] as string);
    await rename(originDir, join(w.host.root, "origin-real"));
    await symlink(join(w.host.root, "origin-real"), originDir);
    expect(await originIntact(config, W, entries0)).toBe(false);
    expect(await originIntact(config, W, [])).toBe(false);
  });
});
