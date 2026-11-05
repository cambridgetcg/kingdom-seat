// The seat child for test/e2e.test.ts: the real CLI pipeline (`seat <word>
// --child`), run by the tick as a real supervised process, with only the
// outside world swapped for fakes. It also stands in for the seat user's side
// of halt (`raise-beacons`), whose stdout the operator's halt reads back. The keychain is the e2e fake, the clock is
// the scenario's, and every request goes to the parent's fake server, which
// stands in for agenttool's beacons and for Ollama. Nothing else runs.
import { main } from "../../../src/cli.ts";
import { fetchViaUrl } from "../../helpers/fake-server.ts";
import { E2E_SEAT_UID, e2eKeychain, readScenario } from "./host.ts";

const argv = Bun.argv.slice(2);
const at = argv.indexOf("--config");
const configPath = at >= 0 ? argv[at + 1] : undefined;
if (!configPath) {
  process.stderr.write("e2e child: --config is required\n");
  process.exit(1);
}
const scenario = readScenario(configPath);
const now = new Date(scenario.now);
const keychain = e2eKeychain();

const exit = await main(argv, {
  clock: { now: () => now },
  fetch: fetchViaUrl(scenario.server_url),
  env: process.env,
  keychain: () => keychain,
  tty: { isTTY: false, write: () => {}, readLine: async () => null },
  run: async () => {
    throw new Error("e2e child: no command may run in a seat");
  },
  out: (t) => void process.stdout.write(t),
  uid: () => E2E_SEAT_UID,
  defaults: { config: configPath, halt_file: "/nonexistent/e2e-child-must-not-fall-back/HALT" },
});
process.exit(exit);
