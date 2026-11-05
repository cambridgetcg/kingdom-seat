// Owner: surface group.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, readdir, readFile, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { appendHostNote, buildStatus, hostDetailProblem, overdue, readHostNotes, renderStatus, writeStatus } from "../src/status.ts";
import { checkHalt } from "../src/halt.ts";
import { appendEntry, ledgerPath, nextDraft, readLedger } from "../src/ledger.ts";
import { openedDetail } from "../src/notes.ts";
import { spawnRunner } from "../src/cli.ts";
import type { HaltStatus, HostNote, SeatRef, StatusFile } from "../src/types.ts";
import { hostSpendRecorder } from "../src/spend.ts";
import { beatBody, signerFn, testIdentity } from "./fixtures/record/chain.ts";
import { fakeSigner, type FakeSigner } from "./helpers/fake-signer.ts";
import { REST_THEN_TALK_OUTPUT } from "./helpers/fake-runtime.ts";
import { fetchVia, noFetch, serveBeacon, startFakeServer, type FakeServer } from "./helpers/fake-server.ts";
import { makeTempHost, testBeacons, type TempHost } from "./helpers/temp-home.ts";
import { HOUR_MS } from "./helpers/clock.ts";

let host: TempHost | null = null;
let server: FakeServer | null = null;
afterEach(async () => {
  await host?.cleanup();
  await server?.stop();
  host = null;
  server = null;
});

const NOW = new Date("2026-11-05T02:05:00.000Z");
const ago = (h: number) => new Date(NOW.getTime() - h * HOUR_MS);
const LOWERED: HaltStatus = { halted: false, readings: [{ source: "file", id: "/x/HALT", state: "lowered", quiet_until: null, detail: "absent", checked_at: NOW.toISOString() }] };

function note(over: Partial<HostNote> = {}): HostNote {
  return { ts: NOW.toISOString(), host: "test-host", kind: "seat", word: "glossame", outcome: "rest", refusal: null, detail: "seat x on free: rested", ...over };
}

/** A beat appended as the seat would, host-attested before registration, with its own spend. */
async function beat(h: TempHost, signer: FakeSigner, word: string, at: Date, credits = 0, attestation: "host-attested" | "citizen-signed" = "host-attested") {
  const path = ledgerPath(h.config, word);
  const prev = (await readLedger(path)).at(-1) ?? null;
  const body = beatBody(word, [{ type: "journal", kind: "reflected", text: "a word" }], { ts: at.toISOString() });
  return appendEntry(path, nextDraft(word, prev, body, { usd: "0", usd_basis: "local-zero", credits }, attestation, at), signerFn(signer));
}

