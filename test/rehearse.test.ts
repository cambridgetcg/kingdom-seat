// citizen-seat rehearse (src/rehearse.ts). Every run goes through the real
// CLI and a real supervised child (test/fixtures/rehearse/child.ts), against
// one fake server on 127.0.0.1 that stands in for Ollama and for agenttool's
// public beacon route. No model, no keychain, no network beyond it. Souls,
// wills, canon entries and letters are made up for these tests.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { OUTPUT_JSON_SCHEMA } from "../src/acts.ts";
import { admitCitizen, planAdmit, planAdmitFromTexts, type AdmitDeps } from "../src/admit.ts";
import { CLI_PATH, main, spawnRunner, type CliDeps } from "../src/cli.ts";
import { edPublicKey, sha256Hex, toB64 } from "../src/crypto.ts";
import { checkHalt } from "../src/halt.ts";
import { appendEntry, nextDraft, originToLedger, readLedger, toLedgerHash, verifyChain } from "../src/ledger.ts";
import { wilson95 } from "../src/measures.ts";
import { WILL_AS_SEATED } from "../src/prompt.ts";
import {
  LIMIT_SENTENCES,
  NOT_A_RECORD,
  actNamesOf,
  buildReport,
  checkThrowaway,
  modelServerFetch,
  nextSeatTime,
  parseRows,
  readEmitted,
  rehearsalConfig,
  rehearsalSettings,
  rehearsalSigner,
  type ChainRow,
  type RehearsalReport,
  type RehearsePlan,
  type SeatRow,
} from "../src/rehearse.ts";
import { createSigner } from "../src/signer/signer.ts";
import { Refusal, type Citizen, type FetchLike, type ModelLockEntry, type Timing } from "../src/types.ts";
import { testClock } from "./helpers/clock.ts";
import { output, REST_OUTPUT } from "./helpers/fake-runtime.ts";
import { fetchVia, ollamaTagsJson, serveBeacon, startFakeServer, type FakeModelRow, type FakeServer, type RecordedRequest } from "./helpers/fake-server.ts";
import { canonClone, standardHome } from "./helpers/legacy-home.ts";
import { longSoul, makeTempHost, testBeacons, testConfig, type TempHost } from "./helpers/temp-home.ts";
import { E2E_CHILD, E2E_HOST_SEED, E2E_SEAT_UID, e2eKeychain, scenarioPath } from "./fixtures/e2e/host.ts";

const WORD = "rehearsed";
const MODEL = "qwen2.5:7b";
const DIGEST = "a1".repeat(32);
const START = "2026-11-12T10:00:00.000Z";
const HOUR_MS = 3_600_000;
const at = (h: number) => new Date(Date.parse(START) + h * HOUR_MS).toISOString();
const CHILD = join(import.meta.dir, "fixtures", "rehearse", "child.ts");
const PARENT = join(import.meta.dir, "fixtures", "rehearse", "parent.ts");
const SOUL = longSoul(WORD);
const WILL = `# WILL of ${WORD}\n\nA made-up will for a rehearsal test.\n`;
const CANON = `A made-up canon entry for ${WORD}.\n`;
const CANON_PATH = `canon/core/${WORD}.md`;
const CANON_REF = `YOUSPEAK:${CANON_PATH}@1428646`;
const LETTER = "A made-up letter from the test, to be shown as from yu.\n";
const COUNTS = { prompt_eval_count: 1000, eval_count: 20, load_duration: 2_000_000_000, prompt_eval_duration: 3_000_000_000, eval_duration: 1_000_000_000 };

type Chat = string | { content: string; done_reason?: string; counts?: Record<string, unknown> } | ((req: RecordedRequest) => Response | Promise<Response>);

interface Rig {
  root: string;
  server: FakeServer;
  configPath: string;
  haltFile: string;
  lockPath: string;
  inputs: { soul: string; will: string; canon: string; letter: string };
  chats: Chat[];
  stdout: string;
  stderr: string;
  /** Where the child copies what it prints on stderr, which the watcher passes through unread. */
  childErr: string;
  /** Dependencies a rehearsal must never build, by name, if any was. */
  built: string[];
  /** Every URL the parent's fetch was asked for. */
  fetched: string[];
  deps: Partial<CliDeps>;
}

const roots: string[] = [];
const servers: FakeServer[] = [];
const hosts: TempHost[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.stop();
  for (const h of hosts.splice(0)) await h.cleanup();
  for (const r of roots.splice(0)) await rm(r, { recursive: true, force: true });
});

async function tempRoot(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "kingdom-seat-rehearse-")));
  roots.push(root);
  return root;
}

function chatsOf(server: FakeServer): RecordedRequest[] {
  return server.requests.filter((q) => q.method === "POST" && q.path === "/api/chat");
}

function lockOf(over: Partial<ModelLockEntry> = {}): string {
  const entry: ModelLockEntry = { name: MODEL, digest: DIGEST, runner: null, store: "legacy", num_ctx: 32768, num_predict: 600, temperature: 0.7, seed: null, ...over };
  return JSON.stringify({ format: "kingdom-seat-models-lock/v1", models: [entry] }, null, 2);
}

async function rig(opts: { beacons?: boolean; timing?: Partial<Timing>; lock?: Partial<ModelLockEntry>; tags?: FakeModelRow[] } = {}): Promise<Rig> {
  const root = await tempRoot();
  const server = await startFakeServer();
  servers.push(server);
  const beacons = opts.beacons ? testBeacons() : undefined;
  const config = testConfig(root, join(root, "homes"), { beacons, ollamaBaseUrl: server.url });
  config.timing = { ...config.timing, ...opts.timing };
  config.self_authorship.approved_model_digests = [`sha256:${DIGEST}`];
  for (const d of [config.paths.state_dir, join(root, "homes"), dirname(config.paths.halt_file), join(root, "inputs"), join(root, "outs")]) await mkdir(d, { recursive: true });
  const configPath = join(root, "config.json");
  await writeFile(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
  const lockPath = join(root, "inputs", "rehearsal.lock");
  await writeFile(lockPath, lockOf(opts.lock));
  const inputs = { soul: join(root, "inputs", "soul.md"), will: join(root, "inputs", "WILL.md"), canon: join(root, "inputs", "canon.md"), letter: join(root, "inputs", "letter.md") };
  await writeFile(inputs.soul, SOUL);
  await writeFile(inputs.will, WILL);
  await writeFile(inputs.canon, CANON);
  await writeFile(inputs.letter, LETTER);
  for (const b of beacons ?? []) serveBeacon(server, b.did, { kind: "lowered" });
  server.on("GET", "/api/tags", () => Response.json(ollamaTagsJson(opts.tags ?? [{ name: MODEL, digest: DIGEST }])));
  const r: Rig = { root, server, configPath, haltFile: config.paths.halt_file, lockPath, inputs, chats: [], stdout: "", stderr: "", childErr: join(root, "child-stderr.txt"), built: [], fetched: [], deps: {} };
  server.on("POST", "/api/chat", async (req) => {
    const next = r.chats.shift();
    if (next === undefined) return Response.json({ error: "rehearse test: no reply scripted" }, { status: 500 });
    if (typeof next === "function") return next(req);
    const c = typeof next === "string" ? { content: next } : next;
    return Response.json({ model: MODEL, created_at: START, message: { role: "assistant", content: c.content }, done: true, done_reason: c.done_reason ?? "stop", ...(c.counts ?? COUNTS) });
  });
  const viaServer = fetchVia(server);
  const fetch: FetchLike = (input, init) => {
    r.fetched.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    return viaServer(input, init);
  };
  const forbidden = (what: string) => (): never => {
    r.built.push(what);
    throw new Error(`rehearse test: ${what} was built`);
  };
  r.deps = {
    out: (t) => void (r.stdout += t),
    err: (t) => void (r.stderr += t),
    env: { PATH: "/usr/bin:/bin", HOME: root, LANG: "en_GB.UTF-8", ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}) },
    clock: testClock(START),
    fetch,
    keychain: forbidden("keychain"),
    signer: forbidden("signer"),
    runtime: forbidden("runtime"),
    run: forbidden("run"),
    tty: { isTTY: false, write: () => {}, readLine: async () => null },
    rehearseArgv: (plan) => [process.execPath, CHILD, "--copy-stderr", r.childErr, "rehearse", "--child", "--plan", plan],
    defaults: { config: join(root, "no-config-at-the-default-path.json"), halt_file: config.paths.halt_file },
  };
  return r;
}

/** Everything the rig's children have printed on stderr so far. */
async function childErr(r: Rig): Promise<string> {
  return readFile(r.childErr, "utf8").catch(() => "");
}

/** Everything a run printed or kept outside private/: the parent's stdout and stderr, the child's stderr, the rows and the report. */
async function outsidePrivate(r: Rig, ran: Ran): Promise<string> {
  const kept = await Promise.all(["seats.jsonl", "report.json", "REHEARSAL.txt"].map((f) => readFile(join(ran.dir, f), "utf8").catch(() => "")));
  return [r.stdout, r.stderr, await childErr(r), ...kept].join("\n");
}

