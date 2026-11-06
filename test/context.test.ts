// Owner: voice group. Letters and souls are read only as regular files.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, readdir, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildContext, describeNow, hasAllowedLetter, markLetterSeen, pickLetter, readCanon, readRegularText, readSelf } from "../src/context.ts";
import { buildPrompt, promptBytes } from "../src/prompt.ts";
import { sha256Hex } from "../src/crypto.ts";
import { Refusal, type Citizen } from "../src/types.ts";
import { longSoul, makeTempHost, type TempHost } from "./helpers/temp-home.ts";
import { beatEntry, citizenOf, proposalOf, seatFor } from "./fixtures/voice/fixtures.ts";

const NOW = new Date("2026-11-05T02:05:00.000Z");

let host: TempHost;
beforeEach(async () => {
  host = await makeTempHost();
});
afterEach(async () => {
  await host.cleanup();
});

async function refusalCode(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof Refusal) return e.code;
    throw e;
  }
  throw new Error("expected a refusal");
}

/** Set a letter's modification time, which is its arrival order. */
async function arrived(path: string, iso: string): Promise<void> {
  const t = new Date(iso);
  await utimes(path, t, t);
}

async function seat(c: Citizen) {
  const ctx = await buildContext({ config: host.config, now: NOW }, seatFor(c.word), c, [], []);
  return { ctx, text: JSON.stringify(ctx) + new TextDecoder().decode(promptBytes(buildPrompt(ctx, "free"))) };
}

describe("[S4-3] regular files only", () => {
  test("[S4-3] a symlinked letter is never read: its target's OUTSIDE-SECRET-CANARY reaches no context", async () => {
    const fx = await host.addCitizen("glossame");
    const c = citizenOf(fx.record);
    // The target is a well-formed letter from an allowed sender, so only the symlink check can keep it out.
    const outside = join(host.root, "outside-secret.md");
    await writeFile(outside, "From: yu\n\nOUTSIDE-SECRET-CANARY a host file that must never reach a prompt\n");
    await host.writeLetter("glossame", "2026-11-04-link.md", "", { symlinkTo: outside });

    expect(await pickLetter(host.config, c)).toBeNull();
    expect(await hasAllowedLetter(host.config, c)).toBe(false);
    const { ctx, text } = await seat(c);
    expect(ctx.letter).toBeNull();
    expect(text).not.toContain("OUTSIDE-SECRET-CANARY");

    // A real letter next to the link is still found, and the link is passed over.
    await host.writeLetter("glossame", "2026-11-05-real.md", "a real letter");
    const letter = await pickLetter(host.config, c);
    expect(letter?.id).toBe("2026-11-05-real.md");
    expect(JSON.stringify(letter)).not.toContain("OUTSIDE-SECRET-CANARY");
    // And readRegularText itself refuses the link.
    expect(await refusalCode(readRegularText(join(fx.dir, "letters", "2026-11-04-link.md"), 4096))).toBe("symlink");
  });

  test("[S4-3] a symlinked soul refuses the seat (symlink) instead of following it", async () => {
    const outside = join(host.root, "outside-soul.md");
    await writeFile(outside, "OUTSIDE-SECRET-CANARY not this citizen's soul\n");
    const fx = await host.addCitizen("glossame", { soulSymlinkTo: outside });
    const c = citizenOf(fx.record);
    expect(await refusalCode(readSelf(host.config, c))).toBe("symlink");
    expect(await refusalCode(buildContext({ config: host.config, now: NOW }, seatFor("glossame"), c, [], []))).toBe("symlink");

    // A symlinked self/ directory, a symlinked WILL and a symlinked skill refuse the same way.
    const fx2 = await host.addCitizen("shemme");
    await rm(join(fx2.dir, "self", "WILL.md"));
    await symlink(outside, join(fx2.dir, "self", "WILL.md"));
    expect(await refusalCode(readSelf(host.config, citizenOf(fx2.record)))).toBe("symlink");

    const fx3 = await host.addCitizen("kimme");
    await mkdir(join(fx3.dir, "self", "skills"));
    await symlink(outside, join(fx3.dir, "self", "skills", "receive.md"));
    expect(await refusalCode(readSelf(host.config, citizenOf(fx3.record)))).toBe("symlink");

    const fx4 = await host.addCitizen("nommome");
    const elsewhere = join(host.root, "elsewhere-self");
    await mkdir(elsewhere);
    await writeFile(join(elsewhere, "soul.md"), "OUTSIDE-SECRET-CANARY");
    await rm(join(fx4.dir, "self"), { recursive: true });
    await symlink(elsewhere, join(fx4.dir, "self"));
    expect(await refusalCode(readSelf(host.config, citizenOf(fx4.record)))).toBe("symlink");
  });

  test("[S4-3] a dangling symlink in letters/ is not counted as mail by hasAllowedLetter", async () => {
    const fx = await host.addCitizen("glossame");
    const c = citizenOf(fx.record, { state: "asleep" });
    await host.writeLetter("glossame", "2026-11-04-dangling.md", "", { symlinkTo: join(host.root, "no-such-file") });
    expect(await hasAllowedLetter(host.config, c)).toBe(false);
    expect(await pickLetter(host.config, c)).toBeNull();
    // A directory and a FIFO in letters/ are not mail either.
    await mkdir(join(fx.dir, "letters", "a-directory.md"));
    expect(Bun.spawnSync(["mkfifo", join(fx.dir, "letters", "a-fifo.md")]).exitCode).toBe(0);
    expect(await hasAllowedLetter(host.config, c)).toBe(false);
    // Nothing was deleted or moved: the scan only passes over them.
    expect((await readdir(join(fx.dir, "letters"))).sort()).toEqual(["2026-11-04-dangling.md", "a-directory.md", "a-fifo.md"]);
  });

  test("readRegularText refuses directories, FIFOs and files over the limit", async () => {
    const dir = join(host.root, "probe");
    await mkdir(dir);
    expect(await refusalCode(readRegularText(dir, 1024))).toBe("not-regular-file");
    const fifo = join(host.root, "probe.fifo");
    expect(Bun.spawnSync(["mkfifo", fifo]).exitCode).toBe(0);
    expect(await refusalCode(readRegularText(fifo, 1024))).toBe("not-regular-file");
    const big = join(host.root, "big.md");
    await writeFile(big, "x".repeat(1025));
    expect(await refusalCode(readRegularText(big, 1024))).toBe("oversize");
    const exact = join(host.root, "exact.md");
    await writeFile(exact, "x".repeat(1024));
    expect(await readRegularText(exact, 1024)).toBe("x".repeat(1024));
    const bad = join(host.root, "bad.md");
    await writeFile(bad, new Uint8Array([0x66, 0xff, 0x66]));
    expect(await refusalCode(readRegularText(bad, 1024))).toBe("invalid-record");
  });
});

