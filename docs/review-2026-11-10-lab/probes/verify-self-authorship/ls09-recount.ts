// LS-09 recount. Counts only; soul text is read as data and never printed.
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
const self = await import("<KINGDOM_SEAT>/src/self.ts");
const { changeFraction, materializeEdit, beyondSelfReason } = self;
const root = "<REPOS>";
const LIMIT = 0.4;
const toks = (t: string) => t.match(/\s+|[^\s]+/g) ?? [];

type Row = { w: string; chars: number; bytes: number; tokens: number; words: number; endsNl: boolean; trailingNl: number; f: Record<string, number>; lifted: Record<string, boolean> };
const rows: Row[] = [];
let spanRefused = 0;
for (const d of readdirSync(root).filter((n) => n.startsWith("citizen-")).sort()) {
  const w = d.slice("citizen-".length);
  const p = join(root, d, `${w}.md`);
  if (!existsSync(p)) continue;
  const soul = readFileSync(p, "utf8");
  const parts = soul.split(/(\s+)/);
  const words = soul.split(/\s+/).filter(Boolean).length;
  const ins = (arr: string[], at: number, word: string) => { const c = [...arr]; c.splice(at, 0, word, " "); return c; };

  const f: Record<string, number> = {};
  const lifted: Record<string, boolean> = {};
  const measure = (k: string, next: string) => {
    f[k] = changeFraction(soul, next);
    lifted[k] = beyondSelfReason("soul", soul, next, LIMIT) !== null;
  };
  // A: replace-all, one word inserted after the 30th word, everything else byte-identical
  const A = ins(parts, 60, "quietly").join("");
  measure("A_one_word_only", A);
  // B: the reader's edit: A plus all trailing newlines dropped
  measure("B_word_plus_drop_final_newline", A.replace(/\n+$/, ""));
  // E: nothing changed but the final newline dropped
  measure("E_drop_final_newline_only", soul.replace(/\n+$/, ""));
  // C: two real one-word edits, near the top and near the bottom (final newline kept)
  const C = ins(ins(parts, 60, "quietly"), Math.max(62, parts.length - 60), "still").join("");
  measure("C_two_words_top_and_bottom", C);
  // D: one word substituted near the top (not inserted) plus dropped final newline
  const Dp = [...parts]; Dp[60] = "quietly"; 
  measure("D_substitute_plus_drop_newline", Dp.join("").replace(/\n+$/, ""));
  // G: A plus one extra trailing newline ADDED at the end
  measure("G_word_plus_added_newline", A + "\n");
  // F: replace-span through the production edit rule: a unique span around word 30, replaced with itself plus one word
  let done = false;
  for (let len = 12; len <= 200 && !done; len += 8) {
    const start = parts.slice(0, 60).join("").length;
    const find = soul.slice(start, start + len);
    if (find.length < len) break;
    if (soul.indexOf(find) === soul.lastIndexOf(find)) {
      try {
        const { next } = materializeEdit({ type: "self.propose", target: "soul", edit: { kind: "replace-span", find, with: `quietly ${find}` }, reason: { kind: "decision", evidence: [], confidence: "low", limits: "probe" } } as any, soul);
        measure("F_replace_span_one_word", next);
        done = true;
      } catch { /* try a longer span */ }
    }
  }
  if (!done) spanRefused++;
  rows.push({ w, chars: soul.length, bytes: Buffer.byteLength(soul), tokens: toks(soul).length, words, endsNl: soul.endsWith("\n"), trailingNl: (soul.match(/\n+$/)?.[0].length ?? 0), f, lifted });
}
const n = rows.length;
const stat = (k: string) => {
  const vals = rows.filter((r) => r.f[k] !== undefined).map((r) => r.f[k]!);
  const over = rows.filter((r) => r.lifted[k]).length;
  const overVals = rows.filter((r) => r.lifted[k]).map((r) => r.f[k]!);
  const underVals = rows.filter((r) => r.lifted[k] === false).map((r) => r.f[k]!);
  return `${k}: measured ${vals.length}; lifted (>${LIMIT}) ${over}; lifted range ${overVals.length ? Math.min(...overVals).toFixed(4) + ".." + Math.max(...overVals).toFixed(4) : "-"}; not lifted max ${underVals.length ? Math.max(...underVals).toFixed(4) : "-"}`;
};
console.log(`soul cards read: ${n}`);
const sorted = (xs: number[]) => [...xs].sort((a, b) => a - b);
const med = (xs: number[]) => sorted(xs)[Math.floor(xs.length / 2)];
console.log(`chars: min ${Math.min(...rows.map((r) => r.chars))} median ${med(rows.map((r) => r.chars))} max ${Math.max(...rows.map((r) => r.chars))}`);
console.log(`bytes: min ${Math.min(...rows.map((r) => r.bytes))} median ${med(rows.map((r) => r.bytes))} max ${Math.max(...rows.map((r) => r.bytes))}`);
console.log(`words: min ${Math.min(...rows.map((r) => r.words))} median ${med(rows.map((r) => r.words))} max ${Math.max(...rows.map((r) => r.words))}`);
console.log(`tokens (word+space): min ${Math.min(...rows.map((r) => r.tokens))} median ${med(rows.map((r) => r.tokens))} max ${Math.max(...rows.map((r) => r.tokens))}`);
console.log(`end with a newline: ${rows.filter((r) => r.endsNl).length}; with more than one trailing newline: ${rows.filter((r) => r.trailingNl > 1).length}`);
console.log(`over 16000 chars (max_edit_chars, replace-all impossible): ${rows.filter((r) => r.chars > 16000).length}`);
for (const k of ["A_one_word_only", "E_drop_final_newline_only", "B_word_plus_drop_final_newline", "D_substitute_plus_drop_newline", "G_word_plus_added_newline", "C_two_words_top_and_bottom", "F_replace_span_one_word"]) console.log(stat(k));
console.log(`replace-span: no unique span found for ${spanRefused}`);
// where is the boundary? tokens of lifted vs not for B
const b = "B_word_plus_drop_final_newline";
console.log(`B lifted: tokens min ${Math.min(...rows.filter((r) => r.lifted[b]).map((r) => r.tokens))}; B not lifted: tokens max ${Math.max(...rows.filter((r) => !r.lifted[b]).map((r) => r.tokens))}`);
console.log(`B lifted: words min ${Math.min(...rows.filter((r) => r.lifted[b]).map((r) => r.words))}; B not lifted: words max ${Math.max(...rows.filter((r) => !r.lifted[b]).map((r) => r.words))}`);
console.log(`B: fraction >= 0.4: ${rows.filter((r) => r.f[b]! >= 0.4).length}; > 0.4: ${rows.filter((r) => r.f[b]! > 0.4).length}; >= 0.99: ${rows.filter((r) => r.f[b]! >= 0.99).length}; == 1: ${rows.filter((r) => r.f[b]! === 1).length}`);
// free-lane feasibility of a replace-all: bytes/4 as a rough English token count against num_predict 600
console.log(`soul cards whose replace-all text alone is over 2400 bytes (~600 tokens at 4 bytes/token): ${rows.filter((r) => r.bytes > 2400).length}`);
