// Owner: runtime group. recordingRunner only; no test runs claude.
//
// test/fixtures/runtime/claude-result-success.json is synthetic: its shape
// follows the result schema read in the Claude Code 2.1.314 binary
// (runtimes-and-host.md 2.1). No `claude -p` was run to produce it.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fromUtf8, utf8 } from "../../src/crypto.ts";
import {
  parseSummonResult,
  SummonError,
  SummonRefusal,
  summonArgv,
  summonEnv,
  summonRuntime,
  summonStdin,
  UNKNOWN_SPEND,
} from "../../src/runtime/summon.ts";
import { Refusal, type CommandResult, type RefusalCode, type RuntimeRequest, type SeatRef, type YuPresence } from "../../src/types.ts";
import { hostSpendRecorder, readSpendRecord, usdSpentToday, type SpendRecorder } from "../../src/spend.ts";
import { recordingRunner, type RecordedCommand } from "../helpers/fake-runtime.ts";
import { makeTempHost, type TempHost } from "../helpers/temp-home.ts";
import successFixture from "../fixtures/runtime/claude-result-success.json";

const SEAT_ID = "22222222-2222-4222-8222-222222222222";
const WORD = "glossame";
const SCHEMA = { type: "object", required: ["acts"], properties: { acts: { type: "array" } } };
const PROMPT = { system: "SYSTEM-CANARY you have no body and no senses", user: "USER-CANARY the date, and one letter" };
const CLAUDE = "/nonexistent/claude-must-not-run";

const EXACT_FLAGS = [
  "--restricted",
  "--strict-mcp-config",
  "-p",
  "--output-format",
  "json",
  "--max-budget-usd",
  "<budget>",
  "--permission-mode",
  "dontAsk",
  "--permission-prompts",
  "none",
  "--no-session-persistence",
  "--tools",
  "",
  "--json-schema",
  JSON.stringify(SCHEMA),
];

function expectedArgv(budget: string): string[] {
  return [CLAUDE, ...EXACT_FLAGS.map((f) => (f === "<budget>" ? budget : f))];
}

const PRESENT: YuPresence = { present: true, via: "tty-confirm", confirmed_at: "2026-11-05T02:04:00.000Z", scope: `summon ${WORD}` };

const SEAT_REF: SeatRef = {
  format: "kingdom-seat-seat/v1",
  seat_id: SEAT_ID,
  host: "test-host",
  word: WORD,
  runtime: "summon",
  invoker: { kind: "summons", who: "yu", why: "a summons with Yu present" },
  opened_at: "2026-11-05T02:05:00.000Z",
};

function request(over: Partial<RuntimeRequest> = {}): RuntimeRequest {
  return { prompt: PROMPT, schema: SCHEMA, seat_ref: SEAT_REF, deadline_ms: 60_000, signal: new AbortController().signal, ...over };
}

type ResultJson = Record<string, unknown>;

function resultJson(over: ResultJson = {}): ResultJson {
  return { ...structuredClone(successFixture), ...over };
}

function withUsage(usage: Record<string, unknown>, over: ResultJson = {}): ResultJson {
  return resultJson({ modelUsage: usage, ...over });
}

function answer(json: ResultJson | string, code = 0): (cmd: RecordedCommand) => CommandResult {
  return () => ({ code, stdout: utf8(typeof json === "string" ? json : JSON.stringify(json)), stderr: "" });
}

