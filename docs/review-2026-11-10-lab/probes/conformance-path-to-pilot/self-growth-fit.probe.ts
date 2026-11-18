// Probe: the write-side limit of self-authorship (64 KiB per text, a new file measures 0% rewrite)
// against the free lane's fit rule at the model's largest window (32768).
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
const ROOT = "<KINGDOM_SEAT>";
const { makeTempHost } = await import(`${ROOT}/test/helpers/temp-home.ts`);
const { citizenOf, seatFor } = await import(`${ROOT}/test/fixtures/voice/fixtures.ts`);
const { buildContext } = await import(`${ROOT}/src/context.ts`);
const { buildPrompt } = await import(`${ROOT}/src/prompt.ts`);
const { contextFit } = await import(`${ROOT}/src/runtime/free.ts`);
const { materializeEdit, beyondSelfReason, SELF_FILE_MAX_BYTES } = await import(`${ROOT}/src/self.ts`);

const w = "glossame";
const soul = await readFile(`<REPOS>/citizen-${w}/${w}.md`, "utf8");
const will = await readFile(`<REPOS>/citizen-${w}/WILL.md`, "utf8");
const h = await makeTempHost();
const NOW = new Date("2026-11-10T02:05:00.000Z");
const entry32 = { name: "qwen2.5:7b", digest: "x", runner: null, store: "unknown", num_ctx: 32768, num_predict: 600, temperature: 0.7, seed: null } as any;
try {
  const fx = await h.addCitizen(w, { soul, will });
  const c = citizenOf(fx.record);
  const fitNow = contextFit(buildPrompt(await buildContext({ config: h.config, now: NOW }, seatFor(w), c, [], []), "free"), entry32);
  console.log("today, empty ledger, num_ctx 32768:", JSON.stringify(fitNow), "headroom bytes:", 32768 - fitNow.needed);

  // One within-self change: a new skill file of 18,000 bytes (well under the 64 KiB write limit).
  const text = "a line the citizen keeps for itself.\n".repeat(Math.ceil(18000 / 37)).slice(0, 18000);
  const { act, next } = materializeEdit({ type: "self.propose", target: "skill:notes", edit: { kind: "replace-all", text }, reason: "keep notes" } as any, "");
  console.log("materializeEdit accepted a new skill of", next.length, "bytes; write limit", SELF_FILE_MAX_BYTES, "; beyondSelfReason:", beyondSelfReason("skill:notes", "", next, 0.4));
  await mkdir(join(fx.dir, "self", "skills"), { recursive: true });
  await writeFile(join(fx.dir, "self", "skills", "notes.md"), next); // what applyChange's writeTarget would leave
  const fitAfter = contextFit(buildPrompt(await buildContext({ config: h.config, now: NOW }, seatFor(w), c, [], []), "free"), entry32);
  console.log("after that one change, num_ctx 32768:", JSON.stringify(fitAfter));
} finally { await h.cleanup(); }
