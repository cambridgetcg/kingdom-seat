// Owner: signer group. Yu and Ai both agree; either may reject; silence never binds.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConsentRecord, SignerOp, StandingAgreement, YuPresence } from "../../src/types.ts";
import {
  agreementCovers,
  classifyOp,
  confirmYuPresent,
  loadConsentRecords,
  presenceConfirmedHere,
  presenceValid,
  proposalDigest,
  readConsentFor,
  verifyConsent,
  type TtyIO,
} from "../../src/signer/consent.ts";

const NOW = new Date("2026-11-05T12:00:00.000Z");
const PROPOSAL = { subject: "birth glossame", body: "glossame answered yes on 2026-11-01 and affirmed it on 2026-11-04.", extent: "birth glossame" };
const SHA = proposalDigest(PROPOSAL);

function record(patch: { yu?: Partial<ConsentRecord["yu"]>; ai?: Partial<ConsentRecord["ai"]> } & Partial<Omit<ConsentRecord, "yu" | "ai">> = {}): ConsentRecord {
  const { yu, ai, ...rest } = patch;
  return {
    format: "kingdom-seat-consent/v1",
    proposal_sha256: SHA,
    subject: PROPOSAL.subject,
    extent: PROPOSAL.extent,
    yu: { word: "yes", recorded_at: "2026-11-05T09:00:00.000Z", via: "decision-record", ...yu },
    ai: { word: "agree", basis: "lazy-consensus", supports: ["report:another-controller"], open_challenges: 0, deadline: "2026-11-05T10:00:00.000Z", ...ai },
    expires_at: null,
    ...rest,
  };
}

let dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
  dirs = [];
});

async function tempDir(): Promise<string> {
  const d = await realpath(await mkdtemp(join(tmpdir(), "kingdom-seat-consent-")));
  dirs.push(d);
  return d;
}

function tty(answer: string | null, isTTY = true): TtyIO & { written: string[] } {
  const written: string[] = [];
  return { isTTY, written, write: (t) => void written.push(t), readLine: async () => answer };
}