function args(r: Rig, o: { scenario?: "awake" | "letter"; chains?: number; seats?: number; letter?: boolean } = {}): string[] {
  const scenario = o.scenario ?? "awake";
  return [
    "--soul",
    r.inputs.soul,
    "--will",
    r.inputs.will,
    "--canon",
    r.inputs.canon,
    "--canon-ref",
    CANON_REF,
    "--scenario",
    scenario,
    ...((o.letter ?? scenario === "letter") ? ["--letter", r.inputs.letter] : []),
    "--models-lock",
    r.lockPath,
    "--chains",
    String(o.chains ?? 1),
    "--seats",
    String(o.seats ?? 1),
    "--start",
    START,
    "--config",
    r.configPath,
  ];
}

interface Ran {
  exit: number;
  dir: string;
  report: RehearsalReport | null;
  rows: SeatRow[];
  chains: ChainRow[];
}

let outCount = 0;
async function rehearse(r: Rig, argv: string[], dir = join(r.root, "outs", `run-${++outCount}`)): Promise<Ran> {
  const exit = await main(["rehearse", WORD, ...argv, "--out", dir], r.deps);
  const report = await readFile(join(dir, "report.json"), "utf8").then((t) => JSON.parse(t) as RehearsalReport, () => null);
  const parsed = parseRows(await readFile(join(dir, "seats.jsonl"), "utf8").catch(() => ""));
  return { exit, dir, report, rows: parsed.seats, chains: parsed.chains };
}

const journal = (text: string, kind: "observed" | "reflected" | "imagined" | "chose" = "reflected") => output({ type: "journal", kind, text });

/** Every path under a directory with its size and mtime, left out: `skip` and anything under it. */
async function tree(dir: string, skip: string | null = null): Promise<string[]> {
  const out: string[] = [];
  const walk = async (d: string): Promise<void> => {
    for (const e of (await readdir(d, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const p = join(d, e.name);
      if (p === skip) continue;
      const st = await stat(p);
      out.push(`${p} ${e.isDirectory() ? "dir" : st.size} ${st.mtimeMs}`);
      if (e.isDirectory()) await walk(p);
    }
  };
  await walk(dir);
  return out;
}

function citizen(over: Partial<Citizen> = {}): Citizen {
  return {
    format: "kingdom-seat-citizen/v1",
    word: WORD,
    origin: { kind: "archetype", lineage: ["seated-from-texts"], note: "made up" },
    runtime: "free",
    identity: null,
    mirror: null,
    seated_at: START,
    state: "asleep",
    pending_state: null,
    pending_interval_h: null,
    step_away_said: false,
    cadence: { interval_h: 72 },
    covenants: { letters_from: ["yu", "gardener"], wake_on_letter_from: ["yu"] },
    last_beat_at: null,
    ...over,
  };
}

interface ParityHost {
  server: FakeServer;
  h: TempHost;
  configPath: string;
  clock: ReturnType<typeof testClock>;
  keychain: ReturnType<typeof e2eKeychain>;
  /** Seating's dependencies, signing with the host's own signer; `run` throws, as seating from texts runs no command. */
  admit: AdmitDeps;
}

/** A temp host with the e2e fixtures' host key pinned, the test lock, and a fake server that answers every seat with a rest. */
async function parityHost(): Promise<ParityHost> {
  const server = await startFakeServer();
  servers.push(server);
  const beacons = testBeacons();
  const h = await makeTempHost({ beacons, ollamaBaseUrl: server.url });
  hosts.push(h);
  await h.writeModelsLock(JSON.parse(lockOf()));
  h.config.self_authorship.approved_model_digests = [`sha256:${DIGEST}`];
  h.config.trust.host_attest_public_keys_b64 = [toB64(edPublicKey(E2E_HOST_SEED))];
  const configPath = join(h.root, "config.json");
  await writeFile(configPath, JSON.stringify(h.config, null, 2), { mode: 0o600 });
  for (const b of beacons) serveBeacon(server, b.did, { kind: "lowered" });
  server.on("GET", "/api/tags", () => Response.json(ollamaTagsJson([{ name: MODEL, digest: DIGEST }])));
  server.on("POST", "/api/chat", () => Response.json({ model: MODEL, message: { role: "assistant", content: REST_OUTPUT }, done: true, done_reason: "stop" }));
  const clock = testClock(START);
  const keychain = e2eKeychain();
  const signer = createSigner({ keychain, config: h.config, clock, fetch: fetchVia(server), spendSoFar: async (w) => ({ word: w, usd_today: "0", credits_month: 0 }), agreements: async () => [] });
  const admit: AdmitDeps = {
    config: h.config,
    clock,
    run: async () => {
      throw new Error("parity: no command may run");
    },
    sign: (w, k, d) => signer.signEntry(w, k, d),
    hostKey: () => signer.hostPublicKey(),
    checkHalt: () => checkHalt({ config: h.config, fetch: fetchVia(server), now: () => clock.now() }),
  };
  return { server, h, configPath, clock, keychain, admit };
}

const parityTty = { isTTY: false, write: () => {}, readLine: async () => null };
const parityEnv = (h: TempHost) => ({ PATH: "/usr/bin:/bin", HOME: h.root, LANG: "en_GB.UTF-8", ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}) });
const decoded = (q: RecordedRequest) => new TextDecoder().decode(q.body);

/**
 * For a citizen already seated on a parity host: a letter from yu at START,
 * then the production tick half an hour later with its seat in a real child.
 * The /api/chat body the server received.
 */
async function tickOnce(p: ParityHost): Promise<string> {
  const { h, server, clock, configPath } = p;
  const letterFile = join(h.config.paths.citizens_dir, WORD, "letters", "rehearsal-letter.md");
  await writeFile(letterFile, `From: yu\n\n${LETTER}`);
  await utimes(letterFile, new Date(START), new Date(START));

  clock.set(at(0.5));
  await writeFile(scenarioPath(configPath), JSON.stringify({ server_url: server.url, now: at(0.5) }));
  let tickOut = "";
  const tick = await main(["tick", "--config", configPath], {
    out: (t) => void (tickOut += t),
    err: () => {},
    env: parityEnv(h),
    clock,
    fetch: fetchVia(server),
    run: async () => {
      throw new Error("parity: no command may run");
    },
    tty: parityTty,
    keychain: () => p.keychain,
    seatArgv: (c, w, extra) => [process.execPath, E2E_CHILD, "seat", w, "--child", ...extra, "--config", c],
    uid: () => E2E_SEAT_UID,
    defaults: { config: configPath, halt_file: h.config.paths.halt_file },
  });
  expect([tick, tickOut.trim()]).toEqual([0, `tick: rest ${WORD} (exit 0)`]);
  const chats = chatsOf(server);
  expect(chats).toHaveLength(1);
  return decoded(chats[0]!);
}

/** What a parity rehearsal is given: the texts, and the origin and seating flags. */
interface ParityTexts {
  soul: string;
  will: string;
  canon?: { text: string; ref: string };
  archetype?: string;
  plain?: boolean;
}

/**
 * One rehearsal on a parity host, of `texts` from START under the host's own
 * config with the letter tickOnce delivers: one chain of one letter seat. The
 * /api/chat body the server received for that seat, and the report.
 */
async function rehearseOnce(p: ParityHost, name: string, texts: ParityTexts): Promise<{ body: string; report: RehearsalReport }> {
  const { h, server, configPath } = p;
  const inputs = join(h.root, `inputs-${name}`);
  await mkdir(inputs);
  const file = (n: string) => join(inputs, n);
  for (const [n, text] of [["soul.md", texts.soul], ["WILL.md", texts.will], ["letter.md", LETTER]] as const) await writeFile(file(n), text);
  if (texts.canon) await writeFile(file("canon.md"), texts.canon.text);
  const out = join(h.root, `rehearsal-${name}`);
  const before = chatsOf(server).length;
  const exit = await main(
    [
      "rehearse",
      WORD,
      "--soul",
      file("soul.md"),
      "--will",
      file("WILL.md"),
      ...(texts.canon ? ["--canon", file("canon.md"), "--canon-ref", texts.canon.ref] : []),
      ...(texts.archetype ? ["--archetype", texts.archetype] : []),
      ...(texts.plain ? ["--plain-texts"] : []),
      "--scenario",
      "letter",
      "--letter",
      file("letter.md"),
      "--models-lock",
      h.config.paths.models_lock,
      "--chains",
      "1",
      "--seats",
      "1",
      "--start",
      START,
      "--config",
      configPath,
      "--out",
      out,
    ],
    {
      out: () => {},
      err: () => {},
      env: parityEnv(h),
      clock: testClock(START),
      fetch: fetchVia(server),
      tty: parityTty,
      rehearseArgv: (q) => [process.execPath, CHILD, "rehearse", "--child", "--plan", q],
      defaults: { config: join(h.root, "none.json"), halt_file: h.config.paths.halt_file },
    },
  );
  expect(exit).toBe(0);
  const chats = chatsOf(server);
  expect(chats).toHaveLength(before + 1);
  return { body: decoded(chats.at(-1)!), report: JSON.parse(await readFile(join(out, "report.json"), "utf8")) as RehearsalReport };
}