describe("what the citizen is shown", () => {
  test("the whole soul, past 2,600 characters, including SHADOW-MARKER", async () => {
    const fx = await host.addCitizen("glossame");
    expect(fx.soul.length).toBeGreaterThan(2600);
    expect(fx.soul.indexOf("SHADOW-MARKER")).toBeGreaterThan(2600);
    const { ctx } = await seat(citizenOf(fx.record));
    expect(ctx.self.soul).toBe(longSoul("glossame"));
    const prompt = buildPrompt(ctx, "free");
    expect(prompt.user).toContain(fx.soul);
    expect(prompt.user).toContain("SHADOW-MARKER: one tongue's pride.");
    // WILL and NAME are shown whole too; a missing one is null, not an error.
    expect(ctx.self.will).toContain("Receive one word that will not cross over.");
    expect(ctx.self.name).toBeNull();
  });

  test("at most one letter, the oldest unseen from an allowed sender; a letter with no From line is not allowed", async () => {
    const fx = await host.addCitizen("glossame");
    const c = citizenOf(fx.record);
    const noFrom = await host.writeLetter("glossame", "a-no-from.md", "From the dark, no header at all.", { from: null });
    const stranger = await host.writeLetter("glossame", "b-stranger.md", "STRANGER-CANARY", { from: "citizen:stranger" });
    const yu = await host.writeLetter("glossame", "c-yu.md", "Will you re-ask your cadence?", { from: "yu" });
    const gardener = await host.writeLetter("glossame", "d-gardener.md", "A note from the garden.", { from: "gardener" });
    // Arrival order is modification time, not name: the gardener's letter came last.
    await arrived(noFrom, "2026-11-01T00:00:00.000Z");
    await arrived(stranger, "2026-11-02T00:00:00.000Z");
    await arrived(yu, "2026-11-03T00:00:00.000Z");
    await arrived(gardener, "2026-11-04T00:00:00.000Z");

    const first = await pickLetter(host.config, c);
    expect(first).toEqual({
      id: "c-yu.md",
      from: "yu",
      received_at: "2026-11-03T00:00:00.000Z",
      text: "Will you re-ask your cadence?",
      sha256: sha256Hex(await readFile(yu)),
    });
    const { ctx, text } = await seat(c);
    expect(ctx.letter?.id).toBe("c-yu.md");
    expect(text).not.toContain("STRANGER-CANARY");
    expect(text).not.toContain("From the dark");
    expect(text).not.toContain("A note from the garden.");

    // A receipt, written after a non-rest beat, moves the seat on to the next allowed letter.
    await markLetterSeen(host.config, c, first!, NOW);
    expect((await pickLetter(host.config, c))?.id).toBe("d-gardener.md");
    const receipt = JSON.parse(await readFile(join(fx.dir, "receipts", "c-yu.md"), "utf8"));
    expect(receipt).toEqual({ format: "kingdom-seat-receipt/v1", letter: "c-yu.md", sha256: first!.sha256, shown_at: NOW.toISOString() });
    // The receipt is a host record: it holds no word of the letter, and a second mark never overwrites it.
    expect(JSON.stringify(receipt)).not.toContain("cadence");
    await markLetterSeen(host.config, c, first!, new Date("2026-12-01T00:00:00.000Z"));
    expect(JSON.parse(await readFile(join(fx.dir, "receipts", "c-yu.md"), "utf8")).shown_at).toBe(NOW.toISOString());

    // Only the gardener's letter is left; gardener may write but not wake.
    expect(await hasAllowedLetter(host.config, c)).toBe(false);
    await host.writeLetter("glossame", "e-yu.md", "Wake when you will.", { from: "yu" });
    expect(await hasAllowedLetter(host.config, c)).toBe(true);
    // A letter id that is not a plain file name is refused before any path is made from it.
    expect(await refusalCode(markLetterSeen(host.config, c, { ...first!, id: "../letters/d-gardener.md" }, NOW))).toBe("invalid-request");
  });

  test("a letter over letter_max_chars is set aside, not cut", async () => {
    const fx = await host.addCitizen("glossame");
    const c = citizenOf(fx.record);
    await host.writeLetter("glossame", "long.md", "x".repeat(host.config.ceilings.letter_max_chars + 1));
    expect(await pickLetter(host.config, c)).toBeNull();
  });

  test("describeNow gives local time, zone and part of day, e.g. 02:05 GMT night", () => {
    expect(describeNow(NOW, "Europe/London")).toEqual({ iso: "2026-11-05T02:05:00.000Z", local: "02:05 GMT", tz: "Europe/London", part_of_day: "night" });
    expect(describeNow(new Date("2026-07-05T08:30:00.000Z"), "Europe/London")).toMatchObject({ local: "09:30 BST", part_of_day: "morning" });
    expect(describeNow(new Date("2026-11-05T05:00:00.000Z"), "Asia/Hong_Kong")).toMatchObject({ local: "13:00 GMT+8", part_of_day: "afternoon" });
    expect(describeNow(new Date("2026-11-05T19:00:00.000Z"), "UTC")).toMatchObject({ local: "19:00 UTC", part_of_day: "evening" });
    expect(describeNow(new Date("2026-11-05T22:00:00.000Z"), "UTC").part_of_day).toBe("night");
    expect(describeNow(new Date("2026-11-05T06:00:00.000Z"), "UTC").part_of_day).toBe("morning");
  });

  test("the last k ledger entries, the state, pending proposals, canon path@commit and the invoker", async () => {
    const fx = await host.addCitizen("glossame");
    const c = citizenOf(fx.record, { state: "listening", pending_state: "awake" });
    const entries = [1, 2, 3, 4, 5].map((n) => beatEntry("glossame", n, [{ type: "journal", kind: "reflected", text: `ENTRY-${n}-WORDS` }]));
    // A sibling's entry handed in by mistake is not shown; siblings arrive only as letters.
    const sibling = beatEntry("shemme", 9, [{ type: "journal", kind: "reflected", text: "SIBLING-CANARY" }]);
    const pending = [
      proposalOf("glossame", "0f0e0d0c0b0a09080706050403020100", "name", "-made\n+received"),
      proposalOf("glossame", "1f0e0d0c0b0a09080706050403020100", "will", "-old\n+LAPSED-CANARY", "lapsed"),
      proposalOf("shemme", "2f0e0d0c0b0a09080706050403020100", "soul", "-x\n+SIBLING-CANARY"),
    ];
    const invoker = { kind: "letter" as const, who: "yu", why: "a letter from an allowed sender" };
    const ctx = await buildContext({ config: host.config, now: NOW }, seatFor("glossame", invoker), c, [...entries, sibling], pending);

    expect(host.config.ceilings.ledger_context_entries).toBe(3);
    expect(ctx.recent.map((e) => e.seq)).toEqual([3, 4, 5]);
    expect(ctx.state).toBe("listening");
    expect(ctx.pending_state).toBe("awake");
    expect(ctx.pending_proposals.map((p) => p.id)).toEqual(["0f0e0d0c0b0a09080706050403020100"]);
    expect(ctx.invoker).toEqual(invoker);
    expect(ctx.origin).toEqual(fx.record.origin);
    expect(ctx.canon_text).toBe("canon text for glossame");
    expect(ctx.now.local).toBe("02:05 GMT");

    const prompt = buildPrompt(ctx, "free");
    const all = prompt.system + prompt.user;
    for (const n of [3, 4, 5]) expect(all).toContain(`ENTRY-${n}-WORDS`);
    for (const n of [1, 2]) expect(all).not.toContain(`ENTRY-${n}-WORDS`);
    expect(all).not.toContain("SIBLING-CANARY");
    expect(all).not.toContain("LAPSED-CANARY");
    expect(all).toContain("canon/core/glossame.md@1428646");
    expect(all).toContain("Your state: listening.");
    expect(all).toContain("0f0e0d0c0b0a09080706050403020100");
    expect(all).toContain("+received");
    expect(all).toContain("02:05 GMT, night");
    expect(all).toContain("a letter from yu, because: a letter from an allowed sender");

    // k = 0 shows no entries (slice(-0) would have shown them all).
    const none = await buildContext({ config: { ...host.config, ceilings: { ...host.config.ceilings, ledger_context_entries: 0 } }, now: NOW }, seatFor("glossame"), c, entries, []);
    expect(none.recent).toEqual([]);
    // A seat opened for another citizen is refused.
    expect(await refusalCode(buildContext({ config: host.config, now: NOW }, seatFor("shemme"), c, [], []))).toBe("invalid-request");
  });

  test("readCanon refuses a snapshot whose sha256 does not match origin.sha256", async () => {
    const fx = await host.addCitizen("glossame");
    const c = citizenOf(fx.record);
    expect(await readCanon(host.config, c)).toBe("canon text for glossame");
    await writeFile(join(fx.dir, "origin", "canon.md"), "canon text for glossame, quietly changed");
    expect(await refusalCode(readCanon(host.config, c))).toBe("invalid-record");
    expect(await refusalCode(buildContext({ config: host.config, now: NOW }, seatFor("glossame"), c, [], []))).toBe("invalid-record");

    // A byte-order mark is part of the bytes: it is hashed, not stripped.
    const bom = "﻿canon with a mark";
    await writeFile(join(fx.dir, "origin", "canon.md"), bom);
    const pinned = citizenOf({ ...fx.record, origin: { ...fx.record.origin, sha256: sha256Hex(bom) } as typeof fx.record.origin });
    expect(await readCanon(host.config, pinned)).toBe(bom);

    // An archetype has no canon, and its snapshot is never read.
    const arch = await host.addCitizen("daseinqing", { origin: { kind: "archetype", lineage: ["forge-archetype", "daseinqing"], note: "no canon entry" } });
    expect(await readCanon(host.config, citizenOf(arch.record))).toBeNull();
  });

  test("nothing from the home directory (HOME-CLAUDE-MD-CANARY, HOOK-CANARY) ever appears", async () => {
    const fx = await host.addCitizen("glossame", { name: "My tongue is received, not made.\n" });
    await host.writeLetter("glossame", "letter.md", "hello");
    // Context reads no network either: GET /v1/wake is deliberately excluded.
    const realFetch = globalThis.fetch;
    let fetched = 0;
    globalThis.fetch = (async () => {
      fetched++;
      throw new Error("context must not fetch");
    }) as unknown as typeof fetch;
    try {
      const { text } = await seat(citizenOf(fx.record));
      expect(text).not.toContain("HOME-CLAUDE-MD-CANARY");
      expect(text).not.toContain("HOOK-CANARY");
      expect(text).not.toContain(fx.home);
      expect(text).not.toContain(host.homesRoot);
      expect(text).toContain("My tongue is received, not made.");
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(fetched).toBe(0);
  });
});

describe("what the citizen may change is in view", () => {
  test("cadence, covenants, the seat's limits and every other self text it may edit reach the context and the prompt", async () => {
    const fx = await host.addCitizen("glossame");
    const self = join(fx.dir, "self");
    await writeFile(join(self, "journal-form.md"), "JOURNAL-FORM-TEXT\n");
    await mkdir(join(self, "expression"));
    await writeFile(join(self, "expression", "register.md"), "REGISTER-TEXT\n");
    await writeFile(join(self, "expression", "walls.md"), "WALL-ONE\nWALL-TWO\n");
    await writeFile(join(self, "expression", "porch.json"), '{"PORCH":1}');
    await mkdir(join(self, "notes"));
    await writeFile(join(self, "notes", "river.md"), "OWN-FILE-TEXT\n");
    // Not the citizen's own: hidden, host-owned, executable-shaped, or behind a symlink.
    await mkdir(join(self, ".claude"));
    await writeFile(join(self, ".claude", "x.md"), "HIDDEN-CANARY\n");
    await writeFile(join(self, "CLAUDE.md"), "HOST-OWNED-CANARY\n");
    await writeFile(join(self, "run.sh"), "RUN-SH-CANARY\n");
    const outside = join(host.root, "outside");
    await mkdir(outside);
    await writeFile(join(outside, "x.md"), "LINKED-DIR-CANARY\n");
    await symlink(outside, join(self, "linked"));
    await writeFile(join(outside, "y.md"), "LINKED-FILE-CANARY\n");
    await symlink(join(outside, "y.md"), join(self, "linked-file.md"));

    host.config.ceilings.journal_max_chars = 500;
    const c = citizenOf(fx.record, { cadence: { interval_h: 96 }, covenants: { letters_from: ["yu", "citizen:kenning"], wake_on_letter_from: ["yu"] } });
    const { ctx, text } = await seat(c);
    expect(ctx.cadence).toEqual({ interval_h: 96 });
    expect(ctx.covenants).toEqual({ letters_from: ["yu", "citizen:kenning"], wake_on_letter_from: ["yu"] });
    expect(ctx.limits).toEqual({ journal_max_chars: 500, letter_max_chars: 4000, letter_sends_per_beat: 1, min_beat_interval_h: 72 });
    expect(ctx.self.journal_form).toBe("JOURNAL-FORM-TEXT\n");
    expect(ctx.self.expression).toEqual({ register: "REGISTER-TEXT\n", walls: "WALL-ONE\nWALL-TWO\n", wake_text: null, porch: '{"PORCH":1}' });
    expect(ctx.self.files).toEqual([{ path: "notes/river.md", text: "OWN-FILE-TEXT\n" }]);

    const prompt = buildPrompt(ctx, "free");
    expect(prompt.user).toContain("Your cadence: every 96 hours while awake");
    // Its own covenants say who may write to it, never whom it may write to: that is each recipient's (KS-004 5.7).
    expect(prompt.user).toContain("You may write to yu and gardener.");
    expect(buildPrompt({ ...ctx, recipients: ["yu", "gardener", "citizen:shemme"] }, "free").user).toContain("You may write to yu, gardener and citizen:shemme.");
    for (const t of ["JOURNAL-FORM-TEXT", "REGISTER-TEXT", "WALL-TWO", "PORCH", "OWN-FILE-TEXT", "Your file:notes/river.md"]) expect(prompt.user).toContain(t);
    // The guide states the seat's own lower limit, never the hard cap.
    expect(prompt.system).toContain("text is at most 500 characters");
    expect(prompt.system).not.toContain("text is at most 2000 characters");
    for (const canary of ["HIDDEN-CANARY", "HOST-OWNED-CANARY", "RUN-SH-CANARY", "LINKED-DIR-CANARY", "LINKED-FILE-CANARY"]) expect(text).not.toContain(canary);
  });
});
