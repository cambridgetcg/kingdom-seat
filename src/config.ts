// Host configuration. Strict: unknown keys are refused, paths must be
// absolute, the state dir must not be inside a citizen home, Ollama must be
// on 127.0.0.1, and the agenttool origin is pinned. A missing beacon list
// halts unless allow_no_beacons is set on purpose (3.6: fail closed).
import type { Config } from "./types.ts";

/** Where the CLI looks when --config is not given: the seat user's Application Support folder. */
export function defaultConfigPath(home: string): string {
  throw new Error("unimplemented");
}

/** A complete config rooted at stateDir, with decision-9 ceilings and default timing; for provisioning and tests. */
export function defaultConfig(stateDir: string, host: string): Config {
  throw new Error("unimplemented");
}

/** Validate an untrusted object into a Config, refusing anything ambiguous. */
export function parseConfig(raw: unknown): Config {
  throw new Error("unimplemented");
}

/** Read a config file as a regular file (no symlink) and parse it strictly. */
export async function loadConfig(path: string): Promise<Config> {
  throw new Error("unimplemented");
}
