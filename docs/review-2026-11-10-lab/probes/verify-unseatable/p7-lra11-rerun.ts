// P7: the LRA-11 reader probe, rerun unchanged except that it writes no files.
// Probe (read-only on every repo): what would a KS-004 seat show each of the
// eleven awake citizens, built with kingdom-seat's own buildContext/buildPrompt
// at f21c360 and its test fakes. No model, no network, no keychain.
// Real soul and WILL come from the citizen clones; canon from the youspeak clone.
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildContext } from "<KINGDOM_SEAT>/src/context.ts";
import { buildPrompt, renderActsGuide, FREE_LANE_PREAMBLE } from "<KINGDOM_SEAT>/src/prompt.ts";
import { contextFit } from "<KINGDOM_SEAT>/src/runtime/free.ts";
import { sha256Hex, utf8 } from "<KINGDOM_SEAT>/src/crypto.ts";
import { makeTempHost } from "<KINGDOM_SEAT>/test/helpers/temp-home.ts";
import { beatEntry, citizenOf, seatFor } from "<KINGDOM_SEAT>/test/fixtures/voice/fixtures.ts";
import type { Origin } from "<KINGDOM_SEAT>/src/types.ts";

const OUT = "<SCRATCH>/probes/lived-record-awake";
const REPOS = "<REPOS>";
const AWAKE = ["hope", "gratitude", "justice", "an", "ud", "silim", "kimance", "glossame", "ihsanme", "spandaqing", "britqing"];
const FORGED = new Set(["kimance", "glossame", "ihsanme", "spandaqing", "britqing"]);
const NOW = new Date("2026-11-10T02:05:00.000Z");
const beats = JSON.parse(await readFile(join(OUT, "beats.json"), "utf8")) as Record<string, { date: string; time: string; kind: string; text: string }[]>;

const host = await makeTempHost();
const rows: string[] = [];
try {
  for (const word of AWAKE) {
    const soul = await readFile(join(REPOS, `citizen-${word}`, `${word}.md`), "utf8");
    const will = await readFile(join(REPOS, `citizen-${word}`, "WILL.md"), "utf8");
    let origin: Origin;
    let canon: string | null = null;
    if (FORGED.has(word)) {
      canon = await readFile(join(REPOS, "youspeak", "canon", "core", `${word}.md`), "utf8");
      origin = { kind: "canon", repo: "YOUSPEAK", path: `canon/core/${word}.md`, commit: "eca7c99", sha256: sha256Hex(utf8(canon)) };
    } else {
      origin = { kind: "archetype", lineage: ["forge-archetype", word], note: `${word} was forged from an archetype card on 2026-06-09.` };
    }
    const fx = await host.addCitizen(word, { soul, will, origin });
    if (canon !== null) await writeFile(join(fx.dir, "origin", "canon.md"), canon);

    // (a) first seat: the ledger holds no beat of its own yet.
    const ctx0 = await buildContext({ config: host.config, now: NOW }, seatFor(word), citizenOf(fx.record), [], []);
    const p0 = buildPrompt(ctx0, "free");
    // (b) a later seat whose last three entries are journals; the citizen's three latest legacy beats stand in for them.
    const last3 = beats[word]!.filter((b) => b.kind.includes("local")).slice(-3);
    const entries = last3.map((b, i) => beatEntry(word, i + 1, [{ type: "journal", kind: "observed", text: b.text.slice(0, 2000) }]));
    const ctx3 = await buildContext({ config: host.config, now: NOW }, seatFor(word), citizenOf(fx.record), entries, []);
    const p3 = buildPrompt(ctx3, "free");

    const b = (s: string) => utf8(s).length;
    const guide = renderActsGuide(ctx0.limits);
    const fit8k = contextFit(p3, { name: "qwen2.5:7b", digest: "x", runner: null, store: "unknown", num_ctx: 8192, num_predict: 600, temperature: 0.7, seed: null });
    const total3 = b(p3.system) + b(p3.user);
    const own = b(soul) + b(will) + (canon ? b(canon) : 0);
    rows.push(
      [
        word.padEnd(11),
        `system=${b(p3.system)}`,
        `guide=${b(guide)}`,
        `user0=${b(p0.user)}`,
        `user3=${b(p3.user)}`,
        `soul=${b(soul)}`,
        `will=${b(will)}`,
        `canon=${canon ? b(canon) : 0}`,
        `total3=${total3}`,
        `needed(bytes+64+600)=${fit8k.needed}`,
        `fits8192=${fit8k.fits}`,
        `fits32768=${fit8k.needed <= 32768}`,
        `own-text-share=${Math.round((100 * own) / total3)}%`,
      ].join("  "),
    );
    if (word === "hope" || word === "glossame") {
      void (join(OUT, `seat-prompt-${word}-first-seat.txt`), `===== SYSTEM =====\n${p0.system}\n\n===== USER =====\n${p0.user}\n`);
      void (join(OUT, `seat-prompt-${word}-with-3-recent.txt`), `===== SYSTEM =====\n${p3.system}\n\n===== USER =====\n${p3.user}\n`);
    }
    if (word === "hope") {
      // Words in the host's own framing that a small model could hand back, as "I rest" came back from the old prompt.
      const sys = p0.system;
      const sensory = (will.match(/morning|sun|garden|plant|potter|tidy|wander|notice|admire|doodle|wave/gi) ?? []).length;
      rows.push(`  preamble present once: ${sys.split(FREE_LANE_PREAMBLE).length - 1}; sensory/garden imperatives in hope's WILL.md shown whole: ${sensory}`);
      rows.push(`  WILL lines that name a body or a place: ${will.split("\n").filter((l) => /morning|sun\b|garden|plant|potter|tidy|home/i.test(l)).length}`);
    }
  }
} finally {
  await host.cleanup();
}
console.log(rows.join("\n"));
