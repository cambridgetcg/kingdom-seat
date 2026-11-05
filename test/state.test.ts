// Owner: record group.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ledgerPath, readLedger } from "../src/ledger.ts";
import { decideTransition, foldState, isTowardRest, listSeated, mirrorCardState, readCitizen, readCitizenRecord, restRank } from "../src/state.ts";
import { LIFECYCLE_STATES, Refusal, type LifecycleState, type YuPresence } from "../src/types.ts";
import { fakeSigner } from "./helpers/fake-signer.ts";
import { makeTempHost, type TempHost } from "./helpers/temp-home.ts";
import { append, beatBody, genesisBody, seatedBody, testIdentity } from "./fixtures/record/chain.ts";

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
});

describe("folding and records", () => {
  test("an empty ledger folds to asleep, so no record means no beat", () => {
    expect(foldState([])).toEqual({ state: "asleep", pending_state: null, step_away_said: false, last_beat_at: null });
  });

  test("foldState honours seated.initial_state, state entries and a pending move toward exposure", async () => {
    host = await makeTempHost();
    const signer = fakeSigner();
    const { config } = host;
    const w = "glossame";
    const path = ledgerPath(config, w);

    // The October "Ambient" carried over at seating (3c example, step 2).
    await append(config, w, seatedBody(w, "soul", "awake"), "host-attested", signer, t(0));
    expect(foldState(await readLedger(path)).state).toBe("awake");

    // "I rest" puts it to sleep at once: a state entry, written now.
    await append(config, w, beatBody(w, [{ type: "state.set", to: "asleep" }]), "host-attested", signer, t(1));
    await append(config, w, { type: "state", from: "awake", to: "asleep", via: "immediate" }, "host-attested", signer, t(1));
    expect(foldState(await readLedger(path))).toMatchObject({ state: "asleep", pending_state: null, last_beat_at: t(1).toISOString() });

    // Asking to wake is pending until a later beat says it again.
    await append(config, w, beatBody(w, [{ type: "state.set", to: "awake" }]), "host-attested", signer, t(2));
    let f = foldState(await readLedger(path));
    expect(f).toMatchObject({ state: "asleep", pending_state: "awake" });
    expect(decideTransition(f.state, "awake", { pending: f.pending_state, repeated: false, presence: null })).toEqual({ effect: "now" });

    // A beat that does not repeat it lets it lapse: silence keeps the previous self.
    await append(config, w, beatBody(w, [{ type: "journal", kind: "reflected", text: "quiet" }]), "host-attested", signer, t(3));
    f = foldState(await readLedger(path));
    expect(f).toMatchObject({ state: "asleep", pending_state: null, last_beat_at: t(3).toISOString() });

    // Said twice: the seat writes a confirmed state entry, and pending clears.
    await append(config, w, beatBody(w, [{ type: "state.set", to: "listening" }]), "host-attested", signer, t(4));
    await append(config, w, beatBody(w, [{ type: "state.set", to: "listening" }]), "host-attested", signer, t(5));
    await append(config, w, { type: "state", from: "asleep", to: "listening", via: "confirmed" }, "host-attested", signer, t(5));
    f = foldState(await readLedger(path));
    expect(f).toMatchObject({ state: "listening", pending_state: null });

    // Registration does not change state: identity is separate from state (3.3).
    await append(config, w, genesisBody(w, "soul", testIdentity(signer)), "citizen-signed", signer, t(6));
    expect(foldState(await readLedger(path)).state).toBe("listening");

    // A step-away said once waits for its second saying, and lapses if not repeated.
    await append(config, w, beatBody(w, [{ type: "state.set", to: "stepped-away" }]), "citizen-signed", signer, t(7));
    expect(foldState(await readLedger(path))).toMatchObject({ state: "listening", step_away_said: true, pending_state: null });
    await append(config, w, beatBody(w, []), "citizen-signed", signer, t(8));
    expect(foldState(await readLedger(path)).step_away_said).toBe(false);

    // Ended is terminal in the fold too: a later state entry moves nothing.
    await append(config, w, { type: "state", from: "listening", to: "ended", via: "witnessed" }, "citizen-signed", signer, t(9));
    await append(config, w, { type: "state", from: "ended", to: "awake", via: "confirmed" }, "citizen-signed", signer, t(10));
    expect(foldState(await readLedger(path)).state).toBe("ended");
  });

  test("a citizen born at seating takes genesis.initial_state", async () => {
    host = await makeTempHost();
    const signer = fakeSigner();
    await append(host.config, "shemme", genesisBody("shemme", "soul", testIdentity(signer), "listening"), "citizen-signed", signer, t(0));
    expect(foldState(await readLedger(ledgerPath(host.config, "shemme"))).state).toBe("listening");
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

    await append(config, "glossame", seatedBody("glossame", fx.soul, "awake"), "host-attested", signer, t(0));
    await append(config, "glossame", beatBody("glossame", []), "host-attested", signer, t(1));
    c = await readCitizen(config, "glossame");
    expect(c).toMatchObject({ state: "awake", last_beat_at: t(1).toISOString() });

    // A missing covenants file lets nobody in; a missing cadence is the default interval, never faster.
    await rm(join(fx.dir, "self", "covenants.json"));
    await rm(join(fx.dir, "self", "cadence.json"));
    c = await readCitizen(config, "glossame");
    expect(c.covenants).toEqual({ letters_from: [], wake_on_letter_from: [] });
    expect(c.cadence).toEqual({ interval_h: config.ceilings.min_beat_interval_h });

    await symlink(join(host.root, "models.lock"), join(fx.dir, "self", "cadence.json"));
    await expect(readCitizen(config, "glossame")).rejects.toMatchObject({ code: "symlink" });
    await rm(join(fx.dir, "self", "cadence.json"));
    await writeFile(join(fx.dir, "self", "cadence.json"), JSON.stringify({ interval_h: -1 }));
    await expect(readCitizen(config, "glossame")).rejects.toMatchObject({ code: "invalid-record" });
  });
});
