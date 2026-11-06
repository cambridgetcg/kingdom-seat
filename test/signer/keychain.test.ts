// Owner: signer group. Uses recordingRunner only; no test runs /usr/bin/security.
import { describe, expect, test } from "bun:test";
import { fromUtf8, toHex, utf8 } from "../../src/crypto.ts";
import { Refusal, type KeychainItemName } from "../../src/types.ts";
import { KEYCHAIN_READER, classifySecurityFailure, itemAccount, macosKeychain, readArgv, writeCommand, type MacosKeychainOptions } from "../../src/signer/keychain.ts";
import { recordingRunner, type RecordedCommand } from "../helpers/fake-runtime.ts";

const SECRET = utf8("at_test_bearer_never_real_0123456789");
const SEED = new Uint8Array(32).map((_, i) => (i * 7 + 3) & 0xff);
const BASE = {
  keychainPath: "/Users/seat/Library/Keychains/kingdom-seat.keychain-db",
  service: "dev.kingdom.citizen-seat.test",
  securityPath: "/usr/bin/security" as const,
  trustedApp: "/usr/local/libexec/kingdom-seat/citizen-signer",
};
const OP: KeychainItemName = { kind: "citizen-op-seed", word: "glossame" };

function keychainWith(respond: (cmd: RecordedCommand) => { code: number; stdout: Uint8Array; stderr: string }, patch: Partial<MacosKeychainOptions> = {}) {
  const run = recordingRunner(respond);
  return { run, kc: macosKeychain({ ...BASE, run, ...patch }) };
}

/** Every spelling a secret could leak as. */
function leaks(secret: Uint8Array): string[] {
  return [toHex(secret), Buffer.from(secret).toString("base64"), Buffer.from(secret).toString("base64url"), Buffer.from(secret).toString("latin1")];
}

