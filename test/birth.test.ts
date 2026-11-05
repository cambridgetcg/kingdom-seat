// Owner: agenttool group. fakeKeychain, fakeSigner and fetchVia only.
import { describe, test } from "bun:test";

describe("never unattended", () => {
  test.todo("citizenBirth refuses without Yu present for 'birth <word>'");
  test.todo("citizenBirth refuses without a consent record bound to this citizen's confirmed yes");
  test.todo("citizenBirth refuses when the citizen's keychain items already exist");
});

describe("keys go straight to Keychain", () => {
  test.todo("mintKeys writes a 24-word mnemonic and a 32-byte op seed to the fake keychain and returns public keys only");
  test.todo("no secret appears in out() lines, thrown errors, the ledger, or any file under the temp host");
});

describe("the birth sequence", () => {
  test.todo("order: enroll, keys/import (op), box-keys, private expression PUT, genesis entry; stops at the first failure");
  test.todo("the genesis entry is citizen-signed and records origin, birth-soul hash, old repo, June DID and public identity");
  test.todo("renderBirthReport prints only the word, DID and three SHA256 fingerprints");
});
