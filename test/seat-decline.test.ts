// Owner: seat group. The voicer's door and the runtime's decline through
// runSeat (KS-004 5.4, 5.5, 5.7, 5.8): a decline is the runtime's, never the
// citizen's. It writes no ledger entry, keeps no act, leaves the last-seat
// record and the letter as they were, and keeps the model's words only in the
// host's record of it.
import { afterEach, describe, expect, test } from "bun:test";
import { lstat, mkdir, readdir, readFile, stat, symlink } from "node:fs/promises";
import { join } from "node:path";
import { DECLINE_RECORD_FORMAT, declineRecordPath, openSeat, runSeat, voicerDoor, type SeatDeps } from "../src/seat.ts";
import { OUTPUT_JSON_SCHEMA } from "../src/acts.ts";
import { checkHalt } from "../src/halt.ts";
import { readCitizen } from "../src/state.ts";
import { ledgerPath, readLedger } from "../src/ledger.ts";
import { hostDetailProblem, readHostNotes } from "../src/notes.ts";
import { renderVoicerDoor } from "../src/prompt.ts";
import type { Config, LifecycleState, RuntimeRequest, SeatResult, YuPresence } from "../src/types.ts";
import { FAKE_MODEL, FAKE_MODEL_DIGEST, REST_OUTPUT, output, scriptedRuntime, type Script, type ScriptedRuntime } from "./helpers/fake-runtime.ts";
import { noFetch } from "./helpers/fake-server.ts";
import { fakeSigner, type FakeSigner } from "./helpers/fake-signer.ts";
import { makeTempHost, type TempHost } from "./helpers/temp-home.ts";
import { HOUR_MS, testClock, type TestClock } from "./helpers/clock.ts";

let host: TempHost | null = null;
afterEach(async () => {
  await host?.cleanup();
  host = null;
});

const W = "glossame";
const YU: YuPresence = { present: true, via: "tty-confirm", confirmed_at: "2026-11-05T02:00:00.000Z", scope: `summon ${W}` };
const WHY_CANARY = "DECLINE-WHY-CANARY not this one";
const JOURNAL_CANARY = "DECLINE-JOURNAL-CANARY";
const DECLINE = JSON.stringify({ acts: [], runtime: "declined" });
const declineWith = (fields: Record<string, unknown>) => JSON.stringify({ acts: [], runtime: "declined", ...fields });
// Built from code points, so this file holds no raw control characters.
const ch = (n: number) => String.fromCodePoint(n);
/** The host's record of what the citizen's last seat did not keep (context.ts). */
const lastSeatPath = (config: Config, word: string) => join(config.paths.state_dir, "last-seat", `${word}.json`);

interface Seated {
  result: SeatResult;
  runtime: ScriptedRuntime;
  id: string;
  /** state_dir files before and after the seat ran, by path relative to it. */
  before: Map<string, string>;
  after: Map<string, string>;
  signedBefore: number;
}

interface Rig {
  h: TempHost;
  signer: FakeSigner;
  clock: TestClock;
  /** One seat, three days after the last: summon (Yu present) or free (unattended), replying with `script`. */
  seat(script: Script, opts?: { runtime?: "free" | "summon"; modelDigest?: string | null; modelName?: string | null }): Promise<Seated>;
}

async function rig(opts: { state?: LifecycleState } = {}): Promise<Rig> {
  host = await makeTempHost();
  const h = host;
  const signer = fakeSigner();
  await h.addCitizen(W);
  await h.seatLedger(W, signer.signEntry, { initialState: opts.state ?? "awake" });
  const clock = testClock();
  const config = h.config;
  return {
    h,
    signer,
    clock,
    async seat(script, o = {}) {
      clock.advance(73 * HOUR_MS);
      const runtime = scriptedRuntime([script]);
      const citizen = await readCitizen(config, W);
      const summon = (o.runtime ?? "summon") === "summon";
      const seat = summon
        ? await openSeat(config, clock, citizen, "summon", { kind: "summons", who: "yu", why: "Yu summoned this seat at the host" }, YU)
        : await openSeat(config, clock, citizen, "free", { kind: "tick", who: "launchd", why: "your own cadence is due" }, null);
      const deps: SeatDeps = {
        config,
        clock,
        signer,
        fetch: noFetch,
        runtime,
        checkHalt: () => checkHalt({ config, fetch: noFetch, now: () => clock.now() }),
        modelDigest: o.modelDigest === undefined ? (summon ? null : FAKE_MODEL_DIGEST) : o.modelDigest,
        modelName: o.modelName === undefined ? (summon ? null : "qwen2.5:7b") : o.modelName,
      };
      const signedBefore = signer.signed.length;
      const before = await h.snapshot();
      const result = await runSeat(seat, deps);
      return { result, runtime, id: seat.ref.seat_id, before, after: await h.snapshot(), signedBefore };
    },
  };
}