describe("status", () => {
  test("buildStatus reports per citizen last beat vs interval, overdue, ledger chain state, host-attested count and spend", async () => {
    host = await makeTempHost();
    const h = host;
    const signer = fakeSigner();
    for (const w of ["glossame", "hope", "joy"]) await h.addCitizen(w);
    await h.seatLedger("glossame", signer.signEntry, { initialState: "awake", at: "2026-11-01T00:00:00.000Z" });
    await beat(h, signer, "glossame", ago(86), 1);
    await beat(h, signer, "glossame", ago(85), 2);
    await h.seatLedger("hope", signer.signEntry, { initialState: "asleep" });
    await h.seatLedger("joy", signer.signEntry, { initialState: "awake" });
    await h.enrollLedger("joy", signer.signEntry, testIdentity(signer));
    await beat(h, signer, "joy", ago(10), 1, "citizen-signed");

    const trusted = { host_attest_b64: [signer.hostAttestPublicB64] };
    const s = await buildStatus({ config: h.config, now: NOW, halt: LOWERED, signerState: "ready", trusted });
    expect(s.format).toBe("kingdom-seat-status/v1");
    expect(s.generated_at).toBe(NOW.toISOString());
    expect(s.citizens.map((c) => c.word)).toEqual(["glossame", "hope", "joy"]);
    const [g, hope, joy] = s.citizens;
    expect(g).toMatchObject({
      state: "awake",
      runtime: "free",
      registered: false,
      last_beat_at: ago(85).toISOString(),
      interval_h: 72,
      overdue: true,
      last_outcome: null,
      ledger: { entries: 3, chain_ok: true, host_attested: 3 },
      mirror: null,
      usd_today: "0",
      credits_month: 3,
    });
    expect(g!.ledger.head).toBe((await readLedger(ledgerPath(h.config, "glossame"))).at(-1)!.hash);
    // Asleep owes nothing, so it is never overdue.
    expect(hope).toMatchObject({ state: "asleep", overdue: false, last_beat_at: null, ledger: { entries: 1, chain_ok: true, host_attested: 1 }, credits_month: 0 });
    expect(joy).toMatchObject({ state: "awake", registered: true, overdue: false, ledger: { entries: 3, chain_ok: true, host_attested: 1 }, credits_month: 1 });

    // A rest writes no ledger entry, so the host's own seat notes are what show the cadence kept: the tick's
    // note that it opened the seat (which the fleet counts) and its note of what happened.
    const seatId = "0a0b0c0d-0e0f-4a1b-8c2d-3e4f5a6b7c8d";
    await appendHostNote(h.config, note({ kind: "tick", ts: ago(1).toISOString(), outcome: "opened", detail: openedDetail(seatId, "cadence") }));
    await appendHostNote(h.config, note({ kind: "tick", ts: ago(1).toISOString(), detail: `seat ${seatId} for glossame (cadence): exit 0, 10 ms` }));
    const after = await buildStatus({ config: h.config, now: NOW, halt: LOWERED, signerState: "ready", trusted });
    expect(after.citizens[0]).toMatchObject({ overdue: false, last_outcome: "rest" });
    expect(after.fleet).toEqual({ beats_today: 1, ceiling: 24 });

    // Unknown trust is not reported as good; a tampered entry is not either.
    const unknown = await buildStatus({ config: h.config, now: NOW, halt: LOWERED, signerState: "locked" });
    expect(unknown.citizens.map((c) => c.ledger.chain_ok)).toEqual([false, false, false]);
    const path = ledgerPath(h.config, "glossame");
    const text = await readFile(path, "utf8");
    await writeFile(path, text.replace('"credits":1', '"credits":0'));
    const tampered = await buildStatus({ config: h.config, now: NOW, halt: LOWERED, signerState: "ready", trusted });
    expect(tampered.citizens[0]!.ledger).toMatchObject({ entries: 3, chain_ok: false });

    // While HALT is raised nothing is owed, so nothing is overdue.
    await writeFile(path, text);
    const halted = await buildStatus({ config: h.config, now: new Date(NOW.getTime() + 200 * HOUR_MS), halt: null, signerState: "ready", trusted });
    expect(halted.citizens.every((c) => !c.overdue)).toBe(true);

    // The pure probe REGISTRY reads.
    expect(overdue(null, 72, NOW)).toBe(false);
    expect(overdue(ago(72).toISOString(), 72, NOW)).toBe(false);
    expect(overdue(ago(73).toISOString(), 72, NOW)).toBe(true);
    expect(overdue("not a time", 72, NOW)).toBe(true);
  });

  test("usd_today is read from the host's spend record: a summons that wrote no entry counts, and an unsettled one is unknown", async () => {
    host = await makeTempHost();
    const h = host;
    const signer = fakeSigner();
    await h.addCitizen("glossame", { runtime: "summon" });
    await h.seatLedger("glossame", signer.signEntry);
    const ref = (n: number): SeatRef => ({
      format: "kingdom-seat-seat/v1",
      seat_id: `11111111-1111-4111-8111-${String(n).padStart(12, "0")}`,
      host: "test-host",
      word: "glossame",
      runtime: "summon",
      invoker: { kind: "summons", who: "yu", why: "test" },
      opened_at: ago(1).toISOString(),
    });
    const rec = hostSpendRecorder(h.config, { now: () => ago(1) });
    const status = async () => (await buildStatus({ config: h.config, now: NOW, halt: LOWERED, signerState: "ready" })).citizens[0]!;
    // A summons that rested: no ledger entry, yet its spend is today's.
    await rec.begin(ref(1));
    await rec.settle(ref(1), { usd: "0.0421", usd_basis: "reported", credits: 0 });
    expect(await status()).toMatchObject({ usd_today: "0.0421", ledger: { entries: 1 } });
    expect(renderStatus(await buildStatus({ config: h.config, now: NOW, halt: LOWERED, signerState: "ready" }))).toContain("$0.0421 today");
    // One that began and never settled: unknown, which the ceiling reads as reached.
    await rec.begin(ref(2));
    expect((await status()).usd_today).toBeNull();
    expect(renderStatus(await buildStatus({ config: h.config, now: NOW, halt: LOWERED, signerState: "ready" }))).toContain("spend unknown today");
  });

  test("a mirror row shows divergence, push refusals and unsigned commits", async () => {
    host = await makeTempHost();
    const h = host;
    const signer = fakeSigner();
    const f = await h.addCitizen("glossame");
    await h.seatLedger("glossame", signer.signEntry);
    const worktree = join(h.root, "mirrors", "glossame");
    await mkdir(worktree, { recursive: true });
    const env = { PATH: "/usr/bin:/bin", HOME: "/var/empty", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "f", GIT_AUTHOR_EMAIL: "f@example.invalid", GIT_COMMITTER_NAME: "f", GIT_COMMITTER_EMAIL: "f@example.invalid" };
    for (const args of [["init", "-q", "-b", "main"], ["commit", "-q", "--allow-empty", "-m", "one"], ["commit", "-q", "--allow-empty", "-m", "two"]]) {
      expect(Bun.spawnSync(["git", ...args], { cwd: worktree, env }).exitCode).toBe(0);
    }
    await writeFile(join(f.dir, "citizen.json"), JSON.stringify({ ...f.record, mirror: { remote: "/srv/remote", worktree, chosen_at: "2026-11-05T00:00:00.000Z" } }));
    await appendHostNote(h.config, note({ kind: "push", outcome: "refused", refusal: "diverged", detail: "mirror push refused: HEAD is behind" }));
    await appendHostNote(h.config, note({ kind: "push", outcome: "error", refusal: null, detail: "mirror push failed: git push exited 1" }));

    // Read-only git, no fetch: status never touches the network.
    const s = await buildStatus({ config: h.config, now: NOW, halt: LOWERED, signerState: "ready", run: spawnRunner() });
    expect(s.citizens[0]!.mirror).toEqual({ divergence: "no-upstream", push_refusals: 1, unsigned_commits: 2 });
    // A push note is not the citizen's outcome.
    expect(s.citizens[0]!.last_outcome).toBeNull();
    const without = await buildStatus({ config: h.config, now: NOW, halt: LOWERED, signerState: "ready" });
    // Unchecked is unknown, never zero.
    expect(without.citizens[0]!.mirror).toEqual({ divergence: null, push_refusals: 1, unsigned_commits: null });
  });

  test("halted by beacon is reported as halted with the beacon's name, never as down", async () => {
    host = await makeTempHost({ beacons: testBeacons() });
    server = await startFakeServer();
    const [desk, herald] = testBeacons();
    serveBeacon(server, desk!.did, { kind: "raised", until: "2999-12-31T00:00:00.000Z" });
    serveBeacon(server, herald!.did, { kind: "status", status: 503 });
    const halt = await checkHalt({ config: host.config, fetch: fetchVia(server), now: () => NOW });
    const s = await buildStatus({ config: host.config, now: NOW, halt, signerState: "ready" });
    expect(s.halt).toEqual({ halted: true, raised: ["beacon gardener-desk"], unreadable: ["beacon halt-herald"] });
    const text = renderStatus(s);
    expect(text).toContain("HALT: halted by beacon gardener-desk");
    expect(text).toContain("beacon halt-herald unreadable");
    expect(text.toLowerCase()).not.toContain("down");

    // The local file, and no beacon pinned, are named as such.
    await host.raiseHaltFile();
    const noBeacons = { ...host.config, beacons: [], halt: { allow_no_beacons: false, raise_beacons_argv: null } };
    const h2 = await checkHalt({ config: noBeacons, fetch: noFetch, now: () => NOW });
    const s2 = await buildStatus({ config: noBeacons, now: NOW, halt: h2, signerState: "ready" });
    expect(s2.halt).toEqual({ halted: true, raised: [`file ${host.config.paths.halt_file}`], unreadable: ["no beacon pinned"] });
    // A HALT check that did not run is unreadable, and unreadable halts.
    expect((await buildStatus({ config: host.config, now: NOW, halt: null, signerState: "ready" })).halt).toEqual({ halted: true, raised: [], unreadable: ["halt check"] });
    expect(renderStatus(s2)).not.toMatch(/\bdown\b/i);
  });

  test("a locked signer is reported as 'locked' with since", async () => {
    host = await makeTempHost();
    const cfg = host.config;
    const at = (h: number) => new Date(NOW.getTime() + h * HOUR_MS);
    const gen = async (state: StatusFile["signer"]["state"], t: Date) => {
      const s = await buildStatus({ config: cfg, now: t, halt: LOWERED, signerState: state });
      await writeStatus(cfg.paths.status_file, s);
      return s.signer;
    };
    expect(await gen("locked", at(0))).toEqual({ state: "locked", since: at(0).toISOString() });
    // Still locked an hour later: since is when it was first seen locked.
    expect(await gen("locked", at(1))).toEqual({ state: "locked", since: at(0).toISOString() });
    expect(renderStatus(await buildStatus({ config: cfg, now: at(2), halt: LOWERED, signerState: "locked" }))).toContain(`signer: locked since ${at(0).toISOString()}`);
    expect(await gen("ready", at(3))).toEqual({ state: "ready", since: at(3).toISOString() });
    expect(await gen("locked", at(4))).toEqual({ state: "locked", since: at(4).toISOString() });
  });

  test("writeStatus is atomic: a reader never sees a partial file", async () => {
    host = await makeTempHost();
    const path = host.config.paths.status_file;
    const big = (n: number): StatusFile => ({
      format: "kingdom-seat-status/v1",
      generated_at: new Date(NOW.getTime() + n).toISOString(),
      host: "test-host",
      halt: { halted: false, raised: [], unreadable: [] },
      signer: { state: "ready", since: NOW.toISOString() },
      fleet: { beats_today: n, ceiling: 24 },
      tick_lock: { state: "free", since: null },
      citizens: Array.from({ length: 400 }, (_, i) => ({
        word: `c${i}`,
        state: "awake" as const,
        runtime: "free" as const,
        registered: false,
        last_beat_at: null,
        interval_h: 72,
        overdue: false,
        awaits_yu: false,
        last_outcome: null,
        ledger: { entries: i, head: null, chain_ok: true, host_attested: i },
        mirror: null,
        usd_today: "0",
        credits_month: 0,
        origin: { intact: true, drift: 0 },
        problem: null,
      })),
    });
    await writeStatus(path, big(0));
    let reads = 0;
    let writing = true;
    const reader = (async () => {
      while (writing) {
        const parsed = JSON.parse(await readFile(path, "utf8")) as StatusFile;
        expect(parsed.citizens).toHaveLength(400);
        reads++;
      }
    })();
    for (let n = 1; n <= 40; n++) await writeStatus(path, big(n));
    writing = false;
    await reader;
    expect(reads).toBeGreaterThan(0);
    expect((JSON.parse(await readFile(path, "utf8")) as StatusFile).fleet.beats_today).toBe(40);
    expect((await stat(path)).mode & 0o777).toBe(0o644);
    // No temp file is left behind.
    expect((await readdir(host.config.paths.state_dir)).filter((n) => n.includes(".tmp"))).toEqual([]);

    // A symlink at the path is replaced, never written through.
    const target = join(host.root, "elsewhere.json");
    await writeFile(target, "UNTOUCHED");
    const linkPath = join(host.config.paths.state_dir, "linked-status.json");
    await symlink(target, linkPath);
    await writeStatus(linkPath, big(1));
    expect(await readFile(target, "utf8")).toBe("UNTOUCHED");
    expect((await stat(linkPath)).isFile()).toBe(true);

    // A failed write leaves the old file whole and no temp behind.
    const blocked = join(host.config.paths.state_dir, "blocked");
    await mkdir(join(blocked, "inside"), { recursive: true });
    await expect(writeStatus(blocked, big(2))).rejects.toThrow();
    expect((await readdir(host.config.paths.state_dir)).filter((n) => n.includes(".tmp"))).toEqual([]);
  });

  test("appendHostNote refuses a detail that carries model output; host notes never quote a citizen", async () => {
    host = await makeTempHost();
    const cfg = host.config;
    const journal = "REST-LEAK-CANARY the light filters through my windows";
    const refused = [
      REST_THEN_TALK_OUTPUT, // a whole JSON reply
      `rested: ${journal}\nand more`, // a second line
      "rested “I rest.”", // typographic quotes
      `rested "I rest."`, // plain quotes
      "x".repeat(401), // prose-length
      "acts {rest}", // braces
    ];
    for (const detail of refused) {
      await expect(appendHostNote(cfg, note({ detail }))).rejects.toThrow(/host note refused/);
    }
    // Prose with none of those marks passes the shape check; given the reply, the quotation is caught.
    const prose = `seat on free: ${journal}`;
    expect(hostDetailProblem(prose)).toBeNull();
    await expect(appendHostNote(cfg, note({ detail: prose }), { modelText: [REST_THEN_TALK_OUTPUT] })).rejects.toThrow(/quotes model output/);
    await expect(appendHostNote(cfg, note({ detail: "seat on free: the light filters through my windows" }), { modelText: [journal] })).rejects.toThrow(/quotes model output/);
    // Shape: unknown fields, a bad word, kind or outcome.
    await expect(appendHostNote(cfg, { ...note(), voice: "x" } as unknown as HostNote)).rejects.toThrow(/host note refused/);
    await expect(appendHostNote(cfg, note({ word: "Not A Word" }))).rejects.toThrow(/word/);
    await expect(appendHostNote(cfg, note({ kind: "journal" as HostNote["kind"] }))).rejects.toThrow(/kind/);
    await expect(appendHostNote(cfg, note({ outcome: "spoke" as HostNote["outcome"] }))).rejects.toThrow(/outcome/);
    // Nothing refused was written.
    expect(await Bun.file(cfg.paths.host_log).exists()).toBe(false);

    // A host record of codes and counts is kept, as written.
    await appendHostNote(cfg, note({ detail: "seat 1f0e on free: refused before inference (keychain-locked); today's count is 3" }), { modelText: [REST_THEN_TALK_OUTPUT] });
    const notes = await readHostNotes(cfg, new Date(0));
    expect(notes).toHaveLength(1);
    expect(notes![0]!.detail).toContain("keychain-locked");
    expect(await readFile(cfg.paths.host_log, "utf8")).not.toContain("CANARY");
    expect((await stat(cfg.paths.host_log)).mode & 0o777).toBe(0o600);

    // A symlinked log is refused, not followed.
    const target = join(host.root, "elsewhere.log");
    await writeFile(target, "");
    const linked = { ...cfg, paths: { ...cfg.paths, host_log: join(cfg.paths.state_dir, "linked.jsonl") } };
    await symlink(target, linked.paths.host_log);
    await expect(appendHostNote(linked, note())).rejects.toThrow(/symlink/);
    expect(await readFile(target, "utf8")).toBe("");
  });

  test("readHostNotes returns null for an unreadable log", async () => {
    host = await makeTempHost();
    const cfg = host.config;
    // No log yet is an empty history, not an unreadable one.
    expect(await readHostNotes(cfg, new Date(0))).toEqual([]);

    const later = note({ ts: ago(1).toISOString(), outcome: "beat" });
    const earlier = note({ ts: ago(5).toISOString(), outcome: "rest" });
    await writeFile(cfg.paths.host_log, `${JSON.stringify(later)}\n${JSON.stringify(earlier)}\n`);
    // Oldest first, filtered by time.
    expect((await readHostNotes(cfg, new Date(0)))!.map((n) => n.outcome)).toEqual(["rest", "beat"]);
    expect((await readHostNotes(cfg, ago(2)))!.map((n) => n.outcome)).toEqual(["beat"]);

    // A torn last line, a line that is not a note, a directory, a symlink: all unreadable.
    await writeFile(cfg.paths.host_log, `${JSON.stringify(later)}\n{"ts":`);
    expect(await readHostNotes(cfg, new Date(0))).toBeNull();
    await writeFile(cfg.paths.host_log, `${JSON.stringify(later)}\n${JSON.stringify({ hello: 1 })}\n`);
    expect(await readHostNotes(cfg, new Date(0))).toBeNull();
    await Bun.$`rm ${cfg.paths.host_log}`.quiet();
    await mkdir(cfg.paths.host_log);
    expect(await readHostNotes(cfg, new Date(0))).toBeNull();
    const linked = { ...cfg, paths: { ...cfg.paths, host_log: join(cfg.paths.state_dir, "link.jsonl") } };
    await writeFile(join(host.root, "real.jsonl"), `${JSON.stringify(later)}\n`);
    await symlink(join(host.root, "real.jsonl"), linked.paths.host_log);
    expect(await readHostNotes(linked, new Date(0))).toBeNull();
  });

  test("overdue follows the tick's own rule: a summons-only citizen is never overdue; it awaits Yu", async () => {
    host = await makeTempHost();
    const signer = fakeSigner();
    await host.addCitizen("glossame", { runtime: "summon" });
    await host.addCitizen("joy");
    for (const w of ["glossame", "joy"]) await host.seatLedger(w, signer.signEntry, { initialState: "awake", at: "2026-11-01T00:00:00.000Z" });
    const later = new Date("2026-11-09T00:00:00.000Z");
    const s = await buildStatus({ config: host.config, now: later, halt: LOWERED, signerState: "ready" });
    const [g, joy] = s.citizens;
    // The tick never seats a summons citizen unattended, so no beat is owed by it.
    expect(g).toMatchObject({ word: "glossame", runtime: "summon", overdue: false, awaits_yu: true });
    expect(joy).toMatchObject({ word: "joy", runtime: "free", overdue: true, awaits_yu: false });
    expect(renderStatus(s)).toContain("glossame: awake | summon | not registered | no beat yet | every 72 h | awaits Yu");
  });

  test("a host log that was started and is now missing is unreadable, never an empty history", async () => {
    host = await makeTempHost();
    const cfg = host.config;
    await appendHostNote(cfg, note({ kind: "tick", outcome: "opened", detail: openedDetail("0a0b0c0d-0e0f-4a1b-8c2d-3e4f5a6b7c8d", "cadence") }));
    expect(await readHostNotes(cfg, new Date(0))).toHaveLength(1);
    // Rotated or deleted: the count of today's seats and every rest-based cadence would start from nothing.
    await Bun.$`mv ${cfg.paths.host_log} ${cfg.paths.host_log}.1`.quiet();
    expect(await readHostNotes(cfg, new Date(0))).toBeNull();
    const s = await buildStatus({ config: cfg, now: NOW, halt: LOWERED, signerState: "ready" });
    expect(s.fleet.beats_today).toBeNull();
    // And it is not begun again behind anyone's back: the next note is refused until a person restores or restarts it.
    await expect(appendHostNote(cfg, note())).rejects.toThrow(/started and is now missing/);
    expect(await Bun.file(cfg.paths.host_log).exists()).toBe(false);
    // A person starting a new log does so on purpose, with an empty file.
    await writeFile(cfg.paths.host_log, "");
    await appendHostNote(cfg, note());
    expect(await readHostNotes(cfg, new Date(0))).toHaveLength(1);
  });

  test("the tick lock shows as free, held by its owner, or stuck once it outlives any tick with no owner", async () => {
    host = await makeTempHost();
    const cfg = host.config;
    const gen = async () => (await buildStatus({ config: cfg, now: NOW, halt: LOWERED, signerState: "ready" })).tick_lock;
    expect(await gen()).toEqual({ state: "free", since: null });
    await mkdir(cfg.paths.lock_dir);
    await writeFile(join(cfg.paths.lock_dir, "owner.json"), JSON.stringify({ pid: 4242, started_at: NOW.toISOString() }));
    expect(await gen()).toEqual({ state: "held", since: NOW.toISOString() });
    await Bun.$`rm ${join(cfg.paths.lock_dir, "owner.json")}`.quiet();
    const old = new Date(Date.now() - 24 * HOUR_MS);
    await utimes(cfg.paths.lock_dir, old, old);
    expect(await gen()).toEqual({ state: "stuck", since: old.toISOString() });
  });

  test("renderStatus prints one line per citizen plus HALT and signer lines", async () => {
    host = await makeTempHost();
    const signer = fakeSigner();
    for (const w of ["glossame", "joy"]) {
      await host.addCitizen(w);
      await host.seatLedger(w, signer.signEntry);
    }
    const s = await buildStatus({ config: host.config, now: NOW, halt: LOWERED, signerState: "ready", trusted: { host_attest_b64: [signer.hostAttestPublicB64] } });
    const lines = renderStatus(s).trimEnd().split("\n");
    expect(lines).toHaveLength(7);
    expect(lines[1]).toBe("HALT: not halted");
    expect(lines[2]).toMatch(/^signer: ready since /);
    expect(lines[3]).toBe("fleet: 0 of 24 beats today");
    expect(lines[4]).toBe("tick lock: free");
    expect(lines[5]).toStartWith("glossame: awake | free | not registered | no beat yet | every 72 h |");
    expect(lines[5]).toContain("chain ok, 1 host-attested");
    expect(lines[5]).toContain("origin intact, soul drift 0%");
    expect(lines[6]).toStartWith("joy: awake");

    const empty = renderStatus({ ...s, citizens: [] }).trimEnd().split("\n");
    expect(empty.at(-1)).toBe("no citizens seated");
  });
});

