// The macOS Keychain behind the Keychain interface (types.ts). Only the
// signer and citizen-birth hold one. Secrets cross the process boundary on a
// pipe, never in argv or env (runtimes-and-host.md 3.3), and a locked
// keychain after a reboot is a normal, fail-closed state (3.4).
import { utf8, wipe } from "../crypto.ts";
import { Refusal, WORD_PATTERN, type CommandRunner, type Keychain, type KeychainItemName } from "../types.ts";

export interface MacosKeychainOptions {
  /** Absolute path of the keychain file, named so another keychain cannot answer instead. */
  keychainPath: string;
  /** Generic-password service shared by every kingdom-seat item, e.g. "dev.kingdom.citizen-seat". */
  service: string;
  /** Always /usr/bin/security; launchd's PATH is not trusted. */
  securityPath: "/usr/bin/security";
  /** The signer binary that items are ACL'd to with -T; null refuses every write. */
  trustedApp: string | null;
  /** Injected so tests can check argv and stdin without touching a real keychain. */
  run: CommandRunner;
}

/** A `security` call that waits for a dialog no one can answer must not hold the tick forever. */
const SECURITY_TIMEOUT_MS = 15_000;

function assertName(name: string, what: string): void {
  if (typeof name !== "string" || !WORD_PATTERN.test(name)) throw new Refusal("invalid-request", `${what} must match WORD_PATTERN`);
}

/** The generic-password account for an item, e.g. "citizen/glossame/op-seed"; the name, never the value. */
export function itemAccount(item: KeychainItemName): string {
  switch (item.kind) {
    case "citizen-mnemonic":
      assertName(item.word, "a citizen word");
      return `citizen/${item.word}/mnemonic`;
    case "citizen-op-seed":
      assertName(item.word, "a citizen word");
      return `citizen/${item.word}/op-seed`;
    case "host-attest-seed":
      return "host/attest-seed";
    case "commons-bearer":
      return "host/commons-bearer";
    case "operator-mnemonic":
      assertName(item.operator, "an operator name");
      return `operator/${item.operator}/mnemonic`;
    case "operator-bearer":
      assertName(item.operator, "an operator name");
      return `operator/${item.operator}/bearer`;
    default:
      throw new Refusal("invalid-request", "unknown keychain item kind");
  }
}

/**
 * A value `security -i` will read back as one double-quoted argument. Quotes,
 * backslashes and control characters are refused instead of escaped, because
 * its quoting rules for them are not verified (runtimes-and-host.md 3.3).
 */