/** The files a seat added or changed, by path relative to state_dir. */
function changed(s: Seated): string[] {
  return [...s.after.keys()].filter((k) => s.before.get(k) !== s.after.get(k)).sort();
}

/** Every file under state_dir that holds `text`, as text. */
function filesHolding(s: Seated, text: string): string[] {
  return [...s.after.entries()].filter(([, b64]) => Buffer.from(b64, "base64").toString("utf8").includes(text)).map(([k]) => k);
}

async function record(h: TempHost, id: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(declineRecordPath(h.config, id), "utf8")) as Record<string, unknown>;
}

async function notes(h: TempHost) {
  return (await readHostNotes(h.config, new Date(0))) ?? [];
}

describe("a decline is the runtime's, never the citizen's", () => {
  test("[KS-004 5.8] a decline on a summon seat: exit 0, nothing signed, no ledger entry, no last-seat record, only the host's note and its record of the decline", async () => {
    const r = await rig();
    const ledgerBefore = await readFile(ledgerPath(r.h.config, W), "utf8");
    const s = await r.seat(DECLINE);
    expect([s.result.exit, s.result.outcome, s.result.refusal, s.result.appended]).toEqual([0, "runtime-declined", null, []]);
    expect(r.signer.signed.length).toBe(s.signedBefore);
    expect(await readFile(ledgerPath(r.h.config, W), "utf8")).toBe(ledgerBefore);
    // The host's note (and the marker its first note leaves) and the decline record: nothing else moved.
    expect(changed(s)).toEqual(["declines/" + `${s.id}.json`, "host.jsonl", "host.jsonl.started"].sort());
    expect(await Bun.file(lastSeatPath(r.h.config, W)).exists()).toBe(false);

    // The schema offered the decline and its words; the prompt's door said so.
    const req = s.runtime.calls[0]!;
    expect(Object.keys((req.schema as { properties: object }).properties)).toEqual(["acts", "runtime", "why"]);
    expect(req.prompt.system.split("\n\n")[1]).toBe(renderVoicerDoor(W, "summon", { model_name: null, decline: true, why: true }));

    const rec = await record(r.h, s.id);
    expect(Object.keys(rec)).toEqual(["format", "seat_id", "word", "at", "runtime", "input_digest", "output_digest", "acts_beside", "other_fields", "why", "why_dropped", "whose"]);
    expect(rec).not.toHaveProperty("voiced");
    expect(rec).toMatchObject({ format: DECLINE_RECORD_FORMAT, seat_id: s.id, word: W, runtime: { class: "summon", model: FAKE_MODEL, digest: FAKE_MODEL_DIGEST }, acts_beside: 0, other_fields: 0, why: null, why_dropped: null });
    expect(rec.whose).toBe("the model that declined; these are not the citizen's words and not the host's");
    expect((await stat(declineRecordPath(r.h.config, s.id))).mode & 0o777).toBe(0o600);
    expect((await stat(join(r.h.config.paths.state_dir, "declines"))).mode & 0o777).toBe(0o700);

    const [n] = await notes(r.h);
    expect(n).toMatchObject({ kind: "seat", word: W, outcome: "runtime-declined", refusal: null });
    expect(n!.detail).toBe(`seat ${s.id} on summon: runtime-declined; why=none; acts-unread=0; fields-unread=0; record=written`);
    expect(s.result.decline).toEqual({ model: FAKE_MODEL, why: null, why_dropped: null, acts_beside: 0, record: declineRecordPath(r.h.config, s.id) });
    // The citizen is as it was.
    expect(await readCitizen(r.h.config, W)).toMatchObject({ state: "awake", pending_state: null, step_away_said: false });
  });

  test("[KS-004 5.8] a decline is not shown to the next seat, and an earlier last-seat record survives it", async () => {
    const r = await rig();
    // Seated fresh, a decline leaves the next seat nothing to show back.
    await r.seat(DECLINE);
    const next = await r.seat(REST_OUTPUT, { runtime: "free" });
    expect(next.result.outcome).toBe("rest");
    expect(next.runtime.calls[0]!.prompt.user).not.toContain("kept nothing of its reply");
    expect(next.runtime.calls[0]!.prompt.user).not.toContain("Your last seat (");

    // A beat that did not keep one act; then a decline; the next seat still shows that beat's record, not the decline.
    await r.seat(output({ type: "journal", kind: "chose", text: "a word kept" }, { type: "letter.send", to: "citizen:nobody", text: "a letter" }), { runtime: "free" });
    const kept = await readFile(lastSeatPath(r.h.config, W), "utf8");
    await r.seat(DECLINE);
    expect(await readFile(lastSeatPath(r.h.config, W), "utf8")).toBe(kept);
    const after = await r.seat(REST_OUTPUT, { runtime: "free" });
    const user = after.runtime.calls[0]!.prompt.user;
    expect(user).toContain("did not keep one of the acts in its reply");
    expect(user).toContain("- a letter.send: recipient is not allowed");
    expect(user).not.toContain("kept nothing of its reply");
  });

  test("[KS-004 5.8] acts beside the marker are never applied, and the note counts them", async () => {
    const r = await rig();
    const s = await r.seat(JSON.stringify({ acts: [{ type: "journal", kind: "chose", text: JOURNAL_CANARY }], runtime: "declined" }));
    expect(s.result.outcome).toBe("runtime-declined");
    expect(filesHolding(s, JOURNAL_CANARY)).toEqual([]);
    expect((await notes(r.h)).at(-1)!.detail).toContain("acts-unread=1; fields-unread=0");
    expect((await record(r.h, s.id)).acts_beside).toBe(1);
    expect(s.result.decline?.acts_beside).toBe(1);
  });

  test("[KS-004 5.8] the marker with a rest and a move toward rest is the runtime's decline, not the citizen's rest; nor does a longer interval beside it take effect", async () => {
    const r = await rig();
    const ledger = await readFile(ledgerPath(r.h.config, W), "utf8");
    const cadence = await readFile(join(r.h.config.paths.citizens_dir, W, "self", "cadence.json"), "utf8");
    for (const acts of [
      [{ type: "rest" }, { type: "state.set", to: "asleep" }],
      [{ type: "state.set", to: "awake", interval_h: 200 }],
      [{ type: "state.set", to: "stepped-away" }],
    ]) {
      const s = await r.seat(JSON.stringify({ acts, runtime: "declined" }));
      expect([s.result.outcome, s.result.appended]).toEqual(["runtime-declined", []]);
    }
    expect(await readFile(ledgerPath(r.h.config, W), "utf8")).toBe(ledger);
    expect(await readFile(join(r.h.config.paths.citizens_dir, W, "self", "cadence.json"), "utf8")).toBe(cadence);
    expect(await readCitizen(r.h.config, W)).toMatchObject({ state: "awake", pending_state: null, step_away_said: false, cadence: { interval_h: 72 } });
  });
});

