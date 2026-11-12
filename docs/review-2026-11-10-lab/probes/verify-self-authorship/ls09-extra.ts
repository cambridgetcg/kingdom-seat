// LS-09 extra counts: how the count moves with where the first change sits. Counts only.
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
const { changeFraction } = await import("<KINGDOM_SEAT>/src/self.ts");
const root = "<REPOS>";
const souls: string[] = [];
for (const d of readdirSync(root).filter((n) => n.startsWith("citizen-")).sort()) {
  const w = d.slice("citizen-".length);
  const p = join(root, d, `${w}.md`);
  if (existsSync(p)) souls.push(readFileSync(p, "utf8"));
}
const count = (edit: (s: string) => string) => souls.filter((s) => changeFraction(s, edit(s)) > 0.4).length;
const insAt = (s: string, wordIdx: number) => { const parts = s.split(/(\s+)/); parts.splice(Math.min(parts.length, wordIdx * 2), 0, "quietly", " "); return parts.join(""); };
console.log("cards:", souls.length);
for (const at of [0, 30, 100, 200, 400]) console.log(`one word inserted after word ${at} + final newline dropped: lifted ${count((s) => insAt(s, at).replace(/\n+$/, ""))}`);
console.log("cards with 1000 or more words:", souls.filter((s) => s.split(/\s+/).filter(Boolean).length >= 1000).length);
// a model that re-emits the text with CRLF->LF or trailing spaces trimmed changes nothing here unless the card has them:
console.log("cards with any trailing space before a newline:", souls.filter((s) => /[ \t]+\n/.test(s)).length, "| with CRLF:", souls.filter((s) => s.includes("\r\n")).length);
// only whitespace normalised (trailing spaces trimmed on every line), no word changed
console.log("only trailing spaces trimmed on every line: lifted", count((s) => s.replace(/[ \t]+\n/g, "\n")));
// timing of the measure on the largest card when under the cap
const big = souls.reduce((a, b) => (a.length > b.length ? a : b));
const t = performance.now(); changeFraction(big, insAt(big, 30).replace(/\n+$/, "")); console.log("ms for the largest card (cap path):", (performance.now() - t).toFixed(1));