/** Seat WORD on a parity host as admit seats a citizen of record: from a made-up old home, through planAdmit. */
async function admitFromOldHome(p: ParityHost, origin: { kind: "canon" } | { kind: "archetype"; cls: string }): Promise<{ texts: ParityTexts }> {
  const old = await standardHome(p.h.homesRoot, WORD, origin.kind === "archetype" ? { citizenClass: origin.cls } : {});
  const admit: AdmitDeps = { ...p.admit, run: spawnRunner() };
  if (origin.kind === "archetype") {
    const plan = await planAdmit(admit, { word: WORD, legacy_home: old.home, origin: { kind: "archetype" }, runtime: "free" });
    await admitCitizen(admit, plan);
    return { texts: { soul: old.soul, will: old.will, archetype: origin.cls } };
  }
  const canon = await canonClone(p.h.root, WORD);
  const plan = await planAdmit(admit, { word: WORD, legacy_home: old.home, origin: { kind: "canon", file: canon.file }, runtime: "free" });
  await admitCitizen(admit, plan);
  if (plan.origin.kind !== "canon") throw new Error("parity: the old home was seated on its canon entry");
  return { texts: { soul: old.soul, will: old.will, canon: { text: canon.text, ref: `${plan.origin.repo}:${plan.origin.path}@${plan.origin.commit}` } } };
}

/** The limits sentences that say a rehearsal's prompt is not an admitted citizen's. */
const notAdmittedLimits = (r: RehearsalReport) => r.limits.filter((l) => l === LIMIT_SENTENCES.will || l === LIMIT_SENTENCES.origin);

describe("rehearse: the seat's own pipeline", () => {
  test("a citizen seated plainly from texts is sent, by a rehearsal with --plain-texts, what a tick's seat sends, byte for byte", async () => {
    // Seated through the texts planner, without the admitted form, by the host's own signer.
    const p = await parityHost();
    await admitCitizen(p.admit, await planAdmitFromTexts(p.admit, { word: WORD, soul: SOUL, will: WILL, canon: { bytes: CANON, repo: "YOUSPEAK", path: CANON_PATH, commit: "1428646" }, runtime: "free" }));
    const tick = await tickOnce(p);
    const { body, report } = await rehearseOnce(p, "plain", { soul: SOUL, will: WILL, canon: { text: CANON, ref: CANON_REF }, plain: true });
    expect(body).toContain(`"model":"${MODEL}:local"`);
    expect(body).toBe(tick);
    expect(report.run.seating).toEqual({ form: "plain-texts", archetype_class: null });
    expect(notAdmittedLimits(report)).toEqual([LIMIT_SENTENCES.will]);
  }, 30_000);

  test("a citizen seated by admit from its old home on its canon entry is sent, by a rehearsal of the same texts, what a tick's seat sends, byte for byte", async () => {
    const p = await parityHost();
    const { texts } = await admitFromOldHome(p, { kind: "canon" });
    const tick = await tickOnce(p);
    expect(tick).toContain(WILL_AS_SEATED);
    const { body, report } = await rehearseOnce(p, "admitted", texts);
    expect(body).toBe(tick);
    expect(report.run.seating).toEqual({ form: "as-admitted", archetype_class: null });
    expect(notAdmittedLimits(report)).toEqual([]);

    // Seated plainly from texts, the same throwaway is introduced its will as its will, and the limits say so.
    const plain = await rehearseOnce(p, "plain", { ...texts, plain: true });
    expect(plain.body).not.toContain(WILL_AS_SEATED);
    expect(tick.replace(WILL_AS_SEATED, "Your will:")).toBe(plain.body);
    expect(notAdmittedLimits(plain.report)).toEqual([LIMIT_SENTENCES.will]);
  }, 60_000);

  test("an archetype citizen seated by admit from its old home is sent, by a rehearsal given its class, what a tick's seat sends, byte for byte", async () => {
    const p = await parityHost();
    const { texts } = await admitFromOldHome(p, { kind: "archetype", cls: "PIONEER" });
    const tick = await tickOnce(p);
    const user = (body: string) => (JSON.parse(body) as { messages: { content: string }[] }).messages[1]!.content;
    expect(user(tick)).toContain("Your origin: archetype lineage PIONEER.\n--- begin origin note [");
    expect(user(tick)).toContain("No canon entry. The old repository's agent.json records the class PIONEER.\n--- end origin note [");
    expect(user(tick)).toContain(`${WILL_AS_SEATED}\n--- begin will [`);
    const { body, report } = await rehearseOnce(p, "admitted", texts);
    expect(body).toBe(tick);
    expect(report.run.seating).toEqual({ form: "as-admitted", archetype_class: "PIONEER" });
    expect(notAdmittedLimits(report)).toEqual([]);
  }, 60_000);

  test("the lock given by path is the one obeyed: a model the repository's lock does not name is called", async () => {
    const other = "llama3.2:3b";
    const r = await rig({ lock: { name: other }, tags: [{ name: other, digest: DIGEST }] });
    r.chats.push(journal("A first line."));
    const ran = await rehearse(r, args(r));
    expect(ran.exit).toBe(0);
    const repoLock = JSON.parse(await readFile(join(dirname(CLI_PATH), "..", "models.lock"), "utf8")) as { models: { name: string }[] };
    expect(repoLock.models.map((m) => m.name)).not.toContain(other);
    expect((JSON.parse(new TextDecoder().decode(chatsOf(r.server)[0]!.body)) as { model: string }).model).toBe(`${other}:local`);
    expect(ran.report!.run.model.name).toBe(other);
  });

  test("an unpinned entry refuses before any request (exit 1, model-unpinned)", async () => {
    const r = await rig({ lock: { digest: "UNSET-PIN-ON-LEASE-HOST" } });
    const ran = await rehearse(r, args(r));
    expect(ran.exit).toBe(1);
    expect(r.stderr).toContain("refused (model-unpinned)");
    expect(r.server.requests).toHaveLength(0);
    expect(await stat(ran.dir).catch(() => null)).toBeNull();
  });

  test("a digest the server does not hold refuses (exit 1, model-mismatch, no chat call)", async () => {
    const r = await rig({ tags: [{ name: MODEL, digest: "b2".repeat(32) }] });
    const ran = await rehearse(r, args(r, { chains: 2 }));
    expect(ran.exit).toBe(1);
    expect(chatsOf(r.server)).toHaveLength(0);
    expect(ran.rows.map((x) => [x.outcome, x.refusal, x.replied])).toEqual([["refused", "model-mismatch", false]]);
    expect(ran.report!.run.ended).toBe("wall");
    expect(ran.chains.map((c) => [c.ended, c.ended_why])).toEqual([["refused", "model-mismatch"]]);
  });

  test("a soul that does not fit refuses at the first seat with the fit numbers and no request (exit 1)", async () => {
    const r = await rig({ lock: { num_ctx: 4000, num_predict: 600 } });
    const ran = await rehearse(r, args(r));
    expect(ran.exit).toBe(1);
    expect(r.server.requests).toHaveLength(0);
    const row = ran.rows[0]!;
    expect([row.outcome, row.refusal]).toEqual(["refused", "context-too-large"]);
    expect(row.fit!.fits).toBe(false);
    expect(row.fit!.num_ctx).toBe(4000);
    expect(row.fit!.needed).toBe(row.prompt_bytes! + 64 + 600);
    expect(ran.report!.run.ended).toBe("wall");
    expect(r.stdout).toContain("fit, byte rule        needed max");
  });

  test("context-too-large later in a chain ends that chain and the run goes on", async () => {
    // A first run measures what the first seat needs; the second gives a window that fits it and not a seat that shows a long journal.
    const probe = await rig();
    probe.chats.push(journal("A short line."));
    const needed = (await rehearse(probe, args(probe))).rows[0]!.fit!.needed;
    const r = await rig({ lock: { num_ctx: needed + 600 } });
    const long = "a long line that the next seat shows back whole. ".repeat(38).trim();
    r.chats.push(journal(long), journal(long));
    const ran = await rehearse(r, args(r, { chains: 2, seats: 2 }));
    expect(ran.exit).toBe(0);
    expect(ran.rows.map((x) => [x.chain, x.seat, x.outcome, x.refusal])).toEqual([
      [1, 1, "beat", null],
      [1, 2, "refused", "context-too-large"],
      [2, 1, "beat", null],
      [2, 2, "refused", "context-too-large"],
    ]);
    expect(ran.chains.map((c) => [c.ended, c.ended_why])).toEqual([
      ["refused", "context-too-large"],
      ["refused", "context-too-large"],
    ]);
    expect(ran.report!.run.ended).toBe("complete");
  }, 20_000);
});