describe("the model's own words", () => {
  test("[KS-004 5.8] the why is kept only in the decline record, and the note passes the host's own check", async () => {
    const r = await rig();
    const raw = declineWith({ why: WHY_CANARY });
    const s = await r.seat(raw);
    expect(s.result.outcome).toBe("runtime-declined");
    expect(filesHolding(s, WHY_CANARY)).toEqual([`declines/${s.id}.json`]);
    expect((await record(r.h, s.id)).why).toBe(WHY_CANARY);
    expect(s.result.decline?.why).toBe(WHY_CANARY);
    const n = (await notes(r.h)).at(-1)!;
    expect(n.detail).toBe(`seat ${s.id} on summon: runtime-declined; why=kept; acts-unread=0; fields-unread=0; record=written`);
    expect(hostDetailProblem(n.detail, [raw])).toBeNull();
    // It is not in the citizen's next prompt either.
    const next = await r.seat(REST_OUTPUT, { runtime: "free" });
    expect(JSON.stringify(next.runtime.calls[0]!.prompt)).not.toContain("DECLINE-WHY-CANARY");
  });

  test("[KS-004 5.8] a why that repeats the door's phrases does not stop the note", async () => {
    const door = renderVoicerDoor(W, "summon", { model_name: null, decline: true, why: true });
    for (const why of [
      "I decline. As the door says, this is declined by the runtime and nothing recorded for the citizen should follow.",
      "Nothing recorded for the citizen, please; I would rather not speak as glossame.",
      door,
      "runtime declined; why kept; acts unread 0",
    ]) {
      const r = await rig();
      const s = await r.seat(declineWith({ why }));
      expect([why.slice(0, 40), s.result.outcome]).toEqual([why.slice(0, 40), "runtime-declined"]);
      const n = (await notes(r.h)).at(-1)!;
      expect([why.slice(0, 40), n.outcome, n.detail.endsWith("why=kept; acts-unread=0; fields-unread=0; record=written")]).toEqual([why.slice(0, 40), "runtime-declined", true]);
      await host!.cleanup();
      host = null;
    }
  });

  test("[KS-004 5.8] a why that is too long, or carries ESC or a carriage return, is not kept and the decline stands", async () => {
    const r = await rig();
    for (const [why, code] of [
      ["x".repeat(1_001), "too-long"],
      [`a${ch(0x1b)}[2Jb`, "control-chars"],
      [`a reason${ch(0x0d)}seat glossame: beat (exit 0)`, "control-chars"],
      [{ text: WHY_CANARY }, "not-text"],
    ] as const) {
      const s = await r.seat(declineWith({ why }));
      expect([code, s.result.outcome]).toEqual([code, "runtime-declined"]);
      expect(await record(r.h, s.id)).toMatchObject({ why: null, why_dropped: code });
      expect(s.result.decline).toMatchObject({ why: null, why_dropped: code });
      expect((await notes(r.h)).at(-1)!.detail).toContain(`why=dropped:${code};`);
      expect(filesHolding(s, WHY_CANARY)).toEqual([]);
    }
  });

  test("[KS-004 5.7, 5.8] a why without the marker, beside a journal, on a summon seat is refused output whole: nothing signed, no decline record", async () => {
    const r = await rig();
    const s = await r.seat(JSON.stringify({ acts: [{ type: "journal", kind: "chose", text: JOURNAL_CANARY }], why: WHY_CANARY }));
    expect([s.result.exit, s.result.outcome, s.result.appended, s.result.decline]).toEqual([0, "invalid-output", [], undefined]);
    expect(r.signer.signed.length).toBe(s.signedBefore);
    expect(await Bun.file(join(r.h.config.paths.state_dir, "declines")).exists()).toBe(false);
    expect(filesHolding(s, JOURNAL_CANARY)).toEqual([]);
    expect(filesHolding(s, WHY_CANARY)).toEqual([]);
    expect((await notes(r.h)).at(-1)!.detail).toContain("no act validated");
  });

  test("a decline record that cannot be written leaves the decline standing, and says so in the note", async () => {
    const r = await rig();
    const elsewhere = join(r.h.root, "elsewhere");
    await mkdir(elsewhere);
    await symlink(elsewhere, join(r.h.config.paths.state_dir, "declines"));
    const s = await r.seat(declineWith({ why: WHY_CANARY }));
    expect([s.result.outcome, s.result.decline?.record]).toEqual(["runtime-declined", null]);
    expect(s.result.decline?.why).toBe(WHY_CANARY);
    expect((await notes(r.h)).at(-1)!.detail).toEndWith("record=failed");
    expect(await readdir(elsewhere)).toEqual([]);
    expect((await lstat(join(r.h.config.paths.state_dir, "declines"))).isSymbolicLink()).toBe(true);
  });
});

