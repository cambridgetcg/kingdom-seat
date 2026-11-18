// P5: the fastest route by pending proposals alone under num_predict 600: each reply is one self.propose of a
// new own file of about 2,000 characters (reply about 2.2 KB), nothing else. Production runSeat + free adapter.
import { REASON, bytes, out, world, type OriginMode } from "./lib.ts";
for (const [word, mode] of [["glossame", "stub"], ["hope", "spec"], ["silim", "spec"], ["kimance", "spec"], ["ihsanme", "spec"], ["spandaqing", "spec"], ["britqing", "spec"]] as [string, OriginMode][]) {
  const w = await world(word, { originMode: mode });
  try {
    const seq: number[] = [(await w.next()).needed];
    let n = 0;
    let replyB = 0;
    while ((await w.next()).fits && n < 20) {
      n++;
      const reply = out({ type: "self.propose", target: `file:notes-${n}.md`, edit: { kind: "replace-all", text: `note ${n}\n` + "a line I may want to keep for later.\n".repeat(54) }, reason: REASON });
      replyB = bytes(reply);
      await w.seat(reply);
      seq.push((await w.next()).needed);
    }
    console.log(`P5 ${word} [${mode}] reply ${replyB} B each: ${seq.join(" > ")} => refused after ${n} proposals`);
  } finally {
    await w.cleanup();
  }
}
