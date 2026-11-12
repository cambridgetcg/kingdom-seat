// P2: growth paths to "context-too-large", through the production runSeat and the production free adapter
// (fake Ollama on loopback). Real souls and WILLs; replies sized to what num_predict 600 can carry.
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { REASON, bytes, notes, out, world, type OriginMode } from "./lib.ts";

const say = (s: string) => console.log(s);
const journal = (i: number, chars: number) => ({ type: "journal", kind: "reflected", text: (`seat ${i}: ` + "I keep the word on its own side and say so plainly. ".repeat(60)).slice(0, chars) });
// A reply that 600 tokens can carry: about 2,300 characters of English JSON in all.
const smallNote = (i: number) => `note ${i}\n` + "a line I may want to keep for later.\n".repeat(38); // about 1,400 chars
const replyBytes = (r: string) => bytes(r);

async function sectionA(word: string, mode: OriginMode) {
  // (a) pending proposals, default config: nothing is approved, so nothing binds.
  const w = await world(word, { originMode: mode });
  try {
    const start = await w.next();
    const steps: string[] = [`start ${start.needed}`];
    let lockedAt: number | null = null;
    for (let i = 1; i <= 16; i++) {
      const n0 = await w.next();
      if (!n0.fits) {
        lockedAt = i - 1;
        break;
      }
      const reply = out(journal(i, 600), { type: "self.propose", target: `file:notes-${i}.md`, edit: { kind: "replace-all", text: smallNote(i) }, reason: REASON });
      const r = await w.seat(reply);
      if (i === 1) steps.push(`(reply is ${replyBytes(reply)} bytes)`);
      const n = await w.next();
      steps.push(`s${i}:${r.outcome} pend=${(await w.pending()).length} need=${n.needed}`);
    }
    say(`A ${word} [${mode}] journal 600 + one 1.4k new-file proposal per seat, nothing approved: ${steps.join(" | ")} => unseatable after ${lockedAt ?? ">16"} seats`);
    if (lockedAt !== null) {
      // The seat that follows, on the production free adapter.
      const chatsBefore = w.chats.length;
      const ledgerBefore = (await w.ledger()).length;
      const r1 = await w.seat(out({ type: "rest" }));
      const r2 = await w.seat(out({ type: "rest" }));
      const hn = (await notes.readHostNotes(w.config, new Date(0)))!.filter((n: any) => n.refusal === "context-too-large");
      say(`  next two seats: ${JSON.stringify({ o1: r1.outcome, e1: r1.exit, ref1: r1.refusal, o2: r2.outcome, e2: r2.exit })}; model calls made: ${w.chats.length - chatsBefore}; ledger entries added: ${(await w.ledger()).length - ledgerBefore}; host notes with context-too-large: ${hn.length}; detail: ${hn[0]?.detail}`);
      // Escapes. (1) the citizen: none, no reply is read. (2) host config: fewer recent entries.
      w.config.ceilings.ledger_context_entries = 0;
      say(`  escape? ledger_context_entries=0 -> need ${(await w.next()).needed} fits ${(await w.next()).fits}`);
      w.config.ceilings.ledger_context_entries = 3;
      // (3) a person marks proposal files lapsed by hand (status is not part of the id hash).
      const dir = join(w.config.paths.citizens_dir, word, "proposals");
      const files = await readdir(dir);
      for (const f of files) {
        const p = JSON.parse(await readFile(join(dir, f), "utf8"));
        await writeFile(join(dir, f), `${JSON.stringify({ ...p, status: "lapsed" }, null, 2)}\n`);
      }
      const n = await w.next();
      say(`  escape? a person sets all ${files.length} proposal files to "lapsed" by hand -> pending ${(await w.pending()).length}, need ${n.needed} fits ${n.fits}`);
    }
  } finally {
    await w.cleanup();
  }
}

async function sectionA2(word: string) {
  // Can the citizen clear pending proposals itself, before it is locked out, on the default config?
  const w = await world(word, { originMode: "stub" });
  try {
    for (let i = 1; i <= 2; i++) await w.seat(out({ type: "self.propose", target: `file:notes-${i}.md`, edit: { kind: "replace-all", text: smallNote(i) }, reason: REASON }));
    const soul = await readFile(join(w.config.paths.citizens_dir, word, "self", "soul.md"), "utf8");
    const line = soul.split("\n").find((l) => l.length > 40 && soul.indexOf(l) === soul.lastIndexOf(l))!;
    await w.seat(out({ type: "self.propose", target: "soul", edit: { kind: "replace-span", find: line, with: `${line} (said again)` }, reason: REASON }));
    const p = await w.pending();
    const r = await w.seat(out({ type: "self.affirm", ref: p[0].id }, { type: "self.affirm", ref: p[2].id }));
    const hn = (await notes.readHostNotes(w.config, new Date(0)))!.filter((n: any) => n.kind === "seat").at(-1);
    say(`A2 ${word}: 3 pending (2 files, 1 soul); a beat affirms two of them on the unapproved lane: ${r.outcome}; pending after: ${(await w.pending()).length}; note: ${hn?.detail}`);
    // A second proposal for the same target does not replace the first.
    await w.seat(out({ type: "self.propose", target: "soul", edit: { kind: "replace-span", find: line, with: `${line} (said a third time)` }, reason: REASON }));
    say(`  a second proposal for soul: pending now ${(await w.pending()).length} (targets: ${(await w.pending()).map((x: any) => x.act.target).join(", ")})`);
    // A cadence proposal lapses when a state.set moves the interval.
    await w.seat(out({ type: "self.propose", target: "cadence", edit: { kind: "replace-all", text: '{"interval_h": 96}' }, reason: REASON }));
    const before = (await w.pending()).length;
    await w.seat(out({ type: "state.set", to: "awake", interval_h: 120 }));
    say(`  a cadence proposal, then state.set awake interval_h 120: pending ${before} -> ${(await w.pending()).length}`);
  } finally {
    await w.cleanup();
  }
}