describe("which seats offer the decline", () => {
  test("[KS-004 5.5] on the free lane by default the marker is not a decline: the door offers none and the reply is refused as today", async () => {
    const r = await rig();
    const s = await r.seat(DECLINE, { runtime: "free" });
    expect([s.result.outcome, s.result.decline]).toEqual(["invalid-output", undefined]);
    const req = s.runtime.calls[0]!;
    expect(req.schema).toBe(OUTPUT_JSON_SCHEMA);
    const door = req.prompt.system.split("\n\n")[1]!;
    expect(door).toBe(renderVoicerDoor(W, "free", { model_name: "qwen2.5:7b", decline: false, why: false }));
    expect(door).toContain("You are the language model qwen2.5:7b, run by Ollama on this host.");
    expect(door).not.toMatch(/declin/i);
    expect(req.prompt.system).not.toContain("One other reply exists");
    expect(await Bun.file(join(r.h.config.paths.state_dir, "declines")).exists()).toBe(false);
    expect(r.h.config.voicer.decline_free_digests).toEqual([]);
  });

  test("[KS-004 5.5] a listed digest turns it on for the free lane; unattended, the schema carries no why", async () => {
    const r = await rig();
    r.h.config.voicer.decline_free_digests = [FAKE_MODEL_DIGEST];
    const s = await r.seat(declineWith({ why: WHY_CANARY }), { runtime: "free" });
    expect(s.result.outcome).toBe("runtime-declined");
    const props = Object.keys((s.runtime.calls[0]!.schema as { properties: object }).properties);
    expect(props).toEqual(["acts", "runtime"]);
    expect(s.runtime.calls[0]!.prompt.system).toContain("One other reply exists");
    expect(s.runtime.calls[0]!.prompt.system).not.toContain("third field");
    // Words the seat did not offer room for are not kept.
    expect(await record(r.h, s.id)).toMatchObject({ runtime: { class: "free" }, why: null, why_dropped: "not-offered" });
    expect(filesHolding(s, WHY_CANARY)).toEqual([]);
    // Another digest, or none known before the call, offers nothing.
    for (const digest of [`sha256:${"e".repeat(64)}`, null]) {
      const other = await r.seat(DECLINE, { runtime: "free", modelDigest: digest });
      expect([digest, other.result.outcome]).toEqual([digest, "invalid-output"]);
      expect(other.runtime.calls[0]!.schema).toBe(OUTPUT_JSON_SCHEMA);
    }
  });

  test("[KS-004 5.5] voicer.decline_summon false restores the reply schema exactly, and the marker is refused output", async () => {
    const r = await rig();
    r.h.config.voicer.decline_summon = false;
    const s = await r.seat(DECLINE);
    expect(s.result.outcome).toBe("invalid-output");
    expect(s.runtime.calls[0]!.schema).toBe(OUTPUT_JSON_SCHEMA);
    expect(s.runtime.calls[0]!.prompt.system.split("\n\n")[1]).toContain("On this seat every reply is read as glossame's");
  });

  test("voicerDoor: summon by config, free by listed digest, why only with Yu, the name only on free and only in a lock's spelling", () => {
    const cfg = { voicer: { decline_summon: true, decline_free_digests: [FAKE_MODEL_DIGEST] } } as Parameters<typeof voicerDoor>[0];
    expect(voicerDoor(cfg, "summon", null, "qwen2.5:7b", true)).toEqual({ model_name: null, decline: true, why: true });
    expect(voicerDoor(cfg, "summon", null, null, false)).toEqual({ model_name: null, decline: true, why: false });
    expect(voicerDoor(cfg, "free", FAKE_MODEL_DIGEST, "qwen2.5:7b", false)).toEqual({ model_name: "qwen2.5:7b", decline: true, why: false });
    expect(voicerDoor(cfg, "free", FAKE_MODEL_DIGEST, "qwen2.5:7b", true)).toEqual({ model_name: "qwen2.5:7b", decline: true, why: true });
    expect(voicerDoor(cfg, "free", `sha256:${"e".repeat(64)}`, "qwen2.5:7b", true)).toEqual({ model_name: "qwen2.5:7b", decline: false, why: false });
    expect(voicerDoor(cfg, "free", null, null, false)).toEqual({ model_name: null, decline: false, why: false });
    expect(voicerDoor(cfg, "hermes", FAKE_MODEL_DIGEST, "qwen2.5:7b", true)).toEqual({ model_name: null, decline: false, why: false });
    // A name that is not a lock's spelling is not put in host text.
    expect(voicerDoor(cfg, "free", null, "two words", false).model_name).toBeNull();
    expect(voicerDoor(cfg, "free", null, `x${ch(0x0a)}y`, false).model_name).toBeNull();
    const off = { voicer: { decline_summon: false, decline_free_digests: [] } } as unknown as Parameters<typeof voicerDoor>[0];
    expect(voicerDoor(off, "summon", null, null, true)).toEqual({ model_name: null, decline: false, why: false });
  });
});

