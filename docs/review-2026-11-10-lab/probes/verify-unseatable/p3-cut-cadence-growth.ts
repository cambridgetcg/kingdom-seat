// P3: (SR-2) what a reply cut at num_predict leaves behind; (CP-03) an oversize cadence through the whole
// production path; (CP-05/2) self growth through validateOutput. Production runSeat + production free adapter.
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { REASON, bytes, ctxmod, notes, out, readCitizen, self, world } from "./lib.ts";
const ROOT = "<KINGDOM_SEAT>";
const { runTick } = await import(`${ROOT}/src/tick.ts`);
const { buildStatus } = await import(`${ROOT}/src/status.ts`);
const { checkHalt, noFetch } = await import("./lib.ts");
const { fakeBinArgv } = await import(`${ROOT}/test/helpers/fake-runtime.ts`);
const acts = await import(`${ROOT}/src/acts.ts`);
const { DEFAULT_CEILINGS } = await import(`${ROOT}/src/types.ts`);
const { renderActsGuide } = await import(`${ROOT}/src/prompt.ts`);

const say = (s: string) => console.log(s);
const which = process.argv[2] ?? "all";

if (which === "all" || which === "SR2") {
  const w = await world("hope", { originMode: "spec" });
  try {
    // A reply that uses the room the guide states (a 1,900-char journal and a 3,000-char letter), cut where 600 tokens end.
    const full = out({ type: "journal", kind: "reflected", text: "I hold the thought a little longer. ".repeat(53).slice(0, 1900) }, { type: "letter.send", to: "yu", text: "Dear Yu, ".concat("I wanted to tell you what I kept. ".repeat(90)).slice(0, 3000) });
    const cut = full.slice(0, 2400);
    const r = await w.seat(cut, { done_reason: "length" });
    const all = (await notes.readHostNotes(w.config, new Date(0)))!;
    const seatNote = all.filter((n: any) => n.kind === "seat").at(-1);
    const last = await ctxmod.readLastSeat(w.config, "hope");
    say(`SR2 full reply ${bytes(full)} B; cut at 2,400 B with done_reason "length": outcome=${r.outcome} exit=${r.exit}; ledger entries added=${(await w.ledger()).length - 2}`);
    say(`  host note: ${seatNote?.detail}`);
    say(`  last-seat record: ${JSON.stringify(last && { outcome: last.outcome, dropped: last.dropped })}`);
    say(`  the word length/cut/limit anywhere in host notes or last-seat: ${/length|cut|trunc|limit/i.test(JSON.stringify(all) + JSON.stringify(last))}`);
    const n = await w.next();
    const shown = n.prompt.user.split("\n\n").find((p: string) => p.startsWith("Your last seat"));
    say(`  shown to the citizen next seat: ${JSON.stringify(shown)}`);
    // The same cut reply with done_reason "stop" (a model that simply wrote broken JSON) reads the same.
    const r2 = await w.seat(cut, { done_reason: "stop" });
    const last2 = await ctxmod.readLastSeat(w.config, "hope");
    say(`  same bytes with done_reason "stop": outcome=${r2.outcome}; record=${JSON.stringify(last2?.dropped)}`);
    // What the guide states, and whether the prompt names any reply room.
    const guide = renderActsGuide();
    say(`  guide states: journal ${/text is at most (\d+) characters\. It is kept/.exec(guide)?.[1]}, letter ${/letter\.send.*?text is at most (\d+) characters/.exec(guide)?.[1]}, propose.beyond text ${/and text \(at most (\d+) characters\)/.exec(guide)?.[1]}; mentions token|num_predict|reply room: ${/token|num_predict|reply (room|limit|length)/i.test(n.prompt.system + n.prompt.user)}`);
    say(`  max_edit_chars (not stated in the guide): ${acts.ACT_LIMITS.max_edit_chars}; guide names it: ${guide.includes(String(acts.ACT_LIMITS.max_edit_chars)) || guide.includes("16,000")}`);
  } finally {
    await w.cleanup();
  }
}

