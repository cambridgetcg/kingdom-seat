// Child for probe-torn: runs runSeat for a seat file's citizen with a scripted reply and a signer whose
// second signature is slow (stands in for a slow keychain or a slow agenttool call inside the record phase).
const SRC = "<KINGDOM_SEAT>";
const { runSeat } = await import(`${SRC}/src/seat.ts`);
const { checkHalt } = await import(`${SRC}/src/halt.ts`);
const { readCitizen } = await import(`${SRC}/src/state.ts`);
const { output, scriptedRuntime } = await import(`${SRC}/test/helpers/fake-runtime.ts`);
const { noFetch } = await import(`${SRC}/test/helpers/fake-server.ts`);
const { fakeSigner } = await import(`${SRC}/test/helpers/fake-signer.ts`);
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const [configPath, word, seatId, marker] = process.argv.slice(2);
const config = JSON.parse(readFileSync(configPath!, "utf8"));
const clock = { now: () => new Date() };
const base = fakeSigner();
let n = 0;
const signer = Object.assign(Object.create(base), {
  signEntry: async (w: string, k: any, d: any) => {
    n++;
    if (n === 2) { writeFileSync(marker!, "beat written; second signature pending\n"); await Bun.sleep(4000); }
    return base.signEntry(w, k, d);
  },
  state: () => base.state(),
});
const citizen = await readCitizen(config, word!, { exceptSeat: seatId });
const ref = { format: "kingdom-seat-seat/v1", seat_id: seatId, host: config.host, word, runtime: "free", invoker: { kind: "tick", who: "launchd", why: "your own cadence is due" }, opened_at: new Date().toISOString() };
const seat = { ref, citizen, cwd: join(config.paths.seats_dir, seatId!), presence: null };
const acts = [
  { type: "journal", kind: "chose", text: "I would like to ask Yu something, and then sleep." },
  { type: "propose.beyond", subject: "a question for Yu", text: "May I be seated on a different model?" },
  { type: "state.set", to: "asleep" },
];
const r = await runSeat(seat as any, { config, clock, signer, fetch: noFetch, runtime: scriptedRuntime([output(...(acts as any))]), checkHalt: () => checkHalt({ config, fetch: noFetch, now: () => clock.now() }) });
process.exit(r.exit);