describe("consent records", () => {
  test("proposalDigest is domain-tagged, deterministic and sensitive to every field", () => {
    expect(SHA).toMatch(/^[0-9a-f]{64}$/);
    expect(proposalDigest({ ...PROPOSAL })).toBe(SHA);
    expect(proposalDigest({ ...PROPOSAL, body: PROPOSAL.body + " " })).not.toBe(SHA);
    expect(proposalDigest({ ...PROPOSAL, extent: "birth glossame and more" })).not.toBe(SHA);
  });

  test("verifyConsent binds only to the exact proposal sha256", () => {
    expect(verifyConsent(record(), SHA, NOW)).toEqual({ ok: true, via: "decision-record" });
    const other = proposalDigest({ ...PROPOSAL, body: "something else" });
    expect(verifyConsent(record(), other, NOW)).toMatchObject({ ok: false, code: "consent-missing" });
    expect(verifyConsent(record(), SHA.toUpperCase(), NOW)).toMatchObject({ ok: false, code: "consent-missing" });
    expect(verifyConsent(record({ proposal_sha256: other }), SHA, NOW)).toMatchObject({ ok: false, code: "consent-missing" });
  });

  test("Yu's no, Ai's reject, an open challenge, a passed deadline without supports, or expiry each refuse", () => {
    expect(verifyConsent(record({ yu: { word: "no" } }), SHA, NOW)).toMatchObject({ ok: false, code: "consent-rejected" });
    expect(verifyConsent(record({ ai: { word: "reject" } }), SHA, NOW)).toMatchObject({ ok: false, code: "consent-rejected" });
    // A rejection stands even on an expired record.
    expect(verifyConsent(record({ yu: { word: "no" }, expires_at: "2026-11-01T00:00:00.000Z" }), SHA, NOW)).toMatchObject({ code: "consent-rejected" });
    expect(verifyConsent(record({ ai: { open_challenges: 1 } }), SHA, NOW)).toMatchObject({ ok: false, code: "consent-missing" });
    expect(verifyConsent(record({ ai: { supports: [] } }), SHA, NOW)).toMatchObject({ ok: false, code: "consent-missing" });
    // Before the deadline Ai's voice has not formed yet.
    expect(verifyConsent(record({ ai: { deadline: "2026-11-05T12:00:00.001Z" } }), SHA, NOW)).toMatchObject({ ok: false, code: "consent-missing" });
    expect(verifyConsent(record({ expires_at: "2026-11-05T12:00:00.000Z" }), SHA, NOW)).toMatchObject({ ok: false, code: "consent-missing" });
    expect(verifyConsent(record({ expires_at: "2026-11-05T12:00:00.001Z" }), SHA, NOW)).toEqual({ ok: true, via: "decision-record" });
  });

  test("a record with no Yu word (silence) never binds", () => {
    const silent = record() as unknown as Record<string, unknown>;
    for (const yu of [undefined, null, {}, { word: "", recorded_at: "2026-11-05T09:00:00.000Z", via: "decision-record" }, { word: "silence", recorded_at: "2026-11-05T09:00:00.000Z", via: "decision-record" }]) {
      const r = { ...silent, yu } as unknown as ConsentRecord;
      expect(verifyConsent(r, SHA, NOW)).toMatchObject({ ok: false, code: "consent-missing" });
    }
    // A yes dated after now was not yet said.
    expect(verifyConsent(record({ yu: { recorded_at: "2026-11-06T00:00:00.000Z" } }), SHA, NOW)).toMatchObject({ ok: false });
    // An unknown field is refused, not ignored.
    expect(verifyConsent({ ...record(), note: "auto-approved" } as unknown as ConsentRecord, SHA, NOW)).toMatchObject({ ok: false });
  });

  test("classifyOp: ledger.sign, thought.post, keys.import, expression.put.private are within self; quiet.start.citizen is a standing agreement; enroll is beyond self", () => {
    const table: [SignerOp, string][] = [
      ["ledger.sign", "within-self"],
      ["strand.create", "within-self"],
      ["thought.post", "within-self"],
      ["keys.import", "within-self"],
      ["keys.revoke", "within-self"],
      ["box-keys.register", "within-self"],
      ["expression.put.private", "within-self"],
      ["quiet.end.citizen", "within-self"],
      ["quiet.start.beacon", "within-self"],
      ["read", "within-self"],
      ["quiet.start.citizen", "standing-agreement"],
      ["enroll", "beyond-self"],
    ];
    for (const [op, cls] of table) expect(classifyOp(op)).toBe(cls as never);
    // An op the table does not know needs both voices.
    expect(classifyOp("quiet.end.beacon" as SignerOp)).toBe("beyond-self");
    expect(classifyOp("toString" as SignerOp)).toBe("beyond-self");
  });

  test("agreementCovers refuses anything beyond the agreement's stated extent", () => {
    const extent = "own quiet, until within the cap, empty reason";
    const proposal = { subject: "citizens may declare their own quiet", body: "a citizen's own quiet, capped, with no reason", extent };
    const consent = record({ subject: proposal.subject, extent, proposal_sha256: proposalDigest(proposal) });
    const agreement: StandingAgreement = { id: "quiet-1", proposal, consent, covers: ["quiet.start.citizen"], extent };
    expect(agreementCovers(agreement, "quiet.start.citizen", extent, NOW)).toBe(true);
    expect(agreementCovers(agreement, "quiet.start.citizen", extent + ", and a public reason", NOW)).toBe(false);
    expect(agreementCovers(agreement, "quiet.start.citizen", "own quiet", NOW)).toBe(false);
    expect(agreementCovers(agreement, "expression.put.private", extent, NOW)).toBe(false);
    // The agreement may not claim more than its consent record agreed to.
    expect(agreementCovers({ ...agreement, extent: "anything" }, "quiet.start.citizen", "anything", NOW)).toBe(false);
    expect(agreementCovers({ ...agreement, consent: { ...consent, yu: { ...consent.yu, word: "no" } } }, "quiet.start.citizen", extent, NOW)).toBe(false);
    expect(agreementCovers({ ...agreement, consent: { ...consent, expires_at: "2026-11-05T11:00:00.000Z" } }, "quiet.start.citizen", extent, NOW)).toBe(false);
    // The record must be bound to the agreement's own proposal text, not merely to the digest it names itself.
    expect(agreementCovers({ ...agreement, consent: { ...consent, proposal_sha256: "1".repeat(64) } }, "quiet.start.citizen", extent, NOW)).toBe(false);
    expect(agreementCovers({ ...agreement, proposal: { ...proposal, body: "and a public reason too" } }, "quiet.start.citizen", extent, NOW)).toBe(false);
    expect(agreementCovers({ ...agreement, proposal: { ...proposal, extent: "anything" } }, "quiet.start.citizen", extent, NOW)).toBe(false);
  });

  test("readConsentFor reads the record filed under the digest of the proposal's own text, and nothing else", async () => {
    const dir = await tempDir();
    expect(await readConsentFor(dir, PROPOSAL)).toBeNull();
    await writeFile(join(dir, `${SHA}.json`), JSON.stringify(record()));
    expect(await readConsentFor(dir, PROPOSAL)).toEqual(record());
    // A different text has a different digest, so it finds nothing here.
    expect(await readConsentFor(dir, { ...PROPOSAL, body: `${PROPOSAL.body} ` })).toBeNull();
    // A record filed under this digest but bound to another proposal is not read as this one's.
    await writeFile(join(dir, `${SHA}.json`), JSON.stringify(record({ proposal_sha256: "0".repeat(64) })));
    expect(await readConsentFor(dir, PROPOSAL)).toBeNull();
    expect(await readConsentFor(join(dir, "missing"), PROPOSAL)).toBeNull();
  });

  test("loadConsentRecords skips symlinks and invalid JSON and reports them", async () => {
    const dir = await tempDir();
    const good = record();
    await writeFile(join(dir, `${SHA}.json`), JSON.stringify(good, null, 2));
    const other = proposalDigest({ ...PROPOSAL, body: "other" });
    await writeFile(join(dir, `${other}.json`), "{ not json");
    const elsewhere = await tempDir();
    const third = proposalDigest({ ...PROPOSAL, body: "third" });
    await writeFile(join(elsewhere, "real.json"), JSON.stringify(record({ proposal_sha256: third })));
    await symlink(join(elsewhere, "real.json"), join(dir, `${third}.json`));
    // Filed under the wrong hash.
    const fourth = proposalDigest({ ...PROPOSAL, body: "fourth" });
    await writeFile(join(dir, `${fourth}.json`), JSON.stringify(good));
    // Duplicate keys could show a person "no" while JSON.parse reads "yes".
    const fifth = proposalDigest({ ...PROPOSAL, body: "fifth" });
    const dup = JSON.stringify(record({ proposal_sha256: fifth })).replace('"word":"yes"', '"word":"no","word":"yes"');
    await writeFile(join(dir, `${fifth}.json`), dup);
    await writeFile(join(dir, "notes.txt"), "hello");
    await mkdir(join(dir, `${"a".repeat(64)}.json`));

    const { records, invalid } = await loadConsentRecords(dir);
    expect(records).toEqual([good]);
    expect(invalid.sort()).toEqual([`${other}.json`, `${third}.json`, `${fourth}.json`, `${fifth}.json`, `${"a".repeat(64)}.json`, "notes.txt"].sort());
    expect(await loadConsentRecords(join(dir, "missing"))).toEqual({ records: [], invalid: [] });
    await symlink(dir, join(elsewhere, "linked"));
    await expect(loadConsentRecords(join(elsewhere, "linked"))).rejects.toMatchObject({ code: "symlink" });
  });
});