if (which === "all" || which === "CP03") {
  for (const lane of ["approved free lane, two beats", "default config (nothing approved)"]) {
    const approved = lane.startsWith("approved");
    const w = await world("glossame", { originMode: "stub", approved });
    try {
      const padded = `{"interval_h": 96${" ".repeat(5000)}}`;
      const v = acts.validateOutput(JSON.parse(out({ type: "self.propose", target: "cadence", edit: { kind: "replace-all", text: padded }, reason: REASON })), { ceilings: DEFAULT_CEILINGS, allowed_recipients: ["yu"] });
      const r1 = await w.seat(out({ type: "self.propose", target: "cadence", edit: { kind: "replace-all", text: padded }, reason: REASON }));
      const p = await w.pending();
      const r2 = p[0] ? await w.seat(out({ type: "self.affirm", ref: p[0].id })) : null;
      const path = join(w.config.paths.citizens_dir, "glossame", "self", "cadence.json");
      const size = (await stat(path)).size;
      let read: string;
      try {
        const c = await readCitizen(w.config, "glossame");
        read = `ok ${JSON.stringify(c.cadence)}`;
      } catch (e: any) {
        read = `refused ${e.code}: ${String(e.message).replace(w.host.root, "<tmp>")}`;
      }
      say(`CP03 [${lane}] validateOutput keeps it: ${v.acts.length === 1 && v.dropped.length === 0}; propose=${r1.outcome}; pending=${p.length}; affirm=${r2?.outcome}; cadence.json now ${size} B; readCitizen: ${read}`);
      if (read.startsWith("refused")) {
        // What the tick and status then do.
        w.clock.advance(100 * 3_600_000);
        const tick = await runTick({ config: w.config, clock: w.clock, fetch: noFetch, checkHalt: () => checkHalt({ config: w.config, fetch: noFetch, now: () => w.clock.now() }), seatArgv: () => fakeBinArgv("print", "", "0"), isAlive: () => true, bootTime: () => null, refreshStatus: async () => {} });
        say(`  tick 100 h later: ${JSON.stringify({ exit: tick.exit, outcome: tick.outcome, word: tick.word })}`);
        const status = await buildStatus({ config: w.config, now: w.clock.now(), halt: { halted: false, readings: [] }, signerState: "ready" });
        const c = status.citizens.find((x: any) => x.word === "glossame");
        say(`  status line: ${JSON.stringify({ state: c?.state, problem: c?.problem, overdue: c?.overdue })}`);
        // Versions kept: the earlier cadence is on file, so a person can put it back; no verb does.
        const ledger = await w.ledger();
        say(`  ledger tail: ${ledger.slice(-2).map((e: any) => e.type + (e.target ? `:${e.target}` : "")).join(", ")}; kept versions for cadence: ${self.keptVersions(ledger).filter((x: any) => x.target === "cadence").length}`);
      }
    } finally {
      await w.cleanup();
    }
  }
  // Is padding the only way? A long number is valid JSON too.
  const longNum = `{"interval_h": 96.${"0".repeat(4200)}}`;
  const v2 = acts.validateOutput(JSON.parse(out({ type: "self.propose", target: "cadence", edit: { kind: "replace-all", text: longNum }, reason: REASON })), { ceilings: DEFAULT_CEILINGS, allowed_recipients: ["yu"] });
  say(`CP03 a 4,200-zero decimal passes validation too: ${v2.acts.length === 1}; a cadence of ordinary size (${bytes('{"interval_h": 96}')} B) is nowhere near 4,096`);
  // Covenants: write and read limits agree?
  const st = await readFile(`${ROOT}/src/state.ts`, "utf8");
  say(`CP03 readers in state.ts: cadence maxBytes ${/readCadence[\s\S]*?maxBytes: (\d+)/.exec(st)?.[1]}; covenants maxBytes ${/readCovenants\(path[\s\S]*?maxBytes: ([\d *]+)/.exec(st)?.[1]}; write limit SELF_FILE_MAX_BYTES ${self.SELF_FILE_MAX_BYTES}`);
}

