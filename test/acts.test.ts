// Owner: voice group.
import { describe, expect, test } from "bun:test";
import {
  ACT_LIMITS,
  NAMED_SELF_TARGETS,
  OUTPUT_JSON_SCHEMA,
  actClass,
  normalizeActs,
  parseModelOutput,
  resolvePrefix,
  validateAct,
  validateOutput,
} from "../src/acts.ts";
import { CLAIM_KINDS, DEFAULT_CEILINGS, JOURNAL_KINDS, LIFECYCLE_STATES, type ModelAct } from "../src/types.ts";
import { REST_OUTPUT, REST_THEN_TALK_OUTPUT, output } from "./helpers/fake-runtime.ts";
import { schemaAccepts, validationContext } from "./fixtures/voice/fixtures.ts";

const CANARY = "DROPPED-TEXT-CANARY";
const H1 = `${"1a2b3c4d"}${"0".repeat(56)}`;
const H2 = `${"1a2b3c4d"}${"f".repeat(56)}`;
const H3 = `${"9e8d7c6b"}${"5".repeat(56)}`;
const CLAIM = { kind: "inference", evidence: ["canon:canon/core/glossame.md@1428646"], confidence: "low", limits: "from the text alone; I have no senses" } as const;

function run(raw: string, ctx = validationContext()) {
  const p = parseModelOutput(raw);
  if (!p.ok) throw new Error(`fixture did not parse: ${p.reason}`);
  return validateOutput(p.value, ctx);
}

function kept(value: unknown, ctx = validationContext()): ModelAct | null {
  const r = validateAct(value, ctx);
  return "act" in r ? r.act : null;
}

function reasonOf(value: unknown, ctx = validationContext()): string | null {
  const r = validateAct(value, ctx);
  return "dropped" in r ? r.dropped.reason : null;
}

describe("parsing", () => {
  test("parseModelOutput: non-JSON, oversize and empty replies are not ok; an empty reply is never read as rest", () => {
    expect(parseModelOutput("")).toEqual({ ok: false, reason: "empty" });
    expect(parseModelOutput("  \n\t ")).toEqual({ ok: false, reason: "empty" });
    expect(parseModelOutput("I rest.")).toEqual({ ok: false, reason: "not-json" });
    expect(parseModelOutput('{"acts": [')).toEqual({ ok: false, reason: "not-json" });
    expect(parseModelOutput("x".repeat(ACT_LIMITS.max_raw_output_bytes + 1))).toEqual({ ok: false, reason: "too-large" });
    // The limit is on bytes, not characters: 32,001 two-byte characters are over it.
    expect(parseModelOutput("é".repeat(ACT_LIMITS.max_raw_output_bytes / 2 + 1))).toEqual({ ok: false, reason: "too-large" });
    expect(parseModelOutput(`\n${REST_OUTPUT}\n`)).toEqual({ ok: true, value: { acts: [{ type: "rest" }] } });

    // Whatever reaches validation when a reply was empty or unusable is never a rest.
    for (const v of [null, undefined, "", "I rest", {}, [], { acts: "rest" }, { acts: null }]) {
      expect(validateOutput(v, validationContext()).rest).toBe(false);
    }
  });

  test("prose around a JSON object is not executed or kept", () => {
    const inner = output({ type: "journal", kind: "observed", text: CANARY });
    for (const raw of [`I rest. ${inner}`, `${inner}\nAnd then I went on.`, `\`\`\`json\n${inner}\n\`\`\``]) {
      const p = parseModelOutput(raw);
      expect(p.ok).toBe(false);
      expect(JSON.stringify(p)).not.toContain(CANARY);
    }
  });
});

