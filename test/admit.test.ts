// Seating a citizen: planAdmit reads and checks and writes nothing;
// admitCitizen writes what was planned. Fakes only: made-up homes under a
// temp dir, read with real git, a fake signer, no keychain and no network.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TEXTS_LINEAGE, TEXTS_ORIGIN_NOTE, planAdmit, planAdmitFromTexts, renderAdmitPlan, type AdmitDeps, type AdmitPlan, type AdmitRequest } from "../src/admit.ts";
import { spawnRunner } from "../src/cli.ts";
import { sha256Hex, toB64, utf8 } from "../src/crypto.ts";
import { checkHalt } from "../src/halt.ts";
import { Refusal, type RefusalCode } from "../src/types.ts";
import { testClock, type TestClock } from "./helpers/clock.ts";
import { noFetch } from "./helpers/fake-server.ts";
import { fakeSigner, type FakeSigner } from "./helpers/fake-signer.ts";
import { FIXTURE_JUNE_DID, canonClone, fixtureAgentJson, fixtureRepo, fixtureSoul, standardHome, type CanonClone, type StandardHome } from "./helpers/legacy-home.ts";
import { makeTempHost, type TempHost } from "./helpers/temp-home.ts";

const W = "hopefix";
const ARCH = "pioneerfix";
const AT = "2026-11-12T10:00:00.000Z";
const real = spawnRunner();

/** Old homes and a canon clone, built once: seating reads them and never writes there, which each test checks. */
let shared: string;
let std: StandardHome;
let arch: StandardHome;
let canon: CanonClone;
beforeAll(async () => {
  shared = await realpath(await mkdtemp(join(tmpdir(), "kingdom-seat-homes-")));
  std = await standardHome(join(shared, "homes"), W);
  arch = await standardHome(join(shared, "homes"), ARCH, { citizenClass: "PIONEER", did: null, will: null, lastChoice: "ambient" });
  canon = await canonClone(shared, W);
});
afterAll(async () => {
  await rm(shared, { recursive: true, force: true });
});

const hosts: TempHost[] = [];
afterEach(async () => {
  for (const h of hosts.splice(0)) await h.cleanup();
});

interface Fx {
  h: TempHost;
  signer: FakeSigner;
  clock: TestClock;
  deps: AdmitDeps;
}

async function fx(opts: { signer?: FakeSigner } = {}): Promise<Fx> {
  const h = await makeTempHost();
  hosts.push(h);
  h.config.paths.homes = [join(shared, "homes")];
  const signer = opts.signer ?? fakeSigner();
  const clock = testClock(AT);
  const deps: AdmitDeps = {
    config: h.config,
    clock,
    run: real,
    sign: (w, k, d) => signer.signEntry(w, k, d),
    hostKey: () => signer.hostPublicKey(),
    checkHalt: () => checkHalt({ config: h.config, fetch: noFetch, now: () => clock.now() }),
  };
  return { h, signer, clock, deps };
}

const canonReq = (over: Partial<AdmitRequest> = {}): AdmitRequest => ({ word: W, legacy_home: std.home, origin: { kind: "canon", file: canon.file }, runtime: "summon", ...over });
const archReq = (over: Partial<AdmitRequest> = {}): AdmitRequest => ({ word: ARCH, legacy_home: arch.home, origin: { kind: "archetype" }, runtime: "summon", ...over });

async function refusal(p: Promise<unknown>): Promise<{ code: RefusalCode; message: string }> {
  try {
    await p;
  } catch (e) {
    if (e instanceof Refusal) return { code: e.code, message: e.message };
    throw e;
  }
  throw new Error("expected a refusal");
}