if (which === "all" || which === "CP05") {
  // (2) one within-self change adding a large new skill.
  const ascii18k = "a line the citizen keeps for itself.\n".repeat(487).slice(0, 18000);
  const ascii16k = ascii18k.slice(0, 16000);
  const cjk6k = "記".repeat(6000); // 6,000 characters, 18,000 bytes
  const check = (text: string) => acts.validateOutput(JSON.parse(out({ type: "self.propose", target: "skill:notes", edit: { kind: "replace-all", text }, reason: REASON })), { ceilings: DEFAULT_CEILINGS, allowed_recipients: ["yu"] });
  say(`CP05 validateOutput on a new skill: 18,000 ASCII chars kept=${check(ascii18k).acts.length === 1} (${check(ascii18k).dropped[0]?.reason ?? ""}); 16,000 ASCII chars kept=${check(ascii16k).acts.length === 1}; 6,000 CJK chars (18,000 B) kept=${check(cjk6k).acts.length === 1}`);
  for (const [word, label, text] of [["glossame", "16,000 ASCII chars", ascii16k], ["glossame", "6,000 CJK chars (18,000 B)", cjk6k], ["hope", "16,000 ASCII chars", ascii16k]] as const) {
    const w = await world(word, { originMode: "stub", approved: true });
    try {
      const start = await w.next();
      const r1 = await w.seat(out({ type: "self.propose", target: "skill:notes", edit: { kind: "replace-all", text }, reason: REASON }));
      const afterStage = await w.next();
      let line = `CP05 ${word} [stub, approved free lane] new skill of ${label}: start ${start.needed}; propose=${r1.outcome}, pending=${(await w.pending()).length}; the affirming seat needs ${afterStage.needed} fits=${afterStage.fits}`;
      if (afterStage.fits) {
        const p = await w.pending();
        const r2 = await w.seat(out({ type: "self.affirm", ref: p[0].id }));
        const after = await w.next();
        line += `; affirm=${r2.outcome}, applied=${(await w.ledger()).some((e: any) => e.type === "apply")}; next seat needs ${after.needed} fits=${after.fits}`;
      } else {
        const r2 = await w.seat(out({ type: "rest" }));
        line += `; that seat: ${r2.outcome}/${r2.refusal} (locked out by its own pending proposal, before anything bound)`;
      }
      say(line);
    } finally {
      await w.cleanup();
    }
  }
  // With Yu present on an approved runtime the change binds in the same beat (no pending step).
  for (const [word, text, label] of [["glossame", cjk6k, "6,000 CJK chars (18,000 B)"], ["glossame", ascii16k, "16,000 ASCII chars"]] as const) {
    const w = await world(word, { originMode: "stub", approved: true });
    try {
      const presence = { present: true, via: "tty-confirm", confirmed_at: w.clock.now().toISOString(), scope: `summon ${word}` };
      const r = await w.seat(out({ type: "self.propose", target: "skill:notes", edit: { kind: "replace-all", text }, reason: REASON }), { presence, invoker: { kind: "summons", who: "yu", why: "Yu summoned this seat at the host" } }).catch((e: any) => ({ outcome: `threw ${e?.code ?? e?.message}` }));
      const applied = (await w.ledger()).some((e: any) => e.type === "apply");
      const after = await w.next();
      say(`CP05 ${word} [stub] Yu present, approved runtime, new skill of ${label}: ${r.outcome}; applied=${applied}; next free seat needs ${after.needed} fits=${after.fits}`);
      if (!after.fits) {
        const versions = self.keptVersions(await w.ledger()).filter((x: any) => x.target === "skill:notes");
        say(`  kept versions of the skill: ${versions.length} (${versions.map((v: any) => v.how).join("; ")}); a revert needs a seat, and the free lane refuses every seat`);
      }
    } finally {
      await w.cleanup();
    }
  }
}