describe("macosKeychain", () => {
  test("readArgv names /usr/bin/security, the service, the account and the explicit keychain path, and nothing secret", () => {
    expect(readArgv(BASE, OP)).toEqual([
      "/usr/bin/security",
      "find-generic-password",
      "-s",
      BASE.service,
      "-a",
      "citizen/glossame/op-seed",
      "-w",
      BASE.keychainPath,
    ]);
    expect(() => readArgv({ ...BASE, keychainPath: "login.keychain" }, OP)).toThrow(Refusal);
  });

  test("a write sends the secret on stdin as -X hex to `security -i`, and argv is exactly [security, -i]", async () => {
    const { run, kc } = keychainWith(() => ({ code: 0, stdout: new Uint8Array(), stderr: "" }));
    await kc.write(OP, SEED);
    expect(run.calls).toHaveLength(1);
    const call = run.calls[0]!;
    expect(call.argv).toEqual(["/usr/bin/security", "-i"]);
    for (const form of leaks(SEED)) expect(call.argv.join(" ")).not.toContain(form);
    expect(call.env === undefined || Object.values(call.env).every((v) => !leaks(SEED).some((f) => v.includes(f)))).toBe(true);
    // The stdin buffer is wiped once the command has run, so only the recorded reference remains, zeroed.
    expect(call.stdin!.every((b) => b === 0)).toBe(true);
  });

  test("writeCommand carries -X hex, -T for the reader that actually reads and the trusted app, and the explicit keychain, with no -U", () => {
    const line = fromUtf8(writeCommand(BASE, OP, SEED));
    // Every read is asked by /usr/bin/security, so the ACL names it explicitly instead of
    // depending on what -T does to the creator's entry; the trusted app is kept for a future signer.
    expect(line).toBe(
      `add-generic-password -s "${BASE.service}" -a "citizen/glossame/op-seed" -T "/usr/bin/security" -T "${BASE.trustedApp}" -X ${toHex(SEED)} "${BASE.keychainPath}"\n`,
    );
    expect(readArgv(BASE, OP)[0]).toBe(KEYCHAIN_READER);
    // Named once, even when the trusted app is the reader itself.
    expect(fromUtf8(writeCommand({ ...BASE, trustedApp: "/usr/bin/security" }, OP, SEED))).toContain(' -T "/usr/bin/security" -X ');
    expect(line).not.toContain(" -U");
    expect(line).not.toContain(" -w");
    expect(line.split("\n")).toHaveLength(2);
  });

  test("writes carry -T for the trusted app and refuse when trusted_app is null", async () => {
    const { run, kc } = keychainWith(() => ({ code: 0, stdout: new Uint8Array(), stderr: "" }), { trustedApp: null });
    await expect(kc.write(OP, SEED)).rejects.toMatchObject({ code: "invalid-request" });
    expect(run.calls).toHaveLength(0);
    expect(() => writeCommand({ ...BASE, trustedApp: null }, OP, SEED)).toThrow(Refusal);
    // Characters `security -i` might parse differently are refused rather than escaped.
    expect(() => writeCommand({ ...BASE, trustedApp: '/tmp/a" -A "' }, OP, SEED)).toThrow(Refusal);
    expect(() => writeCommand({ ...BASE, service: "a\nadd-generic-password" }, OP, SEED)).toThrow(Refusal);
    expect(() => writeCommand(BASE, OP, new Uint8Array())).toThrow(Refusal);
  });

  test("a write that finds the item already there refuses instead of overwriting", async () => {
    const { kc } = keychainWith(() => ({ code: 45, stdout: new Uint8Array(), stderr: "security: SecKeychainItemCreateFromContent: The specified item already exists in the keychain. (-25299)" }));
    await expect(kc.write(OP, SEED)).rejects.toMatchObject({ code: "invalid-request" });
  });

  test("classifySecurityFailure maps -25308 and -25293 to keychain-locked and -25300 to keychain-missing", () => {
    expect(classifySecurityFailure(36, "security: SecKeychainSearchCopyNext: User interaction is not allowed. (-25308)")).toBe("keychain-locked");
    expect(classifySecurityFailure(51, "The user name or passphrase you entered is not correct. (-25293)")).toBe("keychain-locked");
    expect(classifySecurityFailure(44, "security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain. (-25300)")).toBe("keychain-missing");
    expect(classifySecurityFailure(1, "error -25308")).toBe("keychain-locked");
    expect(classifySecurityFailure(1, "-25300")).toBe("keychain-missing");
    // Exit codes alone, derived from the OSStatus low byte.
    expect(classifySecurityFailure(44, "")).toBe("keychain-missing");
    expect(classifySecurityFailure(36, "")).toBe("keychain-locked");
    expect(classifySecurityFailure(1, "something else")).toBe("error");
    expect(classifySecurityFailure(2, "-253000")).toBe("error");
  });

  test("a locked or missing keychain read refuses with the matching code and never echoes stderr", async () => {
    const locked = keychainWith(() => ({ code: 36, stdout: new Uint8Array(), stderr: "User interaction is not allowed. (-25308)" }));
    await expect(locked.kc.read(OP)).rejects.toMatchObject({ code: "keychain-locked" });
    await expect(locked.kc.has(OP)).rejects.toMatchObject({ code: "keychain-locked" });
    const missing = keychainWith(() => ({ code: 44, stdout: new Uint8Array(), stderr: "could not be found (-25300)" }));
    await expect(missing.kc.read(OP)).rejects.toMatchObject({ code: "keychain-missing" });
    expect(await missing.kc.has(OP)).toBe(false);
    const odd = keychainWith(() => ({ code: 9, stdout: new Uint8Array(), stderr: "CANARY-STDERR" }));
    const err = await odd.kc.read(OP).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).not.toContain("CANARY-STDERR");
  });

  test("read strips exactly one trailing newline and returns bytes", async () => {
    const stored = utf8("abandon about\n\n");
    const { run, kc } = keychainWith(() => ({ code: 0, stdout: stored, stderr: "" }));
    const got = await kc.read(OP);
    expect(fromUtf8(got)).toBe("abandon about\n");
    // The runner's buffer is wiped; the returned bytes are a separate copy.
    expect(stored.every((b) => b === 0)).toBe(true);
    expect(run.calls[0]!.argv).toEqual(readArgv(BASE, OP));
    expect(run.calls[0]!.stdin).toBeUndefined();
    const plain = keychainWith(() => ({ code: 0, stdout: utf8("no-newline"), stderr: "" }));
    expect(fromUtf8(await plain.kc.read(OP))).toBe("no-newline");
  });

  test("has asks without -w or -g, so no value is printed", async () => {
    const { run, kc } = keychainWith(() => ({ code: 0, stdout: utf8('keychain: "x"\nattributes: ...'), stderr: "" }));
    expect(await kc.has({ kind: "commons-bearer" })).toBe(true);
    const argv = run.calls[0]!.argv;
    expect(argv).not.toContain("-w");
    expect(argv).not.toContain("-g");
    expect(argv.at(-1)).toBe(BASE.keychainPath);
    expect(argv).toContain("host/commons-bearer");
  });

  test("itemAccount gives distinct accounts per kind and word, and refuses a word outside WORD_PATTERN", () => {
    const items: KeychainItemName[] = [
      { kind: "citizen-mnemonic", word: "glossame" },
      { kind: "citizen-op-seed", word: "glossame" },
      { kind: "citizen-mnemonic", word: "zoeme" },
      { kind: "citizen-op-seed", word: "zoeme" },
      { kind: "host-attest-seed" },
      { kind: "commons-bearer" },
      { kind: "operator-mnemonic", operator: "halt-herald" },
      { kind: "operator-bearer", operator: "halt-herald" },
      { kind: "operator-bearer", operator: "gardener-desk" },
    ];
    const accounts = items.map(itemAccount);
    expect(new Set(accounts).size).toBe(items.length);
    expect(itemAccount({ kind: "citizen-mnemonic", word: "glossame" })).toBe("citizen/glossame/mnemonic");
    for (const word of ["../x", "Glossame", "", "a/b", "-x", "x y", 'a"b']) {
      expect(() => itemAccount({ kind: "citizen-op-seed", word })).toThrow(Refusal);
    }
    expect(() => itemAccount({ kind: "operator-bearer", operator: "../root" })).toThrow(Refusal);
  });

  test("the security path is pinned", () => {
    expect(() => macosKeychain({ ...BASE, securityPath: "security" as "/usr/bin/security", run: recordingRunner() })).toThrow();
  });
});
