// Seating a citizen: planAdmit reads and checks and writes nothing;
// admitCitizen writes what was planned. Fakes only: made-up homes under a
// temp dir, read with real git, a fake signer, no keychain and no network.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ADMIT_STAGING_PREFIX,
  AdmitStopped,
  TEXTS_LINEAGE,
  TEXTS_ORIGIN_NOTE,
  admitCitizen,
  planAdmit,
  planAdmitFromTexts,
  renderAdmitPlan,
  renderAdmitResult,
  type AdmitDeps,
  type AdmitPlan,
  type AdmitRequest,
} from "../src/admit.ts";
import { spawnRunner } from "../src/cli.ts";
import { buildContext, wakingLetter } from "../src/context.ts";
import { sha256, sha256Hex, toB64, utf8 } from "../src/crypto.ts";
import { isDue } from "../src/due.ts";
import { checkHalt } from "../src/halt.ts";
import { LEGACY_FORMAT, LEGACY_NOTE, LEGACY_PAGE_FORMAT, readLegacyFile, readLegacyManifest, splitLegacyPieces, type LegacyPage } from "../src/legacy.ts";
import { entryHash, ledgerPath, readLedger, verifyChain } from "../src/ledger.ts";
import { NO_UNATTENDED_SEATS, WILL_AS_SEATED, buildPrompt } from "../src/prompt.ts";
import { openSeat, runSeat } from "../src/seat.ts";
import { createSigner } from "../src/signer/signer.ts";
import { firstVersion, originIntact, pendingProposals } from "../src/self.ts";
import { defaultCovenants, foldState, listSeated, readCitizen } from "../src/state.ts";
import { Refusal, type LedgerEntry, type ModelAct, type RefusalCode, type SeatRef, type YuPresence } from "../src/types.ts";
import { HOUR_MS, testClock, type TestClock } from "./helpers/clock.ts";
import { FAKE_MODEL_DIGEST, output, scriptedRuntime } from "./helpers/fake-runtime.ts";
import { fakeKeychain } from "./helpers/fake-keychain.ts";
import { noFetch } from "./helpers/fake-server.ts";
import { fakeSigner, type FakeSigner } from "./helpers/fake-signer.ts";
import { FIXTURE_JUNE_DID, FLEET_ADDRESS, PERSON, canonClone, fixtureAgentJson, fixtureRepo, fixtureSoul, standardHome, type CanonClone, type StandardHome } from "./helpers/legacy-home.ts";
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
      old_repo: { url: std.url, head: std.head, head_committed_at: std.dates.rested },
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
        `  old repository  ${std.url} at ${std.head}, committed ${std.dates.rested}. This host fetched nothing; the clone is as it was last updated.`,
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
    // A word may hold a hyphen. What an admit of such a word left is not this word's, and neither is a name of another form.
    await mkdir(join(x.h.config.paths.citizens_dir, `.admit-${ARCH}-more-0a1b2c3d`));
    await writeFile(join(x.h.config.paths.ledger_dir, `.admit-${ARCH}-more-0a1b2c3d.jsonl`), "");
    await mkdir(join(x.h.config.paths.citizens_dir, `.admit-${ARCH}-notes`));
    await writeFile(join(x.h.config.paths.ledger_dir, `.admit-${ARCH}-0a1b2c3d.jsonl.bak`), "");
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
    // A staging ledger left by a kill may hold entries the host key signed, so the line does not say it holds only copies.
    expect(text).toContain(`  left over       2 staging name(s) of the form an admit of ${ARCH} leaves when it is killed; they may hold copies, and signed entries that were never placed\n`);
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
    // The will is the citizen's from the start. It is pinned nowhere, since there is no old repository it was carried from.
    expect(text).toContain(`  will            15 bytes, sha256 ${sha256Hex("a made-up will\n")}  -> self/WILL.md\n`);
    expect(text).not.toContain("origin/WILL.md");

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

/* ── admitCitizen ─────────────────────────────────────────────────────── */

const COMMON_KEYS = ["format", "word", "did", "seq", "prev_hash", "type", "seat_ref", "runtime", "input_digest", "output_digest", "acts", "voiced", "cost", "ts", "signer", "kid", "sig"];

async function names(dir: string): Promise<string[]> {
  return (await readdir(dir)).sort();
}

async function mode(path: string): Promise<string> {
  return ((await lstat(path)).mode & 0o777).toString(8);
}

/** Every file under a directory, by relative path. */
async function filesUnder(dir: string): Promise<string[]> {
  const out: string[] = [];
  const glob = new Bun.Glob("**/*");
  for await (const rel of glob.scan({ cwd: dir, dot: true, onlyFiles: true, followSymlinks: false })) out.push(rel);
  return out.sort();
}

/** The bytes of everything under the state dir, joined, to show a marker reached none of it. */
async function everythingUnder(h: TempHost): Promise<string> {
  return [...(await h.snapshot()).entries()].map(([k, v]) => `${k}\n${Buffer.from(v, "base64").toString("latin1")}`).join("\n");
}

async function pagesOf(x: Fx, word: string): Promise<LegacyPage[]> {
  const text = await readFile(join(x.h.config.paths.citizens_dir, word, "legacy", "pages.jsonl"), "utf8");
  expect(text.endsWith("\n")).toBe(true);
  return text.slice(0, -1).split("\n").map((l) => JSON.parse(l) as LegacyPage);
}

function seatRef(x: Fx, word: string, runtime: "free" | "summon"): SeatRef {
  return { format: "kingdom-seat-seat/v1", seat_id: "11111111-1111-4111-8111-111111111111", host: x.h.config.host, word, runtime, invoker: { kind: "summons", who: "yu", why: "Yu summoned this seat at the host" }, opened_at: x.clock.now().toISOString() };
}