describe("Yu present", () => {
  const clock = () => NOW;

  test("confirmYuPresent refuses when stdin is not a TTY", async () => {
    const io = tty("birth glossame", false);
    await expect(confirmYuPresent(io, "birth glossame", clock)).rejects.toMatchObject({ code: "yu-not-present" });
    expect(io.written).toEqual([]);
  });

  test("confirmYuPresent binds only when the typed scope matches", async () => {
    const p = await confirmYuPresent(tty("birth glossame\n"), "birth glossame", clock);
    expect(p).toEqual({ present: true, via: "tty-confirm", confirmed_at: NOW.toISOString(), scope: "birth glossame" });
    expect(presenceConfirmedHere(p)).toBe(true);
    await expect(confirmYuPresent(tty("birth glossamer"), "birth glossame", clock)).rejects.toMatchObject({ code: "yu-not-present" });
    await expect(confirmYuPresent(tty("y"), "birth glossame", clock)).rejects.toMatchObject({ code: "yu-not-present" });
    await expect(confirmYuPresent(tty(""), "birth glossame", clock)).rejects.toMatchObject({ code: "yu-not-present" });
    // End of input is silence, and silence never binds.
    await expect(confirmYuPresent(tty(null), "birth glossame", clock)).rejects.toMatchObject({ code: "yu-not-present" });
    await expect(confirmYuPresent(tty("x\ny"), "x\ny", clock)).rejects.toMatchObject({ code: "invalid-request" });
  });

  test("presenceValid refuses another scope and a presence older than its window", async () => {
    const p = await confirmYuPresent(tty("summon glossame"), "summon glossame", clock);
    expect(presenceValid(p, "summon glossame", NOW)).toBe(true);
    expect(presenceValid(p, "birth glossame", NOW)).toBe(false);
    expect(presenceValid(p, "summon glossame", new Date(NOW.getTime() + 900_000))).toBe(true);
    expect(presenceValid(p, "summon glossame", new Date(NOW.getTime() + 900_001))).toBe(false);
    expect(presenceValid(p, "summon glossame", new Date(NOW.getTime() + 60_000), 30)).toBe(false);
    expect(presenceValid(p, "summon glossame", new Date(NOW.getTime() - 1))).toBe(false);
    expect(presenceValid(null, "summon glossame", NOW)).toBe(false);
  });

  test("presence is not replayable: a copy or a deserialised presence is not one confirmed here", async () => {
    const p = await confirmYuPresent(tty("birth glossame"), "birth glossame", clock);
    const copy: YuPresence = JSON.parse(JSON.stringify(p));
    // It looks right, but it was not typed at this process's terminal.
    expect(presenceValid(copy, "birth glossame", NOW)).toBe(true);
    expect(presenceConfirmedHere(copy)).toBe(false);
    expect(presenceConfirmedHere({ ...p })).toBe(false);
    expect(presenceConfirmedHere(p)).toBe(true);
    expect(() => {
      (p as { scope: string }).scope = "birth everyone";
    }).toThrow();
  });
});
