// The macOS Keychain behind the Keychain interface (types.ts). Only the
// signer and citizen-birth hold one. Secrets cross the process boundary on a
// pipe, never in argv or env (runtimes-and-host.md 3.3), and a locked
// keychain after a reboot is a normal, fail-closed state (3.4).
import type { CommandRunner, Keychain, KeychainItemName } from "../types.ts";

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

/** The generic-password account for an item, e.g. "citizen/glossame/op-seed"; the name, never the value. */
export function itemAccount(item: KeychainItemName): string {
  throw new Error("unimplemented");
}

/** A Keychain that reads with `security find-generic-password -w` and writes through `security -i` on stdin with -X hex. */
export function macosKeychain(opts: MacosKeychainOptions): Keychain {
  throw new Error("unimplemented");
}

/** The argv for reading one item; it carries the item's name and keychain path, never a secret. */
export function readArgv(opts: Pick<MacosKeychainOptions, "keychainPath" | "service" | "securityPath">, item: KeychainItemName): string[] {
  throw new Error("unimplemented");
}

/** The stdin command line for writing one item via `security -i`; the secret travels here as hex, never in argv. */
export function writeCommand(opts: Pick<MacosKeychainOptions, "keychainPath" | "service" | "trustedApp">, item: KeychainItemName, secret: Uint8Array): Uint8Array {
  throw new Error("unimplemented");
}

/** Map a `security` exit and stderr to a Refusal: -25308 and -25293 mean locked, -25300 means missing. */
export function classifySecurityFailure(code: number, stderr: string): "keychain-locked" | "keychain-missing" | "error" {
  throw new Error("unimplemented");
}