function quotable(value: string, what: string): string {
  if (typeof value !== "string" || value.length === 0 || /["\\\u0000-\u001f\u007f]/.test(value)) {
    throw new Refusal("invalid-request", `${what} cannot be passed to security -i`);
  }
  return `"${value}"`;
}

function assertAbsolute(path: string, what: string): void {
  if (typeof path !== "string" || !path.startsWith("/")) throw new Refusal("invalid-request", `${what} must be an absolute path`);
}

/** The argv for reading one item; it carries the item's name and keychain path, never a secret. */
export function readArgv(opts: Pick<MacosKeychainOptions, "keychainPath" | "service" | "securityPath">, item: KeychainItemName): string[] {
  assertAbsolute(opts.keychainPath, "the keychain path");
  return [opts.securityPath, "find-generic-password", "-s", opts.service, "-a", itemAccount(item), "-w", opts.keychainPath];
}

/** The argv for asking whether an item exists; without -w or -g, `security` prints attributes only. */
function hasArgv(opts: Pick<MacosKeychainOptions, "keychainPath" | "service" | "securityPath">, item: KeychainItemName): string[] {
  assertAbsolute(opts.keychainPath, "the keychain path");
  return [opts.securityPath, "find-generic-password", "-s", opts.service, "-a", itemAccount(item), opts.keychainPath];
}

const HEX = utf8("0123456789abcdef");

/** The stdin command line for writing one item via `security -i`; the secret travels here as hex, never in argv. */
export function writeCommand(opts: Pick<MacosKeychainOptions, "keychainPath" | "service" | "trustedApp">, item: KeychainItemName, secret: Uint8Array): Uint8Array {
  if (opts.trustedApp === null) throw new Refusal("invalid-request", "no trusted signer binary is configured, so no item may be written");
  assertAbsolute(opts.trustedApp, "the trusted app");
  assertAbsolute(opts.keychainPath, "the keychain path");
  if (!(secret instanceof Uint8Array) || secret.length === 0) throw new Refusal("invalid-request", "a secret must be non-empty bytes");
  // No -U: an existing item is never overwritten. -T names the one binary that may read it silently.
  const head = utf8(
    `add-generic-password -s ${quotable(opts.service, "the service")} -a ${quotable(itemAccount(item), "the account")} -T ${quotable(opts.trustedApp, "the trusted app")} -X `,
  );
  const tail = utf8(` ${quotable(opts.keychainPath, "the keychain path")}\n`);
  // The hex is written straight into the buffer, so the secret never exists as an unwipeable string.
  const out = new Uint8Array(head.length + secret.length * 2 + tail.length);
  out.set(head, 0);
  let o = head.length;
  for (const b of secret) {
    out[o++] = HEX[b >> 4]!;
    out[o++] = HEX[b & 15]!;
  }
  out.set(tail, o);
  return out;
}

/**
 * Map a `security` exit and stderr to a Refusal: -25308 and -25293 mean
 * locked, -25300 means missing. `security` exits with the low byte of the
 * OSStatus (-25300 → 44, -25308 → 36, -25293 → 51); that mapping is reasoned
 * from the codes, not observed, so stderr is consulted first.
 */
export function classifySecurityFailure(code: number, stderr: string): "keychain-locked" | "keychain-missing" | "error" {
  const text = typeof stderr === "string" ? stderr : "";
  if (/-25300\b|could not be found/i.test(text)) return "keychain-missing";
  if (/-25308\b|-25293\b|User interaction is not allowed|passphrase you entered is not correct/i.test(text)) return "keychain-locked";
  if (code === 44) return "keychain-missing";
  if (code === 36 || code === 51) return "keychain-locked";
  return "error";
}

const DUPLICATE_ITEM = /-25299\b|already exists/i;

/** A failure as a Refusal or a plain error. Never carries stderr or stdout, which `security -i` may echo. */
function failure(verb: string, code: number, stderr: string): Error {
  const kind = classifySecurityFailure(code, stderr);
  if (kind === "keychain-locked") return new Refusal("keychain-locked", `${verb}: the keychain is locked`);
  if (kind === "keychain-missing") return new Refusal("keychain-missing", `${verb}: no such item`);
  return new Error(`${verb}: security exited ${code}`);
}

/** A Keychain that reads with `security find-generic-password -w` and writes through `security -i` on stdin with -X hex. */
export function macosKeychain(opts: MacosKeychainOptions): Keychain {
  if (opts.securityPath !== "/usr/bin/security") throw new Error("macosKeychain: securityPath must be /usr/bin/security");
  assertAbsolute(opts.keychainPath, "the keychain path");
  return {
    async read(item) {
      const result = await opts.run(readArgv(opts, item), { timeoutMs: SECURITY_TIMEOUT_MS });
      if (result.code !== 0) {
        wipe(result.stdout);
        throw failure("read", result.code, result.stderr);
      }
      // -w prints the value and one newline; strip exactly that one, so a value ending in 0x0a survives.
      const out = result.stdout;
      const end = out.length > 0 && out[out.length - 1] === 0x0a ? out.length - 1 : out.length;
      const value = out.slice(0, end);
      wipe(out);
      return value;
    },
    async write(item, secret) {
      const stdin = writeCommand(opts, item, secret);
      try {
        const result = await opts.run([opts.securityPath, "-i"], { stdin, timeoutMs: SECURITY_TIMEOUT_MS });
        wipe(result.stdout);
        if (result.code !== 0) {
          if (DUPLICATE_ITEM.test(result.stderr)) throw new Refusal("invalid-request", "write: the item already exists");
          throw failure("write", result.code, result.stderr);
        }
      } finally {
        wipe(stdin);
      }
    },
    async has(item) {
      const result = await opts.run(hasArgv(opts, item), { timeoutMs: SECURITY_TIMEOUT_MS });
      wipe(result.stdout);
      if (result.code === 0) return true;
      const err = failure("has", result.code, result.stderr);
      if (err instanceof Refusal && err.code === "keychain-missing") return false;
      throw err;
    },
  };
}
