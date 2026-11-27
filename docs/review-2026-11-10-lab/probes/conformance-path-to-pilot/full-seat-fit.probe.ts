// Probe: an ordinary, fully loaded seat for glossame (real soul and WILL) against num_ctx 16384 and 32768:
// three recent beats with journals at the 2,000-character limit, and one letter from Yu at the 4,000-character limit,
// in ASCII and in CJK (3 UTF-8 bytes per character).
import { readFile } from "node:fs/promises";
const ROOT = "<KINGDOM_SEAT>";
const { makeTempHost } = await import(`${ROOT}/test/helpers/temp-home.ts`);
const { citizenOf, seatFor, beatEntry } = await import(`${ROOT}/test/fixtures/voice/fixtures.ts`);
const { buildContext } = await import(`${ROOT}/src/context.ts`);
const { buildPrompt } = await import(`${ROOT}/src/prompt.ts`);
const { contextFit } = await import(`${ROOT}/src/runtime/free.ts`);
const w = "glossame";
const soul = await readFile(`<REPOS>/citizen-${w}/${w}.md`, "utf8");
const will = await readFile(`<REPOS>/citizen-${w}/WILL.md`, "utf8");
const NOW = new Date("2026-11-10T02:05:00.000Z");
const lock = (n: number) => ({ name: "qwen2.5:7b", digest: "x", runner: null, store: "unknown", num_ctx: n, num_predict: 600, temperature: 0.7, seed: null }) as any;
async function run(label: string, journalChars: number, letter: string | null) {
  const h = await makeTempHost();
  try {
    const fx = await h.addCitizen(w, { soul, will });
    const c = citizenOf(fx.record);
    const j = "a true line the citizen kept. ".repeat(100).slice(0, journalChars);
    const entries = journalChars > 0 ? [1, 2, 3].map((s) => beatEntry(w, s, [{ type: "journal", kind: "reflected", text: j } as any])) : [];
    if (letter !== null) await h.writeLetter(w, "2026-11-09-from-yu.md", letter, { from: "yu" });
    const ctx = await buildContext({ config: h.config, now: NOW }, seatFor(w), c, entries, []);
    const p = buildPrompt(ctx, "free");
    const f16 = contextFit(p, lock(16384)), f32 = contextFit(p, lock(32768));
    console.log(`${label.padEnd(58)} letter_shown=${ctx.letter !== null} needed=${f32.needed} fits16384=${f16.fits} fits32768=${f32.fits}`);
  } finally { await h.cleanup(); }
}
await run("first seat: empty ledger, no letter", 0, null);
await run("3 beats with 600-char journals, no letter", 600, null);
await run("3 beats with 2000-char journals, no letter", 2000, null);
await run("3 beats x2000 + 4000-char ASCII letter from Yu", 2000, "x".repeat(3990));
await run("3 beats x2000 + 4000-char CJK letter from Yu", 2000, "你".repeat(3990));
await run("empty ledger + 4000-char CJK letter from Yu", 0, "你".repeat(3990));
