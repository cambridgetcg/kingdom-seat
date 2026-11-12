// A rehearsal parent as a process of its own, for the test in
// test/rehearse.test.ts that kills the parent while its child runs:
//
//   parent.ts <fake server url> <child stderr copy> <default config> <default HALT file> rehearse <word> ...
//
// It runs the real CLI with the same fakes as the in-process tests: every
// request goes to the fake server, and the keychain, the signer, the runtime
// and the command runner throw if built. Its child is
// test/fixtures/rehearse/child.ts, which copies its stderr to the file named.
import { join } from "node:path";
import { main } from "../../../src/cli.ts";
import { fetchViaUrl } from "../../helpers/fake-server.ts";

const [serverUrl, childErr, defaultConfig, defaultHalt, ...argv] = Bun.argv.slice(2);
if (!serverUrl || !childErr || !defaultConfig || !defaultHalt) {
  process.stderr.write("rehearse parent: <server url> <child stderr copy> <default config> <default HALT file> are required\n");
  process.exit(1);
}
const child = join(import.meta.dir, "child.ts");
const forbidden = (what: string) => (): never => {
  throw new Error(`rehearse parent: ${what} was built`);
};

const exit = await main(argv, {
  fetch: fetchViaUrl(serverUrl),
  env: process.env,
  keychain: forbidden("a keychain"),
  signer: forbidden("a signer"),
  runtime: forbidden("a runtime"),
  run: forbidden("a command"),
  tty: { isTTY: false, write: () => {}, readLine: async () => null },
  rehearseArgv: (plan) => [process.execPath, child, "--copy-stderr", childErr, "rehearse", "--child", "--plan", plan],
  defaults: { config: defaultConfig, halt_file: defaultHalt },
});
process.exit(exit);
