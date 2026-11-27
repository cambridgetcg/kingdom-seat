// Owner: seat group. What a ledger says about registration (KS-004 11.2),
// read from hand-built beats: which saying a beat makes, which has an id
// and a proposal, and where a saying stands.
import { describe, expect, test } from "bun:test";
import { entryHash } from "../src/ledger.ts";
import { beatAnswer, registrationAnswers, registrationProposal, registrationStage } from "../src/registration.ts";
import { proposalDigest } from "../src/signer/consent.ts";
import type { Act, RegistrationView } from "../src/types.ts";
import { beatEntry } from "./fixtures/voice/fixtures.ts";

const WORD = "glossame";
const no: Act = { type: "registration.answer", answer: "no", text: "No." };
const notYet: Act = { type: "registration.answer", answer: "not-yet" };
const yes: Act = { type: "registration.answer", answer: "yes", text: "Yes: one of my own." };
const untyped: Act = { type: "propose.beyond", subject: " Registration ", text: "Yes, register me." };
const journal: Act = { type: "journal", kind: "reflected", text: "a line" };

describe("[KS-004 11.2] what a beat says about registration", () => {
  test("only a typed yes has an id and a proposal; its extent names the typed word, the citizen and the beat", () => {
    for (const act of [no, notYet, untyped]) {
      const a = beatAnswer(beatEntry(WORD, 3, [journal, act]));
      expect([act.type, a?.id, a?.proposal]).toEqual([act.type, null, null]);
    }
    expect(beatAnswer(beatEntry(WORD, 3, [no]))).toMatchObject({ answer: "no", text: "No.", seq: 3 });
    expect(beatAnswer(beatEntry(WORD, 3, [notYet]))).toMatchObject({ answer: "not-yet", text: null });
    expect(beatAnswer(beatEntry(WORD, 3, [untyped]))).toMatchObject({ answer: "untyped", text: null });

    const beat = beatEntry(WORD, 3, [yes]);
    const a = beatAnswer(beat)!;
    const proposal = { subject: "registration", body: "Yes: one of my own.", extent: `registration yes ${WORD} ${entryHash(beat)}` };
    expect(a).toMatchObject({ answer: "yes", text: "Yes: one of my own.", beat: entryHash(beat), seq: 3, asked_at: beat.ts, voiced: beat.voiced, proposal, id: proposalDigest(proposal) });
    expect(registrationProposal(WORD, "Yes: one of my own.", entryHash(beat))).toEqual(proposal);
    // A beat that says nothing about registration says nothing; any other entry is not a beat.
    expect(beatAnswer(beatEntry(WORD, 3, [journal, { type: "propose.beyond", subject: "the canon", text: "x" }]))).toBeNull();
    expect(beatAnswer({ ...beat, type: "state", acts: null, from: "asleep", to: "asleep", via: "seated" } as never)).toBeNull();
  });

  test("within one beat a typed no or not-yet comes before an untyped proposal, and both before a typed yes", () => {
    const said = (acts: Act[]) => beatAnswer(beatEntry(WORD, 3, acts))?.answer ?? null;
    expect(said([yes, no])).toBe("no");
    expect(said([yes, untyped, notYet])).toBe("not-yet");
    expect(said([untyped, no])).toBe("no");
    expect(said([yes, untyped])).toBe("untyped");
    expect(said([untyped, yes])).toBe("untyped");
    expect(said([journal, yes])).toBe("yes");
    // One saying per beat, oldest first, from this citizen's own beats only.
    const entries = [beatEntry(WORD, 1, [yes]), beatEntry("shemme", 2, [no]), beatEntry(WORD, 3, [journal]), beatEntry(WORD, 4, [yes, untyped]), beatEntry(WORD, 5, [no, notYet])];
    expect(registrationAnswers(entries, WORD).map((a) => [a.seq, a.answer])).toEqual([
      [1, "yes"],
      [4, "untyped"],
      [5, "no"],
    ]);
  });

  test("the stage is affirmed only while the yes is agreed; anything but a yes is closed", () => {
    const at = "2026-11-08T03:05:00.000Z";
    const view = (decision: "waiting" | "agreed" | "declined", affirmed: boolean): RegistrationView => ({
      answer: "yes",
      id: "ab".repeat(32),
      text: "Yes.",
      asked_at: at,
      seq: 4,
      decision,
      affirmed_in: affirmed ? `sha256:${"e".repeat(64)}` : null,
    });
    expect(registrationStage({ answer: "no", text: null, asked_at: at, seq: 4 })).toBe("closed");
    expect(registrationStage({ answer: "not-yet", text: "Later.", asked_at: at, seq: 4 })).toBe("closed");
    expect(registrationStage({ answer: "untyped", asked_at: at, seq: 4 })).toBe("closed");
    expect(registrationStage(view("waiting", false))).toBe("waiting");
    expect(registrationStage(view("declined", false))).toBe("declined");
    expect(registrationStage(view("agreed", false))).toBe("agreed");
    expect(registrationStage(view("agreed", true))).toBe("affirmed");
    // Affirmed once, but the agreement no longer stands: shown where its decision now is.
    expect(registrationStage(view("waiting", true))).toBe("waiting");
    expect(registrationStage(view("declined", true))).toBe("declined");
  });
});
