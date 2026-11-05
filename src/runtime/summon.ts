// The summon lane (3.2 step 5): Claude Code headless, with Yu present, as
// `claude --restricted --strict-mcp-config`. Every bound is passed as a flag
// the runtime enforces, because `-p` silently ignores settings files that
// fail validation (runtimes-and-host.md 2). The signer's USD ceiling is the
// bound that fails closed; --max-budget-usd is a second, runtime-side one.
// No citizen home is ever passed as --add-dir or used as cwd.
import type { CommandRunner, Config, Prompt, RuntimeAdapter, Spend, YuPresence } from "../types.ts";

export interface SummonOptions {
  claudePath: string;
  /** The seat's empty cwd; never inside a home. */
  cwd: string;
  /** USD the signer has left for this citizen today; the run is refused when it is 0 or unknown. */
  budgetUsd: number;
  schema: object;
}

export interface SummonDeps {
  config: Config;
  run: CommandRunner;
  presence: YuPresence | null;
  /** Remaining USD for this citizen today from the signer's ceiling; null is unknown, which refuses. */
  remainingUsd: number | null;
}

/** The exact argv: --restricted --strict-mcp-config -p --output-format json --max-budget-usd --permission-mode dontAsk --permission-prompts none --no-session-persistence --tools "" --json-schema. */
export function summonArgv(opts: SummonOptions): string[] {
  throw new Error("unimplemented");
}

/** An explicit environment allowlist; CLAUDE_CODE_RESTRICTED is not relied on and no secret is passed. */
export function summonEnv(parent: Record<string, string | undefined>): Record<string, string> {
  throw new Error("unimplemented");
}

/** The prompt as stdin bytes, so it never appears in argv or a process listing. */
export function summonStdin(prompt: Prompt): Uint8Array {
  throw new Error("unimplemented");
}

/** Parse the --output-format json result: structured_output, subtype, total_cost_usd, modelUsage costUSD and costBasis. */
export function parseSummonResult(stdout: Uint8Array): { structured: unknown; subtype: string; model: string; spend: Spend } {
  throw new Error("unimplemented");
}

/** The summon adapter: refuses without Yu present or with no USD left; records cost, with unknown counted as at-ceiling. */
export function summonRuntime(deps: SummonDeps): RuntimeAdapter {
  throw new Error("unimplemented");
}
