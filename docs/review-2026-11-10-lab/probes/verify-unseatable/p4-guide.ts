// P4: how much of the system turn the three self.* acts take.
const ROOT = "<KINGDOM_SEAT>";
const { renderActsGuide } = await import(`${ROOT}/src/prompt.ts`);
const b = (s: string) => new TextEncoder().encode(s).length;
const guide = renderActsGuide();
const lines = guide.split("\n").filter((l: string) => l.startsWith("- "));
const selfLines = lines.filter((l: string) => /^- self\./.test(l));
console.log(JSON.stringify({ guide_bytes: b(guide), act_lines: lines.map((l: string) => `${l.slice(2, l.indexOf(":"))}=${b(l)}`), self_bytes: selfLines.reduce((a: number, l: string) => a + b(l) + 1, 0), share_of_guide: (selfLines.reduce((a: number, l: string) => a + b(l) + 1, 0) / b(guide)).toFixed(3) }, null, 1));
