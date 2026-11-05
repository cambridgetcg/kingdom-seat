// Owner: seat group. Seat opening and the pipeline's happy path.
import { describe, test } from "bun:test";

describe("seat cwd and environment", () => {
  test.todo("assertCwdOutsideHomes refuses a home, a path inside one, and a symlink that resolves into one");
  test.todo("openSeat makes a fresh empty cwd under seats_dir with a random seat_id and the invoker recorded");
  test.todo("seatEnv passes only the allowlist; a parent env holding a fake secret does not reach the child (record mode)");
});

describe("pipeline", () => {
  test.todo("a journal beat appends exactly one beat entry whose envelope has seat_ref, digests, acts, prev_hash and voiced_through");
  test.todo("input_digest is sha256 of promptBytes and output_digest is sha256 of the raw output");
  test.todo("an unregistered citizen's entry is host-attested; a registered one's is citizen-signed with the op key");
  test.todo("a locked signer: exit 3, outcome refused, refusal keychain-locked, nothing written");
  test.todo("a propose.beyond act becomes an inert outbox proposal and executes nothing");
  test.todo("the runtime receives no key, bearer or grant (fake keychain leak check over the prompt)");
  test.todo("hermes runtime class is refused until S8");
});