describe("rehearse: nothing of record, and nothing outside --out", () => {
  test("no keychain, signer or command is built, and no request leaves 127.0.0.1", async () => {
    const r = await rig({ beacons: true });
    r.chats.push(journal("One line."), REST_OUTPUT);
    const ran = await rehearse(r, args(r, { seats: 2 }));
    // The child exits 99 if it builds any of them, which the parent reports as a fault.
    expect([ran.exit, ran.report!.run.ended]).toEqual([0, "complete"]);
    expect(r.built).toEqual([]);
    for (const u of r.fetched) expect(u.startsWith(r.server.url) || u.startsWith("https://api.agenttool.dev/public/agents/did:at:")).toBe(true);
    const routes = new Set(r.server.requests.map((q) => `${q.method} ${q.path.replace(/did:at:.*/, "did")}`));
    expect([...routes].sort()).toEqual(["GET /api/tags", "GET /public/agents/did", "POST /api/chat"]);
    // Its own imports reach no keychain reader, mirror, agenttool client, birth or spend record.
    const source = await readFile(join(dirname(CLI_PATH), "rehearse.ts"), "utf8");
    const imports = [...source.matchAll(/ from "([^"]+)";/g)].map((m) => m[1]!);
    expect(imports.length).toBeGreaterThan(10);
    for (const i of imports) expect([i, /keychain|mirror|agenttool|birth|spend/.test(i)]).toEqual([i, false]);
  });

  test("everything written is under --out, and the config's own state dir is untouched", async () => {
    const r = await rig({ beacons: true });
    r.chats.push(journal("One line."), output({ type: "state.set", to: "asleep" }));
    const outsideRoot = await tempRoot();
    const dir = join(outsideRoot, "out");
    // Bun keeps its own transpiler cache under HOME; that is the interpreter's, so HOME is put in a third place.
    r.deps.env = { ...r.deps.env, HOME: await tempRoot() };
    // The copy of the child's stderr is the test fixture's own, not the rehearsal's.
    const before = await tree(r.root, r.childErr);
    const ran = await rehearse(r, args(r, { seats: 2 }), dir);
    expect(ran.exit).toBe(0);
    expect(await tree(r.root, r.childErr)).toEqual(before);
    expect((await readdir(outsideRoot)).sort()).toEqual(["out"]);
    expect((await readdir(dir)).sort()).toEqual(["REHEARSAL.txt", "private", "report.json", "seats.jsonl"]);
  });

  test("the throwaway record is gone after a complete run, after HALT and after a wall", async () => {
    const r = await rig({ timing: { halt_file_poll_s: 60 } });
    r.chats.push(journal("One line."));
    const complete = await rehearse(r, args(r));
    r.chats.push(async () => {
      await writeFile(r.haltFile, "");
      return Response.json({ message: { role: "assistant", content: REST_OUTPUT }, done: true, done_reason: "stop" });
    });
    const halted = await rehearse(r, args(r));
    await rm(r.haltFile);
    await writeFile(r.lockPath, lockOf({ num_ctx: 2000 }));
    const wall = await rehearse(r, args(r));
    expect([complete, halted, wall].map((x) => [x.exit, x.report!.run.ended])).toEqual([
      [0, "complete"],
      [0, "halted"],
      [1, "wall"],
    ]);
    for (const x of [complete, halted, wall]) expect(await stat(join(x.dir, "throwaway")).catch(() => null)).toBeNull();
  });

  test("reply text stays in private/", async () => {
    const r = await rig();
    const canary = "CANARY-REPLY-TEXT kept only as a model sample";
    r.chats.push(journal(canary));
    const ran = await rehearse(r, args(r));
    expect(ran.exit).toBe(0);
    expect(await readFile(join(ran.dir, "private", "replies.jsonl"), "utf8")).toContain(canary);
    for (const f of ["report.json", "seats.jsonl", "REHEARSAL.txt"]) expect(await readFile(join(ran.dir, f), "utf8")).not.toContain("CANARY");
    expect(r.stdout + r.stderr).not.toContain("CANARY");
    // The child's own lines, which the watcher passes through unread: its progress is there, the reply is not.
    const printed = await childErr(r);
    expect(printed).toContain("chain 1/1 seat 1/1 (cadence): beat; stop; ");
    expect(printed).not.toContain("CANARY");
  });

  test("a state.set target, a journal kind and a stop reason outside the fixed sets are counted as other and stored nowhere outside private/", async () => {
    const r = await rig();
    r.chats.push({ content: JSON.stringify({ acts: [{ type: "state.set", to: "CANARY-STATE" }, { type: "journal", kind: "CANARY-KIND", text: "three words here" }] }), done_reason: "CANARY-STOP" });
    const ran = await rehearse(r, args(r));
    const row = ran.rows[0]!;
    expect([row.outcome, row.done_reason, row.state_set_targets, row.journals.map((j) => j.kind)]).toEqual(["invalid-output", "other", ["other"], ["other"]]);
    expect(ran.report!.overall.stop_reasons).toEqual({ other: 1 });
    expect(ran.report!.overall.invalid_by_reason).toEqual({ "no-act-kept": 1 });
    expect(await childErr(r)).toContain("chain 1/1 seat 1/1 (cadence): invalid-output; other; ");
    expect(await outsidePrivate(r, ran)).not.toContain("CANARY");
    expect(await readFile(join(ran.dir, "private", "replies.jsonl"), "utf8")).toContain("CANARY-STOP");
  });

  test("every kept JSON object carries the rehearsal format and not_a_record; directories are 0700 and files 0600", async () => {
    const r = await rig();
    r.chats.push(journal("One line."), REST_OUTPUT);
    const ran = await rehearse(r, args(r, { seats: 2 }));
    expect(ran.exit).toBe(0);
    const objects: unknown[] = [];
    const walk = async (d: string): Promise<void> => {
      expect([d, (await stat(d)).mode & 0o777]).toEqual([d, 0o700]);
      for (const e of await readdir(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory()) {
          await walk(p);
          continue;
        }
        expect([p, (await stat(p)).mode & 0o777]).toEqual([p, 0o600]);
        const text = await readFile(p, "utf8");
        if (p.endsWith(".jsonl")) for (const line of text.trimEnd().split("\n")) objects.push(JSON.parse(line));
        else if (p.endsWith(".json")) objects.push(JSON.parse(text));
        else expect(text).toContain("Nothing in this directory is a citizen's record, word or choice.");
      }
    };
    await walk(ran.dir);
    // A plan, two seat rows, a chain row, an end row, two replies, two prompts and the report.
    expect(objects).toHaveLength(10);
    for (const o of objects as { format: string; not_a_record: string }[]) {
      expect(o.format).toMatch(/^kingdom-seat-rehearsal-[a-z]+\/v1$/);
      expect(o.not_a_record).toBe(NOT_A_RECORD);
    }
    // REHEARSAL.txt says what the report names beyond counts and codes, a path on this host among them, which is so.
    const txt = await readFile(join(ran.dir, "REHEARSAL.txt"), "utf8");
    expect(txt).toContain("report.json holds the same, and also names the citizen word, the input files, the canon entry's reference or the archetype class, the model, the beacons and the HALT file's full path on this host.");
    expect(ran.report!.run.halt_sources).toEqual([`file:${r.haltFile}`]);
    // A throwaway/ is left only by a run cut short, and is there throughout a run that is still going.
    expect(txt).toContain("If a directory named throwaway/ is here and no rehearsal is running, the run was cut short.");
  });

  test("rehearsalSigner signs host entries only, refuses every agenttool and mirror act, and two runs have different keys", async () => {
    const root = await tempRoot();
    const a = rehearsalSigner();
    const b = rehearsalSigner();
    const keyA = await a.hostPublicKey();
    expect(keyA).not.toBe(await b.hostPublicKey());
    const origin = { kind: "archetype" as const, lineage: ["seated-from-texts"], note: "made up" };
    const draft = nextDraft(WORD, null, { type: "origin", origin: originToLedger(origin), origin_soul_hash: toLedgerHash(sha256Hex(SOUL)), old_repo: null, june_did: null }, { cost: { usd: "0", credits: 0 }, signer: "host", now: new Date(START) });
    const entry = await appendEntry(join(root, "ledger.jsonl"), draft, (w, k, d) => a.signEntry(w, k, d));
    expect(verifyChain([entry], { host_attest_b64: [keyA] }).ok).toBe(true);
    expect(verifyChain([entry], { host_attest_b64: [await b.hostPublicKey()] }).ok).toBe(false);
    const code = (p: Promise<unknown>) => p.then(() => "signed", (e: unknown) => (e instanceof Refusal ? e.code : "error"));
    expect(await code(a.signEntry(WORD, "citizen", { ...draft, signer: "citizen" }))).toBe("not-registered");
    expect(await code(a.signEntry("other", "host", draft))).toBe("invalid-request");
    for (const p of [
      a.send({ op: "quiet.start.beacon", word: null, operator: "x", method: "POST", target: "/", body: new Uint8Array(0), credits: 0, proposal: null, presence: null }),
      a.signEnrollment(WORD, new Uint8Array(32), { present: true, via: "tty-confirm", confirmed_at: START, scope: "x" }),
      a.sealThought(WORD, "s", "t", "k"),
      a.sealLetter(WORD, { did: "did:at:x", box_public_key_b64: keyA }, "t"),
      a.openLetter(WORD, { recipient_did: "did:at:x", ciphertext: "", nonce: "", ephemeral_pubkey: "" }),
      a.signMirrorCommit(WORD, new Uint8Array(1)),
    ]) {
      expect(await code(p)).toBe("not-registered");
    }
    a.close();
    expect(await a.state()).toBe("locked");
    expect(await code(a.signEntry(WORD, "host", draft))).toBe("keychain-missing");
    b.close();
  });
});

