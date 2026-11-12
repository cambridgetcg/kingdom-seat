// The rehearsal child for test/rehearse.test.ts: the real CLI
// (`rehearse --child --plan <file>`), run by the rehearsal parent as a real
// supervised process. Every request goes to the parent's fake server, found
// as the plan's ollama.base_url, which also stands in for agenttool's beacon
// route. The keychain, the signer, the runtime and the command runner are
// never to be built here: if any is, the child exits 99, which the parent
// reports as a fault and the test sees.
import { readFileSync } from "node:fs";
import { main } from "../../../src/cli.ts";
import { fetchViaUrl } from "../../helpers/fake-server.ts";

const argv = Bun.argv.slice(2);
const at = argv.indexOf("--plan");
const planPath = at >= 0 ? argv[at + 1] : undefined;
if (!planPath) {
  process.stderr.write("rehearse child: --plan is required\n");
  process.exit(1);
}
let serverUrl = "http://127.0.0.1:9";
try {
  serverUrl = (JSON.parse(readFileSync(planPath, "utf8")) as { settings: { ollama_base_url: string } }).settings.ollama_base_url;
} catch {
  // A plan that does not read is the CLI's to refuse; the fetch then reaches nothing.
}

/** Stands for a dependency a rehearsal must never build. */
function forbidden(what: string): never {
  process.stderr.write(`rehearse child: ${what} was built\n`);
  process.exit(99);
}

const exit = await main(argv, {
  fetch: fetchViaUrl(serverUrl),
  env: process.env,
  keychain: () => forbidden("a keychain"),
  signer: () => forbidden("a signer"),
  runtime: async () => forbidden("a runtime"),
  run: async () => forbidden("a command"),
  tty: { isTTY: false, write: () => {}, readLine: async () => null },
  defaults: { config: "/nonexistent/rehearse-child-must-not-fall-back/config.json", halt_file: "/nonexistent/rehearse-child-must-not-fall-back/HALT" },
});
process.exit(exit);