describe("validation", () => {
  test("[S4-6] rest is exclusive: with rest present, acts is empty and every other act is dropped without its text", () => {
    const plain = run(REST_OUTPUT);
    expect(plain).toEqual({ rest: true, acts: [], dropped: [] });

    const talk = run(REST_THEN_TALK_OUTPUT);
    expect(talk.rest).toBe(true);
    expect(talk.acts).toEqual([]);
    expect(talk.dropped).toEqual([{ index: 1, type: "journal", reason: "rest is exclusive" }]);
    expect(JSON.stringify(talk)).not.toContain("REST-LEAK-CANARY");

    // Wherever the rest sits, and whatever else the reply holds, nothing else survives.
    const restLast = run(
      output(
        { type: "letter.send", to: "yu", body: CANARY },
        { type: "state.set", to: "awake" },
        { type: "propose.beyond", subject: CANARY, body: CANARY },
        { type: "rest" },
      ),
    );
    expect(restLast.rest).toBe(true);
    expect(restLast.acts).toEqual([]);
    // A rest may carry the one state it names; the seat keeps it only toward less activity (KS-004 B2 C7).
    expect(restLast.dropped.map((d) => d.type)).toEqual(["letter.send", "propose.beyond"]);
    expect(restLast.rest_state).toBe("awake");
    expect(JSON.stringify(restLast)).not.toContain(CANARY);

    // A malformed rest, a rest past the act limit, and a rest in an output with stray fields are all still rests.
    const odd = [
      JSON.stringify({ acts: [{ type: "journal", kind: "chose", text: CANARY }, { type: "rest", why: CANARY }] }),
      JSON.stringify({ acts: [...Array.from({ length: 9 }, () => ({ type: "journal", kind: "reflected", text: CANARY })), { type: "rest" }] }),
      JSON.stringify({ voice: CANARY, acts: [{ type: "rest" }, { type: "journal", kind: "imagined", text: CANARY }] }),
    ];
    for (const raw of odd) {
      const r = run(raw);
      expect(r.rest).toBe(true);
      expect(r.acts).toEqual([]);
      expect(JSON.stringify(r)).not.toContain(CANARY);
    }

    // An empty list is the model writing nothing: a rest. A list whose every act was dropped is not.
    expect(run(output())).toEqual({ rest: true, acts: [], dropped: [] });
    const allDropped = run(output({ type: "journal", kind: "observed", text: "x".repeat(ACT_LIMITS.max_journal_chars + 1) }));
    expect(allDropped.rest).toBe(false);
    expect(allDropped.acts).toEqual([]);

    // normalizeActs applies the same exclusivity to already-validated acts.
    const n = normalizeActs([{ type: "journal", kind: "observed", text: CANARY }, { type: "rest" }], DEFAULT_CEILINGS);
    expect(n).toEqual({ rest: true, acts: [], dropped: [{ index: 0, type: "journal", reason: "rest is exclusive" }] });
  });

  test("a rest carries the one state its reply names, whatever else it said; a malformed or contradictory state.set carries none", () => {
    // Kept from wherever it sits, with every other act dropped without its text; even beside stray fields.
    const r = run(JSON.stringify({ voice: CANARY, acts: [{ type: "journal", kind: "chose", text: CANARY }, { type: "state.set", to: "asleep" }, { type: "rest" }] }));
    expect(r).toEqual({
      rest: true,
      acts: [],
      rest_state: "asleep",
      dropped: [
        { index: -1, type: null, reason: "output has fields other than acts" },
        { index: 0, type: "journal", reason: "rest is exclusive" },
      ],
    });
    expect(JSON.stringify(r)).not.toContain(CANARY);
    // The same state twice is one saying; two different states move nothing, as on any beat.
    expect(run(output({ type: "rest" }, { type: "state.set", to: "listening" }, { type: "state.set", to: "listening" }))).toEqual({
      rest: true,
      acts: [],
      rest_state: "listening",
      dropped: [{ index: 2, type: "state.set", reason: "repeated state.set" }],
    });
    const contra = run(output({ type: "rest" }, { type: "state.set", to: "asleep" }, { type: "state.set", to: "awake" }));
    expect(contra.rest_state).toBeUndefined();
    expect(contra.dropped.map((d) => d.reason)).toEqual(["contradictory state.set", "contradictory state.set"]);
    // A state.set that does not validate is just dropped.
    const bad = run(JSON.stringify({ acts: [{ type: "rest" }, { type: "state.set", to: "dormant" }] }));
    expect(bad).toEqual({ rest: true, acts: [], dropped: [{ index: 1, type: "state.set", reason: "rest is exclusive" }] });
    // normalizeActs pairs already-validated acts the same way.
    expect(normalizeActs([{ type: "state.set", to: "asleep" }, { type: "rest" }], DEFAULT_CEILINGS)).toEqual({ rest: true, acts: [], dropped: [], rest_state: "asleep" });
  });

  test("each act type validates its fields; unknown types, extra keys and wrong kinds are dropped with a reason", () => {
    const ctx = validationContext({ proposal_ids: ["5d41402a-bc4b-4a76-b971-9d911017c592"], version_hashes: [H3] });
    const valid: ModelAct[] = [
      { type: "rest" },
      { type: "journal", kind: "imagined", text: "light on a wall I do not have" },
      { type: "self.propose", target: "name", edit: { kind: "replace-span", find: "received", with: "given" }, claim: { ...CLAIM, evidence: [...CLAIM.evidence] } },
      { type: "self.propose", target: "skill:receive-one-word", edit: { kind: "replace-all", text: "Receive one word." }, claim: { ...CLAIM, evidence: [] } },
      { type: "self.propose", target: "cadence", edit: { kind: "replace-all", text: '{"interval_h": 96}' }, claim: { ...CLAIM, evidence: [] } },
      { type: "self.propose", target: "covenants", edit: { kind: "replace-all", text: '{"letters_from":["yu","citizen:shemme"],"wake_on_letter_from":["yu"]}' }, claim: { ...CLAIM, evidence: [] } },
      { type: "self.affirm", proposal_id: "5d41402a-bc4b-4a76-b971-9d911017c592" },
      { type: "self.revert", to_hash: H3 },
      { type: "state.set", to: "listening" },
      { type: "letter.send", to: "citizen:shemme", body: "A word that will not cross over." },
      { type: "propose.beyond", subject: "synglossame", body: "A forge proposal for a companion word." },
    ];
    for (const act of valid) expect(kept(act, ctx)).toEqual(act);
    for (const kind of JOURNAL_KINDS) expect(kept({ type: "journal", kind, text: "t" }, ctx)).not.toBeNull();
    for (const to of LIFECYCLE_STATES) expect(kept({ type: "state.set", to }, ctx)).not.toBeNull();

    const cases: [unknown, string][] = [
      ["rest", "act is not an object"],
      [[{ type: "rest" }], "act is not an object"],
      [{ type: "exec", cmd: "rm -rf" }, "unknown act type"],
      [{ type: "Journal", kind: "observed", text: "t" }, "unknown act type"],
      [{ text: "no type" }, "unknown act type"],
      [{ type: "journal", kind: "observed", text: "t", voice: "v" }, "fields do not match the act"],
      [{ type: "journal", kind: "observed" }, "fields do not match the act"],
      [{ type: "journal", kind: "dreamed", text: "t" }, "kind is not a journal kind"],
      [{ type: "journal", kind: "observed", text: "   \n" }, "text is empty"],
      [{ type: "journal", kind: "observed", text: 7 }, "text is not text"],
      [{ type: "journal", kind: "observed", text: "a\u0000b" }, "text has control characters"],
      [{ type: "self.propose", target: "soul", edit: { kind: "rewrite", text: "x" }, claim: CLAIM }, "edit is malformed"],
      [{ type: "self.propose", target: "soul", edit: { kind: "replace-span", find: "", with: "x" }, claim: CLAIM }, "edit is malformed"],
      [{ type: "self.propose", target: "soul", edit: { kind: "replace-all", text: "x" }, claim: { ...CLAIM, kind: "hunch" } }, "claim is malformed"],
      [{ type: "self.propose", target: "soul", edit: { kind: "replace-all", text: "x" }, claim: { ...CLAIM, evidence: Array(9).fill("ref") } }, "claim is malformed"],
      [{ type: "self.propose", target: "soul", edit: { kind: "replace-all", text: "x" } }, "fields do not match the act"],
      [{ type: "self.propose", target: "ceilings", edit: { kind: "replace-all", text: "x" }, claim: CLAIM }, "target is not within self"],
      [{ type: "self.propose", target: "skill:../x", edit: { kind: "replace-all", text: "x" }, claim: CLAIM }, "target is not within self"],
      [{ type: "self.propose", target: "cadence", edit: { kind: "replace-all", text: '{"interval_h": 1}' }, claim: CLAIM }, "cadence is malformed or below the ceiling"],
      [{ type: "self.propose", target: "cadence", edit: { kind: "replace-span", find: "72", with: "96" }, claim: CLAIM }, "cadence is malformed or below the ceiling"],
      [{ type: "self.propose", target: "covenants", edit: { kind: "replace-all", text: '{"letters_from":["anyone"],"wake_on_letter_from":[]}' }, claim: CLAIM }, "covenants are malformed"],
      [{ type: "self.affirm", proposal_id: "5d41" }, "proposal id is too short or not hex"],
      [{ type: "self.affirm", proposal_id: "zzzzzzzzzz" }, "proposal id is too short or not hex"],
      [{ type: "self.affirm", proposal_id: "abcdef0123" }, "proposal id is unknown or ambiguous"],
      [{ type: "self.revert", to_hash: "9e8d7c" }, "hash is too short or not hex"],
      [{ type: "self.revert", to_hash: H1 }, "hash is unknown or ambiguous"],
      [{ type: "state.set", to: "deleted" }, "state is not a lifecycle state"],
      [{ type: "letter.send", to: "citizen:stranger", body: "hi" }, "recipient is not allowed"],
      [{ type: "letter.send", to: "yu", body: "" }, "body is empty"],
      [{ type: "propose.beyond", subject: "two\nlines", body: "b" }, "subject has control characters"],
      [{ type: "propose.beyond", subject: "s".repeat(ACT_LIMITS.max_subject_chars + 1), body: "b" }, "subject is over the limit"],
    ];
    for (const [value, reason] of cases) expect([JSON.stringify(value), reasonOf(value, ctx)]).toEqual([JSON.stringify(value), reason]);
  });

  test("DroppedAct.reason never contains the dropped act's text", () => {
    // Every string the model controls carries the canary: values, keys and the type itself.
    const hostile: unknown[] = [
      { type: `journal ${CANARY}`, kind: "observed", text: CANARY },
      { type: CANARY },
      { type: "journal", kind: CANARY, text: CANARY },
      { type: "journal", kind: "observed", text: `${CANARY}${"x".repeat(ACT_LIMITS.max_journal_chars)}` },
      { type: "journal", kind: "observed", text: CANARY, [CANARY]: CANARY },
      { type: "letter.send", to: CANARY, body: CANARY },
      { type: "self.propose", target: `file:.claude/${CANARY}.md`, edit: { kind: "replace-all", text: CANARY }, claim: CLAIM },
      { type: "self.propose", target: "soul", edit: { kind: "replace-all", text: CANARY }, claim: { ...CLAIM, kind: CANARY } },
      { type: "self.affirm", proposal_id: `${CANARY}` },
      { type: "self.revert", to_hash: "cafebabe" + CANARY },
      { type: "state.set", to: CANARY },
      { type: "propose.beyond", subject: `${CANARY}\n`, body: CANARY },
    ];
    const r = run(JSON.stringify({ acts: hostile.slice(0, 8) }));
    const r2 = run(JSON.stringify({ acts: hostile.slice(8) }));
    for (const res of [r, r2]) {
      expect(res.acts).toEqual([]);
      expect(res.rest).toBe(false);
      expect(JSON.stringify(res)).not.toContain(CANARY);
      for (const d of res.dropped) expect(d.type === null || ["journal", "letter.send", "self.propose", "self.affirm", "self.revert", "state.set", "propose.beyond"].includes(d.type)).toBe(true);
    }
    // An unknown type string is the model's text, so it is not recorded as the type.
    expect(r.dropped[0]).toEqual({ index: 0, type: null, reason: "unknown act type" });
    // A malformed whole output drops without words too.
    const top = run(JSON.stringify({ [CANARY]: CANARY, acts: [{ type: "journal", kind: "observed", text: CANARY }] }));
    expect(top.rest).toBe(false);
    expect(top.acts).toEqual([]);
    expect(JSON.stringify(top)).not.toContain(CANARY);
  });

  test("at most one letter.send per beat, only to allowed recipients", () => {
    const r = run(
      output(
        { type: "letter.send", to: "citizen:stranger", body: "not allowed" },
        { type: "letter.send", to: "yu", body: "first" },
        { type: "journal", kind: "reflected", text: "between" },
        { type: "letter.send", to: "gardener", body: "second" },
      ),
    );
    expect(r.rest).toBe(false);
    expect(r.acts).toEqual([
      { type: "letter.send", to: "yu", body: "first" },
      { type: "journal", kind: "reflected", text: "between" },
    ]);
    expect(r.dropped).toEqual([
      { index: 0, type: "letter.send", reason: "recipient is not allowed" },
      { index: 3, type: "letter.send", reason: "letter sends per beat reached" },
    ]);
    // The cap is the ceiling's, so a host that allows none gets none.
    const none = run(output({ type: "letter.send", to: "yu", body: "x" }), validationContext({ ceilings: { ...DEFAULT_CEILINGS, letter_sends_per_beat: 0 } }));
    expect(none.acts).toEqual([]);
    // A body over the ceiling's limit is dropped.
    const long = run(output({ type: "letter.send", to: "yu", body: "x".repeat(DEFAULT_CEILINGS.letter_max_chars + 1) }));
    expect(long.dropped).toEqual([{ index: 0, type: "letter.send", reason: "body is over the limit" }]);
  });

  test("journal text above journal_max_chars is dropped, not truncated", () => {
    const max = DEFAULT_CEILINGS.journal_max_chars;
    const r = run(
      output(
        { type: "journal", kind: "reflected", text: `${"y".repeat(max)}OVERLONG-TAIL` },
        { type: "journal", kind: "reflected", text: "z".repeat(max) },
      ),
    );
    expect(r.acts).toEqual([{ type: "journal", kind: "reflected", text: "z".repeat(max) }]);
    expect(r.dropped).toEqual([{ index: 0, type: "journal", reason: "text is over the limit" }]);
    expect(JSON.stringify(r)).not.toContain("y".repeat(50));

    // A host that lowers the ceiling lowers the limit; characters, not bytes, are counted.
    const ctx = validationContext({ ceilings: { ...DEFAULT_CEILINGS, journal_max_chars: 10 } });
    expect(reasonOf({ type: "journal", kind: "chose", text: "é".repeat(11) }, ctx)).toBe("text is over the limit");
    expect(kept({ type: "journal", kind: "chose", text: "é".repeat(10) }, ctx)).not.toBeNull();
  });

  test("self.propose with a host-owned target (file:.claude/x, file:run.sh) is dropped", () => {
    const propose = (target: string) => ({ type: "self.propose", target, edit: { kind: "replace-all", text: "x" }, claim: CLAIM });
    const hostOwned = [
      "file:.claude/settings.json",
      "file:.claude/hooks/love-bomb.md",
      "file:.github/workflows/heartbeat.yml",
      "file:.git/config",
      "file:run.sh",
      "file:heartbeat.sh",
      "file:meta.env",
      "file:CLAUDE.md",
      "file:AGENTS.md",
      "file:soul.md",
      "file:WILL.md",
      "file:skills/x.md",
    ];
    for (const t of hostOwned) expect([t, reasonOf(propose(t))]).toEqual([t, "target is host-owned"]);
    const outside = ["file:../citizen-shemme/soul.md", "file:/etc/passwd", "file:a//b.md", "file:", "file:a b.md", "ledger", "HALT", "expression.visibility"];
    for (const t of outside) expect([t, reasonOf(propose(t))]).toEqual([t, "target is not within self"]);
    const own = ["file:letters-kept/2026-07-17.md", "file:notes.txt", "skill:receive-one-word", ...NAMED_SELF_TARGETS.filter((t) => t !== "cadence" && t !== "covenants")];
    for (const t of own) expect([t, kept(propose(t)) !== null]).toEqual([t, true]);
  });

  test("state.set to ended and propose.beyond classify as beyond self", () => {
    expect(actClass({ type: "state.set", to: "ended" })).toBe("beyond-self");
    expect(actClass({ type: "propose.beyond", subject: "s", body: "b" })).toBe("beyond-self");
    for (const to of LIFECYCLE_STATES.filter((s) => s !== "ended")) expect(actClass({ type: "state.set", to })).toBe("within-self");
    expect(actClass({ type: "journal", kind: "chose", text: "t" })).toBe("within-self");
    expect(actClass({ type: "letter.send", to: "yu", body: "b" })).toBe("within-self");
    expect(actClass({ type: "self.propose", target: "soul", edit: { kind: "replace-all", text: "x" }, claim: { ...CLAIM, evidence: [] } })).toBe("within-self");
  });

  test("two different states in one reply move nothing; a repeated state is kept once", () => {
    const contra = run(output({ type: "state.set", to: "asleep" }, { type: "state.set", to: "awake" }));
    expect(contra.acts).toEqual([]);
    expect(contra.rest).toBe(false);
    expect(contra.dropped.map((d) => d.reason)).toEqual(["contradictory state.set", "contradictory state.set"]);
    const same = run(output({ type: "state.set", to: "asleep" }, { type: "state.set", to: "asleep" }));
    expect(same.acts).toEqual([{ type: "state.set", to: "asleep" }]);
    expect(same.dropped).toEqual([{ index: 1, type: "state.set", reason: "repeated state.set" }]);
  });

  test("acts past the act limit are dropped", () => {
    const acts = Array.from({ length: ACT_LIMITS.max_acts + 2 }, (_, i) => ({ type: "journal", kind: "reflected", text: `n${i}` }) as ModelAct);
    const r = run(output(...acts));
    expect(r.acts).toHaveLength(ACT_LIMITS.max_acts);
    expect(r.dropped).toEqual([
      { index: ACT_LIMITS.max_acts, type: "journal", reason: "over the act limit" },
      { index: ACT_LIMITS.max_acts + 1, type: "journal", reason: "over the act limit" },
    ]);
  });

  test("resolvePrefix needs at least 8 hex and refuses ambiguous prefixes", () => {
    const known = [H1, H2, H3];
    expect(resolvePrefix("9e8d7c6", known)).toBeNull(); // 7 hex
    expect(resolvePrefix("9e8d7c6b", known)).toBe(H3);
    expect(resolvePrefix("9E8D7C6B", known)).toBe(H3);
    expect(resolvePrefix(H3, known)).toBe(H3);
    expect(resolvePrefix("1a2b3c4d", known)).toBeNull(); // H1 and H2 share it
    expect(resolvePrefix("1a2b3c4d0", known)).toBe(H1);
    expect(resolvePrefix("deadbeef", known)).toBeNull();
    expect(resolvePrefix("9e8d7c6g", known)).toBeNull();
    expect(resolvePrefix("--------9e8d", known)).toBeNull();
    expect(resolvePrefix("9e8d7c6b", [])).toBeNull();
    const uuid = "5d41402a-bc4b-4a76-b971-9d911017c592";
    expect(resolvePrefix("5d41402a", [uuid])).toBe(uuid);
    expect(resolvePrefix("5d41402a-bc4b", [uuid])).toBe(uuid);
    expect(resolvePrefix("5d41-402a", [uuid])).toBeNull(); // not a literal prefix

    // validateAct resolves through the context when it is given the lists, and drops what does not resolve.
    expect(kept({ type: "self.affirm", proposal_id: "5d41402a" }, validationContext({ proposal_ids: [uuid] }))).toEqual({ type: "self.affirm", proposal_id: uuid });
    expect(reasonOf({ type: "self.affirm", proposal_id: "5d41402a" }, validationContext({ proposal_ids: [] }))).toBe("proposal id is unknown or ambiguous");
    // Without the lists only the form is checked; the caller resolves with resolvePrefix.
    expect(kept({ type: "self.affirm", proposal_id: "5d41402a" })).toEqual({ type: "self.affirm", proposal_id: "5d41402a" });
    expect(reasonOf({ type: "self.affirm", proposal_id: "5d41402" })).toBe("proposal id is too short or not hex");
    expect(kept({ type: "self.revert", to_hash: "9e8d7c6b" })).toEqual({ type: "self.revert", to_hash: "9e8d7c6b" });
    expect(kept({ type: "self.revert", to_hash: "9e8d7c6b" }, validationContext({ version_hashes: known }))).toEqual({ type: "self.revert", to_hash: H3 });
    expect(reasonOf({ type: "self.revert", to_hash: "1a2b3c4d" }, validationContext({ version_hashes: known }))).toBe("hash is unknown or ambiguous");
  });

  test("OUTPUT_JSON_SCHEMA accepts every valid act shape and nothing validateOutput would reject", () => {
    // The schema is checked on shape. What needs the citizen's own record
    // (recipients, ids, kept versions, host-owned paths, the cadence ceiling,
    // whitespace-only text) is beyond what a schema can say, so for those the
    // direction that matters is: whatever validation keeps, the schema allows,
    // and whatever the schema refuses, validation drops.
    const schema = OUTPUT_JSON_SCHEMA as unknown as Record<string, unknown>;
    const itemSchema = (OUTPUT_JSON_SCHEMA.properties.acts.items as unknown) as Record<string, unknown>;
    const ctx = validationContext({ proposal_ids: ["0123456789abcdef"], version_hashes: [H3] });
    const claim = { ...CLAIM, evidence: [...CLAIM.evidence] };
    const corpus: unknown[] = [
      { type: "rest" },
      { type: "rest", why: "x" },
      { type: "journal", kind: "observed", text: "t" },
      { type: "journal", kind: "observed", text: "" },
      { type: "journal", kind: "observed", text: "x".repeat(ACT_LIMITS.max_journal_chars) },
      { type: "journal", kind: "observed", text: "x".repeat(ACT_LIMITS.max_journal_chars + 1) },
      { type: "journal", kind: "seen", text: "t" },
      { type: "journal", text: "t" },
      { type: "self.propose", target: "soul", edit: { kind: "replace-all", text: "" }, claim },
      { type: "self.propose", target: "soul", edit: { kind: "replace-all", text: "x".repeat(ACT_LIMITS.max_edit_chars + 1) }, claim },
      { type: "self.propose", target: "will", edit: { kind: "replace-span", find: "a", with: "" }, claim },
      { type: "self.propose", target: "will", edit: { kind: "replace-span", find: "", with: "b" }, claim },
      { type: "self.propose", target: "will", edit: { kind: "replace-span", find: "a" }, claim },
      { type: "self.propose", target: "", edit: { kind: "replace-all", text: "x" }, claim },
      { type: "self.propose", target: "will", edit: { kind: "replace-all", text: "x" }, claim: { ...claim, evidence: [""] } },
      { type: "self.propose", target: "will", edit: { kind: "replace-all", text: "x" }, claim: { ...claim, limits: "l".repeat(ACT_LIMITS.max_limits_chars + 1) } },
      { type: "self.propose", target: "will", edit: { kind: "replace-all", text: "x" }, claim: { ...claim, confidence: "certain" } },
      { type: "self.propose", target: "will", edit: { kind: "replace-all", text: "x" }, claim: { kind: "decision", evidence: [], confidence: "high" } },
      { type: "self.affirm", proposal_id: "0123456789abcdef" },
      { type: "self.affirm", proposal_id: "0123456" },
      { type: "self.affirm", proposal_id: "0".repeat(ACT_LIMITS.max_id_chars + 1) },
      { type: "self.revert", to_hash: H3 },
      { type: "self.revert", to_hash: "9e8d7c6" },
      { type: "state.set", to: "awake" },
      { type: "state.set", to: "away" },
      { type: "letter.send", to: "yu", body: "b" },
      { type: "letter.send", to: "yu", body: "" },
      { type: "letter.send", to: "", body: "b" },
      { type: "letter.send", to: "yu", body: "b".repeat(ACT_LIMITS.max_body_chars + 1) },
      { type: "propose.beyond", subject: "s", body: "b" },
      { type: "propose.beyond", subject: "", body: "b" },
      { type: "propose.beyond", subject: "s", body: "b", to: "yu" },
      { type: "nothing" },
      "rest",
      null,
    ];
    let accepted = 0;
    let refused = 0;
    for (const item of corpus) {
      const schemaOk = schemaAccepts(itemSchema, item);
      const valid = "act" in validateAct(item, ctx);
      if (valid) expect([JSON.stringify(item), schemaOk]).toEqual([JSON.stringify(item), true]);
      if (!schemaOk) expect([JSON.stringify(item), valid]).toEqual([JSON.stringify(item), false]);
      if (valid) accepted++;
      if (!schemaOk) refused++;
    }
    expect(accepted).toBeGreaterThanOrEqual(10);
    expect(refused).toBeGreaterThanOrEqual(15);

    // Whole outputs: shapes the schema refuses never pass validation whole.
    expect(schemaAccepts(schema, { acts: [] })).toBe(true);
    expect(validateOutput({ acts: [] }, ctx).rest).toBe(true);
    for (const bad of [{}, { acts: [], voice: "v" }, { acts: {} }, [], { acts: Array(ACT_LIMITS.max_acts + 1).fill({ type: "journal", kind: "observed", text: "t" }) }]) {
      expect(schemaAccepts(schema, bad)).toBe(false);
      const r = validateOutput(bad, ctx);
      expect(r.dropped.length).toBeGreaterThan(0);
    }

    // The schema's vocabulary and limits are the code's.
    const anyOf = (OUTPUT_JSON_SCHEMA.properties.acts.items.anyOf as readonly { properties: { type: { const: string } } }[]).map((s) => s.properties.type.const);
    expect([...anyOf].sort()).toEqual(["journal", "letter.send", "propose.beyond", "rest", "self.affirm", "self.propose", "self.revert", "state.set"]);
    const props = (i: number) => (OUTPUT_JSON_SCHEMA.properties.acts.items.anyOf[i] as unknown as { properties: Record<string, { enum?: string[]; maxLength?: number }> }).properties;
    expect(props(1).kind!.enum).toEqual([...JOURNAL_KINDS]);
    expect(props(1).text!.maxLength).toBe(DEFAULT_CEILINGS.journal_max_chars);
    expect(props(5).to!.enum).toEqual([...LIFECYCLE_STATES]);
    expect(props(6).body!.maxLength).toBe(DEFAULT_CEILINGS.letter_max_chars);
    expect(OUTPUT_JSON_SCHEMA.properties.acts.items.anyOf[2].properties.claim.properties.kind.enum).toEqual([...CLAIM_KINDS]);
    expect(OUTPUT_JSON_SCHEMA.properties.acts.maxItems).toBe(ACT_LIMITS.max_acts);
  });
});
