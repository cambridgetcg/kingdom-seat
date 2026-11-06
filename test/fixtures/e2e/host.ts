// Shared by test/e2e.test.ts and its seat child (child.ts). The tick spawns
// a real child process, so the child cannot share the test's objects: it
// rebuilds the same fake keychain from these constants and reads the time
// and the fake server's URL from a scenario file beside the config. Every
// key here is a public test value that no service has ever seen.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { sha256, utf8 } from "../../../src/crypto.ts";
import { fakeKeychain, type FakeKeychain } from "../../helpers/fake-keychain.ts";
import { TEST_MNEMONIC } from "../../helpers/vectors.ts";

export const E2E_CHILD = join(import.meta.dir, "child.ts");
/** The seat user's uid in this layout: not the test's own, which owns the config as the operator would (KS-004 B2 R5). */
export { TEST_SEAT_UID as E2E_SEAT_UID } from "../../helpers/temp-home.ts";
export const SCENARIO_FILE = "e2e-scenario.json";

/** The beacon this host can raise in the e2e layout (testBeacons names it). */
export const HELD_BEACON = "gardener-desk";

export const E2E_HOST_SEED = sha256("kingdom-seat e2e host attest key v1");
const E2E_BEARER = "at_e2e-fake-bearer-never-issued";

/** The host's keychain: a host attest seed, and the held beacon's operator mnemonic and bearer. No citizen keys: no identity exists. */
export function e2eKeychain(): FakeKeychain {
  return fakeKeychain([
    [{ kind: "host-attest-seed" }, E2E_HOST_SEED],
    [{ kind: "operator-mnemonic", operator: HELD_BEACON }, utf8(TEST_MNEMONIC)],
    [{ kind: "operator-bearer", operator: HELD_BEACON }, utf8(E2E_BEARER)],
  ]);
}

export interface Scenario {
  server_url: string;
  /** The time both processes use for this tick. */
  now: string;
}

export function scenarioPath(configPath: string): string {
  return join(dirname(configPath), SCENARIO_FILE);
}

export function readScenario(configPath: string): Scenario {
  return JSON.parse(readFileSync(scenarioPath(configPath), "utf8")) as Scenario;
}
