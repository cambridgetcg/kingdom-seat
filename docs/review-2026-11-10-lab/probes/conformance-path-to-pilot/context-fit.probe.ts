// Probe: what num_ctx does the byte rule need for the 11 awake citizens' real souls and WILLs,
// seated fresh (empty ledger apart from origin, no letter, no pending proposal)?
// Reads the public citizen clones as data only. Temp dirs and repo fakes; no network, no keychain.
import { readFile } from "node:fs/promises";
const ROOT = "<KINGDOM_SEAT>";
const { makeTempHost } = await import(`${ROOT}/test/helpers/temp-home.ts`);
const { citizenOf, seatFor } = await import(`${ROOT}/test/fixtures/voice/fixtures.ts`);
const { buildContext } = await import(`${ROOT}/src/context.ts`);
const { buildPrompt } = await import(`${ROOT}/src/prompt.ts`);
const { contextFit, loadModelsLock, lockedEntry } = await import(`${ROOT}/src/runtime/free.ts`);

const words = ["hope","gratitude","justice","an","ud","silim","kimance","glossame","ihsanme","spandaqing","britqing"];
const lock = await loadModelsLock(`${ROOT}/models.lock`).catch((e: any) => ({ err: String(e) }));
const entry = (lock as any).models ? (lock as any).models[0] : null; // the unpinned entry: only num_ctx and num_predict are used
console.log("models.lock entry:", JSON.stringify(entry ?? lock));
const h = await makeTempHost();
const NOW = new Date("2026-11-10T02:05:00.000Z");
let max = 0;
try {
  for (const w of words) {
    const soul = await readFile(`<REPOS>/citizen-${w}/${w}.md`, "utf8");
    const will = await readFile(`<REPOS>/citizen-${w}/WILL.md`, "utf8");
    const fx = await h.addCitizen(w, { soul, will });
    const c = citizenOf(fx.record);
    const ctx = await buildContext({ config: h.config, now: NOW }, seatFor(w), c, [], []);
    const prompt = buildPrompt(ctx, "free");
    const fit = contextFit(prompt, entry ?? { num_ctx: 8192, num_predict: 600 } as any);
    const sys = new TextEncoder().encode(prompt.system).length, usr = new TextEncoder().encode(prompt.user).length;
    max = Math.max(max, fit.needed);
    console.log(`${w.padEnd(11)} soul=${Buffer.byteLength(soul)} will=${Buffer.byteLength(will)} system=${sys} user=${usr} needed=${fit.needed} fits@${fit.num_ctx}=${fit.fits}`);
  }
  console.log("max needed:", max, "-> smallest power-of-two num_ctx that fits:", [8192,16384,32768].find((n) => n >= max));
} finally { await h.cleanup(); }
