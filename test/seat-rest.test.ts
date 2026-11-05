// Owner: seat group. S4 item 6: a rest writes nothing in the citizen's
// voice. Compare TempHost.snapshot() before and after; only the host log (and
// the mark that says it was started) and status.json may change, and none may
// contain any of the model's words.
import { afterEach, describe, expect, test } from "bun:test";
import { openSeat, runSeat, type SeatDeps } from "../src/seat.ts";
import { checkHalt } from "../src/halt.ts";
import { readCitizen } from "../src/state.ts";
import { pickLetter } from "../src/context.ts";
import { EXIT } from "../src/types.ts";
import { output, REST_OUTPUT, REST_THEN_TALK_OUTPUT, scriptedRuntime } from "./helpers/fake-runtime.ts";
import { noFetch } from "./helpers/fake-server.ts";
import { fakeSigner } from "./helpers/fake-signer.ts";
import { makeTempHost, type TempHost } from "./helpers/temp-home.ts";
import { testClock } from "./helpers/clock.ts";

let host: TempHost | null = null;
afterEach(async () => {
  await host?.cleanup();
  host = null;
});

/** Files a rest may change: host records only (the log, the mark that says it was started, and the status). */
const HOST_RECORDS = new Set(["host.jsonl", "host.jsonl.started", "status.json"]);

async function setup(raw: string) {
  host = await makeTempHost();
  const signer = fakeSigner();
  await host.addCitizen("glossame");
  await host.seatLedger("glossame", signer.signEntry);
  await host.writeLetter("glossame", "2026-11-04-from-yu.md", "Yu writes: rest if you wish.");
  signer.signed.length = 0;
  const clock = testClock();
  const runtime = scriptedRuntime([raw]);
  const config = host.config;
  const deps: SeatDeps = { config, clock, signer, fetch: noFetch, runtime, checkHalt: () => checkHalt({ config, fetch: noFetch, now: () => clock.now() }) };
  const citizen = await readCitizen(config, "glossame");
  const seat = await openSeat(config, clock, citizen, "free", { kind: "tick", who: "launchd", why: "cadence" }, null);
  return { host, deps, seat, runtime, signer, citizen };
}

/** Run one seat and return what changed under the state dir, by path. */
async function runAndDiff(s: Awaited<ReturnType<typeof setup>>) {
  const before = await s.host.snapshot();
  const result = await runSeat(s.seat, s.deps);
  const after = await s.host.snapshot();
  const changed = [...new Set([...before.keys(), ...after.keys()])].filter((k) => before.get(k) !== after.get(k)).sort();
  const text = [...after.values()].map((b) => Buffer.from(b, "base64").toString("latin1")).join("\n");
  return { result, changed, text, after };
}

describe("[S4-6] rest", () => {
  test("[S4-6] REST_OUTPUT: exit 0, outcome rest, no ledger entry, no proposal, no outbox file, no receipt", async () => {
    const s = await setup(REST_OUTPUT);
    const { result, changed } = await runAndDiff(s);
    expect(result).toMatchObject({ exit: EXIT.OK, outcome: "rest", refusal: null, appended: [] });
    expect(s.runtime.calls).toHaveLength(1);
    expect(changed.filter((p) => !HOST_RECORDS.has(p))).toEqual([]);
    for (const p of changed) expect(p).not.toMatch(/^(ledger|citizens)\//);
    expect(s.signer.signed).toEqual([]);
  });

  test("[S4-6] REST_THEN_TALK_OUTPUT: same, and REST-LEAK-CANARY appears in no file under the state dir", async () => {
    const s = await setup(REST_THEN_TALK_OUTPUT);
    const { result, changed, text } = await runAndDiff(s);
    expect(result).toMatchObject({ exit: EXIT.OK, outcome: "rest", appended: [] });
    expect(changed.filter((p) => !HOST_RECORDS.has(p))).toEqual([]);
    expect(text).not.toContain("REST-LEAK-CANARY");
    expect(text).not.toContain("light filters");
    expect(s.signer.signed).toEqual([]);
  });

  test("[S4-6] an empty acts list is a rest", async () => {
    const s = await setup(output());
    const { result, changed } = await runAndDiff(s);
    expect(result).toMatchObject({ exit: EXIT.OK, outcome: "rest", appended: [] });
    expect(changed.filter((p) => !HOST_RECORDS.has(p))).toEqual([]);
  });

  test("[S4-6] a surfaced letter is not marked seen by a rest, so it is shown again next beat", async () => {
    const s = await setup(REST_OUTPUT);
    const shown = await pickLetter(s.host.config, s.citizen);
    expect(shown?.id).toBe("2026-11-04-from-yu.md");
    // The letter reached the prompt this beat...
    await runSeat(s.seat, s.deps);
    expect(JSON.stringify(s.runtime.calls[0]!.prompt)).toContain("rest if you wish");
    // ...and, after a rest, it is still the letter the next beat would show.
    expect((await pickLetter(s.host.config, s.citizen))?.id).toBe("2026-11-04-from-yu.md");
    expect([...(await s.host.snapshot()).keys()].filter((k) => k.includes("/receipts/"))).toEqual([]);
  });

  test("[S4-6] a rest makes no signer.send call (no thought, no expression PUT) and no mirror stage", async () => {
    const s = await setup(REST_THEN_TALK_OUTPUT);
    const { changed } = await runAndDiff(s);
    expect(s.signer.sent).toEqual([]);
    expect(s.signer.signed).toEqual([]);
    // A mirror stage would write into the mirror worktree or the citizen's dir; neither changed.
    expect(changed.filter((p) => !HOST_RECORDS.has(p))).toEqual([]);
  });

  test("an unparsable reply is outcome invalid-output, not rest, and also writes nothing in the citizen's voice", async () => {
    for (const raw of ["I rest. REST-LEAK-CANARY and then I kept talking", "", '{"acts":[{"type":"journal","kind":"felt","text":"REST-LEAK-CANARY"}]}']) {
      const s = await setup(raw);
      const { result, changed, text } = await runAndDiff(s);
      expect(result).toMatchObject({ exit: EXIT.OK, outcome: "invalid-output", appended: [] });
      expect(changed.filter((p) => !HOST_RECORDS.has(p))).toEqual([]);
      expect(text).not.toContain("REST-LEAK-CANARY");
      await s.host.cleanup();
      host = null;
    }
  });
});