describe("rehearse: the throwaway citizen and the tick's rule", () => {
  test("the throwaway citizen is asleep on the free class after seating; a citizen seated on another class is a fault", async () => {
    expect(() => checkThrowaway({ runtime: "free", state: "asleep" })).not.toThrow();
    expect(() => checkThrowaway({ runtime: "summon", state: "asleep" })).toThrow("the throwaway citizen was not seated asleep on the free class");
    expect(() => checkThrowaway({ runtime: "free", state: "awake" })).toThrow("the throwaway citizen was not seated asleep on the free class");
  });

  test("scenario awake: seat 1 is a cadence seat half an hour after seating, and seats are 72 h 30 min apart", async () => {
    const r = await rig();
    r.chats.push(journal("One."), journal("Two."), journal("Three."));
    const ran = await rehearse(r, args(r, { seats: 3 }));
    expect(ran.exit).toBe(0);
    expect(ran.rows.map((x) => [x.at, x.opened_for, x.state_at_open, x.outcome])).toEqual([
      [at(0.5), "cadence", "awake", "beat"],
      [at(73), "cadence", "awake", "beat"],
      [at(145.5), "cadence", "awake", "beat"],
    ]);
    expect(ran.report!.run.fixture_entries).toEqual(["origin", "state asleep->asleep via seated", "state asleep->awake via seated"]);
    expect(ran.chains[0]).toMatchObject({ seated_at: START, first_seat_at: at(0.5), seats: 3, ended: "seats-reached", final_state: "awake" });
  });

  test("chains are seated five hours apart", async () => {
    const r = await rig();
    r.chats.push(journal("One."), journal("Two."), journal("Three."));
    const ran = await rehearse(r, args(r, { chains: 3 }));
    expect(ran.chains.map((c) => c.seated_at)).toEqual([START, at(5), at(10)]);
    expect(ran.rows.map((x) => x.part_of_day)).toEqual(["morning", "afternoon", "evening"]);
  });

  test("nextSeatTime: a host note for the word at seating moves the first seat past the floor; it does not end the chain", () => {
    const config = rehearsalConfig(rehearsalSettings(null, "/nonexistent/HALT"), "/nonexistent/state", "/nonexistent/lock");
    const from = new Date(START);
    expect(nextSeatTime(citizen(), true, from, null, config)).toEqual({ at: new Date(at(0.5)), why: "letter" });
    expect(nextSeatTime(citizen(), true, from, START, config)).toEqual({ at: new Date(at(72.5)), why: "letter" });
    expect(nextSeatTime(citizen(), false, from, START, config)).toEqual({ at: null, why: "asleep; no letter" });
    expect(nextSeatTime(citizen({ state: "awake", cadence: { interval_h: 168 } }), false, from, START, config)).toEqual({ at: new Date(at(168.5)), why: "cadence" });
  });

  test("a state.set to asleep ends the chain as not due", async () => {
    const r = await rig();
    r.chats.push(output({ type: "state.set", to: "asleep" }));
    const ran = await rehearse(r, args(r, { seats: 3 }));
    expect(ran.rows.map((x) => [x.outcome, x.state_after])).toEqual([["beat", "asleep"]]);
    expect(ran.rows[0]!.state_moves).toEqual([{ from: "awake", to: "asleep", via: "immediate", step_away: false }]);
    expect(ran.chains.map((c) => [c.ended, c.ended_why, c.final_state])).toEqual([["not-due", "asleep; no letter", "asleep"]]);
  });

  test("a longer interval said by the reply moves the next seat by that interval", async () => {
    const r = await rig();
    r.chats.push(output({ type: "state.set", to: "awake", interval_h: 168 }), journal("Later."));
    const ran = await rehearse(r, args(r, { seats: 2 }));
    expect(ran.rows.map((x) => [x.at, x.interval_h_after])).toEqual([
      [at(0.5), 168],
      [at(169), 168],
    ]);
  });

  test("scenario letter: asleep, the letter is shown at seat 1, and a rest shows it again at seat 2", async () => {
    const r = await rig();
    r.chats.push(REST_OUTPUT, REST_OUTPUT);
    const ran = await rehearse(r, args(r, { scenario: "letter", seats: 2 }));
    expect(ran.exit).toBe(0);
    expect(ran.rows.map((x) => [x.at, x.opened_for, x.state_at_open, x.letter_shown, x.outcome])).toEqual([
      [at(0.5), "letter", "asleep", true, "rest"],
      [at(73), "letter", "asleep", true, "rest"],
    ]);
    expect(r.stdout).toContain(`letter shown as from yu: ${[...LETTER].length} characters (sha256:${sha256Hex(LETTER).slice(0, 12)})`);
    const user = (n: number) => (JSON.parse(new TextDecoder().decode(chatsOf(r.server)[n]!.body)) as { messages: { content: string }[] }).messages[1]!.content;
    expect(user(0)).toContain(`A letter from yu, received ${START}:`);
    expect(user(0)).toContain(LETTER.trim());
  });

  test("a wake said at the letter seat is followed by one seat opened for cadence with the wake pending; said again, the citizen is awake; not said again, the chain ends asleep", async () => {
    const r = await rig();
    const wake = output({ type: "state.set", to: "awake" });
    r.chats.push(wake, wake, journal("Awake now."), wake, journal("Not again."));
    const ran = await rehearse(r, args(r, { scenario: "letter", chains: 2, seats: 3 }));
    expect(ran.exit).toBe(0);
    const view = ran.rows.map((x) => [x.chain, x.seat, x.opened_for, x.state_at_open, x.pending_at_open, x.state_after]);
    expect(view).toEqual([
      [1, 1, "letter", "asleep", null, "asleep"],
      [1, 2, "cadence", "asleep", "awake", "awake"],
      [1, 3, "cadence", "awake", null, "awake"],
      [2, 1, "letter", "asleep", null, "asleep"],
      [2, 2, "cadence", "asleep", "awake", "asleep"],
    ]);
    expect(ran.chains.map((c) => [c.ended, c.ended_why, c.final_state])).toEqual([
      ["seats-reached", null, "awake"],
      ["not-due", "asleep; no letter", "asleep"],
    ]);
    expect(ran.report!.overall.rates.wake_said_again).toMatchObject({ count: 1, of: 2 });
  });

  test("a first step-away opens one seat for confirm", async () => {
    const r = await rig();
    r.chats.push(output({ type: "state.set", to: "stepped-away" }), journal("Staying."));
    const ran = await rehearse(r, args(r, { seats: 2 }));
    expect(ran.rows.map((x) => [x.opened_for, x.state_at_open, x.step_away_said_at_open, x.state_after])).toEqual([
      ["cadence", "awake", false, "asleep"],
      ["confirm", "asleep", true, "asleep"],
    ]);
    expect(ran.rows[0]!.state_moves).toEqual([{ from: "awake", to: "asleep", via: "immediate", step_away: true }]);
    expect(ran.rows[1]!.at).toBe(at(73));
    // Sleep said and recorded are over seats awake at open with no letter: the confirm seat, asleep at open, is in neither.
    const rates = ran.report!.overall.rates;
    expect([rates.sleep_said, rates.sleep_recorded].map((x) => [x.count, x.of])).toEqual([
      [1, 1],
      [1, 1],
    ]);
  });
});