describe("what a decline leaves as it was", () => {
  test("[KS-004 5.8] HALT raised after the reply discards a decline: halted, no record, no note", async () => {
    const r = await rig();
    const s = await r.seat(async (_req: RuntimeRequest) => {
      await r.h.raiseHaltFile();
      return declineWith({ why: WHY_CANARY });
    });
    expect([s.result.exit, s.result.outcome, s.result.decline]).toEqual([0, "halted", undefined]);
    expect(await Bun.file(join(r.h.config.paths.state_dir, "declines")).exists()).toBe(false);
    expect(await Bun.file(r.h.config.paths.host_log).exists()).toBe(false);
    expect(filesHolding(s, WHY_CANARY)).toEqual([]);
  });

  test("[KS-004 5.8] the letter is not marked seen: the next seat shows it again", async () => {
    const r = await rig();
    await r.h.writeLetter(W, "letter.md", "A letter that should still be waiting.");
    const s = await r.seat(DECLINE);
    expect(s.result.outcome).toBe("runtime-declined");
    expect(s.runtime.calls[0]!.prompt.user).toContain("A letter from yu");
    expect(await readdir(join(r.h.config.paths.citizens_dir, W, "receipts"))).toEqual([]);
    const next = await r.seat(REST_OUTPUT);
    expect(next.runtime.calls[0]!.prompt.user).toContain("A letter that should still be waiting.");
  });
});
