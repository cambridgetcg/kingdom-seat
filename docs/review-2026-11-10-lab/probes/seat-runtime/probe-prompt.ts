// Probe: render the real prompt for a first seat, with real soul/WILL text as data, and measure contextFit.
// Read-only against the repos; writes only under the OS temp dir via the test helper, and this probes dir.
import { readFile, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";
const SRC = "<KINGDOM_SEAT>";
const { buildContext } = await import(`${SRC}/src/context.ts`);
const { buildPrompt, renderActsGuide, FREE_LANE_PREAMBLE } = await import(`${SRC}/src/prompt.ts`);
const { contextFit, CHAT_TEMPLATE_OVERHEAD_TOKENS } = await import(`${SRC}/src/runtime/free.ts`);
const { makeTempHost } = await import(`${SRC}/test/helpers/temp-home.ts`);
const { fakeSigner } = await import(`${SRC}/test/helpers/fake-signer.ts`);
const { readCitizen } = await import(`${SRC}/src/state.ts`);
const { readLedger, ledgerPath } = await import(`${SRC}/src/ledger.ts`);
const { sha256Hex } = await import(`${SRC}/src/crypto.ts`);

const OUT = "<SCRATCH>/probes/seat-runtime";
const REPOS = "<REPOS>";
const lock = JSON.parse(await readFile(`${SRC}/models.lock`, "utf8"));
const entry = lock.models[0];
const bytes = (s: string) => new TextEncoder().encode(s).length;

const host = await makeTempHost();
const signer = fakeSigner();
const sign = (w: string, k: any, d: any) => signer.signEntry(w, k, d);
const rows: any[] = [];
try {
  const dirs = (await readdir(REPOS)).filter((d) => d.startsWith("citizen-")).sort();
  let first = true;
  for (const d of dirs) {
    const word = d.slice("citizen-".length);
    let soul: string, will: string | null;
    try { soul = await readFile(join(REPOS, d, `${word}.md`), "utf8"); } catch { rows.push({ word, err: "no soul" }); continue; }
    try { will = await readFile(join(REPOS, d, "WILL.md"), "utf8"); } catch { will = null; }
    if (!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(word)) { rows.push({ word, err: "word pattern" }); continue; }
    const canon = `canon text for ${word}`;
    const fx = await host.addCitizen(word, { soul, will, origin: { kind: "canon", repo: "YOUSPEAK", path: `canon/core/${word}.md`, commit: "1428646", sha256: sha256Hex(canon) } });
    await host.seatLedger(word, sign, { initialState: "awake" });
    const citizen = await readCitizen(host.config, word);
    const entries = await readLedger(ledgerPath(host.config, word));
    const ref = { format: "kingdom-seat-seat/v1", seat_id: "00000000-0000-4000-8000-000000000000", host: host.config.host, word, runtime: "free", invoker: { kind: "tick", who: "launchd", why: "your own cadence is due" }, opened_at: "2026-11-10T02:05:00.000Z" };
    const ctx = await buildContext({ config: host.config, now: new Date("2026-11-10T02:05:00.000Z") }, ref as any, citizen, entries.slice(-3), [], { history: entries, selfAuthorship: { runtime_approved: false, window_opens_at: null, yu_present: false } });
    const p = buildPrompt(ctx, "free");
    const fit = contextFit(p, entry);
    rows.push({ word, soul_b: bytes(soul), will_b: will === null ? 0 : bytes(will), system_b: bytes(p.system), user_b: bytes(p.user), needed: fit.needed, fits: fit.fits });
    if (first || word === "hope") {
      await writeFile(join(OUT, `prompt-${word}.system.txt`), p.system);
      await writeFile(join(OUT, `prompt-${word}.user.txt`), p.user);
      first = false;
    }
  }
} finally {
  await host.cleanup();
}
const ok = rows.filter((r) => !r.err);
const needed = ok.map((r) => r.needed).sort((a, b) => a - b);
const q = (f: number) => needed[Math.min(needed.length - 1, Math.floor(f * needed.length))];
const sys = ok[0].system_b;
console.log(JSON.stringify({
  lock: entry,
  overhead: CHAT_TEMPLATE_OVERHEAD_TOKENS,
  citizens: ok.length, errors: rows.filter((r) => r.err),
  system_bytes: sys, system_chars: null,
  guide_bytes: bytes(renderActsGuide()), preamble_bytes: bytes(FREE_LANE_PREAMBLE),
  user_bytes_min: Math.min(...ok.map((r) => r.user_b)), user_bytes_max: Math.max(...ok.map((r) => r.user_b)),
  needed_min: needed[0], needed_p50: q(0.5), needed_p90: q(0.9), needed_max: needed.at(-1),
  fits_at_8192: ok.filter((r) => r.fits).length,
  fits_at_16384: ok.filter((r) => r.needed <= 16384).length,
  fits_at_32768: ok.filter((r) => r.needed <= 32768).length,
  room_for_user_at_8192: entry.num_ctx - entry.num_predict - CHAT_TEMPLATE_OVERHEAD_TOKENS - sys,
  smallest: ok.slice().sort((a, b) => a.needed - b.needed).slice(0, 3),
  largest: ok.slice().sort((a, b) => b.needed - a.needed).slice(0, 5),
  awake11: ok.filter((r) => ["hope","gratitude","justice","an","ud","silim","kimance","glossame","ihsanme","spandaqing","britqing"].includes(r.word)),
}, null, 1));
await writeFile(join(OUT, "context-fit.json"), JSON.stringify(rows, null, 1));
