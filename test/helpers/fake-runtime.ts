// Fake runtimes. `scriptedRuntime` is an in-process RuntimeAdapter that
// returns scripted outputs, for pipeline tests. `fakeBinArgv` runs
// fake-runtime-bin.ts as a real child process, for the watcher tests that
// need something to TERM and KILL. Neither calls a model.
import { join } from "node:path";
import type { CommandResult, CommandRunner, ModelAct, RuntimeAdapter, RuntimeRequest, RuntimeResult } from "../../src/types.ts";

export const FAKE_MODEL = "fake-model:test";
export const FAKE_MODEL_DIGEST = `sha256:${"f".repeat(64)}`;

export type Script = string | ((req: RuntimeRequest) => string | Promise<string>);

export interface ScriptedRuntime extends RuntimeAdapter {
  calls: RuntimeRequest[];
}

/** Returns each script in turn; throws when called more times than scripted, so an extra call is visible. */
export function scriptedRuntime(scripts: Script[]): ScriptedRuntime {
  const calls: RuntimeRequest[] = [];
  const adapter = (async (req: RuntimeRequest): Promise<RuntimeResult> => {
    const script = scripts[calls.length];
    calls.push(req);
    if (script === undefined) throw new Error("scriptedRuntime: no script left");
    const raw = typeof script === "string" ? script : await script(req);
    return {
      runtime: "free",
      model: FAKE_MODEL,
      model_digest: FAKE_MODEL_DIGEST,
      raw_output: raw,
      spend: { usd: "0", usd_basis: "local-zero", credits: 0 },
      done_reason: "stop",
      duration_ms: 1,
    };
  }) as ScriptedRuntime;
  adapter.calls = calls;
  return adapter;
}

/** Raw output for a list of model acts. */
export function output(...acts: ModelAct[]): string {
  return JSON.stringify({ acts });
}

/** The output of a whole rest. */
export const REST_OUTPUT = output({ type: "rest" });

/**
 * A rest that goes on talking, as a 7B model often does
 * (love-unlimited-patterns.md 5.2). Rest is exclusive, so none of this text
 * may be written anywhere in the citizen's voice.
 */
export const REST_THEN_TALK_OUTPUT = output(
  { type: "rest" },
  { type: "journal", kind: "observed", text: "REST-LEAK-CANARY the light filters through my windows" },
);

export const FAKE_RUNTIME_BIN = join(import.meta.dir, "fake-runtime-bin.ts");

/**
 * argv that runs the fake binary under the current bun.
 *   print <text> [exit]        write text to stdout and exit
 *   sleep <ms>                 sleep, then exit 0
 *   ignore-term <ms>           ignore SIGTERM and sleep, so only KILL ends it
 *   grandchild <pidfile> <ms>  spawn a TERM-ignoring grandchild, write its pid, then sleep
 *   record <file> [text]       write argv, env keys (never values), cwd and stdin to file, then print text
 *   note <log> <word> <outcome> [exit] [ts]  append one host note as a seat child would, then exit
 *   speak-later <started> <ledger> <ms> [ignore-term]  write <started>, sleep, then append a canary line to <ledger>,
 *                              as a seat child mid-inference would write in the citizen's voice if nothing stopped it
 */
export function fakeBinArgv(mode: "print" | "sleep" | "ignore-term" | "grandchild" | "record" | "note" | "speak-later", ...args: string[]): string[] {
  return [process.execPath, FAKE_RUNTIME_BIN, mode, ...args];
}

export interface RecordedCommand {
  argv: string[];
  env: Record<string, string> | undefined;
  cwd: string | undefined;
  stdin: Uint8Array | undefined;
}

export interface RecordingRunner extends CommandRunner {
  calls: RecordedCommand[];
}

/**
 * A CommandRunner that runs nothing: it records each call and answers from
 * `respond`. Use it for `security`, `claude` and `git push`, none of which a
 * test may run for real.
 */
export function recordingRunner(respond: (cmd: RecordedCommand) => CommandResult = () => ({ code: 0, stdout: new Uint8Array(), stderr: "" })): RecordingRunner {
  const calls: RecordedCommand[] = [];
  const runner = (async (argv, opts) => {
    const cmd: RecordedCommand = { argv: [...argv], env: opts?.env, cwd: opts?.cwd, stdin: opts?.stdin };
    calls.push(cmd);
    return respond(cmd);
  }) as RecordingRunner;
  runner.calls = calls;
  return runner;
}

/** Poll until cond holds; throws after ms, so a child that never starts fails the test instead of hanging it. */
export async function waitFor(cond: () => boolean | Promise<boolean>, ms = 3_000): Promise<void> {
  const end = performance.now() + ms;
  while (performance.now() < end) {
    if (await cond()) return;
    await Bun.sleep(20);
  }
  throw new Error("waitFor: timed out");
}

/** True while a pid is alive (signal 0 probes without sending anything). */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