async function expectRefusal(fn: () => unknown, code: RefusalCode): Promise<Refusal> {
  let caught: unknown;
  try {
    await fn();
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(Refusal);
  expect((caught as Refusal).code).toBe(code);
  return caught as Refusal;
}

let host: TempHost;
let seatCwd: string;

beforeEach(async () => {
  host = await makeTempHost();
  // A summons is metered spend, which Yu raises per runtime class; the $0 default refuses (tested below).
  host.config.ceilings = { ...host.config.ceilings, usd_per_citizen_per_day: "1" };
  seatCwd = join(host.config.paths.seats_dir, SEAT_ID);
  await mkdir(seatCwd);
});

afterEach(async () => {
  await host.cleanup();
});

/** The host's own spend record under the temp host, on a clock fixed at the seat's day. */
function recorder(): SpendRecorder {
  return hostSpendRecorder(host.config, { now: () => new Date("2026-11-05T02:06:00.000Z") });
}

function deps(
  run: ReturnType<typeof recordingRunner>,
  over: { presence?: YuPresence | null; remainingUsd?: string | null; env?: Record<string, string | undefined>; spend?: SpendRecorder } = {},
) {
  return {
    config: host.config,
    run,
    presence: over.presence === undefined ? PRESENT : over.presence,
    remainingUsd: over.remainingUsd === undefined ? "0.5" : over.remainingUsd,
    spend: over.spend ?? recorder(),
    env: over.env ?? { HOME: "/Users/seat", LANG: "en_GB.UTF-8" },
  };
}

describe("summon", () => {
  test("summonArgv contains --restricted, --strict-mcp-config, -p, --output-format json, --max-budget-usd, --permission-mode dontAsk, --permission-prompts none, --no-session-persistence, --tools '' and --json-schema", async () => {
    expect(summonArgv({ claudePath: CLAUDE, cwd: seatCwd, budgetUsd: "0.25", schema: SCHEMA })).toEqual(expectedArgv("0.25"));
    expect(summonArgv({ claudePath: CLAUDE, cwd: seatCwd, budgetUsd: "2", schema: SCHEMA })[7]).toBe("2");
    // Rounded down to whole micro-dollars, so the runtime's bound is never above what is left.
    expect(summonArgv({ claudePath: CLAUDE, cwd: seatCwd, budgetUsd: "0.0123456789", schema: SCHEMA })[7]).toBe("0.012345");
    expect(summonArgv({ claudePath: CLAUDE, cwd: seatCwd, budgetUsd: "0.1000009", schema: SCHEMA })[7]).toBe("0.1");
    await expectRefusal(() => summonArgv({ claudePath: CLAUDE, cwd: seatCwd, budgetUsd: "0.0000001", schema: SCHEMA }), "ceiling-usd");
    // A float is not an amount, so it is no budget either.
    await expectRefusal(() => summonArgv({ claudePath: CLAUDE, cwd: seatCwd, budgetUsd: 0.5 as unknown as string, schema: SCHEMA }), "ceiling-usd");
    await expectRefusal(() => summonArgv({ claudePath: "claude", cwd: seatCwd, budgetUsd: "1", schema: SCHEMA }), "invalid-request");

    // Through the adapter: the same argv, run from the seat's cwd, with the lower of what is left and the ceiling.
    const run = recordingRunner(answer(resultJson()));
    await summonRuntime(deps(run))(request());
    expect(run.calls).toHaveLength(1);
    expect(run.calls[0]!.argv).toEqual(expectedArgv("0.5"));
    expect(run.calls[0]!.cwd).toBe(seatCwd);
    expect(run.calls[0]!.argv[0]).toBe(host.config.claude.path);

    const capped = recordingRunner(answer(resultJson()));
    await summonRuntime(deps(capped, { remainingUsd: "7" }))(request());
    expect(capped.calls[0]!.argv).toEqual(expectedArgv("1"));
  });

  test("summonArgv never contains --add-dir, bypassPermissions or any path under a citizen home", async () => {
    const citizen = await host.addCitizen(WORD);
    const run = recordingRunner(answer(resultJson()));
    await summonRuntime(deps(run))(request());
    const argv = run.calls[0]!.argv;
    for (const a of argv) {
      expect(a).not.toContain("--add-dir");
      expect(a).not.toContain("bypassPermissions");
      expect(a).not.toContain("--dangerously-skip-permissions");
      expect(a).not.toContain(host.homesRoot);
      expect(a).not.toContain(citizen.home);
      expect(a).not.toContain(seatCwd);
    }

    // A seats dir inside a home would make the cwd a home's subtree, where its CLAUDE.md and hooks load.
    const insideHome = recordingRunner(answer(resultJson()));
    host.config.paths.seats_dir = join(citizen.home, "seats");
    await mkdir(join(host.config.paths.seats_dir, SEAT_ID), { recursive: true });
    await expectRefusal(() => summonRuntime(deps(insideHome))(request()), "cwd-in-home");
    expect(insideHome.calls).toHaveLength(0);
  });

  test("the seat cwd must be a real, empty directory with no CLAUDE.md in or above it", async () => {
    const run = recordingRunner(answer(resultJson()));
    const summon = summonRuntime(deps(run));

    // A CLAUDE.md above the cwd would be read on the way up to the root.
    await writeFile(join(host.config.paths.seats_dir, "CLAUDE.md"), "SEATS-CLAUDE-MD-CANARY\n");
    await expectRefusal(() => summon(request()), "cwd-in-home");
    await Bun.file(join(host.config.paths.seats_dir, "CLAUDE.md")).delete();

    await writeFile(join(seatCwd, "CLAUDE.local.md"), "x");
    await expectRefusal(() => summon(request()), "cwd-in-home");
    await Bun.file(join(seatCwd, "CLAUDE.local.md")).delete();

    await writeFile(join(seatCwd, "notes.txt"), "x");
    await expectRefusal(() => summon(request()), "invalid-request");
    await Bun.file(join(seatCwd, "notes.txt")).delete();

    const elsewhere = join(host.root, "elsewhere");
    await mkdir(elsewhere);
    const linked = "33333333-3333-4333-8333-333333333333";
    await symlink(elsewhere, join(host.config.paths.seats_dir, linked));
    await expectRefusal(() => summon(request({ seat_ref: { ...SEAT_REF, seat_id: linked } })), "symlink");
    await expectRefusal(() => summon(request({ seat_ref: { ...SEAT_REF, seat_id: "../../etc" } })), "invalid-request");
    await expect(summon(request({ seat_ref: { ...SEAT_REF, seat_id: "44444444-4444-4444-8444-444444444444" } }))).rejects.toThrow(/does not exist/);
    expect(run.calls).toHaveLength(0);

    await summon(request());
    expect(run.calls).toHaveLength(1);
  });

  test("the prompt travels on stdin, never in argv", async () => {
    expect(fromUtf8(summonStdin(PROMPT))).toBe(`${PROMPT.system}\n\n${PROMPT.user}`);
    const run = recordingRunner(answer(resultJson()));
    await summonRuntime(deps(run))(request());
    const call = run.calls[0]!;
    expect(fromUtf8(call.stdin!)).toBe(`${PROMPT.system}\n\n${PROMPT.user}`);
    const visible = [...call.argv, ...Object.values(call.env ?? {})].join("\n");
    expect(visible).not.toContain("SYSTEM-CANARY");
    expect(visible).not.toContain("USER-CANARY");
    expect(call.argv).not.toContain("--system-prompt");
    expect(call.argv).not.toContain("--append-system-prompt");
  });

  test("summonEnv is an allowlist; a fake secret in the parent env does not pass", async () => {
    const parent = {
      HOME: "/Users/seat",
      USER: "seat",
      LANG: "en_GB.UTF-8",
      TZ: "Europe/London",
      TMPDIR: "/private/var/folders/xx/T/",
      PATH: "/Users/seat/evil/bin:/usr/bin",
      ANTHROPIC_API_KEY: "sk-ant-FAKE-SECRET-NOT-REAL-0001",
      CLAUDE_CODE_OAUTH_TOKEN: "FAKE-OAUTH-SECRET-0002",
      GITHUB_TOKEN: "ghp_FAKE_SECRET_0003",
      AWS_SECRET_ACCESS_KEY: "FAKE/SECRET/0004",
      AGENTTOOL_BEARER: "FAKE-BEARER-0005",
      CLAUDE_CODE_RESTRICTED: "0",
      HTTP_PROXY: "http://127.0.0.1:9",
      NODE_OPTIONS: "--require /tmp/x.js",
      LC_ALL: "bad\nvalue",
      LOGNAME: "",
    };
    const env = summonEnv(parent);
    expect(env).toEqual({
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      HOME: "/Users/seat",
      USER: "seat",
      LANG: "en_GB.UTF-8",
      TZ: "Europe/London",
      TMPDIR: "/private/var/folders/xx/T/",
    });

    const run = recordingRunner(answer(resultJson()));
    await summonRuntime(deps(run, { env: parent }))(request());
    const passed = run.calls[0]!.env!;
    expect(passed).toEqual(env);
    const everything = JSON.stringify(run.calls[0]);
    for (const secret of ["FAKE-SECRET", "FAKE-OAUTH", "FAKE_SECRET", "FAKE/SECRET", "FAKE-BEARER"]) expect(everything).not.toContain(secret);
  });

  test("summonRuntime refuses without Yu present (yu-not-present) and with remainingUsd 0 or null (ceiling-usd)", async () => {
    const run = recordingRunner(answer(resultJson()));
    const notPresent: (YuPresence | null)[] = [
      null,
      { ...PRESENT, scope: "summon someone-else" },
      { ...PRESENT, scope: `birth ${WORD}` },
      { ...PRESENT, via: "flag" } as unknown as YuPresence,
      { ...PRESENT, present: false } as unknown as YuPresence,
      { ...PRESENT, confirmed_at: "not a time" },
    ];
    for (const presence of notPresent) await expectRefusal(() => summonRuntime(deps(run, { presence }))(request()), "yu-not-present");

    for (const remainingUsd of ["0", null, "-1", "NaN", "Infinity", 0.5 as unknown as string]) {
      await expectRefusal(() => summonRuntime(deps(run, { remainingUsd }))(request()), "ceiling-usd");
    }

    // The $0 default ceiling refuses even if a caller claims USD is left.
    host.config.ceilings = { ...host.config.ceilings, usd_per_citizen_per_day: "0" };
    await expectRefusal(() => summonRuntime(deps(run, { remainingUsd: "5" }))(request()), "ceiling-usd");
    host.config.ceilings = { ...host.config.ceilings, usd_per_citizen_per_day: "1" };

    // A seat opened for another runtime class is not a summons.
    await expectRefusal(() => summonRuntime(deps(run))(request({ seat_ref: { ...SEAT_REF, runtime: "free" } })), "runtime-not-approved");
    expect(run.calls).toHaveLength(0);
    // Nothing ran, so nothing could spend, and the record holds nothing.
    expect(await readSpendRecord(host.config)).toEqual([]);
  });

  test("parseSummonResult reads total_cost_usd and modelUsage costBasis; costBasis unknown or a missing cost gives usd null", async () => {
    const ok = parseSummonResult(utf8(JSON.stringify(resultJson())));
    expect(ok).toEqual({
      structured: successFixture.structured_output,
      subtype: "success",
      is_error: false,
      model: "claude-test-model",
      spend: { usd: "0.0421", usd_basis: "reported", credits: 0 },
      stop_reason: "end_turn",
      duration_ms: 4210,
    });

    const entry = successFixture.modelUsage["claude-test-model"];
    const unknownCases: [string, ResultJson][] = [
      ["costBasis unknown", withUsage({ m: { ...entry, costBasis: "unknown" } })],
      ["costBasis absent", withUsage({ m: (({ costBasis: _c, ...rest }) => rest)(entry) })],
      ["one of two models unknown", withUsage({ a: entry, b: { ...entry, costBasis: "unknown" } })],
      ["costUSD missing", withUsage({ m: (({ costUSD: _c, ...rest }) => rest)(entry) })],
      ["costUSD a string", withUsage({ m: { ...entry, costUSD: "0.04" } })],
      ["costUSD negative", withUsage({ m: { ...entry, costUSD: -0.01 } })],
      ["total missing", resultJson({ total_cost_usd: undefined })],
      ["total null", resultJson({ total_cost_usd: null })],
      ["total negative", resultJson({ total_cost_usd: -1 })],
      ["no modelUsage (a zeroed crash result)", resultJson({ modelUsage: {}, total_cost_usd: 0 })],
      ["modelUsage not an object", resultJson({ modelUsage: [] })],
    ];
    for (const [why, json] of unknownCases) {
      const parsed = parseSummonResult(utf8(JSON.stringify(json)));
      expect(parsed.spend, why).toEqual({ usd: null, usd_basis: "unknown", credits: 0 });
    }

    // Two models, both priced: the higher of the total and the per-model sum is recorded.
    const two = parseSummonResult(utf8(JSON.stringify(withUsage({ "model-b": { ...entry, costUSD: 0.03 }, "model-a": { ...entry, costUSD: 0.02, costBasis: "managed" } }, { total_cost_usd: 0.045 }))));
    expect(two.spend).toEqual({ usd: "0.05", usd_basis: "reported", credits: 0 });
    expect(two.model).toBe("model-a+model-b");
    // Summed as decimals: in floats 0.1 + 0.2 would be recorded as 0.30000000000000004.
    const exact = parseSummonResult(utf8(JSON.stringify(withUsage({ a: { ...entry, costUSD: 0.1 }, b: { ...entry, costUSD: 0.2 } }, { total_cost_usd: 0.3 }))));
    expect(exact.spend).toEqual({ usd: "0.3", usd_basis: "reported", credits: 0 });
    // A small model's cost that claude summed in floats is still a measured cost: rounded up at 18 places, not unknown.
    const noisy = parseSummonResult(utf8(JSON.stringify(withUsage({ main: { ...entry, costUSD: 0.05 }, aux: { ...entry, costUSD: 0.0034000000000000002 } }, { total_cost_usd: 0.0534 }))));
    expect(noisy.spend).toEqual({ usd: "0.053400000000000001", usd_basis: "reported", credits: 0 });

    expect(() => parseSummonResult(utf8("Error: not json"))).toThrow(/not one JSON result/);
    expect(() => parseSummonResult(utf8(JSON.stringify({ type: "assistant" })))).toThrow(/not a result/);
    expect(() => parseSummonResult(new Uint8Array([0xff, 0xfe]))).toThrow();

    // Through the adapter, an unknown cost still comes back as usd null, for the signer to count as at-ceiling.
    const run = recordingRunner(answer(withUsage({ m: { ...entry, costBasis: "unknown" } })));
    const result = await summonRuntime(deps(run))(request());
    expect(result.spend).toEqual({ usd: null, usd_basis: "unknown", credits: 0 });
  });

  test("a successful summons returns the structured output as a RuntimeResult", async () => {
    const run = recordingRunner(answer(resultJson()));
    const result = await summonRuntime(deps(run))(request());
    expect(result).toEqual({
      runtime: "summon",
      model: "claude-test-model",
      model_digest: "claude-test-model",
      raw_output: JSON.stringify(successFixture.structured_output),
      spend: { usd: "0.0421", usd_basis: "reported", credits: 0 },
      done_reason: "stop",
      duration_ms: 4210,
    });
    // The free-text `result` is never what the seat validates.
    expect(result.raw_output).not.toContain("SUMMON-RESULT-TEXT");

    const cut = recordingRunner(answer(resultJson({ stop_reason: "max_tokens" })));
    expect((await summonRuntime(deps(cut))(request())).done_reason).toBe("length");
  });

  test("subtype error_max_budget_usd is reported as refused, not as a beat", async () => {
    const budget = resultJson({
      subtype: "error_max_budget_usd",
      is_error: true,
      terminal_reason: "budget_exhausted",
      errors: ["ERRORS-CANARY budget"],
      structured_output: undefined,
      result: undefined,
      total_cost_usd: 0.51,
      modelUsage: { "claude-test-model": { ...successFixture.modelUsage["claude-test-model"], costUSD: 0.51 } },
    });
    const run = recordingRunner(answer(budget, 1));
    const err = await expectRefusal(() => summonRuntime(deps(run))(request()), "ceiling-usd");
    expect(err).toBeInstanceOf(SummonRefusal);
    expect((err as SummonRefusal).spend).toEqual({ usd: "0.51", usd_basis: "reported", credits: 0 });
    expect((err as SummonRefusal).subtype).toBe("error_max_budget_usd");
    expect(err.message).not.toContain("CANARY");
    expect(run.calls).toHaveLength(1);
  });

  test("every other way a run ends without a beat is an error that still carries its spend", async () => {
    const cases: [string, (cmd: RecordedCommand) => CommandResult, string | null][] = [
      ["error_during_execution", answer(resultJson({ subtype: "error_during_execution", is_error: true, errors: ["ERRORS-CANARY"] }), 1), "0.0421"],
      ["error_max_structured_output_retries", answer(resultJson({ subtype: "error_max_structured_output_retries", is_error: true, structured_output: undefined }), 1), "0.0421"],
      ["success marked is_error", answer(resultJson({ is_error: true })), "0.0421"],
      ["success with a non-zero exit", answer(resultJson(), 1), "0.0421"],
      ["success without structured_output", answer(resultJson({ structured_output: undefined })), "0.0421"],
      ["unreadable stdout", answer("Error: Exceeded USD budget (0.5)", 1), null],
      ["empty stdout", answer("", 143), null],
      ["the runner itself failed", () => {
        throw new Error("spawn failed");
      }, null],
    ];
    for (const [why, respond, usd] of cases) {
      const run = recordingRunner(respond);
      const err = await summonRuntime(deps(run))(request()).catch((e: unknown) => e);
      expect(err, why).toBeInstanceOf(SummonError);
      expect(err, why).not.toBeInstanceOf(Refusal);
      expect((err as SummonError).spend.usd, why).toBe(usd);
      if (usd === null) expect((err as SummonError).spend).toEqual({ ...UNKNOWN_SPEND });
      expect((err as Error).message).not.toContain("CANARY");
      expect(run.calls, why).toHaveLength(1);
    }

    // A seat abort while claude runs stops the wait; what claude spent is unknown.
    const seat = new AbortController();
    const hang = recordingRunner(() => {
      seat.abort(new Error("SEAT-ABORT"));
      return { code: 0, stdout: utf8(JSON.stringify(resultJson())), stderr: "" };
    });
    const aborted = await summonRuntime(deps(hang))(request({ signal: seat.signal })).catch((e: unknown) => e);
    expect(aborted).toBeInstanceOf(SummonError);
    expect((aborted as SummonError).spend.usd).toBeNull();
    expect(((aborted as SummonError).cause as Error).message).toBe("SEAT-ABORT");
  });

  test("every run is in the host's spend record, begun before claude starts and settled however it ends", async () => {
    const entry = successFixture.modelUsage["claude-test-model"];
    const outcomes: [string, (cmd: RecordedCommand) => CommandResult, string | null][] = [
      ["a reply, which the seat may then rest, discard at HALT, or record", answer(resultJson()), "0.0421"],
      ["stopped at --max-budget-usd", answer(resultJson({ subtype: "error_max_budget_usd", is_error: true, structured_output: undefined, total_cost_usd: 0.51, modelUsage: { m: { ...entry, costUSD: 0.51 } } }), 1), "0.51"],
      ["a runtime error", answer(resultJson({ subtype: "error_during_execution", is_error: true }), 1), "0.0421"],
      ["a cost claude cannot stand behind", answer(withUsage({ m: { ...entry, costBasis: "unknown" } })), null],
      ["no readable result", answer("Error", 1), null],
    ];
    let n = 0;
    for (const [why, respond, usd] of outcomes) {
      const seat_id = `22222222-2222-4222-8222-${String(++n).padStart(12, "0")}`;
      await mkdir(join(host.config.paths.seats_dir, seat_id));
      const order: string[] = [];
      const spend = recorder();
      const watched: SpendRecorder = {
        begin: async (ref) => {
          order.push("begun");
          await spend.begin(ref);
        },
        settle: async (ref, s) => {
          order.push("settled");
          await spend.settle(ref, s);
        },
      };
      const run = recordingRunner((cmd) => {
        order.push("claude");
        return respond(cmd);
      });
      await summonRuntime(deps(run, { spend: watched }))(request({ seat_ref: { ...SEAT_REF, seat_id } })).catch(() => null);
      expect(order, why).toEqual(["begun", "claude", "settled"]);
      const mine = (await readSpendRecord(host.config))!.filter((l) => l.seat_id === seat_id);
      expect(
        mine.map((l) => [l.phase, l.usd]),
        why,
      ).toEqual([
        ["begun", null],
        ["settled", usd],
      ]);
      expect(mine.every((l) => l.word === WORD && l.runtime === "summon"), why).toBe(true);
    }
    // Settled costs, and two unknown ones, today: the day is unknown, which is at the ceiling.
    expect(await usdSpentToday(host.config, WORD, new Date("2026-11-05T12:00:00.000Z"))).toBeNull();
  });

  test("a run whose start cannot be recorded never starts, and one that cannot settle stays at the ceiling", async () => {
    const failing: SpendRecorder = {
      begin: async () => {
        throw new Error("disk full");
      },
      settle: async () => {},
    };
    const run = recordingRunner(answer(resultJson()));
    await expectRefusal(() => summonRuntime(deps(run, { spend: failing }))(request()), "ceiling-usd");
    expect(run.calls).toHaveLength(0);

    // Begun, then the settle fails (or the seat is killed first): the seat's spend is unknown, never zero.
    const spend = recorder();
    const noSettle: SpendRecorder = { begin: (ref) => spend.begin(ref), settle: () => Promise.reject(new Error("disk full")) };
    const ok = recordingRunner(answer(resultJson()));
    const result = await summonRuntime(deps(ok, { spend: noSettle }))(request());
    expect(result.spend.usd).toBe("0.0421");
    expect((await readSpendRecord(host.config))!.map((l) => l.phase)).toEqual(["begun"]);
    expect(await usdSpentToday(host.config, WORD, new Date("2026-11-05T12:00:00.000Z"))).toBeNull();
  });
});
