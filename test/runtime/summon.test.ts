// Owner: runtime group. recordingRunner only; no test runs claude.
import { describe, test } from "bun:test";

describe("summon", () => {
  test.todo("summonArgv contains --restricted, --strict-mcp-config, -p, --output-format json, --max-budget-usd, --permission-mode dontAsk, --permission-prompts none, --no-session-persistence, --tools '' and --json-schema");
  test.todo("summonArgv never contains --add-dir, bypassPermissions or any path under a citizen home");
  test.todo("the prompt travels on stdin, never in argv");
  test.todo("summonEnv is an allowlist; a fake secret in the parent env does not pass");
  test.todo("summonRuntime refuses without Yu present (yu-not-present) and with remainingUsd 0 or null (ceiling-usd)");
  test.todo("parseSummonResult reads total_cost_usd and modelUsage costBasis; costBasis unknown or a missing cost gives usd null");
  test.todo("subtype error_max_budget_usd is reported as refused, not as a beat");
});
