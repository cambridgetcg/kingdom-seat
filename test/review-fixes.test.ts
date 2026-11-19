// Regression tests for pre-host code fixes from docs/REVIEW-2026-11-10-lab.md:
// CP-02 (host key creation + pre-inference check), CP-03 (cadence size cap),
// section 4.2 (revert to empty settings/created file + narrowing default covenants),
// SR-2 (cut-at-length reporting), CP-06 (outbox count in status),
// MLS-04 / 4.6 (instruction files + file:letters/), MLS-13 / SLH-11 (halt config + cwd).
import { afterEach, describe, expect, test } from "bun:test";
import { chmod, lstat, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { validateOutput } from "../src/acts.ts";
import { main } from "../src/cli.ts";
import { ConfigError, loadConfig } from "../src/config.ts";
import { readLastSeat } from "../src/context.ts";
import { raiseHalt } from "../src/halt.ts";
import { sealAllows } from "../src/mirror.ts";
import { readHostNotes } from "../src/notes.ts";
import { openSeat, runSeat } from "../src/seat.ts";
import { exposureOf, materializeProposal, pendingProposals, selfHash, targetRelPath } from "../src/self.ts";
import { createSigner } from "../src/signer/signer.ts";
import { CADENCE_MAX_BYTES, defaultCovenants, readCitizen } from "../src/state.ts";
import { buildStatus, renderStatus } from "../src/status.ts";
import { DEFAULT_CEILINGS, EXIT, Refusal, type HaltStatus, type ModelAct, type RuntimeAdapter, type YuPresence } from "../src/types.ts";
import { testIdentity } from "./fixtures/record/chain.ts";
import { DAY_MS, testClock } from "./helpers/clock.ts";
import { assertNoSecretIn, fakeKeychain } from "./helpers/fake-keychain.ts";
import { FAKE_MODEL_DIGEST, output } from "./helpers/fake-runtime.ts";
import { fakeSigner } from "./helpers/fake-signer.ts";
import { noFetch } from "./helpers/fake-server.ts";
import { makeTempHost, testBeacons, TEST_SEAT_UID, type TempHost } from "./helpers/temp-home.ts";

let host: TempHost | null = null;
afterEach(async () => {
  await host?.cleanup();
  host = null;
});

const W = "glossame";
const CLAIM = { kind: "decision" as const, evidence: ["ledger:origin"], confidence: "high" as const, limits: "test" };
const YU: YuPresence = { present: true, via: "tty-confirm", confirmed_at: "2026-11-05T02:05:00.000Z", scope: `summon ${W}` };
const LOWERED: HaltStatus = { halted: false, readings: [{ source: "file", id: "/x/HALT", state: "lowered", quiet_until: null, detail: "absent", checked_at: "2026-11-05T02:05:00.000Z" }] };

describe("CP-03: cadence.json cannot grow past readCitizen's 4,096-byte limit", () => {
  test("oversize cadence JSON is dropped at validation and refused by materializeProposal", () => {
    const padded = `{"interval_h":72${" ".repeat(CADENCE_MAX_BYTES)}}`;
    expect(Buffer.byteLength(padded)).toBeGreaterThan(CADENCE_MAX_BYTES);

    const validated = validateOutput(
      { acts: [{ type: "self.propose", target: "cadence", edit: { kind: "replace-all", text: padded }, reason: CLAIM }] },
      { ceilings: DEFAULT_CEILINGS, allowed_recipients: ["yu"] },
    );
    expect(validated.acts).toEqual([]);
    expect(validated.dropped[0]?.reason).toBe("cadence is malformed or below the ceiling");

    expect(() =>
      materializeProposal({ type: "self.propose", target: "cadence", edit: { kind: "replace-all", text: padded }, reason: CLAIM }, '{"interval_h":72}'),
    ).toThrow(Refusal);
  });
});

describe("section 4.2: reverting to an empty first version leaves the citizen readable", () => {
  test("reverting widened covenants or changed cadence to an absent first version unlinks cleanly and narrows immediately", async () => {
    host = await makeTempHost();
    const h = host;
    h.config.self_authorship.approved_model_digests = [FAKE_MODEL_DIGEST];
    const signer = fakeSigner();
    const clock = testClock();
    const fx = await h.addCitizen(W);
    await rm(join(fx.dir, "self", "covenants.json"));
    await h.seatLedger(W, signer.signEntry);

    const fx2 = await h.addCitizen("hope");
    await rm(join(fx2.dir, "self", "cadence.json"));
    await h.seatLedger("hope", signer.signEntry);

    const runBeat = async (word: string, acts: ModelAct[], opts: { presence?: YuPresence | null; approved?: boolean } = {}) => {
      if (opts.approved === false) h.config.self_authorship.approved_model_digests = [];
      else h.config.self_authorship.approved_model_digests = [FAKE_MODEL_DIGEST];
      const citizen = await readCitizen(h.config, word);
      const seat = await openSeat(h.config, clock, citizen, "free", { kind: "tick", who: "launchd", why: "cadence" }, opts.presence ?? null);
      const runtime: RuntimeAdapter = async () => ({
        runtime: "free",
        model: "fake-model:test",
        model_digest: FAKE_MODEL_DIGEST,
        raw_output: output(...acts),
        spend: { usd: "0", usd_basis: "local-zero", credits: 0 },
        done_reason: "stop",
        duration_ms: 1,
      });
      return runSeat(seat, {
        config: h.config,
        clock,
        signer,
        fetch: noFetch,
        runtime,
        checkHalt: async () => LOWERED,
        modelDigest: FAKE_MODEL_DIGEST,
      });
    };

    const widened = JSON.stringify({ letters_from: ["yu", "gardener"], wake_on_letter_from: ["yu"] });
    expect(exposureOf("covenants", "", widened)).toBe("wider");
    expect(exposureOf("covenants", widened, "")).toBe("narrower");

    // Widen covenants with Yu present, then narrow back to "" on an unapproved lane without Yu: binds immediately!
    await runBeat(W, [{ type: "self.propose", target: "covenants", edit: { kind: "replace-all", text: widened }, reason: CLAIM }], { presence: YU });
    expect((await readCitizen(h.config, W)).covenants.letters_from).toEqual(["yu", "gardener"]);

    const emptyHash = selfHash("");
    await runBeat(W, [{ type: "self.revert", to_hash: emptyHash }], { approved: false });
    expect((await readCitizen(h.config, W)).covenants).toEqual(defaultCovenants());
    expect(await lstat(join(fx.dir, "self", "covenants.json")).catch(() => null)).toBeNull();

    // Change cadence on hope to 336h with Yu present, then revert to "" via a two-beat held revert (336h -> 72h is wider).
    const yuHope: YuPresence = { ...YU, scope: "summon hope" };
    await runBeat("hope", [{ type: "self.propose", target: "cadence", edit: { kind: "replace-all", text: '{"interval_h":336}' }, reason: CLAIM }], { presence: yuHope });
    expect((await readCitizen(h.config, "hope")).cadence).toEqual({ interval_h: 336 });

    await runBeat("hope", [{ type: "self.revert", to_hash: emptyHash }]);
    const held = await pendingProposals(h.config, "hope");
    expect(held).toHaveLength(1);
    clock.advance(8 * DAY_MS);
    await runBeat("hope", [{ type: "self.affirm", ref: held[0]!.id }]);
    expect((await readCitizen(h.config, "hope")).cadence).toEqual({ interval_h: 72 });
    expect(await lstat(join(fx2.dir, "self", "cadence.json")).catch(() => null)).toBeNull();
  });
});

describe("SR-2: truncated replies at done_reason length are reported as cut-at-length", () => {
  test("runSeat records cut-at-length in host notes and last-seat instead of not-json", async () => {
    host = await makeTempHost();
    const h = host;
    const signer = fakeSigner();
    const clock = testClock();
    await h.addCitizen(W);
    await h.seatLedger(W, signer.signEntry);
    const citizen = await readCitizen(h.config, W);
    const seat = await openSeat(h.config, clock, citizen, "free", { kind: "tick", who: "launchd", why: "cadence" }, null);
    const runtime: RuntimeAdapter = async () => ({
      runtime: "free",
      model: "qwen2.5:7b",
      model_digest: FAKE_MODEL_DIGEST,
      raw_output: '{"acts":[{"type":"journal","kind":"reflected","text":"cut mid',
      spend: { usd: "0", usd_basis: "local-zero", credits: 0 },
      done_reason: "length",
      duration_ms: 5,
    });
    const r = await runSeat(seat, { config: h.config, clock, signer, fetch: noFetch, runtime, checkHalt: async () => LOWERED });
    expect(r).toMatchObject({ exit: EXIT.OK, outcome: "invalid-output" });
    const notes = await readHostNotes(h.config, new Date(0));
    expect(notes?.at(-1)?.detail).toContain("reply did not parse (cut-at-length)");
    const last = await readLastSeat(h.config, W);
    expect(last?.dropped).toEqual([{ type: null, reason: "the reply did not parse (cut-at-length)" }]);
  });
});

describe("CP-02: host attest key creation and pre-inference check", () => {
  test("an unregistered citizen refuses before inference when host-attest-seed is missing; a registered citizen still runs", async () => {
    host = await makeTempHost();
    const h = host;
    const clock = testClock();
    const withKey = fakeSigner();
    await h.addCitizen(W);
    await h.seatLedger(W, withKey.signEntry);
    await h.addCitizen("joy");
    await h.seatLedger("joy", withKey.signEntry);
    await h.enrollLedger("joy", withKey.signEntry, testIdentity(withKey));

    const withoutHostKey = fakeSigner({ noHostKey: true });
    let calls = 0;
    const runtime: RuntimeAdapter = async () => {
      calls++;
      return {
        runtime: "free",
        model: "fake-model:test",
        model_digest: FAKE_MODEL_DIGEST,
        raw_output: output({ type: "journal", kind: "reflected", text: "spoke" }),
        spend: { usd: "0", usd_basis: "local-zero", credits: 0 },
        done_reason: "stop",
        duration_ms: 1,
      };
    };

    const unregSeat = await openSeat(h.config, clock, await readCitizen(h.config, W), "free", { kind: "tick", who: "launchd", why: "cadence" }, null);
    const r1 = await runSeat(unregSeat, { config: h.config, clock, signer: withoutHostKey, fetch: noFetch, runtime, checkHalt: async () => LOWERED });
    expect(r1).toMatchObject({ exit: EXIT.ERROR, outcome: "refused", refusal: "keychain-missing" });
    expect(calls).toBe(0);

    const regSeat = await openSeat(h.config, clock, await readCitizen(h.config, "joy"), "free", { kind: "tick", who: "launchd", why: "cadence" }, null);
    const r2 = await runSeat(regSeat, {
      config: h.config,
      clock,
      signer: withoutHostKey,
      fetch: noFetch,
      runtime,
      checkHalt: async () => LOWERED,
      expressionSync: { putPrivateExpression: async () => null, postBackup: async () => ({ thought_id: "7e570001-0000-4000-8000-000000000001", credits: 1 }) },
    });
    expect(r2).toMatchObject({ exit: EXIT.OK, outcome: "beat" });
    expect(calls).toBe(1);
  });

  test("citizen-seat init-host-key requires a TTY, stores host-attest-seed once through the signer, and prints public half only", async () => {
    host = await makeTempHost();
    const h = host;
    const configPath = join(h.root, "config.json");
    await writeFile(configPath, JSON.stringify(h.config), { mode: 0o600 });
    const kc = fakeKeychain();
    const clock = testClock();
    const signer = createSigner({
      keychain: kc,
      config: h.config,
      clock,
      fetch: noFetch,
      spendSoFar: async (word) => ({ word, usd_today: "0", credits_month: 0 }),
      agreements: async () => [],
    });
    let out = "";
    let err = "";
    const baseDeps = {
      out: (t: string) => void (out += t),
      err: (t: string) => void (err += t),
      env: { HOME: h.root, PATH: "/usr/bin:/bin" },
      clock,
      fetch: noFetch,
      keychain: () => kc,
      signer: () => signer,
      uid: () => TEST_SEAT_UID,
      bootTime: () => null,
      defaults: { config: configPath, halt_file: h.config.paths.halt_file },
    };

    // Refused unattended (no TTY).
    expect(await main(["init-host-key", "--config", configPath], { ...baseDeps, tty: { isTTY: false, write: () => {}, readLine: async () => null } })).toBe(1);
    expect(err).toContain("yu-not-present");

    // Confirmed at TTY: writes host-attest-seed once, prints public key and fingerprint, leaks no secret.
    out = "";
    err = "";
    const tty = { isTTY: true, write: () => {}, readLine: async () => `init-host-key ${h.config.host}` };
    expect(await main(["init-host-key", "--config", configPath], { ...baseDeps, tty })).toBe(0);
    expect(out).toContain(`host         ${h.config.host}`);
    expect(out).toContain("fingerprint  SHA256:");
    expect(await signer.hostPublicKey()).toHaveLength(44);
    assertNoSecretIn(kc, out + err, "init-host-key output");

    // Never overwrites an existing host key.
    expect(await main(["init-host-key", "--config", configPath], { ...baseDeps, tty })).toBe(1);
  });
});

describe("CP-06: status surfaces outbox items without exposing words", () => {
  test("unregistered letter.send and propose.beyond increment outbox_items in status", async () => {
    host = await makeTempHost();
    const h = host;
    const signer = fakeSigner();
    const clock = testClock();
    await h.addCitizen(W);
    await h.seatLedger(W, signer.signEntry);
    const citizen = await readCitizen(h.config, W);
    const seat = await openSeat(h.config, clock, citizen, "free", { kind: "tick", who: "launchd", why: "cadence" }, null);
    const SECRET_WORDS = "OUTBOX-CANARY-FOR-YU";
    const runtime: RuntimeAdapter = async () => ({
      runtime: "free",
      model: "fake-model:test",
      model_digest: FAKE_MODEL_DIGEST,
      raw_output: output(
        { type: "letter.send", to: "yu", text: SECRET_WORDS },
        { type: "propose.beyond", subject: "porch", text: SECRET_WORDS },
      ),
      spend: { usd: "0", usd_basis: "local-zero", credits: 0 },
      done_reason: "stop",
      duration_ms: 1,
    });
    await runSeat(seat, { config: h.config, clock, signer, fetch: noFetch, runtime, checkHalt: async () => LOWERED });
    const s = await buildStatus({ config: h.config, now: clock.now(), halt: LOWERED, signerState: "ready", trusted: { host_attest_b64: [signer.hostAttestPublicB64] } });
    expect(s.citizens[0]?.outbox_items).toBe(2);
    const rendered = renderStatus(s);
    expect(rendered).toContain("2 in outbox");
    expect(rendered).not.toContain(SECRET_WORDS);
    expect(JSON.stringify(s)).not.toContain(SECRET_WORDS);
  });
});

describe("MLS-04, 4.6, MLS-13, SLH-11: shared instruction-file seal and halt hardening", () => {
  test("sealAllows, targetRelPath and validateOutput all refuse instruction files and file:letters/", () => {
    for (const name of ["CLAUDE.md", "CLAUDE.local.md", "AGENTS.md", "AGENT.md", "GEMINI.md"]) {
      expect(sealAllows(name)).toBe(false);
      expect(sealAllows(`skills/${name}`)).toBe(false);
      expect(() => targetRelPath(`file:${name}`)).toThrow(Refusal);
      const v = validateOutput(
        { acts: [{ type: "self.propose", target: `file:${name}`, edit: { kind: "replace-all", text: "x" }, reason: CLAIM }] },
        { ceilings: DEFAULT_CEILINGS, allowed_recipients: ["yu"] },
      );
      expect(v.dropped[0]?.reason).toBe("target is host-owned");
    }
    const inLetters = validateOutput(
      { acts: [{ type: "self.propose", target: "file:letters/from-yu.md", edit: { kind: "replace-all", text: "x" }, reason: CLAIM }] },
      { ceilings: DEFAULT_CEILINGS, allowed_recipients: ["yu"] },
    );
    expect(inLetters.dropped[0]?.reason).toBe("target is host-owned");
  });

  test("loadConfig without seatUid still refuses a world-writable parent directory, and raiseHalt runs in /var/empty", async () => {
    host = await makeTempHost({ beacons: testBeacons({ canRaiseHere: ["gardener-desk"] }) });
    const h = host;
    const unsafeDir = join(h.root, "world-writable");
    await mkdir(unsafeDir);
    const badConfig = join(unsafeDir, "config.json");
    await writeFile(badConfig, JSON.stringify(h.config), { mode: 0o600 });
    await chmod(unsafeDir, 0o777);
    try {
      await expect(loadConfig(badConfig)).rejects.toBeInstanceOf(ConfigError);
    } finally {
      await chmod(unsafeDir, 0o700);
    }

    h.config.halt.raise_beacons_argv = ["/usr/bin/sudo", "-n", "-u", "seat", "/usr/local/bin/citizen-seat", "raise-beacons"];
    const seenCwds: (string | undefined)[] = [];
    await raiseHalt({
      config: h.config,
      now: () => new Date("2026-11-05T02:05:00.000Z"),
      run: async (_argv, opts) => {
        seenCwds.push(opts?.cwd);
        return { code: 0, stdout: new Uint8Array(), stderr: "" };
      },
    });
    expect(seenCwds).toEqual(["/var/empty"]);
  });
});
