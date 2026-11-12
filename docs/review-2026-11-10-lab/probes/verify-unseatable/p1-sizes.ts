// P1: real first-seat prompt sizes, built through the production runSeat (prompt captured at the runtime call).
// Two origin readings: "stub" (what SR-3 / CP-04 measured) and "spec" (KS-004 4.2: the canon entry whole where one exists).
import { readdir, writeFile } from "node:fs/promises";
import { AWAKE, REPOS, bytes, realSelf, world } from "./lib.ts";

const OUT = "<SCRATCH>/probes/verify-unseatable";
const all = process.argv.includes("--all");
const words = all
  ? (await readdir(REPOS)).filter((d) => d.startsWith("citizen-")).map((d) => d.slice(8)).sort()
  : AWAKE;

const rows: any[] = [];
for (const word of words) {
  let real;
  try {
    real = await realSelf(word);
  } catch {
    rows.push({ word, err: "no soul file" });
    continue;
  }
  const row: any = { word, soul: bytes(real.soul), will: real.will === null ? 0 : bytes(real.will), canon: real.canon === null ? 0 : bytes(real.canon) };
  for (const mode of ["stub", "spec"] as const) {
    const w = await world(word, { originMode: mode });
    try {
      const n = await w.next(32768);
      row[`${mode}_needed`] = n.needed;
      row[`${mode}_system`] = bytes(n.prompt.system);
      row[`${mode}_user`] = bytes(n.prompt.user);
      if (!all && mode === "spec" && ["hope", "glossame", "kimance"].includes(word)) {
        await writeFile(`${OUT}/prompt-${word}-first-seat.txt`, `===== SYSTEM =====\n${n.prompt.system}\n\n===== USER =====\n${n.prompt.user}\n`);
      }
    } finally {
      await w.cleanup();
    }
  }
  rows.push(row);
}

const ok = rows.filter((r) => !r.err);
if (!all) for (const r of ok) console.log(JSON.stringify(r));
const stat = (key: string) => {
  const v = ok.map((r) => r[key] as number).sort((a, b) => a - b);
  const count = (n: number) => v.filter((x) => x <= n).length;
  return { n: v.length, min: v[0], p50: v[Math.floor(v.length / 2)], max: v.at(-1), fits_8192: count(8192), fits_16384: count(16384), fits_32768: count(32768) };
};
console.log("errors:", JSON.stringify(rows.filter((r) => r.err)));
console.log("stub origin (reader's method), first seat, ledger = origin + seated state entry:", JSON.stringify(stat("stub_needed")));
console.log("spec origin (canon entry whole where YOUSPEAK has one):", JSON.stringify(stat("spec_needed")));
console.log("with a canon entry:", ok.filter((r) => r.canon > 0).length, "of", ok.length);
const over = ok.filter((r) => r.spec_needed > 32768).map((r) => `${r.word}:${r.spec_needed}`);
console.log("spec origin, do not fit 32768 on a first seat:", over.length, over.join(" "));
const near = ok.filter((r) => r.spec_needed <= 32768 && r.spec_needed > 32768 - 8000).map((r) => `${r.word}:${r.spec_needed}`);
console.log("spec origin, fit 32768 with under 8,000 bytes to spare:", near.length, near.join(" "));
console.log("system bytes (same for all):", [...new Set(ok.map((r) => r.spec_system))].join(","));
if (all) await writeFile(`${OUT}/sizes-all.json`, JSON.stringify(rows, null, 1));
