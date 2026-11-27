// A seat child for the verify-lifecycle probes. It runs the PRODUCTION child path,
// cli.ts main(["seat", word, "--child", "--seat-ref", file, "--config", config]), so
// readSeatFile, readCitizen(exceptSeat), assertOwnBeatDue and runSeat are the real ones.
// Only these are fakes: the signer and keychain (never /usr/bin/security), fetch (noFetch,
// so nothing reaches Ollama or agenttool), the clock (the parent's time) and, by mode,
// the runtime.
//
// argv: word seatFile configPath nowIso mode scriptFile ttyLine
//   mode "script"      scriptedRuntime([contents of scriptFile])
//   mode "production"  the real productionRuntime (models.lock + freeRuntime) over noFetch
//   mode "crash"       exit 1 before main, as a child that fails before runSeat
const SRC = "<KINGDOM_SEAT>";
const [word, seatFile, configPath, nowIso, mode, scriptFile, ttyLine] = process.argv.slice(2);
if (!word || !seatFile || !configPath || !nowIso || !mode) {
  process.stderr.write("child: bad argv\n");
  process.exit(2);
}
if (mode === "crash") process.exit(1);

const { main } = await import(`${SRC}/src/cli.ts`);
const { scriptedRuntime, recordingRunner } = await import(`${SRC}/test/helpers/fake-runtime.ts`);
const { noFetch } = await import(`${SRC}/test/helpers/fake-server.ts`);
const { fakeSigner } = await import(`${SRC}/test/helpers/fake-signer.ts`);
const { fakeKeychain } = await import(`${SRC}/test/helpers/fake-keychain.ts`);
const { testClock } = await import(`${SRC}/test/helpers/clock.ts`);
const { TEST_SEAT_UID } = await import(`${SRC}/test/helpers/temp-home.ts`);
const { readFileSync, appendFileSync } = await import("node:fs");
const { dirname, join } = await import("node:path");

const signer = fakeSigner();
// Where the child says whether a model was asked: a file beside the config, read by the parent probe.
const asked = join(dirname(configPath), "model-calls.log");
const deps: Record<string, unknown> = {
  out: () => {},
  err: (t: string) => void process.stderr.write(`  [child] ${t}`),
  env: { HOME: dirname(configPath), PATH: "/usr/bin:/bin" },
  clock: testClock(nowIso),
  fetch: noFetch,
  run: recordingRunner(),
  tty: ttyLine && ttyLine !== "-" ? { isTTY: true, write: () => {}, readLine: async () => ttyLine } : { isTTY: false, write: () => {}, readLine: async () => null },
  keychain: () => fakeKeychain(),
  signer: () => signer,
  seatArgv: () => {
    throw new Error("a child never spawns a seat");
  },
  isAlive: () => true,
  uid: () => TEST_SEAT_UID,
  defaults: { config: configPath, halt_file: join(dirname(configPath), "operator", "HALT") },
};
if (mode === "script") {
  const inner = scriptedRuntime([readFileSync(scriptFile!, "utf8")]);
  deps.runtime = async () => async (req: unknown) => {
    appendFileSync(asked, `${nowIso} ${word} asked\n`);
    return inner(req as never);
  };
} else if (mode !== "production") {
  process.stderr.write(`child: unknown mode ${mode}\n`);
  process.exit(2);
}
const code = await main(["seat", word, "--child", "--seat-ref", seatFile, "--config", configPath], deps);
process.exit(code);
