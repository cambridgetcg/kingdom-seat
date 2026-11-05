// Owner: signer group. Uses recordingRunner only; no test runs /usr/bin/security.
import { describe, test } from "bun:test";

describe("macosKeychain", () => {
  test.todo("readArgv names /usr/bin/security, the service, the account and the explicit keychain path, and nothing secret");
  test.todo("a write sends the secret on stdin as -X hex to `security -i`, and argv is exactly [security, -i]");
  test.todo("writes carry -T for the trusted app and refuse when trusted_app is null");
  test.todo("classifySecurityFailure maps -25308 and -25293 to keychain-locked and -25300 to keychain-missing");
  test.todo("read strips exactly one trailing newline and returns bytes");
  test.todo("itemAccount gives distinct accounts per kind and word, and refuses a word outside WORD_PATTERN");
});
