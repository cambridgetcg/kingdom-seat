// Owner: record group.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ledgerPath, readLedger } from "../src/ledger.ts";
import { decideTransition, foldState, isTowardRest, listSeated, mirrorCardState, readCitizen, readCitizenRecord, restRank } from "../src/state.ts";
import { LIFECYCLE_STATES, Refusal, type LifecycleState, type YuPresence } from "../src/types.ts";
import { fakeSigner } from "./helpers/fake-signer.ts";
import { makeTempHost, type TempHost } from "./helpers/temp-home.ts";
import { append, beatBody, genesisBody, seatedBody, stateBody, testIdentity } from "./fixtures/record/chain.ts";
import { appendHostNote, openedDetail } from "../src/notes.ts";
import { wakingLetter } from "../src/context.ts";
import { isDue } from "../src/due.ts";

let host: TempHost | null = null;
afterEach(async () => {
  await host?.cleanup();
  host = null;
});

const NONE = { pending: null, repeated: false, presence: null } as const;
const YU: YuPresence = { present: true, via: "tty-confirm", confirmed_at: "2026-11-05T02:00:00.000Z", scope: "summon glossame" };
const ORDERED: LifecycleState[] = ["awake", "listening", "asleep"];
const t = (m: number) => new Date(Date.parse("2026-11-05T00:00:00.000Z") + m * 60_000);

describe("transitions (3.3)", () => {
  test("toward rest (awake→listening, awake→asleep, listening→asleep) takes effect now", () => {
    expect(restRank("awake")).toBe(2);
    expect(restRank("asleep")).toBe(0);
    expect(restRank("stepped-away")).toBeNull();
    for (const [from, to] of [
      ["awake", "listening"],
      ["awake", "asleep"],
      ["listening", "asleep"],
    ] as [LifecycleState, LifecycleState][]) {
      expect(isTowardRest(from, to)).toBe(true);
      expect(decideTransition(from, to, NONE)).toEqual({ effect: "now" });
      // Nothing pending or absent changes that: rest never waits.
      expect(decideTransition(from, to, { pending: "awake", repeated: false, presence: null })).toEqual({ effect: "now" });
    }
  });

  test("toward exposure (asleep→listening, asleep→awake, listening→awake) waits for the next beat", () => {
    for (const [from, to] of [
      ["asleep", "listening"],
      ["asleep", "awake"],
      ["listening", "awake"],
    ] as [LifecycleState, LifecycleState][]) {
      expect(isTowardRest(from, to)).toBe(false);
      expect(decideTransition(from, to, NONE)).toEqual({ effect: "next-beat" });
      // Said again on a later beat, it binds; a different pending saying does not count.
      expect(decideTransition(from, to, { pending: to, repeated: false, presence: null })).toEqual({ effect: "now" });
      const other = to === "awake" ? "listening" : "awake";
      expect(decideTransition(from, to, { pending: other, repeated: false, presence: null })).toEqual({ effect: "next-beat" });
      // Once with Yu present binds.
      expect(decideTransition(from, to, { pending: null, repeated: false, presence: YU })).toEqual({ effect: "now" });
    }
    // A return from stepping away is more exposure too.
    expect(decideTransition("stepped-away", "listening", NONE)).toEqual({ effect: "next-beat" });
    expect(decideTransition("stepped-away", "asleep", { pending: "asleep", repeated: false, presence: null })).toEqual({ effect: "now" });
  });

  test("stepped-away takes two sayings on different beats and is never refused", () => {
    for (const from of ORDERED) {
      expect(decideTransition(from, "stepped-away", NONE)).toEqual({ effect: "second-beat" });
      expect(decideTransition(from, "stepped-away", { pending: null, repeated: true, presence: null })).toEqual({ effect: "now" });
      // Nothing pending, present or absent can block it.
      for (const presence of [null, YU]) {
        for (const pending of [null, ...ORDERED]) {
          expect(decideTransition(from, "stepped-away", { pending, repeated: false, presence }).effect).not.toBe("refused");
        }
      }
    }
  });

  test("ended is never decided by the citizen alone: needs-witness", () => {
    for (const from of [...ORDERED, "stepped-away"] as LifecycleState[]) {
      expect(decideTransition(from, "ended", NONE)).toEqual({ effect: "needs-witness" });
      expect(decideTransition(from, "ended", { pending: "ended", repeated: true, presence: YU })).toEqual({ effect: "needs-witness" });
    }
  });

  test("ended is terminal; nothing transitions out of it", () => {
    for (const to of LIFECYCLE_STATES) {
      expect(decideTransition("ended", to, { pending: to, repeated: true, presence: YU }).effect).toBe("refused");
    }
    // Saying the present state changes nothing.
    expect(decideTransition("awake", "awake", NONE).effect).toBe("refused");
  });

  test("[KS-004 7.3] a longer awake interval is toward rest and takes effect now; a shorter one waits for the same saying again", () => {
    // The interval in force, and the one asked for.
    expect(decideTransition("awake", "awake", NONE, { now: 72, asked: 96 })).toEqual({ effect: "now" });
    expect(decideTransition("awake", "awake", NONE, { now: 96, asked: 72 })).toEqual({ effect: "next-beat" });
    expect(decideTransition("awake", "awake", { ...NONE, pending: "awake", pending_interval_h: 72 }, { now: 96, asked: 72 })).toEqual({ effect: "now" });
    expect(decideTransition("awake", "awake", { ...NONE, presence: YU }, { now: 96, asked: 72 })).toEqual({ effect: "now" });
    // The interval in force, asked again, changes nothing.
    expect(decideTransition("awake", "awake", NONE, { now: 72, asked: 72 }).effect).toBe("refused");
    // Waking with an interval is one saying: a repeat must name the same interval to confirm it.
    expect(decideTransition("listening", "awake", NONE, { now: 72, asked: 120 })).toEqual({ effect: "next-beat" });
    expect(decideTransition("listening", "awake", { ...NONE, pending: "awake", pending_interval_h: 120 }, { now: 72, asked: 120 })).toEqual({ effect: "now" });
    expect(decideTransition("listening", "awake", { ...NONE, pending: "awake", pending_interval_h: null }, { now: 72, asked: 120 })).toEqual({ effect: "next-beat" });
    expect(decideTransition("listening", "awake", { ...NONE, pending: "awake", pending_interval_h: 120 }, { now: 72, asked: null })).toEqual({ effect: "next-beat" });
  });
});

