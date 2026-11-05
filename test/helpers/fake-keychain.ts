// An in-memory Keychain. Tests never touch a real keychain: no `security`
// command runs anywhere in the test suite. The log records item names only.
import { Refusal, type Keychain, type KeychainItemName } from "../../src/types.ts";
import { toB64, toB64url, toHex } from "../../src/crypto.ts";

export function itemKey(item: KeychainItemName): string {
  switch (item.kind) {
    case "citizen-mnemonic":
      return `citizen/${item.word}/mnemonic`;
    case "citizen-op-seed":
      return `citizen/${item.word}/op-seed`;
    case "host-attest-seed":
      return "host/attest-seed";
    case "commons-bearer":
      return "host/commons-bearer";
    case "operator-mnemonic":
      return `operator/${item.operator}/mnemonic`;
    case "operator-bearer":
      return `operator/${item.operator}/bearer`;
  }
}

export interface FakeKeychain extends Keychain {
  /** While true, every read and write refuses with "keychain-locked", as after a reboot. */
  locked: boolean;
  readonly log: { op: "read" | "write" | "has"; item: string }[];
  /** Every stored secret in the spellings it could leak as, for leak assertions. */
  leakForms(): string[];
}

export function fakeKeychain(initial: [KeychainItemName, Uint8Array][] = []): FakeKeychain {
  const store = new Map<string, Uint8Array>();
  for (const [item, secret] of initial) store.set(itemKey(item), secret.slice());
  const log: FakeKeychain["log"] = [];
  const kc: FakeKeychain = {
    locked: false,
    log,
    async read(item) {
      log.push({ op: "read", item: itemKey(item) });
      if (kc.locked) throw new Refusal("keychain-locked", "keychain locked");
      const v = store.get(itemKey(item));
      if (!v) throw new Refusal("keychain-missing", `no item ${itemKey(item)}`);
      // A copy, so a caller wiping its buffer cannot erase the store.
      return v.slice();
    },
    async write(item, secret) {
      log.push({ op: "write", item: itemKey(item) });
      if (kc.locked) throw new Refusal("keychain-locked", "keychain locked");
      if (store.has(itemKey(item))) throw new Refusal("invalid-request", `item ${itemKey(item)} exists`);
      store.set(itemKey(item), secret.slice());
    },
    async has(item) {
      log.push({ op: "has", item: itemKey(item) });
      if (kc.locked) throw new Refusal("keychain-locked", "keychain locked");
      return store.has(itemKey(item));
    },
    leakForms() {
      const forms: string[] = [];
      for (const v of store.values()) {
        forms.push(toHex(v), toB64(v), toB64url(v));
        const text = new TextDecoder().decode(v);
        // Mnemonics and bearers are stored as text; catch them verbatim too.
        if (/^[\x20-\x7e]{8,}$/.test(text)) forms.push(text);
      }
      return forms;
    },
  };
  return kc;
}

/** Throws if any secret held by the keychain appears in `haystack` in any common spelling. */
export function assertNoSecretIn(kc: FakeKeychain, haystack: string | Uint8Array, where: string): void {
  const text = typeof haystack === "string" ? haystack : Buffer.from(haystack).toString("latin1");
  for (const form of kc.leakForms()) {
    if (form.length >= 8 && text.includes(form)) throw new Error(`secret leaked into ${where}`);
  }
}