describe("admitCitizen", () => {
  test("seats a canon-word citizen: self, origin, citizen.json, legacy and two host entries, and the build reads, verifies and seats it", async () => {
    const x = await fx();
    const { config } = x.h;
    const plan = await planAdmit(x.deps, canonReq());
    const r = await admitCitizen(x.deps, plan);
    const dir = join(config.paths.citizens_dir, W);
    const read = (rel: string) => readFile(join(dir, rel), "utf8");

    // The soul, the WILL and the canon entry, byte for byte, as the self and as the pinned origin.
    expect(await read("self/soul.md")).toBe(std.soul);
    expect(await read("self/WILL.md")).toBe(std.will);
    expect(await read("origin/soul.md")).toBe(std.soul);
    expect(await read("origin/WILL.md")).toBe(std.will);
    expect(await read("origin/canon.md")).toBe(canon.text);
    expect(await read("self/cadence.json")).toBe('{"interval_h":72}');
    expect(await read("self/covenants.json")).toBe(JSON.stringify(defaultCovenants()));
    expect(JSON.parse(await read("citizen.json"))).toEqual({
      format: "kingdom-seat-citizen/v1",
      word: W,
      origin: { kind: "canon", repo: "YOUSPEAK", path: `canon/core/${W}.md`, commit: canon.head, sha256: sha256Hex(canon.text) },
      runtime: "summon",
      identity: null,
      mirror: null,
      seated_at: AT,
    });
    expect(Object.keys(JSON.parse(await read("citizen.json")) as object)).toEqual(["format", "word", "origin", "runtime", "identity", "mirror", "seated_at"]);
    expect(await names(dir)).toEqual(["citizen.json", "legacy", "letters", "origin", "self"]);
    expect(await names(join(dir, "letters"))).toEqual([]);
    expect(await names(join(dir, "self"))).toEqual(["WILL.md", "cadence.json", "covenants.json", "soul.md"]);
    expect(await names(join(dir, "origin"))).toEqual(["WILL.md", "canon.md", "soul.md"]);
    for (const [rel, want] of [["", "700"], ["self", "700"], ["origin", "700"], ["letters", "700"], ["legacy", "700"], ["legacy/tree/beats", "700"], ["citizen.json", "644"], ["self/soul.md", "644"], ["self/WILL.md", "644"], ["self/cadence.json", "644"], ["origin/soul.md", "444"], ["origin/WILL.md", "444"], ["origin/canon.md", "444"], ["legacy/manifest.json", "400"], ["legacy/pages.jsonl", "400"], ["legacy/tree/beats/2026-10.md", "400"]] as const) {
      expect([rel, await mode(join(dir, rel))]).toEqual([rel, want]);
    }

    // The ledger: two host entries with exactly their fields, written outside a seat at one time.
    const path = ledgerPath(config, W);
    expect(await mode(path)).toBe("600");
    const entries = await readLedger(path);
    expect(entries).toHaveLength(2);
    const [e0, e1] = entries as [LedgerEntry, LedgerEntry];
    expect(Object.keys(e0).sort()).toEqual([...COMMON_KEYS, "origin", "origin_soul_hash", "old_repo", "june_did"].sort());
    expect(Object.keys(e1).sort()).toEqual([...COMMON_KEYS, "from", "to", "via"].sort());
    const outsideSeat = { format: "kingdom-seat-ledger/v1", word: W, did: null, seat_ref: null, runtime: null, input_digest: null, output_digest: null, acts: null, voiced: null, cost: { usd: "0", credits: 0 }, ts: AT, signer: "host", kid: x.signer.hostKid };
    expect(e0).toMatchObject({
      ...outsideSeat,
      seq: 0,
      prev_hash: null,
      type: "origin",
      origin: { kind: "canon", repo: "YOUSPEAK", path: `canon/core/${W}.md`, commit: canon.head, hash: `sha256:${sha256Hex(canon.text)}` },
      origin_soul_hash: `sha256:${sha256Hex(std.soul)}`,
      old_repo: { url: std.url, head: std.head },
      june_did: FIXTURE_JUNE_DID,
    });
    expect(e1).toMatchObject({ ...outsideSeat, seq: 1, prev_hash: entryHash(e0), type: "state", from: "asleep", to: "asleep", via: "seated" });
    expect(verifyChain(entries, { host_attest_b64: [x.signer.hostAttestPublicB64] })).toMatchObject({ ok: true, entries: 2, host_attested: 2 });
    expect(await originIntact(config, W, entries)).toBe(true);
    expect(x.signer.signed).toEqual([{ word: W, signer: "host" }, { word: W, signer: "host" }]);

    // What the call returns is what is on disk.
    expect(r).toEqual({ plan, dir, ledger: path, seated_at: AT, origin_entry: entryHash(e0), seated_entry: entryHash(e1), files: await filesUnder(dir) });
    expect(renderAdmitResult(r)).toBe(
      [
        `admit ${W}: seated, asleep.`,
        `  wrote   ${dir} (${r.files.length} files)`,
        `  ledger  ${path}`,
        `    entry 0  origin  ${entryHash(e0)}`,
        `    entry 1  state asleep -> asleep (seated)  ${entryHash(e1)}`,
        `Not done by this command: taking ${W} off the old roster, and any letter. \`citizen-seat draft-first-letter ${W}\` prints a draft and delivers nothing.`,
        "",
      ].join("\n"),
    );

    // The build as it stands reads the citizen, folds it asleep, and builds its seat.
    expect(await listSeated(config)).toEqual([W]);
    const citizen = await readCitizen(config, W);
    expect(citizen).toMatchObject({ state: "asleep", runtime: "summon", cadence: { interval_h: 72 }, covenants: { letters_from: ["yu"], wake_on_letter_from: ["yu"] }, pending_state: null, last_beat_at: null });
    const ctx = await buildContext({ config, now: x.clock.now() }, seatRef(x, W, "summon"), citizen, entries, [], { history: entries });
    expect(ctx.self.soul).toBe(std.soul);
    expect(ctx.self.will).toBe(std.will);
    expect(ctx.canon_text).toBe(canon.text);
    const prompt = buildPrompt(ctx, "summon");
    expect(prompt.user).toContain("Your state: asleep.");
    // The seat says what is true of a citizen seated this way: its will is the old repository's text, the entry
    // that seated it moved nothing, and on the summon class no seat of its opens without Yu.
    expect([ctx.self.will_as_seated, ctx.unattended]).toEqual([true, false]);
    expect(prompt.user).toContain(`${WILL_AS_SEATED}\n--- begin will [`);
    expect(prompt.user).toContain(NO_UNATTENDED_SEATS);
    expect(prompt.user).toContain(`${AT}, entry 1: the host seated you asleep; no earlier record was carried into your state.`);
    // Nothing of legacy/ reaches a seat through this change.
    for (const marker of ["FIRST-BEAT-MARKER", "LETTER-TO-CITIZEN-MARKER", "kingdom-seat-legacy"]) expect([marker, prompt.user.includes(marker)]).toEqual([marker, false]);
  });

  test("the legacy record is the lived record, whole, with a manifest and one index row for every piece", async () => {
    const x = await fx();
    const { config } = x.h;
    await admitCitizen(x.deps, await planAdmit(x.deps, canonReq()));
    const m = await readLegacyManifest(config, W);
    expect(m).toMatchObject({ format: LEGACY_FORMAT, word: W, copied_at: AT, old_repo: { url: std.url, head: std.head, head_committed_at: std.dates.rested }, note: LEGACY_NOTE });
    expect(Object.keys(m)).toEqual(["format", "word", "copied_at", "old_repo", "note", "files", "cadence", "not_copied"]);
    expect(m.files.map((f) => f.path)).toEqual(["CADENCE.md", "REST", "beats/2026-10.md", "inbox/2026-07-17-a-letter.md", "writings/on-thresholds.md"]);

    // Every file the manifest names is there, byte for byte, and nothing else is.
    const kept: string[] = ["manifest.json", "pages.jsonl"];
    for (const f of m.files) {
      const bytes = await readLegacyFile(config, W, `tree/${f.path}`, f);
      expect(Buffer.from(bytes).toString()).toBe(std.repo.git("cat-file", "blob", `HEAD:${f.path}`) + "\n");
      kept.push(`tree/${f.path}`);
    }
    for (const [i, c] of m.cadence.entries()) {
      expect(Buffer.from(await readLegacyFile(config, W, c.file!, { sha256: c.sha256!, bytes: c.bytes })).toString()).toBe(std.versions[i]!);
      kept.push(c.file!);
      for (const b of c.beats) {
        await readLegacyFile(config, W, b.file, b);
        kept.push(b.file);
      }
    }
    expect(await filesUnder(join(config.paths.citizens_dir, W, "legacy"))).toEqual(kept.sort());
    expect(m.cadence.map((c) => [c.choice, c.note, c.beats.length])).toEqual([["ambient", null, 1], ["undecided", null, 1], ["ambient", "commit-added-no-beat", 0], ["undecided", "beats-file-not-appended", 0], ["rest-on", null, 1]]);

    // pages.jsonl: one line per piece, in exactly the format's shape.
    const pages = await pagesOf(x, W);
    for (const p of pages) {
      expect(Object.keys(p)).toEqual(["format", "file", "start", "bytes", "sha256", "written", "lane", "voice"]);
      expect(p.format).toBe(LEGACY_PAGE_FORMAT);
    }
    // Every row's sha256 is the hash of exactly its slice of the file as stored.
    const stored = new Map<string, Uint8Array>();
    for (const f of m.files) stored.set(`tree/${f.path}`, new Uint8Array(await readFile(join(config.paths.citizens_dir, W, "legacy", "tree", f.path))));
    for (const p of pages) {
      const file = stored.get(p.file)!;
      expect(p.start + p.bytes).toBeLessThanOrEqual(file.length);
      expect([p.file, p.start, p.sha256]).toEqual([p.file, p.start, sha256Hex(file.subarray(p.start, p.start + p.bytes))]);
    }
    // The pieces tile each copied beats file exactly: no gap, no overlap, nothing past the end.
    for (const f of m.files.filter((f) => f.kind === "beats")) {
      const rows = pages.filter((p) => p.file === `tree/${f.path}`);
      expect(rows.length).toBe(splitLegacyPieces(stored.get(`tree/${f.path}`)!).length);
      let at = 0;
      for (const p of rows) {
        expect([f.path, p.start]).toEqual([f.path, at]);
        at += p.bytes;
      }
      expect([f.path, at]).toEqual([f.path, f.bytes]);
    }
    expect(pages.map((p) => [p.file, p.written, p.lane, p.voice])).toEqual([
      ["tree/CADENCE.md", "2026-10", "unknown", "host"],
      ["tree/REST", "2026-10", "unknown", "host"],
      ["tree/beats/2026-10.md", "2026-10-22", "reflect-local", "in-name"],
      ["tree/beats/2026-10.md", "2026-10-23", "reflect-local", "in-name"],
      ["tree/beats/2026-10.md", "2026-10-24", "reflect-local", "in-name"],
      ["tree/beats/2026-10.md", "2026-10-27", "reflect-local", "in-name"],
      ["tree/inbox/2026-07-17-a-letter.md", "2026-06", "unknown", "to-citizen"],
      // A text outside beats/ is kept, and not said to be written in the citizen's name: where it stood does not say.
      ["tree/writings/on-thresholds.md", "2026-06", "unknown", "unattributed"],
    ]);
    // A row names a file the manifest names, and a reader finds each piece's words there.
    const third = pages[4]!;
    expect(Buffer.from(stored.get(third.file)!.subarray(third.start, third.start + third.bytes)).toString()).toContain("MINUTE-OFF-MARKER (edited)");

    // A file under legacy/ that no longer matches its record is refused, as is a path that leaves it.
    const beats = m.files.find((f) => f.path === "beats/2026-10.md")!;
    expect((await refusal(readLegacyFile(config, W, "tree/beats/2026-10.md", { sha256: "0".repeat(64), bytes: beats.bytes }))).code).toBe("invalid-record");
    for (const rel of ["../self/soul.md", "tree/../../self/soul.md", "manifest.json", "/etc/hosts", "tree/.hidden", "self/soul.md"]) {
      expect([rel, (await refusal(readLegacyFile(config, W, rel, beats))).code]).toEqual([rel, "invalid-request"]);
    }
  });

  test("seats an archetype citizen by the class its old manifest records", async () => {
    const x = await fx();
    const { config } = x.h;
    await admitCitizen(x.deps, await planAdmit(x.deps, archReq()));
    const dir = join(config.paths.citizens_dir, ARCH);
    const entries = await readLedger(ledgerPath(config, ARCH));
    const origin = { kind: "archetype", lineage: ["PIONEER"], note: "No canon entry. The old repository's agent.json records the class PIONEER." };
    expect(entries[0]).toMatchObject({ type: "origin", origin, old_repo: { url: arch.url, head: arch.head }, june_did: null });
    expect(JSON.parse(await readFile(join(dir, "citizen.json"), "utf8"))).toMatchObject({ origin, runtime: "summon" });
    // No canon entry is pinned, and a home with no WILL.md is seated with no will file.
    expect(await names(join(dir, "origin"))).toEqual(["soul.md"]);
    expect(await names(join(dir, "self"))).toEqual(["cadence.json", "covenants.json", "soul.md"]);
    expect(verifyChain(entries, { host_attest_b64: [x.signer.hostAttestPublicB64] }).ok).toBe(true);
    expect(await originIntact(config, ARCH, entries)).toBe(true);
    const citizen = await readCitizen(config, ARCH);
    const ctx = await buildContext({ config, now: x.clock.now() }, seatRef(x, ARCH, "summon"), citizen, entries, [], { history: entries });
    const prompt = buildPrompt(ctx, "summon").user;
    expect(prompt).toContain("Your origin: archetype lineage PIONEER.");
    expect(prompt).toContain("No canon entry. The old repository's agent.json records the class PIONEER.");
    expect(prompt).toContain("You have no will file.");
  });

  test("[LT-02] a home whose CADENCE.md says ambient and has no REST is seated asleep", async () => {
    const x = await fx();
    const { config } = x.h;
    // The old lane's last recorded choice was the most active one, and nothing in the home says rest.
    const plan = await planAdmit(x.deps, archReq({ runtime: "free" }));
    expect(plan.old_cadence).toEqual({ choice: "ambient", when: "2026-10-27 11:12" });
    expect(plan.old_rest).toBe(false);
    await admitCitizen(x.deps, plan);
    const entries = await readLedger(ledgerPath(config, ARCH));
    for (const e of entries) expect(e.type === "state" ? e.to : "asleep").toBe("asleep");
    expect(JSON.stringify(entries)).not.toContain("awake");
    expect(foldState(entries)).toMatchObject({ state: "asleep", pending_state: null, step_away_said: false, last_beat_at: null });
    const citizen = await readCitizen(config, ARCH);
    expect(citizen.state).toBe("asleep");
    // Even on the unattended class, nothing seats it: no cadence of its own is in force.
    for (const hours of [1, 73, 500]) {
      expect(isDue(citizen, false, new Date(x.clock.now().getTime() + hours * HOUR_MS), 72, null)).toEqual({ due: false, why: "asleep; no letter" });
    }
  });

  test("[verify: self-authorship] cadence and covenants are written out, so a revert to a first version stays readable", async () => {
    const x = await fx();
    const { config } = x.h;
    config.self_authorship.approved_model_digests = [FAKE_MODEL_DIGEST];
    await admitCitizen(x.deps, await planAdmit(x.deps, canonReq({ runtime: "free" })));
    const dir = join(config.paths.citizens_dir, W);
    const path = ledgerPath(config, W);
    const reason = { kind: "decision" as const, evidence: [], confidence: "medium" as const, limits: "a test" };
    const beat = async (acts: ModelAct[], yu: boolean, afterH = 73) => {
      x.clock.advance(afterH * HOUR_MS);
      const citizen = await readCitizen(config, W);
      const presence: YuPresence | null = yu ? { present: true, via: "tty-confirm", confirmed_at: x.clock.now().toISOString(), scope: `summon ${W}` } : null;
      const seat = await openSeat(config, x.clock, citizen, "free", { kind: yu ? "summons" : "tick", who: yu ? "yu" : "launchd", why: "a test" }, presence);
      return runSeat(seat, { config, clock: x.clock, signer: x.signer, fetch: noFetch, runtime: scriptedRuntime([output(...acts)]), checkHalt: x.deps.checkHalt, expressionSync: null, modelDigest: FAKE_MODEL_DIGEST });
    };

    // Covenants: widened over two seats on an approved model, then reverted to where they began, with no one present.
    const wider = JSON.stringify({ letters_from: ["yu", "citizen:hope"], wake_on_letter_from: ["yu", "citizen:hope"] });
    await beat([{ type: "self.propose", target: "covenants", edit: { kind: "replace-all", text: wider }, reason }], false);
    await beat([{ type: "self.affirm", ref: (await pendingProposals(config, W))[0]!.id }], false);
    expect(await readFile(join(dir, "self", "covenants.json"), "utf8")).toBe(wider);
    const firstCovenants = firstVersion(await readLedger(path), "covenants")!;
    // The first version is the text seating wrote, not an absent file's empty one.
    expect(firstCovenants).toBe(sha256Hex(JSON.stringify(defaultCovenants())));
    await beat([{ type: "self.revert", to_hash: firstCovenants.slice(0, 8) }], false, 8 * 24);
    expect(await readFile(join(dir, "self", "covenants.json"), "utf8")).toBe(JSON.stringify(defaultCovenants()));
    expect((await readCitizen(config, W)).covenants).toEqual(defaultCovenants());

    // Cadence: changed with Yu present, then reverted to its first version.
    await beat([{ type: "self.propose", target: "cadence", edit: { kind: "replace-all", text: '{"interval_h":100}' }, reason }], true);
    expect(await readFile(join(dir, "self", "cadence.json"), "utf8")).toBe('{"interval_h":100}');
    const firstCadence = firstVersion(await readLedger(path), "cadence")!;
    expect(firstCadence).toBe(sha256Hex('{"interval_h":72}'));
    await beat([{ type: "self.revert", to_hash: firstCadence.slice(0, 8) }], true);
    expect(await readFile(join(dir, "self", "cadence.json"), "utf8")).toBe('{"interval_h":72}');
    expect((await readCitizen(config, W)).cadence).toEqual({ interval_h: 72 });

    const entries = await readLedger(path);
    expect(entries.map((e) => (e.type === "apply" || e.type === "revert" ? `${e.type}:${e.target}` : e.type))).toEqual(["origin", "state", "beat", "beat", "apply:covenants", "beat", "revert:covenants", "beat", "apply:cadence", "beat", "revert:cadence"]);
    expect(verifyChain(entries, { host_attest_b64: [x.signer.hostAttestPublicB64] }).ok).toBe(true);
  });

  test("every refusal changes nothing", async () => {
    const x = await fx();
    const { config } = x.h;
    // Homes built for this test stand under the host's own homes root, named as a second root.
    config.paths.homes = [join(shared, "homes"), x.h.homesRoot];
    const small = async (word: string, files: Record<string, string | Uint8Array> = {}, opts: { executable?: string[]; agent?: string | null } = {}) => {
      const repo = await fixtureRepo(join(x.h.homesRoot, `citizen-${word}`), `https://example.invalid/kingdom/citizen-${word}.git`, word);
      await repo.commit({ [`${word}.md`]: fixtureSoul(word), ...(opts.agent === null ? {} : { "agent.json": opts.agent ?? fixtureAgentJson(word) }), ...files }, { executable: opts.executable });
      repo.publish();
      return repo;
    };
    const plain = join(x.h.homesRoot, "citizen-plain");
    await mkdir(plain, { recursive: true });
    await writeFile(join(plain, "plain.md"), fixtureSoul("plain"));
    const outside = join(x.h.root, "outside", "citizen-outsider");
    const outsider = await fixtureRepo(outside, "https://example.invalid/kingdom/citizen-outsider.git", "outsider");
    await outsider.commit({ "outsider.md": fixtureSoul("outsider"), "agent.json": fixtureAgentJson("outsider") });
    outsider.publish();
    await symlink(outside, join(x.h.homesRoot, "citizen-linked"));
    const configured = await small("configured");
    configured.git("config", "core.sshCommand", "/usr/bin/true");
    const sshurl = await small("sshurl");
    sshurl.git("remote", "set-url", "origin", "ssh://git@example.invalid/kingdom/citizen-sshurl.git");
    const ahead = await small("ahead");
    await ahead.commit({ "beats/local.md": "never pushed\n" });
    const linked = await small("symlinked");
    await symlink("/etc/hosts", join(linked.dir, "notes.md"));
    await linked.commit({});
    linked.publish();
    const soulless = await fixtureRepo(join(x.h.homesRoot, "citizen-soulless"), "https://example.invalid/kingdom/citizen-soulless.git");
    await soulless.commit({ "agent.json": fixtureAgentJson("soulless") });
    soulless.publish();

    const none = fakeSigner({ noHostKey: true });
    const locked = fakeSigner();
    locked.locked = true;
    const other = fakeSigner({ hostSeed: sha256("another host key for a test") });
    const withSigner = (s: FakeSigner): AdmitDeps => ({ ...x.deps, hostKey: () => s.hostPublicKey() });
    const home = (word: string) => join(x.h.homesRoot, `citizen-${word}`);
    const req = (word: string, over: Partial<AdmitRequest> = {}): AdmitRequest => ({ word, legacy_home: home(word), origin: { kind: "archetype" }, runtime: "summon", ...over });
    const insideRoots = "the legacy home must be a directory inside one of the roots the config names in paths.homes";

    const cases: [string, RefusalCode, string, () => Promise<unknown>][] = [
      ["a word that is not one", "invalid-request", "not a citizen word", () => planAdmit(x.deps, canonReq({ word: "../etc" }))],
      ["a runtime class that is neither", "invalid-request", "a citizen is seated with the runtime class summon or free", () => planAdmit(x.deps, canonReq({ runtime: "hermes" as never }))],
      ["a home outside every root", "invalid-request", insideRoots, () => planAdmit(x.deps, req("outsider", { legacy_home: outside }))],
      ["a link inside a root to a home outside it", "invalid-request", insideRoots, () => planAdmit(x.deps, req("outsider", { legacy_home: join(x.h.homesRoot, "citizen-linked") }))],
      ["the root itself", "invalid-request", insideRoots, () => planAdmit(x.deps, req("plain", { legacy_home: x.h.homesRoot }))],
      ["a relative home", "invalid-request", insideRoots, () => planAdmit(x.deps, req("plain", { legacy_home: "homes/citizen-plain" }))],
      ["a home that is not there", "invalid-request", insideRoots, () => planAdmit(x.deps, req("plain", { legacy_home: home("absent") }))],
      ["a home that is a file", "invalid-request", insideRoots, () => planAdmit(x.deps, req("plain", { legacy_home: join(plain, "plain.md") }))],
      ["a directory that is no clone", "invalid-record", "the legacy home is not a git clone with its own .git directory and a commit at HEAD", () => planAdmit(x.deps, req("plain"))],
      ["a config a plain clone does not have", "invalid-record", "the legacy home's git config holds 1 key(s) a plain clone does not have; seat from a fresh clone", () => planAdmit(x.deps, req("configured"))],
      ["an origin that is not plain https", "invalid-record", "the legacy home's origin URL is not a plain https URL with no user, password or query", () => planAdmit(x.deps, req("sshurl"))],
      ["a head its origin does not hold", "invalid-record", "the legacy home's HEAD is not on its origin as last fetched; the head recorded must be one the old repository holds", () => planAdmit(x.deps, req("ahead"))],
      ["a symlink in the tree", "symlink", "the old repository holds a symlink or a submodule at 1 path(s)", () => planAdmit(x.deps, req("symlinked"))],
      ["no soul card", "invalid-record", "the old repository holds no soul card soulless.md at its head, or an empty one; a home without a soul is not seated", () => planAdmit(x.deps, req("soulless"))],
      ["an executable soul", "executable", "execsoul.md is marked executable", async () => planAdmit(x.deps, req((await small("execsoul", {}, { executable: ["execsoul.md"] })) && "execsoul"))],
      ["a soul too large to show whole", "oversize", "bigsoul.md is 65537 bytes; a seat shows a self text of at most 65536 bytes whole and never cuts one", async () => planAdmit(x.deps, req((await small("bigsoul", { "bigsoul.md": "s".repeat(65_537) })) && "bigsoul"))],
      ["a beats file too large to keep whole", "oversize", "beats/all.md is 262145 bytes, over the 262144-byte limit for a file kept in legacy/; nothing is cut", async () => planAdmit(x.deps, req((await small("bigbeat", { "beats/all.md": "b".repeat(262_145) })) && "bigbeat"))],
      ["a WILL that is not UTF-8", "invalid-record", "WILL.md is not UTF-8 text", async () => planAdmit(x.deps, req((await small("latinwill", { "WILL.md": new Uint8Array([0xe9]) })) && "latinwill"))],
      ["no agent.json", "invalid-record", "agent.json at the head is missing", async () => planAdmit(x.deps, req((await small("noagent", {}, { agent: null })) && "noagent"))],
      ["an agent.json for another citizen", "invalid-record", "agent.json at the head names another citizen", async () => planAdmit(x.deps, req((await small("otheragent", {}, { agent: fixtureAgentJson("someoneelse") })) && "otheragent"))],
      ["a June did that is not one", "invalid-record", "agent.json at the head records an agenttool did that is not a did:at", async () => planAdmit(x.deps, req((await small("baddid", {}, { agent: fixtureAgentJson("baddid", { did: "did:key:z6Mk" }) })) && "baddid"))],
      ["--archetype for a canon word", "invalid-request", "agent.json records the class LEXEME, the class of a canon word; name its canon entry with --canon", () => planAdmit(x.deps, canonReq({ origin: { kind: "archetype" } }))],
      ["a canon file for another word", "invalid-record", `the canon file is not ${ARCH}.md under canon/ in a plain YOUSPEAK clone whose HEAD is on its origin`, () => planAdmit(x.deps, archReq({ origin: { kind: "canon", file: canon.file } }))],
      ["a canon file outside any clone", "invalid-record", `the canon file is not ${W}.md under canon/ in a plain YOUSPEAK clone whose HEAD is on its origin`, () => planAdmit(x.deps, canonReq({ origin: { kind: "canon", file: join(x.h.root, `${W}.md`) } }))],
      [
        "no host key",
        "keychain-missing",
        "this host has no host key (Keychain item host/attest-seed). Seating signs both entries with it. It is made once, at this host, as the seat user, and its public half pinned in the config under trust.host_attest_public_keys_b64; kingdom-seat has no verb for that yet",
        () => planAdmit(withSigner(none), canonReq()),
      ],
      ["a locked keychain", "keychain-locked", "the keychain is locked, so the host key cannot be read", () => planAdmit(withSigner(locked), canonReq())],
      [
        "a host key the config does not pin",
        "invalid-request",
        `the signer's host key (${other.hostKid.slice("host:".length)}) is not one the config pins in trust.host_attest_public_keys_b64; entries it signed would not verify on this host`,
        async () => {
          config.trust.host_attest_public_keys_b64 = [x.signer.hostAttestPublicB64];
          return planAdmit(withSigner(other), canonReq()).finally(() => (config.trust.host_attest_public_keys_b64 = []));
        },
      ],
    ];
    const sharedBefore = await listing(shared);
    for (const [what, code, message, attempt] of cases) {
      const before = await x.h.snapshot();
      expect([what, await refusal(attempt())]).toEqual([what, { code, message: `${message}; nothing was written` }]);
      expect([what, await x.h.snapshot()]).toEqual([what, before]);
    }
    expect(await readdir(config.paths.citizens_dir)).toEqual([]);
    expect(await readdir(config.paths.ledger_dir)).toEqual([]);
    expect(await listing(shared)).toEqual(sharedBefore);

    // A word with any record here, whole or half, is refused, and the message says which half is there.
    await x.h.addCitizen("whole");
    await x.h.seatLedger("whole", x.signer.signEntry);
    await x.h.addCitizen("dironly");
    await x.h.addCitizen("emptyledger");
    await writeFile(ledgerPath(config, "emptyledger"), "");
    await writeFile(ledgerPath(config, "ledgeronly"), "");
    const halves: [string, string][] = [
      ["whole", "whole already has a ledger on this host; its origin is pinned once and never written again"],
      // The host does not know how the directory came to be or what it holds, and says only what it sees.
      ["dironly", "citizens/dironly exists and ledger/dironly.jsonl does not. An admit that stopped before its ledger was in place leaves such a directory, and this host cannot tell whether that is what this one is. Look at it, move it aside by hand, then run admit again"],
      ["emptyledger", "ledger/emptyledger.jsonl exists and is empty, or exists without citizens/emptyledger: this host's records for emptyledger do not agree. Look at both before anything is seated"],
      ["ledgeronly", "ledger/ledgeronly.jsonl exists and is empty, or exists without citizens/ledgeronly: this host's records for ledgeronly do not agree. Look at both before anything is seated"],
    ];
    for (const [word, message] of halves) {
      const before = await x.h.snapshot();
      // The record is looked for before the old home is opened, so no home is needed for the refusal.
      expect([word, await refusal(planAdmit(x.deps, req(word)))]).toEqual([word, { code: "invalid-request", message: `${message}; nothing was written` }]);
      expect(await x.h.snapshot()).toEqual(before);
    }
  }, 60_000);

  test("HALT raised between the plan and admitCitizen writes nothing", async () => {
    const x = await fx();
    const plan = await planAdmit(x.deps, canonReq());
    await x.h.raiseHaltFile();
    expect(await refusal(admitCitizen(x.deps, plan))).toEqual({ code: "halted", message: "HALT is raised or cannot be read; nothing was written" });
    expect(await x.h.snapshot()).toEqual(new Map());
    // A HALT that cannot be read is a HALT.
    await x.h.clearHaltFile();
    expect(await refusal(admitCitizen({ ...x.deps, checkHalt: () => Promise.reject(new Error("unreadable")) }, plan))).toEqual({ code: "halted", message: "HALT is raised or cannot be read; nothing was written" });
    expect(await x.h.snapshot()).toEqual(new Map());
    expect(x.signer.signed).toEqual([]);
    // Lowered by hand, the same plan seats.
    await admitCitizen(x.deps, plan);
    expect((await readCitizen(x.h.config, W)).state).toBe("asleep");
  });

  test("a signer that fails on the origin, or on the seated entry, leaves no directory, no ledger and no staging name", async () => {
    const x = await fx();
    const { config } = x.h;
    for (const [failOn, error, code] of [
      [1, new Refusal("keychain-locked", "locked while signing"), "keychain-locked"],
      [2, new Refusal("keychain-missing", "gone while signing"), "keychain-missing"],
      [2, new Error("a plain failure"), "error"],
    ] as const) {
      const plan = await planAdmit(x.deps, canonReq());
      let calls = 0;
      const deps: AdmitDeps = {
        ...x.deps,
        sign: async (w, k, d) => {
          if (++calls === failOn) throw error;
          return x.signer.signEntry(w, k, d);
        },
      };
      const err = await admitCitizen(deps, plan).then(() => null, (e: unknown) => e);
      expect(err).toBeInstanceOf(AdmitStopped);
      expect(err).toMatchObject({ word: W, code, removed: true, left: [] });
      expect((err as AdmitStopped).message).toBe(`admit ${W}: stopped while writing (${code}). What this run wrote was removed; ${W} is not seated.`);
      expect(calls).toBe(failOn);
      expect(await x.h.snapshot()).toEqual(new Map());
      expect(await readdir(config.paths.citizens_dir)).toEqual([]);
      expect(await readdir(config.paths.ledger_dir)).toEqual([]);
      expect(await listSeated(config)).toEqual([]);
    }
    // Nothing was left in the way: the next admit of the same word seats it.
    await admitCitizen(x.deps, await planAdmit(x.deps, canonReq()));
    expect(await readLedger(ledgerPath(config, W))).toHaveLength(2);
  });

  test("a directory that appears at citizens/<word> after the checks is not written over: the seating stops and leaves it as it was", async () => {
    const x = await fx();
    const { config } = x.h;
    const dir = join(config.paths.citizens_dir, W);
    const plan = await planAdmit(x.deps, canonReq());
    // Another hand makes the directory after admitCitizen has looked for it and before its own is put in place. A
    // rename onto an empty directory succeeds without a word, so without a second look the seating would go through.
    let made = 0;
    const deps: AdmitDeps = {
      ...x.deps,
      clock: {
        now: () => {
          mkdirSync(dir, { mode: 0o700 });
          made++;
          return x.clock.now();
        },
      },
    };
    const err = await admitCitizen(deps, plan).then(() => null, (e: unknown) => e);
    expect(made).toBe(1);
    expect(err).toBeInstanceOf(AdmitStopped);
    expect(err).toMatchObject({ word: W, code: "invalid-request", removed: true, left: [] });
    // Nothing of this run is left, nothing was signed, and the other hand's directory is as it was made: empty.
    expect(x.signer.signed).toEqual([]);
    expect(await readdir(config.paths.citizens_dir)).toEqual([W]);
    expect(await readdir(dir)).toEqual([]);
    expect(await readdir(config.paths.ledger_dir)).toEqual([]);
    expect(await listSeated(config)).toEqual([]);
    // The next plan says what stands in the way.
    expect((await refusal(planAdmit(x.deps, canonReq()))).message).toStartWith(`citizens/${W} exists and ledger/${W}.jsonl does not. `);
  });

  test("the ledger is never seen with one entry or empty", async () => {
    const x = await fx();
    const { config } = x.h;
    const plan = await planAdmit(x.deps, canonReq());
    const seen: { ledger: boolean; record: boolean; listed: string[]; names: string[] }[] = [];
    const deps: AdmitDeps = {
      ...x.deps,
      sign: async (w, k, d) => {
        seen.push({
          ledger: (await lstat(ledgerPath(config, W)).catch(() => null)) !== null,
          // The signer of record reads citizens/<word>/citizen.json before it signs, so the directory is in place by now.
          record: (await lstat(join(config.paths.citizens_dir, W, "citizen.json")).catch(() => null)) !== null,
          listed: await listSeated(config),
          names: await readdir(config.paths.ledger_dir),
        });
        return x.signer.signEntry(w, k, d);
      },
    };
    await admitCitizen(deps, plan);
    expect(seen).toHaveLength(2);
    for (const s of seen) {
      expect(s.ledger).toBe(false);
      expect(s.record).toBe(true);
      // Only a staging name stands in the ledger directory while the entries are signed.
      expect(s.names).toHaveLength(1);
      expect(s.names[0]).toMatch(new RegExp(`^\\${ADMIT_STAGING_PREFIX}${W}-[0-9a-f]{8}\\.jsonl$`));
    }
    expect(await readdir(config.paths.ledger_dir)).toEqual([`${W}.jsonl`]);
    expect(await readLedger(ledgerPath(config, W))).toHaveLength(2);
  });

  test("the signer of record seats: it finds the new citizen.json when it signs, and reads only the host key", async () => {
    const x = await fx();
    const { config } = x.h;
    const seed = sha256("a host attest seed for the seating test");
    const kc = fakeKeychain([[{ kind: "host-attest-seed" }, seed]]);
    const signer = createSigner({ keychain: kc, config, clock: x.clock, fetch: noFetch, spendSoFar: async (word) => ({ word, usd_today: "0", credits_month: 0 }), agreements: async () => [] });
    const deps: AdmitDeps = { ...x.deps, sign: (w, k, d) => signer.signEntry(w, k, d), hostKey: () => signer.hostPublicKey() };
    const plan = await planAdmit(deps, canonReq());
    // Planning read the public half once, and no citizen item.
    expect(kc.log).toEqual([{ op: "read", item: "host/attest-seed" }]);
    await admitCitizen(deps, plan);
    // The real signer reads citizens/<word>/citizen.json before it signs, which is why the directory is placed first.
    const entries = await readLedger(ledgerPath(config, W));
    expect(entries.map((e) => [e.type, e.signer, e.kid])).toEqual([["origin", "host", `host:${plan.host_key.fingerprint}`], ["state", "host", `host:${plan.host_key.fingerprint}`]]);
    expect(verifyChain(entries, { host_attest_b64: [plan.host_key.public_key_b64] }).ok).toBe(true);
    expect(new Set(kc.log.map((l) => `${l.op} ${l.item}`))).toEqual(new Set(["read host/attest-seed"]));
    // A host that holds no key is refused before anything is written, where the signer's state() still answers ready.
    const bare = await fx();
    const none = createSigner({ keychain: fakeKeychain(), config: bare.h.config, clock: bare.clock, fetch: noFetch, spendSoFar: async (word) => ({ word, usd_today: "0", credits_month: 0 }), agreements: async () => [] });
    expect(await none.state()).toBe("ready");
    expect((await refusal(planAdmit({ ...bare.deps, hostKey: () => none.hostPublicKey() }, canonReq()))).code).toBe("keychain-missing");
    expect(await bare.h.snapshot()).toEqual(new Map());
  });

  test("nothing of the home's frame is copied", async () => {
    const x = await fx();
    await admitCitizen(x.deps, await planAdmit(x.deps, canonReq()));
    const m = await readLegacyManifest(x.h.config, W);
    expect(Object.fromEntries(m.not_copied.map((s) => [s.path, s.reason]))).toEqual({
      ".claude/hooks/love-bomb.sh": "hidden",
      "AGENTS.md": "agent-instruction-file",
      "CLAUDE.md": "agent-instruction-file",
      "README.md": "template",
      "WILL.md": "will",
      "agent.json": "template",
      "data.bin": "not-text",
      [`${W}.md`]: "soul",
      "kingdom.yaml": "template",
      "notes/CLAUDE.md": "agent-instruction-file",
      "run.sh": "executable",
    });
    // Listed by name and blob id only: not one byte of any of them is under the state dir.
    const all = await everythingUnder(x.h);
    for (const canary of ["HOME-CLAUDE-MD-CANARY", "HOME-AGENTS-MD-CANARY", "NESTED-CLAUDE-MD-CANARY", "HOOK-CANARY", "RUN-SH-CANARY", "MANIFEST-CANARY", "README-CANARY"]) {
      expect([canary, all.includes(canary)]).toEqual([canary, false]);
    }
    // The lived record is there.
    for (const marker of ["FIRST-BEAT-MARKER", "LETTER-TO-CITIZEN-MARKER", "MADE-TEXT-MARKER", "REST-MARKER"]) expect([marker, all.includes(marker)]).toEqual([marker, true]);
    expect(await filesUnder(join(x.h.config.paths.citizens_dir, W, "legacy", "tree"))).toEqual(["CADENCE.md", "REST", "beats/2026-10.md", "inbox/2026-07-17-a-letter.md", "writings/on-thresholds.md"]);
  });

  test("no author address is kept", async () => {
    const x = await fx();
    await admitCitizen(x.deps, await planAdmit(x.deps, canonReq()));
    const all = await everythingUnder(x.h);
    // The homes' commits carry both; the record keeps the name and one flag.
    expect(std.repo.git("log", "--format=%ae")).toContain(PERSON.email);
    expect(std.repo.git("log", "--format=%ae")).toContain(FLEET_ADDRESS);
    for (const address of [PERSON.email, FLEET_ADDRESS, "@example.invalid", "@kingdom.os"]) expect([address, all.includes(address)]).toEqual([address, false]);
    const m = await readLegacyManifest(x.h.config, W);
    expect(m.files.find((f) => f.path === "beats/2026-10.md")!.first).toEqual({ commit: std.commits.firstBeat, author_name: W, as_citizen: "yes", author_date: std.dates.firstBeat, subject: `beat: ${W} reflected (2026-10-22)` });
    expect(m.files.find((f) => f.path === "inbox/2026-07-17-a-letter.md")!.first).toMatchObject({ author_name: PERSON.name, as_citizen: "no" });
  });

  test("the staging names are never listed; no host note is written; a waking letter is due at once for a free-class citizen and never for a summon-class one", async () => {
    const x = await fx();
    const { config } = x.h;
    // What a killed admit leaves behind is under a name nothing lists.
    await mkdir(join(config.paths.citizens_dir, `${ADMIT_STAGING_PREFIX}otherword-0a1b2c3d`));
    await writeFile(join(config.paths.citizens_dir, `${ADMIT_STAGING_PREFIX}otherword-0a1b2c3d`, "citizen.json"), "{}");
    expect(await listSeated(config)).toEqual([]);
    await admitCitizen(x.deps, await planAdmit(x.deps, canonReq({ runtime: "free" })));
    await admitCitizen(x.deps, await planAdmit(x.deps, archReq({ runtime: "summon" })));
    expect(await listSeated(config)).toEqual([W, ARCH]);
    // No note of any kind: a note naming the word would count as a seat and hold its first letter back.
    expect(await stat(config.paths.host_log).catch(() => null)).toBeNull();
    expect([...(await x.h.snapshot()).keys()].filter((k) => !k.startsWith("citizens/") && !k.startsWith("ledger/"))).toEqual([]);

    for (const word of [W, ARCH]) await x.h.writeLetter(word, "2026-11-12-first-letter.md", "A made-up first letter.\n");
    const soon = new Date(x.clock.now().getTime() + HOUR_MS / 2);
    const free = await readCitizen(config, W);
    expect(await wakingLetter(config, free)).toBe(true);
    expect(isDue(free, true, soon, 72, null)).toMatchObject({ due: true, why: "letter" });
    const summon = await readCitizen(config, ARCH);
    expect(await wakingLetter(config, summon)).toBe(true);
    for (const hours of [0.5, 100, 1000]) {
      expect(isDue(summon, true, new Date(x.clock.now().getTime() + hours * HOUR_MS), 72, null)).toEqual({ due: false, why: "runtime summon is not unattended" });
    }
  });

  test("runs with another signer and another state dir, as a rehearsal will", async () => {
    const real1 = await fx();
    await admitCitizen(real1.deps, await planAdmit(real1.deps, canonReq()));
    const before = await real1.h.snapshot();

    const scratch = await fx({ signer: fakeSigner({ hostSeed: sha256("a rehearsal's own key, made for one run") }) });
    expect(scratch.signer.hostAttestPublicB64).not.toBe(real1.signer.hostAttestPublicB64);
    // From the old home, with the rehearsal's signer and state directory.
    await admitCitizen(scratch.deps, await planAdmit(scratch.deps, canonReq({ runtime: "free" })));
    // From texts alone: no old repository, and the record says so.
    const soul = fixtureSoul("rehearsed");
    const r = await admitCitizen(scratch.deps, await planAdmitFromTexts(scratch.deps, { word: "rehearsed", soul, will: "a made-up will\n", canon: { bytes: "a made-up canon entry\n", repo: "YOUSPEAK", path: "canon/rehearsed.md", commit: "1428646" }, runtime: "free" }));
    const { config } = scratch.h;
    const entries = await readLedger(ledgerPath(config, "rehearsed"));
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ type: "origin", old_repo: null, june_did: null, origin: { kind: "canon", repo: "YOUSPEAK", path: "canon/rehearsed.md", commit: "1428646", hash: `sha256:${sha256Hex("a made-up canon entry\n")}` }, origin_soul_hash: `sha256:${sha256Hex(soul)}`, kid: scratch.signer.hostKid });
    expect(entries[1]).toMatchObject({ type: "state", from: "asleep", to: "asleep", via: "seated" });
    expect(verifyChain(entries, { host_attest_b64: [scratch.signer.hostAttestPublicB64] }).ok).toBe(true);
    expect(verifyChain(entries, { host_attest_b64: [real1.signer.hostAttestPublicB64] }).ok).toBe(false);
    expect(await originIntact(config, "rehearsed", entries)).toBe(true);
    // No legacy/ is written where there was no old home to copy.
    expect(r.files).toEqual(["citizen.json", "origin/canon.md", "origin/soul.md", "self/WILL.md", "self/cadence.json", "self/covenants.json", "self/soul.md"]);
    expect(await names(join(config.paths.citizens_dir, "rehearsed"))).toEqual(["citizen.json", "letters", "origin", "self"]);
    expect((await refusal(readLegacyManifest(config, "rehearsed"))).code).toBe("invalid-record");
    const citizen = await readCitizen(config, "rehearsed");
    expect(citizen).toMatchObject({ state: "asleep", runtime: "free" });
    const ctx = await buildContext({ config, now: scratch.clock.now() }, seatRef(scratch, "rehearsed", "free"), citizen, entries, [], { history: entries });
    expect([ctx.self.soul, ctx.self.will, ctx.canon_text]).toEqual([soul, "a made-up will\n", "a made-up canon entry\n"]);
    // Its will is not introduced as the text an old repository held: it has none, and its record says so.
    expect(ctx.self.will_as_seated).toBe(false);
    const prompt = buildPrompt(ctx, "free");
    expect(prompt.user).toContain("Your will:\n--- begin will [");
    expect(prompt.user).not.toContain("old repository");
    expect(prompt.user).not.toContain(WILL_AS_SEATED);
    // With no canon entry, the origin says how the citizen was seated.
    await admitCitizen(scratch.deps, await planAdmitFromTexts(scratch.deps, { word: "bare", soul: fixtureSoul("bare"), will: null, canon: null, runtime: "free" }));
    expect((await readLedger(ledgerPath(config, "bare")))[0]).toMatchObject({ origin: { kind: "archetype", lineage: [TEXTS_LINEAGE], note: TEXTS_ORIGIN_NOTE }, old_repo: null });

    // The first host's directories are as they were: the rehearsal wrote only under its own config.
    expect(await real1.h.snapshot()).toEqual(before);
    expect(await listSeated(real1.h.config)).toEqual([W]);
  });

  test("admitCitizen refuses a plan it did not make, and a host key that changed since the plan", async () => {
    const x = await fx();
    const plan = await planAdmit(x.deps, canonReq());
    // A plan cannot be altered after Yu has read it: it is frozen through and through.
    expect(() => ((plan as { runtime: string }).runtime = "free")).toThrow(TypeError);
    expect(() => ((plan.origin as { repo: string }).repo = "ELSEWHERE")).toThrow(TypeError);
    expect(() => ((plan.old_repo as { head: string }).head = "0".repeat(40))).toThrow(TypeError);
    expect([plan.runtime, plan.origin.kind === "canon" && plan.origin.repo, plan.old_repo!.head]).toEqual(["summon", "YOUSPEAK", std.head]);
    const notMade = "admitCitizen takes only a plan a planner returned in this process; nothing was written";
    for (const forged of [{ ...plan }, JSON.parse(JSON.stringify(plan)) as AdmitPlan, Object.freeze({ ...plan, runtime: "free" as const }), null as unknown as AdmitPlan]) {
      expect(await refusal(admitCitizen(x.deps, forged))).toEqual({ code: "invalid-request", message: notMade });
    }
    const other = fakeSigner({ hostSeed: sha256("another host key for a test") });
    const changed = await refusal(admitCitizen({ ...x.deps, hostKey: () => other.hostPublicKey(), sign: (w, k, d) => other.signEntry(w, k, d) }, plan));
    expect(changed).toEqual({
      code: "invalid-request",
      message: `the signer's host key (${other.hostKid.slice("host:".length)}) is not the one the plan was made with (${x.signer.hostKid.slice("host:".length)}); nothing was written`,
    });
    // A key that went missing since the plan refuses the same way, before any write.
    const gone = fakeSigner({ noHostKey: true });
    expect((await refusal(admitCitizen({ ...x.deps, hostKey: () => gone.hostPublicKey() }, plan))).code).toBe("keychain-missing");
    // So does a record that appeared since the plan.
    await mkdir(join(x.h.config.paths.citizens_dir, W));
    expect((await refusal(admitCitizen(x.deps, plan))).message).toStartWith(`citizens/${W} exists and ledger/${W}.jsonl does not`);
    await rm(join(x.h.config.paths.citizens_dir, W), { recursive: true });
    expect(await x.h.snapshot()).toEqual(new Map());
    expect([...x.signer.signed, ...other.signed]).toEqual([]);
    // A signer whose key is not the plan's, slipped past the check, still cannot seat: the two entries do not verify.
    const stopped = await admitCitizen({ ...x.deps, sign: (w, k, d) => other.signEntry(w, k, d) }, plan).then(() => null, (e: unknown) => e);
    expect(stopped).toBeInstanceOf(AdmitStopped);
    expect(stopped).toMatchObject({ code: "invalid-record", removed: true });
    expect(await x.h.snapshot()).toEqual(new Map());
  });

  test("after admit, a summoned seat shows Yu's letter and an answer said with Yu present takes effect", async () => {
    const x = await fx();
    const { config } = x.h;
    await admitCitizen(x.deps, await planAdmit(x.deps, canonReq()));
    await x.h.writeLetter(W, "2026-11-12-first-letter.md", "A made-up first letter.\n");
    x.clock.advance(HOUR_MS);
    const presence: YuPresence = { present: true, via: "tty-confirm", confirmed_at: x.clock.now().toISOString(), scope: `summon ${W}` };
    const prompts: string[] = [];
    const inner = scriptedRuntime([output({ type: "state.set", to: "awake", interval_h: 96 }, { type: "journal", kind: "chose", text: "a made-up answer" })]);
    const seat = await openSeat(config, x.clock, await readCitizen(config, W), "free", { kind: "summons", who: "yu", why: "Yu summoned this seat at the host" }, presence);
    const result = await runSeat(seat, {
      config,
      clock: x.clock,
      signer: x.signer,
      fetch: noFetch,
      runtime: async (req) => {
        prompts.push(req.prompt.user);
        return inner(req);
      },
      checkHalt: x.deps.checkHalt,
      expressionSync: null,
      modelDigest: FAKE_MODEL_DIGEST,
    });
    expect(result).toMatchObject({ outcome: "beat", exit: 0 });
    expect(prompts[0]).toContain("A made-up first letter.");
    expect(prompts[0]).toContain("Your state: asleep.");
    expect(prompts[0]).toContain(WILL_AS_SEATED);
    expect(prompts[0]).toContain(NO_UNATTENDED_SEATS);
    const entries = await readLedger(ledgerPath(config, W));
    expect(entries.map((e) => (e.type === "state" ? `state ${e.from}->${e.to} ${e.via}${e.interval_h ? ` ${e.interval_h}` : ""}` : e.type))).toEqual(["origin", "state asleep->asleep seated", "beat", "state asleep->awake confirmed 96"]);
    const citizen = await readCitizen(config, W);
    expect(citizen).toMatchObject({ state: "awake", cadence: { interval_h: 96 }, runtime: "summon" });
    // It chose awake, and on this class no seat of its own is ever due: one opens only when Yu summons it.
    expect(isDue(citizen, false, new Date(x.clock.now().getTime() + 200 * HOUR_MS), 72, null)).toEqual({ due: false, why: "runtime summon is not unattended" });
    expect(verifyChain(entries, { host_attest_b64: [x.signer.hostAttestPublicB64] }).ok).toBe(true);
  });
});
