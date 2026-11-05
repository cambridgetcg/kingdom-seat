// Owner: record group. Use test/helpers/fake-signer.ts for signatures.
import { describe, test } from "bun:test";

describe("ledger", () => {
  test.todo("entryHash is domain-tagged canonical JSON and changes when any field changes");
  test.todo("appendEntry appends one line, never rewrites, and refuses when the file head moved since prev was read");
  test.todo("readLedger refuses a symlinked ledger and throws on any unparsable line (fail closed)");
  test.todo("verifyChain accepts a seated → beat → genesis → beat chain and counts host-attested entries");
  test.todo("verifyChain flags a broken prev link, a bad hash, a bad signature, a root-kid signature, and a host-attested entry after genesis");
  test.todo("pinnedOpKeys follows genesis and op-key.rotated entries");
  test.todo("lastEntries returns the last k oldest-first");
  test.todo("voicedThrough reads '<word>, voiced through <model> in seat <id>'");
});
