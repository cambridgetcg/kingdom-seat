// Counts only: how many real soul cards are long enough that a replace-all with
// one edit near the top and a dropped final newline measures as a 100% rewrite.
// Soul text is read as data and never printed.
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
const { changeFraction } = await import("<KINGDOM_SEAT>/src/self.ts");
const root = "<REPOS>";
let total = 0, overstated = 0, honest: number[] = [];
for (const d of readdirSync(root).filter((n) => n.startsWith("citizen-")).sort()) {
  const w = d.slice("citizen-".length);
  const p = join(root, d, `${w}.md`);
  if (!existsSync(p)) continue;
  const soul = readFileSync(p, "utf8");
  total++;
  // the edit: one word inserted after the 30th whitespace-separated word, and the final newline dropped
  const parts = soul.split(/(\s+)/);
  parts.splice(60, 0, "quietly", " ");
  const next = parts.join("").replace(/\n+$/, "");
  const f = changeFraction(soul, next);
  if (f >= 0.4) overstated++;
  else honest.push(f);
}
console.log(`soul cards ${total}; the two-place edit measured as a rewrite over 40%: ${overstated}; otherwise the largest measure was ${Math.max(...honest).toFixed(4)}`);