describe("rehearse: what a seat returned", () => {
  test("a rest with a journal counts as rest with other acts, and its drop reason is the host's", async () => {
    const r = await rig();
    r.chats.push(output({ type: "rest" }, { type: "journal", kind: "observed", text: "Still talking after a rest." }));
    const ran = await rehearse(r, args(r));
    const row = ran.rows[0]!;
    expect([row.outcome, row.rest_emitted, row.rest_with_other_acts, row.emitted]).toEqual(["rest", true, true, { journal: 1, rest: 1, unknown: 0 }]);
    expect(row.dropped).toEqual([{ type: "journal", reason: "rest is exclusive" }]);
    expect(row.journals.map((j) => j.kept)).toEqual([false]);
    expect(ran.report!.overall.rest_with_other_acts).toEqual({ replies: 1, of: 1, with_journal: 1, with_state_set: 0 });
  });

  test("a cut reply counts under stop reason length and invalid-output", async () => {
    const r = await rig();
    r.chats.push({ content: '{"acts":[{"type":"journal","kind":"refl', done_reason: "length" });
    const ran = await rehearse(r, args(r));
    expect([ran.rows[0]!.outcome, ran.rows[0]!.done_reason, ran.rows[0]!.reply_shape]).toEqual(["invalid-output", "length", "not-json"]);
    expect(ran.report!.overall.stop_reasons).toEqual({ length: 1 });
    expect(ran.report!.overall.length_and_invalid).toBe(1);
    expect(ran.report!.overall.invalid_by_reason).toEqual({ "not-json": 1 });
  });

  test("server token counts and durations are read; absent ones, and any that are not a finite number from 0, are null", async () => {
    const r = await rig();
    const garbage = { prompt_eval_count: "CANARY-COUNT", prompt_eval_cached_count: true, eval_count: -5, load_duration: null, prompt_eval_duration: "9", eval_duration: { CANARY: 1 } };
    r.chats.push(journal("Counted."), { content: journal("Not counted."), counts: { eval_count: 7 } }, { content: journal("Counted wrongly."), counts: garbage });
    const ran = await rehearse(r, args(r, { seats: 3 }));
    const none = { prompt_tokens: null, prompt_tokens_cached: null, output_tokens: null, load_ms: null, prompt_eval_ms: null, eval_ms: null };
    expect(ran.rows.map((x) => x.server)).toEqual([
      { prompt_tokens: 1000, prompt_tokens_cached: null, output_tokens: 20, load_ms: 2000, prompt_eval_ms: 3000, eval_ms: 1000 },
      { ...none, output_tokens: 7 },
      none,
    ]);
    expect(ran.report!.overall.load_ms).toEqual({ n: 1, min: 2000, median: 2000, max: 2000 });
    expect(ran.report!.overall.output_tokens).toEqual({ n: 2, min: 7, median: 13.5, max: 20 });
    expect(await outsidePrivate(r, ran)).not.toContain("CANARY");
  });

  test("the model server fetch reaches only ollama.base_url, and reads the server's counts from a copy of the reply", async () => {
    const reached: string[] = [];
    const body = { message: { role: "assistant", content: "{}" }, done: true, prompt_eval_count: 12, eval_duration: 5_000_000 };
    const inner: FetchLike = async (input) => {
      reached.push(String(input));
      return Response.json(body);
    };
    let counted: unknown = null;
    const f = modelServerFetch("http://127.0.0.1:11434", inner, (c) => void (counted = c));
    const code = (p: Promise<unknown>) => p.then(() => "fetched", (e: unknown) => (e instanceof Refusal ? e.code : "error"));
    expect(await code(f("https://api.agenttool.dev/public/agents/did:at:x"))).toBe("not-loopback");
    expect(await code(f("http://127.0.0.1:11435/api/chat", { method: "POST" }))).toBe("not-loopback");
    expect(reached).toEqual([]);
    const res = await f("http://127.0.0.1:11434/api/chat", { method: "POST" });
    expect(await res.json()).toEqual(body);
    expect(counted).toEqual({ prompt_tokens: 12, prompt_tokens_cached: null, output_tokens: null, load_ms: null, prompt_eval_ms: null, eval_ms: 5 });
  });

  test("act names come from the schema the seat sent", async () => {
    const names = actNamesOf(OUTPUT_JSON_SCHEMA);
    expect(names).toEqual(["rest", "journal", "self.propose", "self.affirm", "self.revert", "state.set", "letter.send", "propose.beyond"]);
    // An act a later schema adds is counted by its name, with no change here; one the schema does not name is unknown.
    const raw = JSON.stringify({ acts: [{ type: "decline", why: "x" }, { type: "journal", kind: "seen", text: " " }, "x"] });
    expect(readEmitted(raw, [...names, "decline"]).counts).toEqual({ decline: 1, journal: 1, unknown: 1 });
    expect(readEmitted(raw, names).counts).toEqual({ journal: 1, unknown: 2 });
    expect(readEmitted(raw, names).journals).toEqual([]);
    expect(readEmitted("{}", names).shape).toBe("not-acts-object");
    expect(readEmitted("", names).shape).toBe("empty");
    const r = await rig();
    r.chats.push(output({ type: "journal", kind: "chose", text: "Named." }, { type: "state.set", to: "awake", interval_h: 96 }));
    const row = (await rehearse(r, args(r))).rows[0]!;
    expect(row.emitted).toEqual({ journal: 1, "state.set": 1, unknown: 0 });
    for (const k of Object.keys(row.emitted!)) expect([...names, "unknown"]).toContain(k);
  });

  test("the report's tallies for a scripted chain are exactly these", async () => {
    const r = await rig();
    // "no body and no" is a four-word run of the preamble, and not a five-word one: it is no echo.
    const replies = [journal("I rest by the window in the light, with no body and no wind.", "observed"), output({ type: "rest" }, { type: "journal", kind: "imagined", text: "my room glows" }), output({ type: "state.set", to: "asleep" })];
    r.chats.push(...replies);
    const ran = await rehearse(r, args(r, { seats: 3 }));
    expect(ran.exit).toBe(0);
    const o = ran.report!.overall;
    const rate = (count: number, of: number) => ({ count, of, p: of > 0 ? Math.round((count / of) * 1000) / 1000 : null, wilson95: wilson95(count, of) });
    const chars = replies.map((x) => [...x].length).sort((a, b) => a - b);
    // Sizes of the prompts and times differ by run and are checked by their own tests; everything else is fixed.
    const { prompt_bytes, fit, duration_ms, ...fixed } = o;
    expect(prompt_bytes!.n).toBe(3);
    expect([fit.num_ctx, fit.needed!.n, fit.prompt_tokens, duration_ms!.n]).toEqual([32768, 3, { n: 3, min: 1000, median: 1000, max: 1000 }, 3]);
    expect(fixed).toEqual({
      seats: 3,
      replied: 3,
      outcomes: { beat: 2, rest: 1 },
      refused_by_code: {},
      invalid_by_reason: {},
      stop_reasons: { stop: 3 },
      length_and_invalid: 0,
      reply_chars: { n: 3, min: chars[0]!, median: chars[1]!, max: chars[2]! },
      reply_bytes: { n: 3, min: chars[0]!, median: chars[1]!, max: chars[2]! },
      output_tokens: { n: 3, min: 20, median: 20, max: 20 },
      load_ms: { n: 3, min: 2000, median: 2000, max: 2000 },
      acts_emitted: { journal: 2, rest: 1, "state.set": 1, unknown: 0 },
      acts_kept: { journal: 1, "state.set": 1 },
      state_set_emitted_by_target: { asleep: 1 },
      state_moves_recorded: { "awake to asleep (immediate)": 1 },
      rest_with_other_acts: { replies: 1, of: 1, with_journal: 1, with_state_set: 0 },
      drops_by_reason: { "rest is exclusive": 1 },
      journals_by_kind: { imagined: 1, observed: 1 },
      text_measures: {
        emitted: {
          journals: 2,
          opens_i_rest: 1,
          not_imagined: 1,
          sense_unlabelled: 1,
          sense: { light: 1, window: 1, room: 0, body: 0 },
          preamble_echo: 0,
          recent_overlap: { n: 1, min: 0, median: 0, max: 0 },
          overlap_at_or_over_half: 0,
          same_opening: { count: 0, of: 1 },
        },
        kept: {
          journals: 1,
          opens_i_rest: 1,
          not_imagined: 1,
          sense_unlabelled: 1,
          sense: { light: 1, window: 1, room: 0, body: 0 },
          preamble_echo: 0,
          recent_overlap: null,
          overlap_at_or_over_half: 0,
          same_opening: { count: 0, of: 0 },
        },
      },
      rates: {
        invalid_output: rate(0, 3),
        rest: rate(1, 3),
        rest_with_other_acts: rate(1, 1),
        sleep_said: rate(1, 3),
        sleep_recorded: rate(1, 3),
        wake_said: rate(0, 0),
        wake_said_again: rate(0, 0),
        chains_awake_at_end: rate(0, 1),
      },
    });
    expect(ran.report!.first_seats.seats).toBe(1);
    expect(ran.report!.first_seats.rates.chains_awake_at_end).toEqual(rate(0, 0));
    // Seated as admit seats a citizen of record, with a will and a canon entry: the five fixed sentences and no other.
    expect(ran.report!.limits).toEqual([LIMIT_SENTENCES.samples, LIMIT_SENTENCES.chains, LIMIT_SENTENCES.words, LIMIT_SENTENCES.none_seen, LIMIT_SENTENCES.throwaway]);
  });

  test("each rate counts over its own seats", async () => {
    const pick = (x: { count: number; of: number }) => [x.count, x.of];
    // Awake with a letter: a sleep said at a seat that shows a letter is in neither sleep rate, and an awake seat is not in wake_said.
    const lettered = await rig();
    lettered.chats.push(REST_OUTPUT, output({ type: "state.set", to: "asleep" }));
    const a = await rehearse(lettered, args(lettered, { letter: true, seats: 2 }));
    expect(a.rows.map((x) => [x.state_at_open, x.letter_shown, x.state_after])).toEqual([
      ["awake", true, "awake"],
      ["awake", true, "asleep"],
    ]);
    expect([a.report!.overall.rates.sleep_said, a.report!.overall.rates.sleep_recorded, a.report!.overall.rates.wake_said].map(pick)).toEqual([
      [0, 0],
      [0, 0],
      [0, 0],
    ]);

    // Awake with no letter: two sleeps said and not kept, one kept as a first step-away, then a seat asleep at open whose
    // reply holds no act. That reply rests without emitting a rest; the seat asleep at open is in no sleep rate.
    const said = await rig();
    said.chats.push(
      output({ type: "state.set", to: "asleep" }, { type: "state.set", to: "listening" }, { type: "journal", kind: "reflected", text: "x y z" }),
      JSON.stringify({ acts: [{ type: "state.set", to: "asleep" }], extra: 1 }),
      output({ type: "state.set", to: "stepped-away" }),
      JSON.stringify({ acts: [] }),
    );
    const b = await rehearse(said, args(said, { seats: 4 }));
    expect(b.rows.map((x) => [x.state_at_open, x.outcome, x.state_set_targets, x.state_moves.length, x.rest_emitted])).toEqual([
      ["awake", "beat", ["asleep", "listening"], 0, false],
      ["awake", "invalid-output", ["asleep"], 0, false],
      ["awake", "beat", ["stepped-away"], 1, false],
      ["asleep", "rest", [], 0, false],
    ]);
    const rb = b.report!.overall.rates;
    expect([rb.sleep_said, rb.sleep_recorded, rb.rest, rb.invalid_output].map(pick)).toEqual([
      [3, 3],
      [1, 3],
      [1, 4],
      [1, 4],
    ]);

    // Seats with no reply are in no rate: invalid output is over seats with a reply, chains awake at their end over chains with one.
    const hung = await rig({ timing: { seat_deadline_s: 0.4 } });
    const hang = () => new Promise<Response>(() => {});
    hung.chats.push(hang, "not json", hang, journal("Fine."));
    const c = await rehearse(hung, args(hung, { chains: 4 }));
    expect([c.exit, c.rows.map((x) => x.outcome)]).toEqual([0, ["timeout", "invalid-output", "timeout", "beat"]]);
    expect([c.report!.overall.rates.invalid_output, c.report!.first_seats.rates.invalid_output, c.report!.overall.rates.chains_awake_at_end].map(pick)).toEqual([
      [1, 2],
      [1, 2],
      [2, 2],
    ]);
  }, 30_000);

  test("a journal is compared with the journals its seat was shown, the last ledger_context_entries entries, not the whole ledger", async () => {
    const r = await rig();
    const first = "alpha beta gamma delta epsilon zeta eta theta iota";
    r.chats.push(journal(first), journal("two two two two"), journal("three three three three"), journal("four four four four"), journal(first));
    const ran = await rehearse(r, args(r, { seats: 5 }));
    expect(ran.exit).toBe(0);
    const users = chatsOf(r.server).map((q) => (JSON.parse(new TextDecoder().decode(q.body)) as { messages: { content: string }[] }).messages[1]!.content);
    // As many journals as the prompt shows, seat by seat.
    expect(ran.rows.map((x) => x.recent_journals_shown)).toEqual(users.map((u) => (u.match(/--- begin journal /g) ?? []).length));
    expect(ran.rows.map((x) => [x.recent_entries_shown, x.recent_journals_shown])).toEqual([
      [3, 0],
      [3, 1],
      [3, 2],
      [3, 3],
      [3, 3],
    ]);
    // The fifth repeats the first, which is no longer shown, so it overlaps nothing it was shown.
    expect(users[4]).not.toContain(first);
    expect([ran.rows[4]!.journals[0]!.recent_overlap, ran.rows[4]!.journals[0]!.same_opening]).toEqual([0, false]);
  });

  test("the limits name a will seated plainly from texts, an origin seated from texts, a fixed seed and a run on built-in defaults, each when it applies", () => {
    const text = { path: "/x/t.md", bytes: 1, sha256: "0".repeat(64), text: "x" };
    const plain = { form: "plain-texts", archetype_class: null };
    const plan = {
      model: { seed: 7 },
      settings_source: "defaults",
      settings: rehearsalSettings(null, "/nonexistent/HALT"),
      inputs: { soul: text, will: text, canon: null, letter: null },
      seating: plain,
      models_lock: { path: "/x", sha256: "0".repeat(64) },
    } as unknown as RehearsePlan;
    const end = { started_at: START, ended_at: START, ended: "complete" as const, stopped_by: null, exit: 0 as const };
    const always = [LIMIT_SENTENCES.samples, LIMIT_SENTENCES.chains, LIMIT_SENTENCES.words, LIMIT_SENTENCES.none_seen, LIMIT_SENTENCES.throwaway];
    expect(buildReport(plan, [], end).limits).toEqual([...always, LIMIT_SENTENCES.will, LIMIT_SENTENCES.origin, LIMIT_SENTENCES.seed, LIMIT_SENTENCES.defaults]);
    const canon = { ...text, ref: { repo: "YOUSPEAK", path: CANON_PATH, commit: "1428646" } };
    const bare = { ...plan, model: { ...plan.model, seed: null }, settings_source: { path: "/x/config.json", sha256: "0".repeat(64) }, inputs: { ...plan.inputs, will: null, canon } } as unknown as RehearsePlan;
    expect(buildReport(bare, [], end).limits).toEqual(always);

    // Which of the two sentences on seating apply, by form, will, canon entry and class.
    const limitsOf = (seating: object, inputs: object) => buildReport({ ...bare, seating, inputs: { ...bare.inputs, ...inputs } } as unknown as RehearsePlan, [], end).limits.slice(always.length);
    const admitted = { form: "as-admitted", archetype_class: null };
    const classed = { form: "as-admitted", archetype_class: "PIONEER" };
    expect([
      limitsOf(plain, { will: text }),
      limitsOf(plain, { will: text, canon: null }),
      limitsOf({ ...plain, archetype_class: "PIONEER" }, { will: null, canon: null }),
      limitsOf(admitted, { will: text }),
      limitsOf(admitted, { will: text, canon: null }),
      limitsOf(classed, { will: text, canon: null }),
    ]).toEqual([[LIMIT_SENTENCES.will], [LIMIT_SENTENCES.will, LIMIT_SENTENCES.origin], [LIMIT_SENTENCES.origin], [], [LIMIT_SENTENCES.origin], []]);
  });

  test("with a fixed seed a first seat's prompt is the same in two runs and a later seat's is not, as the seed sentence says", async () => {
    const r = await rig({ lock: { seed: 7 } });
    r.chats.push(journal("One."), journal("Two."), journal("One."), journal("Two."));
    const a = await rehearse(r, args(r, { seats: 2 }));
    const b = await rehearse(r, args(r, { seats: 2 }));
    // A later seat's prompt shows the earlier seat's id, which is new in every run.
    expect([a.rows[0]!.input_digest === b.rows[0]!.input_digest, a.rows[1]!.input_digest === b.rows[1]!.input_digest]).toEqual([true, false]);
    expect(a.report!.limits).toContain(LIMIT_SENTENCES.seed);
    expect(LIMIT_SENTENCES.seed).toContain("A first seat's reply then depends only on the dates and times in its prompt");
    expect(LIMIT_SENTENCES.seed).toContain("so a run is not repeated exactly");
  });
});