describe("folding and records", () => {
  test("an empty ledger folds to asleep, so no record means no beat", () => {
    expect(foldState([])).toEqual({ state: "asleep", pending_state: null, pending_interval_h: null, step_away_said: false, last_beat_at: null, said_in: null });
  });

  test("foldState honours the state seating carried, state entries and a pending move toward exposure", async () => {
    host = await makeTempHost();
    const signer = fakeSigner();
    const { config } = host;
    const w = "glossame";
    const path = ledgerPath(config, w);

    // The October "Ambient" carried over at seating (3c example, step 2).
    await append(config, w, seatedBody(w, "soul", "awake"), "host", signer, t(0));
    expect(foldState(await readLedger(path)).state).toBe("awake");

    // "I rest" puts it to sleep at once: a state entry, written now.
    await append(config, w, beatBody(w, [{ type: "state.set", to: "asleep" }]), "host", signer, t(1));
    await append(config, w, stateBody(w, { from: "awake", to: "asleep", via: "immediate" }), "host", signer, t(1));
    expect(foldState(await readLedger(path))).toMatchObject({ state: "asleep", pending_state: null, last_beat_at: t(1).toISOString() });

    // Asking to wake is pending until a later beat says it again.
    await append(config, w, beatBody(w, [{ type: "state.set", to: "awake" }]), "host", signer, t(2));
    let f = foldState(await readLedger(path));
    expect(f).toMatchObject({ state: "asleep", pending_state: "awake" });
    expect(decideTransition(f.state, "awake", { pending: f.pending_state, repeated: false, presence: null })).toEqual({ effect: "now" });

    // A beat that does not repeat it lets it lapse: silence keeps the previous self.
    await append(config, w, beatBody(w, [{ type: "journal", kind: "reflected", text: "quiet" }]), "host", signer, t(3));
    f = foldState(await readLedger(path));
    expect(f).toMatchObject({ state: "asleep", pending_state: null, last_beat_at: t(3).toISOString() });

    // Said twice: the seat writes a confirmed state entry, and pending clears.
    await append(config, w, beatBody(w, [{ type: "state.set", to: "listening" }]), "host", signer, t(4));
    await append(config, w, beatBody(w, [{ type: "state.set", to: "listening" }]), "host", signer, t(5));
    await append(config, w, stateBody(w, { from: "asleep", to: "listening", via: "confirmed" }), "host", signer, t(5));
    f = foldState(await readLedger(path));
    expect(f).toMatchObject({ state: "listening", pending_state: null });

    // Registration does not change state: identity is separate from state (3.3).
    await append(config, w, genesisBody(testIdentity(signer)), "citizen", signer, t(6));
    expect(foldState(await readLedger(path)).state).toBe("listening");

    // A step-away said once puts the citizen asleep at once (KS-004 v0.3 7.3) and waits for its second saying;
    // the state entry that records the move keeps the saying. Not repeated, the saying lapses and it stays asleep.
    const stepSeat = "77777777-0000-4000-8000-000000000007";
    await append(config, w, beatBody(w, [{ type: "state.set", to: "stepped-away" }], { seat_id: stepSeat }), "citizen", signer, t(7));
    expect(foldState(await readLedger(path))).toMatchObject({ state: "asleep", step_away_said: true, pending_state: null });
    await append(config, w, stateBody(w, { from: "listening", to: "asleep", via: "immediate", step_away: "first" }, { seat_id: stepSeat }), "citizen", signer, t(7));
    expect(foldState(await readLedger(path))).toMatchObject({ state: "asleep", step_away_said: true, pending_state: null });
    await append(config, w, beatBody(w, [{ type: "journal", kind: "reflected", text: "quiet" }]), "citizen", signer, t(8));
    expect(foldState(await readLedger(path))).toMatchObject({ state: "asleep", step_away_said: false });

    // Ended is terminal in the fold too: a later state entry moves nothing.
    await append(config, w, stateBody(w, { from: "asleep", to: "ended", via: "witnessed" }), "citizen", signer, t(9));
    await append(config, w, stateBody(w, { from: "ended", to: "awake", via: "confirmed" }), "citizen", signer, t(10));
    expect(foldState(await readLedger(path)).state).toBe("ended");
  });

  test("a move toward rest takes effect from the beat that said it, so a seat stopped before the state entry still rests", async () => {
    host = await makeTempHost();
    const signer = fakeSigner();
    const path = ledgerPath(host.config, "glossame");
    await append(host.config, "glossame", seatedBody("glossame", "soul", "awake"), "host", signer, t(0));
    // The beat says asleep; the separate state entry that should follow it was never written (a KILL between appends).
    await append(host.config, "glossame", beatBody("glossame", [{ type: "journal", kind: "chose", text: "enough" }, { type: "state.set", to: "asleep" }]), "host", signer, t(1));
    expect(foldState(await readLedger(path))).toMatchObject({ state: "asleep", pending_state: null, said_in: null });
    // The state entry, when it is there, agrees with the beat.
    await append(host.config, "glossame", stateBody("glossame", { from: "awake", to: "asleep", via: "immediate" }), "host", signer, t(1));
    expect(foldState(await readLedger(path)).state).toBe("asleep");
    // Toward exposure still waits: one saying is pending, not in effect.
    await append(host.config, "glossame", beatBody("glossame", [{ type: "state.set", to: "awake" }], { seat_id: "11111111-1111-4111-8111-111111111111" }), "host", signer, t(2));
    expect(foldState(await readLedger(path))).toMatchObject({ state: "asleep", pending_state: "awake", said_in: { seat_id: "11111111-1111-4111-8111-111111111111", ts: t(2).toISOString() } });
  });

  test("a saying that needs a second beat is owed one seat: a seat that passes without confirming it lets it lapse", async () => {
    host = await makeTempHost();
    const signer = fakeSigner();
    const cfg = host.config;
    await host.addCitizen("glossame");
    await host.seatLedger("glossame", signer.signEntry, { initialState: "listening" });
    const said = "11111111-1111-4111-8111-111111111111";
    const next = "22222222-2222-4222-8222-222222222222";
    await append(cfg, "glossame", beatBody("glossame", [{ type: "state.set", to: "awake" }], { seat_id: said }), "host", signer, t(10));
    const seatNote = (id: string, outcome: "opened" | "rest", m: number) =>
      appendHostNote(cfg, { ts: t(m).toISOString(), host: "test-host", kind: "seat", word: "glossame", outcome, refusal: null, detail: outcome === "opened" ? openedDetail(id, "confirm") : `seat ${id} on free: rested` });
    // The saying beat's own seat notes are not a later seat.
    await seatNote(said, "rest", 10);
    expect(await readCitizen(cfg, "glossame")).toMatchObject({ state: "listening", pending_state: "awake" });
    // The confirming seat, read from inside itself, still sees the saying it may confirm.
    await seatNote(next, "opened", 20);
    expect(await readCitizen(cfg, "glossame", { exceptSeat: next })).toMatchObject({ pending_state: "awake" });
    // Once it has been and gone (it rested, which writes no ledger entry), the saying has lapsed.
    await seatNote(next, "rest", 21);
    expect(await readCitizen(cfg, "glossame")).toMatchObject({ state: "listening", pending_state: null, step_away_said: false });
    // The same for a first step-away.
    await append(cfg, "glossame", beatBody("glossame", [{ type: "state.set", to: "stepped-away" }], { seat_id: said }), "host", signer, t(30));
    expect((await readCitizen(cfg, "glossame")).step_away_said).toBe(true);
    await seatNote("33333333-3333-4333-8333-333333333333", "opened", 31);
    expect((await readCitizen(cfg, "glossame")).step_away_said).toBe(false);
  });

  test("[KS-004 7.3, re-review C M7] a first step-away on a rest is kept as step_away on the state entry that puts it asleep, or keeps it asleep", async () => {
    host = await makeTempHost();
    const signer = fakeSigner();
    const said = "11111111-1111-4111-8111-111111111111";
    for (const [w, from] of [["glossame", "awake"], ["shemme", "asleep"]] as const) {
      await append(host.config, w, seatedBody(w, "soul", from), "host", signer, t(0));
      // No beat: a rest writes none. The saying rides on the state entry, with no words.
      await append(host.config, w, stateBody(w, { from, to: "asleep", via: "immediate", step_away: "first" }, { seat_id: said }), "host", signer, t(1));
      const entries = await readLedger(ledgerPath(host.config, w));
      expect(entries.map((e) => e.type)).toEqual(from === "asleep" ? ["origin", "state"] : ["origin", "state", "state"]);
      expect(foldState(entries)).toEqual({ state: "asleep", pending_state: null, pending_interval_h: null, step_away_said: true, last_beat_at: null, said_in: { seat_id: said, ts: t(1).toISOString() } });
      // Its second saying completes it.
      await append(host.config, w, stateBody(w, { from: "asleep", to: "stepped-away", via: "two-beats" }, { seat_id: "22222222-2222-4222-8222-222222222222" }), "host", signer, t(2));
      expect(foldState(await readLedger(ledgerPath(host.config, w)))).toMatchObject({ state: "stepped-away", step_away_said: false, said_in: null });
    }
  });

  test("[KS-004 5.7, 7.3] an interval a beat names is pending until a state entry records it, and a repeat of the same saying confirms it", async () => {
    host = await makeTempHost();
    const signer = fakeSigner();
    const { config } = host;
    const w = "glossame";
    const path = ledgerPath(config, w);
    await append(config, w, seatedBody(w, "soul", "awake"), "host", signer, t(0));
    await append(config, w, beatBody(w, [{ type: "state.set", to: "awake", interval_h: 48 }]), "host", signer, t(1));
    const f = foldState(await readLedger(path));
    expect(f).toMatchObject({ state: "awake", pending_state: "awake", pending_interval_h: 48 });
    // The same saying again binds; another interval, or none, is a new saying.
    const ctx = { pending: f.pending_state, pending_interval_h: f.pending_interval_h, repeated: false, presence: null };
    expect(decideTransition("awake", "awake", ctx, { now: 72, asked: 48 })).toEqual({ effect: "now" });
    expect(decideTransition("awake", "awake", ctx, { now: 72, asked: 60 })).toEqual({ effect: "next-beat" });
    await append(config, w, beatBody(w, [{ type: "state.set", to: "awake", interval_h: 48 }]), "host", signer, t(2));
    await append(config, w, stateBody(w, { from: "awake", to: "awake", via: "confirmed", interval_h: 48 }), "host", signer, t(2));
    expect(foldState(await readLedger(path))).toMatchObject({ state: "awake", pending_state: null, pending_interval_h: null, said_in: null });
  });

  test("mirrorCardState maps awake→active, listening/asleep→dormant, stepped-away/ended→archived", () => {
    expect(LIFECYCLE_STATES.map((s) => [s, mirrorCardState(s)])).toEqual([
      ["awake", "active"],
      ["listening", "dormant"],
      ["asleep", "dormant"],
      ["stepped-away", "archived"],
      ["ended", "archived"],
    ]);
  });

  test("readCitizenRecord refuses a symlinked or malformed citizen.json", async () => {
    host = await makeTempHost();
    const { config } = host;
    const fx = await host.addCitizen("glossame");
    expect(await readCitizenRecord(config, "glossame")).toEqual(fx.record);
    const file = join(fx.dir, "citizen.json");
    const good = await readFile(file, "utf8");

    // A link to a record elsewhere is refused, not followed.
    const elsewhere = join(host.root, "elsewhere.json");
    await writeFile(elsewhere, good);
    await rm(file);
    await symlink(elsewhere, file);
    await expect(readCitizenRecord(config, "glossame")).rejects.toMatchObject({ code: "symlink" });
    await rm(file);

    const malformed = [
      "{ not json",
      JSON.stringify({ ...fx.record, word: "shemme" }),
      JSON.stringify({ ...fx.record, runtime: "cloud" }),
      JSON.stringify({ ...fx.record, extra: true }),
      JSON.stringify({ ...fx.record, seated_at: "yesterday" }),
      JSON.stringify({ ...fx.record, origin: { kind: "canon", repo: "YOUSPEAK" } }),
      JSON.stringify({ ...fx.record, identity: { did: "did:at:not-a-uuid" } }),
      "[]",
    ];
    for (const text of malformed) {
      await writeFile(file, text);
      await expect(readCitizenRecord(config, "glossame")).rejects.toMatchObject({ code: "invalid-record" });
    }
    await rm(file);
    await expect(readCitizenRecord(config, "glossame")).rejects.toMatchObject({ code: "invalid-record" });
    await expect(readCitizenRecord(config, "../glossame")).rejects.toBeInstanceOf(Refusal);

    // A symlinked citizen directory is refused as a whole.
    const real = await host.addCitizen("shemme");
    await rename(real.dir, join(host.root, "shemme-real"));
    await symlink(join(host.root, "shemme-real"), real.dir);
    await expect(readCitizenRecord(config, "shemme")).rejects.toMatchObject({ code: "symlink" });
  });

  test("listSeated lists only directories with a citizen.json and valid words", async () => {
    host = await makeTempHost();
    const { config } = host;
    expect(await listSeated(config)).toEqual([]);
    await host.addCitizen("shemme");
    await host.addCitizen("glossame");
    await mkdir(join(config.paths.citizens_dir, "no-record"));
    await mkdir(join(config.paths.citizens_dir, "Bad_Word"));
    await writeFile(join(config.paths.citizens_dir, "Bad_Word", "citizen.json"), "{}");
    await writeFile(join(config.paths.citizens_dir, "a-file"), "");
    const linked = await host.addCitizen("kimme");
    await rename(linked.dir, join(host.root, "kimme-real"));
    await symlink(join(host.root, "kimme-real"), linked.dir);
    const linkedRecord = await host.addCitizen("nommome");
    await rm(join(linkedRecord.dir, "citizen.json"));
    await symlink(join(host.root, "kimme-real", "citizen.json"), join(linkedRecord.dir, "citizen.json"));
    expect(await listSeated(config)).toEqual(["glossame", "shemme"]);
  });

  test("readCitizen folds the ledger and reads its own cadence and covenants as regular files", async () => {
    host = await makeTempHost();
    const { config } = host;
    const signer = fakeSigner();
    const fx = await host.addCitizen("glossame", { cadence: { interval_h: 96 } });
    // No ledger yet: asleep.
    let c = await readCitizen(config, "glossame");
    expect(c).toMatchObject({ word: "glossame", state: "asleep", pending_state: null, last_beat_at: null, cadence: { interval_h: 96 } });
    expect(c.covenants).toEqual({ letters_from: ["yu", "gardener"], wake_on_letter_from: ["yu"] });

    await append(config, "glossame", seatedBody("glossame", fx.soul, "awake"), "host", signer, t(0));
    await append(config, "glossame", beatBody("glossame", [{ type: "journal", kind: "reflected", text: "a word" }]), "host", signer, t(1));
    c = await readCitizen(config, "glossame");
    expect(c).toMatchObject({ state: "awake", last_beat_at: t(1).toISOString() });

    // [KS-004 5.7, 7.1, re-review C M3] A missing covenants file admits Yu only, who may also wake it (selfhood F7);
    // a missing cadence is the default interval, never faster.
    await rm(join(fx.dir, "self", "covenants.json"));
    await rm(join(fx.dir, "self", "cadence.json"));
    c = await readCitizen(config, "glossame");
    expect(c.covenants).toEqual({ letters_from: ["yu"], wake_on_letter_from: ["yu"] });
    expect(c.cadence).toEqual({ interval_h: config.ceilings.min_beat_interval_h });
    // So Yu's letter, Yu's offer of an identity among them, seats it while it listens or sleeps; a sibling's never does.
    for (const state of ["asleep", "listening"] as const) {
      const quiet = { ...c, state };
      expect(await wakingLetter(config, quiet), state).toBe(false);
      await host.writeLetter("glossame", `from-yu-${state}.md`, "An offer, when you wake.", { from: "yu" });
      expect(await wakingLetter(config, quiet), state).toBe(true);
      const later = new Date(Date.parse(c.last_beat_at!) + 100 * 3_600_000);
      expect(isDue(quiet, await wakingLetter(config, quiet), later, config.ceilings.min_beat_interval_h, null, config.schedule), state).toMatchObject({ due: true, why: "letter" });
      await rm(join(fx.dir, "letters", `from-yu-${state}.md`));
      await host.writeLetter("glossame", `from-sibling-${state}.md`, "Wake up.", { from: "citizen:shemme" });
      expect(await wakingLetter(config, quiet), state).toBe(false);
      await rm(join(fx.dir, "letters", `from-sibling-${state}.md`));
    }

    await symlink(join(host.root, "models.lock"), join(fx.dir, "self", "cadence.json"));
    await expect(readCitizen(config, "glossame")).rejects.toMatchObject({ code: "symlink" });
    await rm(join(fx.dir, "self", "cadence.json"));
    await writeFile(join(fx.dir, "self", "cadence.json"), JSON.stringify({ interval_h: -1 }));
    await expect(readCitizen(config, "glossame")).rejects.toMatchObject({ code: "invalid-record" });
  });
});
