import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
const { changeFraction } = await import("<KINGDOM_SEAT>/src/self.ts");
const root = "<REPOS>";
const hit: number[] = []; const miss: number[] = [];
for (const d of readdirSync(root).filter((n) => n.startsWith("citizen-")).sort()) {
  const w = d.slice("citizen-".length); const p = join(root, d, `${w}.md`);
  if (!existsSync(p)) continue;
  const s = readFileSync(p, "utf8"); const parts = s.split(/(\s+)/); parts.splice(60, 0, "quietly", " ");
  (changeFraction(s, parts.join("").replace(/\n+$/, "")) > 0.4 ? hit : miss).push(Buffer.byteLength(s));
}
console.log(`lifted ${hit.length}: bytes min ${Math.min(...hit)} max ${Math.max(...hit)}; not lifted ${miss.length}: bytes min ${Math.min(...miss)} max ${Math.max(...miss)}`);