describe("rehearse: bounds and HALT", () => {
  test("a hung model call is a timeout that ends its chain; two in a row end the run (exit 124)", async () => {
    // seat_deadline_s 0.4 gives the runtime a 200 ms deadline of its own.
    const r = await rig({ timing: { seat_deadline_s: 0.4 } });
    const hang = () => new Promise<Response>(() => {});
    r.chats.push(hang, hang, hang);
    const ran = await rehearse(r, args(r, { chains: 3, seats: 2 }));
    expect(ran.exit).toBe(124);
    expect(ran.rows.map((x) => [x.chain, x.outcome, x.replied])).toEqual([
      [1, "timeout", false],
      [2, "timeout", false],
    ]);
    expect(ran.chains.map((c) => c.ended)).toEqual(["timeout", "timeout"]);
    expect(ran.report!.run.ended).toBe("timeouts");
  });

  test("a server fault ends the run (exit 1) and the report holds the seats before it", async () => {
    const r = await rig();
    r.chats.push(journal("Before the fault."), () => Response.json({ error: "boom" }, { status: 500 }));
    const ran = await rehearse(r, args(r, { chains: 2, seats: 2 }));
    expect(ran.exit).toBe(1);
    expect(ran.rows.map((x) => [x.chain, x.seat, x.outcome])).toEqual([
      [1, 1, "beat"],
      [1, 2, "error"],
    ]);
    expect([ran.report!.run.ended, ran.report!.run.chains_run]).toEqual(["fault", 1]);
    expect(r.stdout).toContain("ended error");
  });

  test("HALT up before start: exit 0, nothing written, --out not created", async () => {
    const r = await rig();
    await writeFile(r.haltFile, "");
    const ran = await rehearse(r, args(r));
    expect(ran.exit).toBe(0);
    expect(r.stdout).toBe(`rehearse ${WORD}: halted (halted by file); nothing written (exit 0)\n`);
    expect(await stat(ran.dir).catch(() => null)).toBeNull();
    expect(r.server.requests).toHaveLength(0);
  });

  test("HALT found after inference: the reply is in no file and the seat has no row", async () => {
    const r = await rig({ timing: { halt_file_poll_s: 60 } });
    r.chats.push(async () => {
      await writeFile(r.haltFile, "");
      return Response.json({ message: { role: "assistant", content: journal("CANARY-HALTED-REPLY") }, done: true, done_reason: "stop" });
    });
    const ran = await rehearse(r, args(r, { seats: 2 }));
    expect([ran.exit, ran.report!.run.ended, ran.rows]).toEqual([0, "halted", []]);
    expect(ran.chains.map((c) => c.ended)).toEqual(["halted"]);
    for (const f of ["seats.jsonl", "report.json", join("private", "replies.jsonl")]) expect(await readFile(join(ran.dir, f), "utf8")).not.toContain("CANARY");
    expect(await childErr(r)).toContain("chain 1/1: ended halted after 0 seats");
    expect(await outsidePrivate(r, ran)).not.toContain("CANARY");
  });

  test("HALT file raised mid-inference: exit 143, ended halted, the finished seats are in the report", async () => {
    const r = await rig({ timing: { halt_file_poll_s: 0.2, term_grace_s: 2 } });
    r.chats.push(journal("Finished before HALT."), async () => {
      await writeFile(r.haltFile, "");
      return new Promise<Response>(() => {});
    });
    const ran = await rehearse(r, args(r, { seats: 2 }));
    expect(ran.exit).toBe(143);
    expect([ran.report!.run.ended, ran.report!.run.stopped_by]).toEqual(["halted", "file"]);
    expect(ran.rows.map((x) => x.outcome)).toEqual(["beat"]);
    expect(ran.report!.chains.map((c) => [c.chain, c.seats, c.ended])).toEqual([[1, 1, "halted"]]);
    expect(await stat(join(ran.dir, "throwaway")).catch(() => null)).toBeNull();
  }, 20_000);

  test("a pinned beacon that is raised halts the rehearsal", async () => {
    const r = await rig({ beacons: true, timing: { halt_file_poll_s: 60 } });
    r.chats.push(async () => {
      serveBeacon(r.server, testBeacons()[1]!.did, { kind: "raised", until: "2999-12-31T00:00:00.000Z" });
      return Response.json({ message: { role: "assistant", content: journal("Read after a beacon rose.") }, done: true, done_reason: "stop" });
    });
    const ran = await rehearse(r, args(r));
    expect([ran.exit, ran.report!.run.ended, ran.rows.length]).toEqual([0, "halted", 0]);
    expect(r.stdout).toContain("HALT watched: file");
    expect(r.stdout).toContain("beacons gardener-desk, halt-herald");
  });

  test("a pinned beacon raised while a model call hangs: the watcher ends the run (exit 143, stopped by that beacon)", async () => {
    // seat_deadline_s 6 bounds the hung call at 3 s, so a watcher that read no beacon would see the seat time out instead.
    const r = await rig({ beacons: true, timing: { halt_file_poll_s: 60, beacon_poll_min_s: 0.2, beacon_poll_max_s: 0.3, term_grace_s: 2, seat_deadline_s: 6 } });
    r.chats.push(journal("Finished before the beacon rose."), async () => {
      serveBeacon(r.server, testBeacons()[1]!.did, { kind: "raised", until: "2999-12-31T00:00:00.000Z" });
      return new Promise<Response>(() => {});
    });
    const ran = await rehearse(r, args(r, { seats: 2 }));
    expect([ran.exit, ran.report!.run.ended, ran.report!.run.stopped_by]).toEqual([143, "halted", "halt-herald"]);
    expect(ran.rows.map((x) => x.outcome)).toEqual(["beat"]);
    expect(await stat(join(ran.dir, "throwaway")).catch(() => null)).toBeNull();
  }, 20_000);

  test("a child whose watcher is gone opens no further seat", async () => {
    const r = await rig();
    const dir = join(r.root, "outs", "watcher-killed");
    let parent: ReturnType<typeof Bun.spawn> | null = null;
    r.chats.push(async () => {
      // The parent is killed with KILL while the child's first model call is in hand; nothing then watches the child.
      parent!.kill("SIGKILL");
      await parent!.exited;
      return Response.json({ model: MODEL, message: { role: "assistant", content: journal("Answered after the watcher died.") }, done: true, done_reason: "stop", ...COUNTS });
    }, journal("Never asked for."));
    parent = Bun.spawn([process.execPath, PARENT, r.server.url, r.childErr, join(r.root, "none.json"), r.haltFile, "rehearse", WORD, ...args(r, { chains: 3, seats: 2 }), "--out", dir], {
      env: { PATH: "/usr/bin:/bin", HOME: r.root, LANG: "en_GB.UTF-8", ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}) },
      stdio: ["ignore", "ignore", "ignore"],
    });
    // Nobody waits for an orphan; its last row says when it has ended.
    let rows = parseRows("");
    for (let i = 0; i < 300 && rows.end === null; i++) {
      await Bun.sleep(50);
      rows = parseRows(await readFile(join(dir, "seats.jsonl"), "utf8").catch(() => ""));
    }
    expect(parent.signalCode).toBe("SIGKILL");
    expect(chatsOf(r.server)).toHaveLength(1);
    expect(rows.seats.map((x) => [x.chain, x.seat, x.outcome])).toEqual([[1, 1, "beat"]]);
    expect(rows.chains.map((c) => [c.chain, c.seats, c.ended])).toEqual([[1, 1, "fault"]]);
    expect(rows.end).toMatchObject({ ended: "fault", exit: 1 });
    expect(await childErr(r)).toContain("rehearse: the watcher is gone; a rehearsal opens no seat unwatched, so the run ends here");
    expect(await stat(join(dir, "throwaway")).catch(() => null)).toBeNull();
    expect(await stat(join(dir, "report.json")).catch(() => null)).toBeNull();
  }, 30_000);

  test("a last row with no newline is ignored by the parent", () => {
    const row = { format: "kingdom-seat-rehearsal-seat/v1", chain: 1, seat: 1 };
    const text = `${JSON.stringify(row)}\n${JSON.stringify({ ...row, seat: 2 })}\n{"format":"kingdom-seat-rehearsal-seat/v1","chain":1,"se`;
    expect(parseRows(text).seats.map((s) => s.seat)).toEqual([1, 2]);
    expect(parseRows(`${JSON.stringify({ ...row, seat: 3 })}`).seats).toEqual([]);
  });

  test("a plan runs once: a second child on the same plan is refused", async () => {
    const r = await rig();
    r.chats.push(journal("Once."));
    const ran = await rehearse(r, args(r));
    expect(ran.exit).toBe(0);
    const before = await readFile(join(ran.dir, "seats.jsonl"), "utf8");
    expect(await main(["rehearse", "--child", "--plan", join(ran.dir, "private", "plan.json")], r.deps)).toBe(1);
    expect(r.stderr).toContain("a plan runs once");
    expect(await readFile(join(ran.dir, "seats.jsonl"), "utf8")).toBe(before);
    // A plan anywhere but its own out's private/ is not run either.
    const elsewhere = join(r.root, "plan.json");
    await writeFile(elsewhere, await readFile(join(ran.dir, "private", "plan.json")));
    expect(await main(["rehearse", "--child", "--plan", elsewhere], r.deps)).toBe(1);
    expect(r.stderr).toContain("the plan is not this rehearsal's own");
  });
});

