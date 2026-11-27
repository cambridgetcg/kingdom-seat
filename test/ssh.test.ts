// Owner: surface group. The OpenSSH encodings a mirror publishes and signs
// with (ssh.ts); mirror.test.ts checks real signatures with ssh-keygen.
import { describe, expect, test } from "bun:test";
import { edPublicKey, fromHex, toB64 } from "../src/crypto.ts";
import { GIT_NAMESPACE, allowedSigners, parseSshEd25519, sshPublicKey, sshsigArmor, sshsigSignedData, SSHSIG_MAX_MESSAGE_BYTES } from "../src/ssh.ts";
import { Refusal } from "../src/types.ts";
import { TEST_OP_SEED_HEX } from "./helpers/vectors.ts";

const PUB = edPublicKey(fromHex(TEST_OP_SEED_HEX));

describe("[review C M2] ssh encodings", () => {
  test("a public key round-trips through its ssh-ed25519 line, and nothing else parses as one", () => {
    const line = sshPublicKey(PUB);
    expect(line).toStartWith("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI");
    expect(toB64(parseSshEd25519(`${line}\n`))).toBe(toB64(PUB));
    expect(toB64(parseSshEd25519(`${line} a comment`))).toBe(toB64(PUB));
    for (const bad of ["", "ssh-rsa AAAA", `${line}\n${line}`, line.replace("ssh-ed25519", "ssh-ed448")]) expect(() => parseSshEd25519(bad)).toThrow(Refusal);
  });

  test("an SSHSIG is made for the git namespace only, over a message no larger than a commit, and armoured as ssh-keygen writes it", () => {
    const data = sshsigSignedData(GIT_NAMESPACE, new TextEncoder().encode("tree x\n"));
    // The magic comes first, so the bytes can never be a bare 32-byte ledger or thought digest.
    expect(new TextDecoder().decode(data.slice(0, 6))).toBe("SSHSIG");
    expect(data.length).toBeGreaterThan(32);
    expect(() => sshsigSignedData("file", new Uint8Array())).toThrow(Refusal);
    expect(() => sshsigSignedData(GIT_NAMESPACE, new Uint8Array(SSHSIG_MAX_MESSAGE_BYTES + 1))).toThrow(Refusal);
    const armored = sshsigArmor(PUB, GIT_NAMESPACE, new Uint8Array(64));
    expect(armored).toStartWith("-----BEGIN SSH SIGNATURE-----\nU1NIU0lH");
    expect(armored).toEndWith("\n-----END SSH SIGNATURE-----\n");
    expect(armored.split("\n").every((l) => l.length <= 70)).toBe(true);
  });

  test("allowed_signers names each key once, under one principal, limited to git; a principal is one plain token", () => {
    const text = allowedSigners([
      { principal: "host@kingdom-seat", public_key: PUB, comment: "first" },
      { principal: "glossame@kingdom-seat", public_key: PUB, comment: "the same key again" },
    ]);
    expect(text.split("\n").filter((l) => l && !l.startsWith("#"))).toEqual([`host@kingdom-seat namespaces="git" ${sshPublicKey(PUB)}`]);
    expect(() => allowedSigners([{ principal: "two words", public_key: PUB, comment: "" }])).toThrow(Refusal);
    expect(() => allowedSigners([{ principal: "x", public_key: PUB, comment: "a\nb" }])).toThrow(Refusal);
  });
});