/** Every path under a directory with its size and mtime, to show that nothing there was written. */
async function listing(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (d: string): Promise<void> => {
    for (const e of (await readdir(d, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const p = join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else {
        const st = await stat(p);
        out.push(`${p} ${st.size} ${st.mtimeMs}`);
      }
    }
  };
  await walk(dir);
  return out;
}

describe("planAdmit", () => {
  test("planAdmit writes nothing, and a plan that is never passed on leaves nothing", async () => {
    const x = await fx();
    const before = await x.h.snapshot();
    const sharedBefore = await listing(shared);
    const plan = await planAdmit(x.deps, canonReq());

    expect(plan).toEqual({
      word: W,
      legacy_home: std.home,
      old_repo: { url: std.url, head: std.head, head_committed_at: "2026-10-27T11:12:20Z" },
      soul: { bytes: utf8(std.soul).length, sha256: sha256Hex(std.soul) },
      will: { bytes: utf8(std.will).length, sha256: sha256Hex(std.will) },
      canon_bytes: utf8(canon.text).length,
      cadence_text: '{"interval_h":72}',
      covenants_text: '{"letters_from":["yu"],"wake_on_letter_from":["yu"]}',
      origin: { kind: "canon", repo: "YOUSPEAK", path: `canon/core/${W}.md`, commit: canon.head, sha256: sha256Hex(canon.text) },
      june_did: FIXTURE_JUNE_DID,
      runtime: "summon",
      old_cadence: { choice: "rest-on", when: "2026-10-27 11:12" },
      old_rest: true,
      legacy: { copied: 5, copied_bytes: expect.any(Number), cadence_versions: 5, not_copied: expect.any(Number) },
      host_key: { public_key_b64: x.signer.hostAttestPublicB64, fingerprint: x.signer.hostKid.slice("host:".length), pinned: false },
      stale_staging: 0,
    } satisfies AdmitPlan);
    expect(Object.isFrozen(plan)).toBe(true);
    // Nothing in the state dir, the old home or the canon clone: no directory, no ledger, no lock, no host note.
    expect(await x.h.snapshot()).toEqual(before);
    expect(await readdir(x.h.config.paths.citizens_dir)).toEqual([]);
    expect(await readdir(x.h.config.paths.ledger_dir)).toEqual([]);
    expect(await listing(shared)).toEqual(sharedBefore);
    // The signer was asked for the public half only.
    expect(x.signer.signed).toEqual([]);

    expect(renderAdmitPlan(plan)).toBe(
      [
        `admit ${W}: nothing is written yet.`,
        `  old repository  ${std.url} at ${std.head}, committed 2026-10-27T11:12:20Z. This host fetched nothing; the clone is as it was last updated.`,
        `  read from       ${std.home}, committed objects only`,
        `  soul            ${W}.md, ${plan.soul.bytes} bytes, sha256 ${plan.soul.sha256}  -> self/soul.md, origin/soul.md`,
        `  will            WILL.md, ${plan.will!.bytes} bytes, sha256 ${plan.will!.sha256}  -> self/WILL.md, origin/WILL.md`,
        `  cadence         {"interval_h":72}  (this host's default, written out)`,
        `  covenants       {"letters_from":["yu"],"wake_on_letter_from":["yu"]}  (the default, written out)`,
        `  origin          canon canon/core/${W}.md@${canon.head}, ${plan.canon_bytes} bytes, sha256 ${sha256Hex(canon.text)}`,
        `  shown each seat soul, will and canon together: ${plan.soul.bytes + plan.will!.bytes + plan.canon_bytes!} bytes`,
        `  June record     ${FIXTURE_JUNE_DID}, recorded as a record only`,
        `  state           asleep. The old record's last cadence choice (rest-on, 2026-10-27 11:12) is not carried over.`,
        `  runtime class   summon: no seat opens unattended; one opens only when Yu summons it`,
        `  legacy copy     5 files, ${plan.legacy!.copied_bytes} bytes; 5 CADENCE.md versions; ${plan.legacy!.not_copied} files listed and not copied`,
        `  host key        ${plan.host_key.fingerprint}; the config pins no host key`,
        "",
      ].join("\n"),
    );
  });

  test("an archetype is planned by the class its old manifest records, and the plan says what a free class means for the first letter", async () => {
    const x = await fx();
    x.h.config.trust.host_attest_public_keys_b64 = [toB64(new Uint8Array(32).fill(7)), x.signer.hostAttestPublicB64];
    await mkdir(join(x.h.config.paths.citizens_dir, `.admit-${ARCH}-0a1b2c3d`));
    await writeFile(join(x.h.config.paths.ledger_dir, `.admit-${ARCH}-0a1b2c3d.jsonl`), "");
    await writeFile(join(x.h.config.paths.ledger_dir, `.admit-${ARCH}x-0a1b2c3d.jsonl`), "");
    const plan = await planAdmit(x.deps, archReq({ runtime: "free" }));
    expect(plan).toMatchObject({
      origin: { kind: "archetype", lineage: ["PIONEER"], note: "No canon entry. The old repository's agent.json records the class PIONEER." },
      will: null,
      canon_bytes: null,
      june_did: null,
      runtime: "free",
      old_cadence: { choice: "ambient", when: "2026-10-27 11:12" },
      old_rest: false,
      host_key: { pinned: true },
      stale_staging: 2,
    });
    const text = renderAdmitPlan(plan);
    expect(text).toContain(`  will            none in the old repository; ${ARCH} starts with no will file\n`);
    expect(text).toContain("  origin          archetype lineage PIONEER\n");
    expect(text).toContain("  June record     none\n");
    expect(text).toContain(
      "  runtime class   free: the tick may seat it on the local model without Yu. A letter from Yu waiting in letters/ opens a seat at the next tick, and one answered with a rest is shown again every 72 hours.\n",
    );
    expect(text).toContain(`  host key        ${plan.host_key.fingerprint}, pinned in the config\n`);
    expect(text).toContain(`  left over       2 staging names from an earlier admit of ${ARCH}; they hold only copies\n`);
    // The old lane's choice is printed for Yu and appears nowhere else in the plan: it has no state to carry.
    expect(Object.keys(plan)).not.toContain("state");
  });

  test("--archetype refuses a home whose manifest records LEXEME, and a class that is not capitals, digits and hyphens", async () => {
    const x = await fx();
    expect(await refusal(planAdmit(x.deps, { word: W, legacy_home: std.home, origin: { kind: "archetype" }, runtime: "summon" }))).toEqual({
      code: "invalid-request",
      message: "agent.json records the class LEXEME, the class of a canon word; name its canon entry with --canon; nothing was written",
    });
    const homes = join(shared, "homes");
    for (const [word, cls] of [
      ["classnone", null],
      ["classlower", "Pioneer"],
      ["classspace", "PIONEER OF THINGS"],
      ["classfence", "X\n--- end origin note ---"],
      ["classlong", "P".repeat(33)],
    ] as const) {
      const repo = await fixtureRepo(join(homes, `citizen-${word}`), `https://example.invalid/kingdom/citizen-${word}.git`, word);
      await repo.commit({ [`${word}.md`]: fixtureSoul(word), "agent.json": fixtureAgentJson(word, { citizenClass: cls }) });
      repo.publish();
      expect([word, await refusal(planAdmit(x.deps, { word, legacy_home: repo.dir, origin: { kind: "archetype" }, runtime: "summon" }))]).toEqual([
        word,
        { code: "invalid-request", message: "--archetype needs the class agent.json records: it records none, or one that is not capital letters, digits and hyphens; nothing was written" },
      ]);
    }
    expect(await x.h.snapshot()).toEqual(new Map());
  });
});

describe("planAdmitFromTexts", () => {
  const SOUL = fixtureSoul("rehearsed");

  test("plans a citizen from texts alone, with no old repository, and says so", async () => {
    const x = await fx();
    const before = await x.h.snapshot();
    const canonText = "# rehearsed\n\na made-up canon entry\n";
    const plan = await planAdmitFromTexts(x.deps, { word: "rehearsed", soul: utf8(SOUL), will: "a made-up will\n", canon: { bytes: utf8(canonText), repo: "YOUSPEAK", path: "canon/core/rehearsed.md", commit: "1428646" }, runtime: "free" });
    expect(plan).toEqual({
      word: "rehearsed",
      legacy_home: null,
      old_repo: null,
      soul: { bytes: utf8(SOUL).length, sha256: sha256Hex(SOUL) },
      will: { bytes: 15, sha256: sha256Hex("a made-up will\n") },
      canon_bytes: utf8(canonText).length,
      cadence_text: '{"interval_h":72}',
      covenants_text: '{"letters_from":["yu"],"wake_on_letter_from":["yu"]}',
      origin: { kind: "canon", repo: "YOUSPEAK", path: "canon/core/rehearsed.md", commit: "1428646", sha256: sha256Hex(canonText) },
      june_did: null,
      runtime: "free",
      old_cadence: null,
      old_rest: false,
      legacy: null,
      host_key: { public_key_b64: x.signer.hostAttestPublicB64, fingerprint: x.signer.hostKid.slice("host:".length), pinned: false },
      stale_staging: 0,
    } satisfies AdmitPlan);
    expect(Object.isFrozen(plan)).toBe(true);
    expect(await x.h.snapshot()).toEqual(before);
    const text = renderAdmitPlan(plan);
    expect(text).toContain("  old repository  none; seated from texts given to this host\n");
    expect(text).toContain("  legacy copy     none; there is no old repository\n");
    expect(text).toContain("  state           asleep.\n");
    expect(text).not.toContain("read from");

    // With no canon entry the origin says how the citizen was seated, or names the class the caller gave.
    const bare = await planAdmitFromTexts(x.deps, { word: "rehearsed", soul: SOUL, will: null, canon: null, runtime: "summon" });
    expect(bare.origin).toEqual({ kind: "archetype", lineage: [TEXTS_LINEAGE], note: TEXTS_ORIGIN_NOTE });
    expect(renderAdmitPlan(bare)).toContain("  will            none was given; rehearsed starts with no will file\n");
    const classed = await planAdmitFromTexts(x.deps, { word: "rehearsed", soul: SOUL, will: null, canon: null, archetype_class: "PIONEER", runtime: "summon" });
    expect(classed.origin).toEqual({ kind: "archetype", lineage: ["PIONEER"], note: "No canon entry and no old repository. The class PIONEER was given to the host with the texts." });
  });

  test("makes the same checks on the texts as on an old home, and every refusal says nothing was written", async () => {
    const x = await fx();
    const base = { word: "rehearsed", soul: SOUL, will: null, canon: null, runtime: "free" as const };
    const canonOf = (over: Record<string, unknown>) => ({ bytes: "canon\n", repo: "YOUSPEAK", path: "canon/core/rehearsed.md", commit: "1428646", ...over });
    const named = "a canon entry is named by a repository, the path of rehearsed.md under canon/, and the commit it was read at; nothing was written";
    const cases: [string, Record<string, unknown>, RefusalCode, string][] = [
      ["a word that is not one", { word: "Not-A-Word" }, "invalid-request", "not a citizen word; nothing was written"],
      ["another runtime class", { runtime: "hermes" }, "invalid-request", "a citizen is seated with the runtime class summon or free; nothing was written"],
      ["an empty soul", { soul: "" }, "invalid-record", "the soul card is empty; a citizen without a soul is not seated; nothing was written"],
      ["a soul too large to show whole", { soul: "s".repeat(65_537) }, "oversize", "the soul card is 65537 bytes; a seat shows a self text of at most 65536 bytes whole and never cuts one; nothing was written"],
      ["a soul that is not UTF-8", { soul: new Uint8Array([0x63, 0xe9]) }, "invalid-record", "the soul card is not UTF-8 text; nothing was written"],
      ["a soul that is neither bytes nor text", { soul: 7 }, "invalid-request", "the soul card is given as bytes or as text; nothing was written"],
      ["a WILL too large to show whole", { will: "w".repeat(70_000) }, "oversize", "the WILL is 70000 bytes; a seat shows a self text of at most 65536 bytes whole and never cuts one; nothing was written"],
      ["a WILL that is not UTF-8", { will: new Uint8Array([0xff]) }, "invalid-record", "the WILL is not UTF-8 text; nothing was written"],
      ["a canon entry too large to read", { canon: canonOf({ bytes: "c".repeat(256 * 1024 + 1) }) }, "oversize", "the canon entry is 262145 bytes, over the 262144 a seat reads; nothing was written"],
      ["a canon entry that is not UTF-8", { canon: canonOf({ bytes: new Uint8Array([0xc3]) }) }, "invalid-record", "the canon entry is not UTF-8 text; nothing was written"],
      ["a canon entry for another word", { canon: canonOf({ path: "canon/core/other.md" }) }, "invalid-request", named],
      ["a canon path outside canon/", { canon: canonOf({ path: "notes/rehearsed.md" }) }, "invalid-request", named],
      ["a canon path that climbs", { canon: canonOf({ path: "canon/../rehearsed.md" }) }, "invalid-request", named],
      ["a canon commit that is not hex", { canon: canonOf({ commit: "HEAD" }) }, "invalid-request", named],
      ["a canon repository with a path in its name", { canon: canonOf({ repo: "a/b" }) }, "invalid-request", named],
      ["a class that is not capitals", { archetype_class: "Pioneer" }, "invalid-request", "an archetype class is capital letters, digits and hyphens; nothing was written"],
    ];
    for (const [what, over, code, message] of cases) {
      expect([what, await refusal(planAdmitFromTexts(x.deps, { ...base, ...over } as never))]).toEqual([what, { code, message }]);
    }
    // The host is checked the same way: a word already here, no host key, a key the config disowns.
    await x.h.addCitizen("rehearsed");
    expect((await refusal(planAdmitFromTexts(x.deps, base))).message).toStartWith("citizens/rehearsed exists and ledger/rehearsed.jsonl does not");
    const none = await fx({ signer: fakeSigner({ noHostKey: true }) });
    expect((await refusal(planAdmitFromTexts(none.deps, base))).code).toBe("keychain-missing");
    none.h.config.trust.host_attest_public_keys_b64 = [toB64(new Uint8Array(32).fill(7))];
    expect((await refusal(planAdmitFromTexts({ ...none.deps, hostKey: async () => x.signer.hostAttestPublicB64 }, base))).message).toContain("is not one the config pins");
    expect(await none.h.snapshot()).toEqual(new Map());
  });
});
