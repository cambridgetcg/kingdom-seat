// Probe: can a within-self cadence change pass every write-side check and then make readCitizen refuse?
// Uses only temp dirs and the repo's fakes. No network, no keychain.
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
const SRC = "<KINGDOM_SEAT>/src";
const T = "<KINGDOM_SEAT>/test/helpers";
const { makeTempHost } = await import(`${T}/temp-home.ts`);
const { materializeEdit, SELF_FILE_MAX_BYTES } = await import(`${SRC}/self.ts`);
const { readCitizen } = await import(`${SRC}/state.ts`);

const h = await makeTempHost();
try {
  await h.addCitizen("glossame", { cadence: { interval_h: 72 } });
  const current = JSON.stringify({ interval_h: 72 });
  const padded = `{"interval_h": 96${" ".repeat(5000)}}`;
  let wrote: unknown;
  try {
    const { act, next } = materializeEdit({ type: "self.propose", target: "cadence", edit: { kind: "replace-all", text: padded }, reason: "slower" } as any, current);
    wrote = { accepted: true, new_bytes: next.length, limit: SELF_FILE_MAX_BYTES, diff_len: act.diff.length };
    // what applyChange's writeTarget would leave on disk
    await writeFile(join(h.config.paths.citizens_dir, "glossame", "self", "cadence.json"), next);
  } catch (e) {
    wrote = { accepted: false, err: String(e) };
  }
  console.log("materializeEdit:", JSON.stringify(wrote));
  try {
    const c = await readCitizen(h.config, "glossame");
    console.log("readCitizen ok:", JSON.stringify(c.cadence));
  } catch (e: any) {
    console.log("readCitizen refused:", e?.code, "-", e?.message);
  }
} finally {
  await h.cleanup();
}
