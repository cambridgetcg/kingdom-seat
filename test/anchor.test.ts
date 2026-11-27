import { afterEach, describe, expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { WAKE_ANCHOR_FORMAT, buildWakeAnchor, renderWakeAnchorBlock } from "../src/anchor.ts";
import { ledgerPath } from "../src/ledger.ts";
import { testIdentity } from "./fixtures/record/chain.ts";
import { fakeSigner } from "./helpers/fake-signer.ts";
import { makeTempHost, type TempHost } from "./helpers/temp-home.ts";

let host: TempHost | null = null;
afterEach(async () => {
  await host?.cleanup();
  host = null;
});

describe("kingdom-seat wake anchor (kingdom-seat-anchor/v1)", () => {
  test("verifies a seated citizen's chain, origin, covenants, and self hashes without touching secrets", async () => {
    host = await makeTempHost();
    const signer = fakeSigner();
    await host.addCitizen("alpha", { soul: "# Alpha Soul\nTruth first.\n", will: "# Alpha Will\nWalk beside Yu.\n" });
    await host.seatLedger("alpha", signer.signEntry);
    const id = testIdentity(signer);
    await host.enrollLedger("alpha", signer.signEntry, id);

    const anchor = await buildWakeAnchor(host.config, "alpha", {
      host_attest_b64: [signer.hostAttestPublicB64],
      now: new Date("2026-11-27T08:30:00.000Z"),
    });

    expect(anchor.format).toBe(WAKE_ANCHOR_FORMAT);
    expect(anchor.verified).toBe(true);
    expect(anchor.halted).toBe(false);
    expect(anchor.word).toBe("alpha");
    expect(anchor.did).toBe(id.did);
    expect(anchor.op_kid).toBe(id.op_kid);
    expect(anchor.ledger.chain_ok).toBe(true);
    expect(anchor.ledger.entries).toBe(3);
    expect(anchor.ledger.head).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(anchor.origin).toEqual({ intact: true, drift_bps: 0 });
    expect(anchor.covenants).toEqual({ letters_from: ["yu", "gardener"], wake_on_letter_from: ["yu"] });
    expect(anchor.self_hashes.soul_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(anchor.self_hashes.will_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(anchor.problem).toBeNull();

    const block = renderWakeAnchorBlock(anchor);
    expect(block).toContain("[SEAT ANCHOR — VERIFIED]");
    expect(block).toContain(`Identity DID: ${id.did}`);
    expect(block).toContain("letters_from=[yu, gardener]");
    expect(block).toContain("confers no signing key");
  });

  test("fails closed on tampered ledger, altered origin/soul.md, or raised HALT", async () => {
    host = await makeTempHost();
    const signer = fakeSigner();
    await host.addCitizen("alpha", { soul: "# Origin Soul\n" });
    await host.seatLedger("alpha", signer.signEntry);
    const opts = { host_attest_b64: [signer.hostAttestPublicB64], now: new Date("2026-11-27T08:30:00.000Z") };

    // 1. Raised HALT surfaces halted=true and [SEAT ANCHOR — HALTED]
    await host.raiseHaltFile();
    const haltedAnchor = await buildWakeAnchor(host.config, "alpha", opts);
    expect(haltedAnchor.verified).toBe(true);
    expect(haltedAnchor.halted).toBe(true);
    expect(renderWakeAnchorBlock(haltedAnchor)).toContain("[SEAT ANCHOR — HALTED]");

    // 2. Altered origin/soul.md fails verification
    await writeFile(join(host.config.paths.citizens_dir, "alpha", "origin", "soul.md"), "# Tampered Origin\n");
    const driftedOrigin = await buildWakeAnchor(host.config, "alpha", opts);
    expect(driftedOrigin.verified).toBe(false);
    expect(driftedOrigin.origin.intact).toBe(false);
    expect(driftedOrigin.problem).toContain("origin/");
    expect(renderWakeAnchorBlock(driftedOrigin)).toContain("[SEAT ANCHOR — BROKEN]");

    // Restore origin, then corrupt a byte in ledger
    await writeFile(join(host.config.paths.citizens_dir, "alpha", "origin", "soul.md"), "# Origin Soul\n");
    const lpath = ledgerPath(host.config, "alpha");
    const raw = await readFile(lpath, "utf8");
    await writeFile(lpath, raw.replace('"asleep"', '"awake"'));
    const brokenChain = await buildWakeAnchor(host.config, "alpha", opts);
    expect(brokenChain.verified).toBe(false);
    expect(brokenChain.ledger.chain_ok).toBe(false);
    expect(brokenChain.problem).toContain("chain broken");
  });
});