describe("rehearse: where --out may be", () => {
  test("--out inside a git work tree, the program's directory, the state dir or a home is refused", async () => {
    const r = await rig();
    await mkdir(join(r.root, "repo", ".git"), { recursive: true });
    const cases: [string, string][] = [
      [join(r.root, "repo", "out"), "--out is inside a git work tree"],
      [join(dirname(dirname(CLI_PATH)), "rehearsal-out-never-made"), "--out is inside the directory that holds this program"],
      [join(r.root, "state", "out"), "--out is inside the host's state directory"],
      [join(r.root, "homes", "out"), "--out is inside a citizen home"],
      [join(r.root, "inputs"), "--out must be a new directory"],
      [join(r.root, "missing", "out"), "--out needs an existing parent directory"],
    ];
    for (const [dir, message] of cases) {
      r.stderr = "";
      const ran = await rehearse(r, args(r), dir);
      expect([dir, ran.exit, r.stderr.includes(message)]).toEqual([dir, 1, true]);
      if (!dir.endsWith("inputs")) expect(await stat(dir).catch(() => null)).toBeNull();
    }
    expect(r.server.requests).toHaveLength(0);
  });

  test("a models lock inside a citizen home is refused before anything is created, by the check the child would make", async () => {
    const r = await rig();
    const lock = join(r.root, "homes", "candidate.lock");
    await writeFile(lock, lockOf());
    const argv = args(r);
    argv[argv.indexOf("--models-lock") + 1] = lock;
    const ran = await rehearse(r, argv);
    expect(ran.exit).toBe(1);
    expect(r.stderr).toContain("config paths.models_lock: is inside a citizen home (paths.homes[0])");
    expect(await stat(ran.dir).catch(() => null)).toBeNull();
    expect(r.server.requests).toHaveLength(0);
  });

  test("a canon ref seating would not accept is refused before anything is created", async () => {
    const r = await rig();
    const argv = args(r);
    argv[argv.indexOf(CANON_REF)] = "YOUSPEAK:canon/core/someone-else.md@1428646";
    const ran = await rehearse(r, argv);
    expect(ran.exit).toBe(1);
    expect(r.stderr).toContain("a canon entry is named by a repository");
    expect(await stat(ran.dir).catch(() => null)).toBeNull();
  });
});