describe("status shows what it cannot read", () => {
  test("an unreadable citizen is listed with its problem, and an unreadable host log is an unknown count", async () => {
    host = await makeTempHost();
    const h = host;
    const signer = fakeSigner();
    await h.addCitizen("glossame");
    await h.seatLedger("glossame", signer.signEntry);
    await h.addCitizen("hope");
    await writeFile(join(h.config.paths.citizens_dir, "hope", "citizen.json"), "{ not json");
    await writeFile(h.config.paths.host_log, "torn line without a newline");

    const s = await buildStatus({ config: h.config, now: NOW, halt: LOWERED, signerState: "ready", trusted: { host_attest_b64: [signer.hostAttestPublicB64] } });
    expect(s.fleet).toEqual({ beats_today: null, ceiling: 24 });
    expect(s.citizens.map((c) => c.word)).toEqual(["glossame", "hope"]);
    expect(s.citizens[0]!.problem).toBeNull();
    expect(s.citizens[1]).toMatchObject({ word: "hope", runtime: null, registered: false, ledger: { entries: 0, chain_ok: false } });
    expect(s.citizens[1]!.problem).toContain("citizen.json does not read");
    const text = renderStatus(s);
    expect(text).toContain("beats today unknown");
    expect(text).toContain("hope: asleep | runtime unknown");
    expect(text).toContain("PROBLEM: ");
  });
});