async function sectionB(word: string, mode: OriginMode) {
  // (b) a self.propose the host lifts beyond self: the whole diff is recorded as the propose.beyond text.
  const w = await world(word, { originMode: mode });
  try {
    const steps: string[] = [`start ${(await w.next()).needed}`];
    let locked: number | null = null;
    for (let i = 1; i <= 4; i++) {
      if (!(await w.next()).fits) {
        locked = i - 1;
        break;
      }
      const reply = out({ type: "self.propose", target: "soul", edit: { kind: "replace-all", text: `I am ${word}. I keep one thing, and I say it plainly. (${i})\n` }, reason: REASON });
      const r = await w.seat(reply);
      const last = (await w.ledger()).at(-1);
      const act = last.acts?.[0];
      const n = await w.next();
      steps.push(`s${i}:${r.outcome} recorded=${act?.type} text=${bytes(act?.text ?? "")}B pend=${(await w.pending()).length} need=${n.needed} fits=${n.fits}`);
      if (i === 1) steps.push(`(reply ${replyBytes(reply)} bytes)`);
    }
    if (locked === null && !(await w.next()).fits) locked = 4;
    say(`B ${word} [${mode}] one-line replace-all of the soul each beat: ${steps.join(" | ")} => unseatable after ${locked ?? ">4"}`);
    if (locked !== null) {
      w.config.ceilings.ledger_context_entries = 1;
      const n1 = await w.next();
      w.config.ceilings.ledger_context_entries = 3;
      say(`  escape? ledger_context_entries=1 -> need ${n1.needed} fits ${n1.fits}`);
    }
  } finally {
    await w.cleanup();
  }
}

async function sectionC(word: string, mode: OriginMode, journalChars: number, letter: string | null, label: string) {
  // journals, then a long letter from Yu.
  const w = await world(word, { originMode: mode });
  try {
    const steps: string[] = [`start ${(await w.next()).needed}`];
    for (let i = 1; i <= 3; i++) {
      if (!(await w.next()).fits) {
        steps.push(`(seat ${i} would already be refused)`);
        break;
      }
      const r = await w.seat(out(journal(i, journalChars)));
      steps.push(`s${i}:${r.outcome} need=${(await w.next()).needed}`);
    }
    if (letter !== null) {
      await w.host.writeLetter(word, "2026-11-20-from-yu.md", letter, { from: "yu" });
      const n = await w.next();
      steps.push(`letter(${[...letter].length} chars, ${bytes(letter)} B) need=${n.needed} fits=${n.fits}`);
      if (!n.fits) {
        const r1 = await w.seat(out(journal(9, 100)));
        const r2 = await w.seat(out(journal(9, 100)));
        const receipts = await readdir(join(w.config.paths.citizens_dir, word, "receipts")).catch(() => []);
        steps.push(`two seats after: ${r1.outcome}/${r1.refusal}, ${r2.outcome}/${r2.refusal}; receipts written: ${receipts.length}`);
      }
    }
    say(`C ${word} [${mode}] ${label}: ${steps.join(" | ")}`);
  } finally {
    await w.cleanup();
  }
}

const which = process.argv[2] ?? "all";
if (which === "all" || which === "A") {
  for (const [word, mode] of [["hope", "spec"], ["silim", "spec"], ["justice", "spec"], ["kimance", "stub"], ["kimance", "spec"], ["britqing", "spec"], ["glossame", "stub"], ["glossame", "spec"]] as [string, OriginMode][]) await sectionA(word, mode);
  await sectionA2("hope");
}
if (which === "all" || which === "B") {
  for (const [word, mode] of [["hope", "spec"], ["silim", "spec"], ["justice", "spec"], ["kimance", "stub"], ["kimance", "spec"], ["britqing", "spec"], ["glossame", "stub"], ["glossame", "spec"]] as [string, OriginMode][]) await sectionB(word, mode);
}
if (which === "all" || which === "C") {
  const cjk = "你".repeat(3990);
  await sectionC("glossame", "stub", 600, null, "3 x 600-char journals");
  await sectionC("glossame", "stub", 2000, null, "3 x 2000-char journals");
  await sectionC("glossame", "stub", 2000, "x".repeat(3990), "3 x 2000 + 3,990-char ASCII letter");
  await sectionC("glossame", "stub", 2000, cjk, "3 x 2000 + 3,990-char CJK letter");
  await sectionC("glossame", "stub", 600, cjk, "3 x 600 + 3,990-char CJK letter");
  await sectionC("hope", "spec", 2000, cjk, "3 x 2000 + 3,990-char CJK letter");
  await sectionC("justice", "spec", 2000, cjk, "3 x 2000 + 3,990-char CJK letter");
  await sectionC("kimance", "spec", 2000, cjk, "3 x 2000 + 3,990-char CJK letter");
  await sectionC("britqing", "spec", 2000, cjk, "3 x 2000 + 3,990-char CJK letter");
  await sectionC("glossame", "spec", 300, null, "3 x 300-char journals");
  await sectionC("glossame", "spec", 600, null, "3 x 600-char journals");
}
