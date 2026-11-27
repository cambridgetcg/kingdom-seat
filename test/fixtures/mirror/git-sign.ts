// git's SSH signing program for test/mirror.test.ts: the real CLI's `-Y sign`
// entry (citizen-seat as gpg.ssh.program), run by a real git, with only the
// keychain swapped for a fake of published test keys. A small shell wrapper
// the test writes runs this file under the test's own Bun, because git runs
// its program as one executable with the mirror's fixed PATH.
import { main } from "../../../src/cli.ts";
import { fromHex, sha256 } from "../../../src/crypto.ts";
import { fakeKeychain } from "../../helpers/fake-keychain.ts";
import { noFetch } from "../../helpers/fake-server.ts";
import { TEST_SEAT_UID } from "../../helpers/temp-home.ts";
import { TEST_OP_SEED_HEX } from "../../helpers/vectors.ts";

/** The host key and glossame's op key, the same published test keys the fake signer uses. */
export const MIRROR_SIGN_HOST_SEED = sha256("kingdom-seat test host attest key v1");

if (import.meta.main) {
  const keychain = fakeKeychain([
    [{ kind: "host-attest-seed" }, MIRROR_SIGN_HOST_SEED],
    [{ kind: "citizen-op-seed", word: "glossame" }, fromHex(TEST_OP_SEED_HEX)],
  ]);
  const exit = await main(Bun.argv.slice(2), {
    env: process.env,
    fetch: noFetch,
    keychain: () => keychain,
    run: async () => {
      throw new Error("git-sign fixture: no command may run while signing");
    },
    uid: () => TEST_SEAT_UID,
    err: (t) => void process.stderr.write(t),
    out: (t) => void process.stdout.write(t),
  });
  process.exit(exit);
}
