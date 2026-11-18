// P6: an ordinary seat: three journals already in the record, then a letter the size of the largest one any
// citizen has been sent so far (2,887 bytes of English), for the eleven awake citizens. Production runSeat.
import { AWAKE, bytes, out, world } from "./lib.ts";
const letter = "A line from Yu, in plain English, about the season and the house. ".repeat(50).slice(0, 2860);
for (const chars of [600, 2000]) {
  const rows: string[] = [];
  for (const word of AWAKE) {
    const w = await world(word, { originMode: "spec" });
    try {
      let stuckAt: number | null = null;
      for (let i = 1; i <= 3; i++) {
        if (!(await w.next()).fits) {
          stuckAt = i;
          break;
        }
        await w.seat(out({ type: "journal", kind: "reflected", text: (`seat ${i}: ` + "I keep the word on its own side and say so plainly. ".repeat(60)).slice(0, chars) }));
      }
      const before = await w.next();
      await w.host.writeLetter(word, "2026-11-20-from-yu.md", letter, { from: "yu" });
      const after = await w.next();
      rows.push(`${word}: ${stuckAt ? `refused from seat ${stuckAt}` : `3 journals ${before.needed}${before.fits ? "" : " (refused)"}`}; +letter ${after.needed} ${after.fits ? "fits" : "REFUSED"}`);
    } finally {
      await w.cleanup();
    }
  }
  console.log(`P6 journals of ${chars} chars, letter ${bytes(letter)} B, num_ctx 32768, canon entry included where one exists:\n  ${rows.join("\n  ")}`);
}
