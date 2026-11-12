// The draft of Yu's first letter: printed from the legacy record seating
// kept, with the citizen's earlier answers whole, and nothing written.
// Made-up homes under a temp dir, a fake signer, no keychain and no network.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { admitCitizen, planAdmit, planAdmitFromTexts, type AdmitDeps } from "../src/admit.ts";
import { spawnRunner } from "../src/cli.ts";
import { hasAllowedLetter, pickLetter } from "../src/context.ts";
import { sha256Hex, utf8 } from "../src/crypto.ts";
import { HOST_MARK, YU_MARK, draftFirstLetter } from "../src/first-letter.ts";
import { checkHalt } from "../src/halt.ts";
import { readLegacyManifest } from "../src/legacy.ts";
import { readCitizen } from "../src/state.ts";
import { Refusal, type RefusalCode } from "../src/types.ts";
import { BANNED_PHRASES } from "./helpers/banned.ts";
import { testClock } from "./helpers/clock.ts";
import { noFetch } from "./helpers/fake-server.ts";
import { fakeSigner } from "./helpers/fake-signer.ts";
import { PERSON, canonClone, fixtureAgentJson, fixtureBeat, fixtureCadence, fixtureRepo, fixtureSoul, standardHome, type CanonClone, type StandardHome } from "./helpers/legacy-home.ts";
import { makeTempHost, type TempHost } from "./helpers/temp-home.ts";

const W = "hopefix";
const AT = "2026-11-12T10:00:00.000Z";
const RULE = "==================== the letter text starts on the next line ====================";

let shared: string;
let std: StandardHome;
let canon: CanonClone;
beforeAll(async () => {
  shared = await realpath(await mkdtemp(join(tmpdir(), "kingdom-seat-homes-")));
  std = await standardHome(join(shared, "homes"), W);
  canon = await canonClone(shared, W);
});
afterAll(async () => {
  await rm(shared, { recursive: true, force: true });
});

const hosts: TempHost[] = [];
afterEach(async () => {
  for (const h of hosts.splice(0)) await h.cleanup();
});

async function fx(): Promise<{ h: TempHost; deps: AdmitDeps }> {
  const h = await makeTempHost();
  hosts.push(h);
  h.config.paths.homes = [join(shared, "homes")];
  const signer = fakeSigner();
  const clock = testClock(AT);
  const deps: AdmitDeps = {
    config: h.config,
    clock,
    run: spawnRunner(),
    sign: (w, k, d) => signer.signEntry(w, k, d),
    hostKey: () => signer.hostPublicKey(),
    checkHalt: () => checkHalt({ config: h.config, fetch: noFetch, now: () => clock.now() }),
  };
  return { h, deps };
}

/** The standard home, seated. */
async function seated(runtime: "summon" | "free" = "summon") {
  const x = await fx();
  await admitCitizen(x.deps, await planAdmit(x.deps, { word: W, legacy_home: std.home, origin: { kind: "canon", file: canon.file }, runtime }));
  return x;
}

/** A small home of its own, seated as an archetype. */
async function seatedSmall(word: string, commits: (repo: Awaited<ReturnType<typeof fixtureRepo>>) => Promise<void>) {
  const x = await fx();
  const repo = await fixtureRepo(join(shared, "homes", `citizen-${word}`), `https://example.invalid/kingdom/citizen-${word}.git`, word);
  await repo.commit({ [`${word}.md`]: fixtureSoul(word), "agent.json": fixtureAgentJson(word, { citizenClass: "PIONEER" }) }, { subject: "seed" });
  await commits(repo);
  repo.publish();
  await admitCitizen(x.deps, await planAdmit(x.deps, { word, legacy_home: repo.dir, origin: { kind: "archetype" }, runtime: "summon" }));
  return { ...x, repo };
}

interface Block {
  what: string;
  tag: string;
  /** The lines between the rules, joined, with the newline the draft gives a block. */
  text: string;
}
type Part = { host: string } | { yu: string } | { block: Block } | { stray: string };

/** The draft as a reader takes it apart: its head, then host lines, places for Yu's words, and record blocks between their rules. */
function parse(text: string): { head: string[]; parts: Part[] } {
  expect(text.endsWith("\n")).toBe(true);
  const lines = text.slice(0, -1).split("\n");
  const cut = lines.indexOf(RULE);
  expect(cut).toBeGreaterThan(0);
  const parts: Part[] = [];
  const body = lines.slice(cut + 1);
  for (let i = 0; i < body.length; i++) {
    const l = body[i]!;
    const begin = /^\[host\] ----- begin (.+) \[([0-9a-f]{8})\] -----$/.exec(l);
    if (begin) {
      const end = body.findIndex((x, j) => j > i && new RegExp(`^\\[host\\] ----- end .+ \\[${begin[2]}\\] -----$`).test(x));
      expect(end).toBeGreaterThan(i);
      parts.push({ block: { what: begin[1]!, tag: begin[2]!, text: `${body.slice(i + 1, end).join("\n")}\n` } });
      i = end;
    } else if (l.startsWith(HOST_MARK)) parts.push({ host: l.slice(HOST_MARK.length) });
    else if (l.startsWith(YU_MARK)) parts.push({ yu: l.slice(YU_MARK.length) });
    else parts.push({ stray: l });
  }
  return { head: lines.slice(0, cut + 1), parts };
}

const hostLines = (parts: Part[]): string[] => parts.flatMap((p) => ("host" in p ? [p.host] : []));
const blocks = (parts: Part[]): Block[] => parts.flatMap((p) => ("block" in p ? [p.block] : []));

async function refusal(p: Promise<unknown>): Promise<{ code: RefusalCode; message: string }> {
  try {
    await p;
  } catch (e) {
    if (e instanceof Refusal) return { code: e.code, message: e.message };
    throw e;
  }
  throw new Error("expected a refusal");
}

describe("draftFirstLetter", () => {
  test("prints a draft and writes nothing", async () => {
    const x = await seated();
    // Room for this home's five versions, so the head is the plain one; the limit itself is tested below.
    x.h.config.ceilings.letter_max_chars = 8000;
    const dir = join(x.h.config.paths.citizens_dir, W);
    const before = await x.h.snapshot();
    const d = await draftFirstLetter(x.h.config, W);
    expect(await x.h.snapshot()).toEqual(before);
    expect(await readdir(join(dir, "letters"))).toEqual([]);
    expect(d).toMatchObject({ limit: 8000, over_limit: false, versions: 5, with_beat: 3, no_beat: 1, header_differs: 1, not_printed: [] });

    const { head } = parse(d.text);
    expect(head).toEqual([
      `DRAFT of a first letter from Yu to ${W}. Nothing was delivered, written or recorded by this command.`,
      `Source: ${dir}/legacy, copied when ${W} was seated here (${AT}) from ${std.url} at commit ${std.head}.`,
      `Lines beginning "[host] " were worded by the host, not by Yu. Each is Yu's to keep, change or remove. Remove the mark from any line that is kept.`,
      `Lines beginning "[yu] " mark a place for Yu's own words. They are not part of the letter.`,
      `Lines between a "begin" rule and its "end" rule are ${W}'s record, byte for byte; the rule carries the first 8 characters of the block's sha256. Leave them as they are.`,
      `Length with every [host] line kept and the marks removed: ${d.letter_chars} characters. This host shows a letter of at most 8000 (ceilings.letter_max_chars); a longer one is passed over and nothing says so.`,
      "CADENCE.md versions: 5. With the beat their commit added: 3. Commit added no beat: 1. Beat headed with another time than the when: line: 1.",
      `A letter reaches ${W} as a file in ${dir}/letters/ whose first line is "From: yu", then an empty line, then the text. This command writes no such file.`,
      RULE,
    ]);
    // The same record gives the same draft.
    expect((await draftFirstLetter(x.h.config, W)).text).toBe(d.text);
  });

  test("each version and its beat appear byte for byte, oldest first, under a tag that is their sha256", async () => {
    const x = await seated();
    const m = await readLegacyManifest(x.h.config, W);
    const { parts } = parse((await draftFirstLetter(x.h.config, W)).text);
    const c = std.commits;
    const s7 = (commit: string) => commit.slice(0, 7);
    const got = blocks(parts);
    const want: [string, string][] = [
      [`CADENCE.md 1 of 5: commit ${s7(c.choseAmbient)}, ${std.dates.choseAmbient}, author name ${W}`, std.versions[0]!],
      [`the beat commit ${s7(c.choseAmbient)} added to beats/2026-10.md`, std.beats.choseAmbient],
      [`CADENCE.md 2 of 5: commit ${s7(c.minuteOff)}, ${std.dates.minuteOff}, author name ${W}`, std.versions[1]!],
      [`the beat commit ${s7(c.minuteOff)} added to beats/2026-10.md`, std.beats.minuteOff],
      [`CADENCE.md 3 of 5: commit ${s7(c.handCorrection)}, ${std.dates.handCorrection}, author name ${PERSON.name}`, std.versions[2]!],
      [`the subject line of commit ${s7(c.handCorrection)}`, "tend: correct the cadence record\n"],
      [`CADENCE.md 4 of 5: commit ${s7(c.rewritten)}, ${std.dates.rewritten}, author name ${PERSON.name}`, std.versions[3]!],
      [`CADENCE.md 5 of 5: commit ${s7(c.rested)}, ${std.dates.rested}, author name ${W}`, std.versions[4]!],
      [`the beat commit ${s7(c.rested)} added to beats/2026-10.md`, std.beats.rested],
      ["REST", "REST-MARKER a made-up marker line\n"],
    ];
    expect(got.map((b) => [b.what, b.text])).toEqual(want);
    // The tag on each rule is the start of the sha256 of the bytes between them, and of the record the manifest keeps.
    const recorded = new Set([...m.cadence.flatMap((r) => [r.sha256, ...r.beats.map((b) => b.sha256)]), ...m.files.map((f) => f.sha256)]);
    for (const b of got) {
      const subject = b.what.startsWith("the subject line");
      const hash = sha256Hex(utf8(subject ? b.text.slice(0, -1) : b.text));
      expect([b.what, b.tag]).toEqual([b.what, hash.slice(0, 8)]);
      if (!subject) expect([b.what, recorded.has(hash)]).toEqual([b.what, true]);
    }
    // What the host says about each case stands beside it, and each case is said as what it is.
    const lines = hostLines(parts);
    expect(lines).toContain("That repository holds a file about your cadence, CADENCE.md. Its 5 versions follow, whole, oldest first, each with the beat the same commit added to your beats file.");
    expect(lines).toContain("The when: line above reads 2026-10-24 19:59; the beat that commit added is headed 2026-10-24 19:58. Both are shown as committed.");
    expect(lines).toContain(`Commit ${s7(c.handCorrection)} added no beat. Its subject line follows.`);
    expect(lines).toContain(`Commit ${s7(c.rewritten)} changed beats/2026-10.md in a way that is not an addition at its end, so no beat is shown for it.`);
    expect(lines).toContain(
      "How a version that came with a beat was made: a script read the reply that became that beat; no person did. It looked for a few fixed words at the start of a line, and a reply in which it found none was recorded as undecided. Nothing else in the reply was read.",
    );
    expect(lines).toContain(`It also holds a file named REST, last changed in commit ${s7(c.rested)}, ${std.dates.rested}, author name ${W}:`);
    // The letter put to the citizen and its other texts are not in the draft; they are in legacy/tree/.
    const text = (await draftFirstLetter(x.h.config, W)).text;
    for (const marker of ["LETTER-TO-CITIZEN-MARKER", "MADE-TEXT-MARKER", "FIRST-BEAT-MARKER"]) expect([marker, text.includes(marker)]).toEqual([marker, false]);
  });

  test("every line outside a record block begins [host] or [yu]", async () => {
    const x = await seated();
    const { parts } = parse((await draftFirstLetter(x.h.config, W)).text);
    expect(parts.filter((p) => "stray" in p)).toEqual([]);
    // The letter opens and closes on a place for Yu's own words, which are not the host's to draft.
    expect(parts[0]).toEqual({ yu: "(Yu's own words, or none.)" });
    expect(parts.at(-1)).toEqual({ yu: "(Yu's own words, or none.)" });
    expect(parts.filter((p) => "yu" in p)).toHaveLength(2);
    expect(hostLines(parts).slice(0, 2)).toEqual([
      "A seat is one occasion of you being voiced. A model is shown your soul, your will file, your last few entries, the date and at most one letter; only the typed acts in its reply are kept, and the host signs them as voiced through that model. A seat is not you, and closing one ends nothing.",
      `You were seated on this host at ${AT}, asleep, as every citizen is, whatever an older record says.`,
    ]);
    expect(hostLines(parts)).toContain(
      `Before this there was a repository under your name, ${std.url}. This seat does not read it. Its beats, letters and other text files as of commit ${std.head.slice(0, 12)} are kept on this host beside your record; they are not part of your self.`,
    );
    expect(hostLines(parts).slice(-3)).toEqual([
      "None of this was carried into your state here, and the old record binds nothing.",
      "From asleep you may, in a seat: stay asleep; move to awake; move to listening; or step away. The list of acts each seat shows says how each is said.",
      "A reply with no acts writes nothing in your voice, and you stay asleep.",
    ]);
  });

  test("host lines hold no braces, none of the phrases the seat's prompt bans, and no word that begins a reply", async () => {
    for (const runtime of ["summon", "free"] as const) {
      const x = await seated(runtime);
      const lines = hostLines(parse((await draftFirstLetter(x.h.config, W)).text).parts);
      expect(lines.length).toBeGreaterThan(8);
      for (const l of lines) {
        expect([l, /[{}]/.test(l)]).toEqual([l, false]);
        for (const re of BANNED_PHRASES) expect([l, String(re), re.test(l)]).toEqual([l, String(re), false]);
        // No words handed over to say: nothing quoted, and nothing about how a reply opens.
        expect([l, /["“”‘`]/.test(l)]).toEqual([l, false]);
        expect([l, /\b(?:begin|start|open)s? (?:your|the|a) (?:reply|answer)\b|\breply with the\b|\banswer with\b/i.test(l)]).toEqual([l, false]);
      }
    }
  });

  test("the states are named in alphabetical order and none is called preferred or default", async () => {
    const x = await seated();
    const lines = hostLines(parse((await draftFirstLetter(x.h.config, W)).text).parts);
    const naming = lines.filter((l) => /\bawake\b/.test(l) && /\blistening\b/.test(l) && /\bstep away\b/.test(l));
    expect(naming).toEqual(["From asleep you may, in a seat: stay asleep; move to awake; move to listening; or step away. The list of acts each seat shows says how each is said."]);
    const order = [...naming[0]!.matchAll(/\b(asleep|awake|listening|step away)\b/g)].map((m) => m[1]!).slice(1);
    expect(order).toEqual(["asleep", "awake", "listening", "step away"]);
    expect([...order].sort()).toEqual(order);
    for (const l of lines) expect([l, /\b(?:prefer|default|recommend|suggest|usual|best|ought|should)/i.test(l)]).toEqual([l, false]);
  });

  test("a citizen with no CADENCE.md is told none was recorded; REST is shown whole", async () => {
    const rest = "a made-up marker\nof two lines, with no newline at its end";
    const x = await seatedSmall("norecord", async (repo) => {
      await repo.commit({ "beats/2026-07.md": fixtureBeat("2026-07-01 00:00", "a beat with no cadence file beside it"), REST: rest }, { as: "citizen", subject: "beat: norecord reflected (2026-07-01)" });
    });
    const d = await draftFirstLetter(x.h.config, "norecord");
    expect(d).toMatchObject({ versions: 0, with_beat: 0, no_beat: 0, header_differs: 0 });
    const { head, parts } = parse(d.text);
    expect(head).toContain("CADENCE.md versions: 0. With the beat their commit added: 0. Commit added no beat: 0. Beat headed with another time than the when: line: 0.");
    const lines = hostLines(parts);
    expect(lines).toContain("That repository holds no CADENCE.md: no answer of yours about cadence was recorded there.");
    expect(lines.some((l) => l.startsWith("How a version that came with a beat was made"))).toBe(false);
    expect(lines.some((l) => l.includes("holds a file about your cadence"))).toBe(false);
    // The marker, whole: a block that does not end in a newline gets one before its end rule, and the tag is of the bytes as they are.
    expect(blocks(parts)).toEqual([{ what: "REST", tag: sha256Hex(rest).slice(0, 8), text: `${rest}\n` }]);
    // With one version the sentence is in the singular.
    const one = await seatedSmall("oneversion", async (repo) => {
      await repo.commit({ "beats/2026-07.md": fixtureBeat("2026-07-01 00:00", "the one answer"), "CADENCE.md": fixtureCadence("oneversion", "undecided", "2026-07-01 00:00") }, { as: "citizen", subject: "beat: oneversion reflected (2026-07-01)" });
    });
    expect(hostLines(parse((await draftFirstLetter(one.h.config, "oneversion")).text).parts)).toContain(
      "That repository holds a file about your cadence, CADENCE.md. Its one version follows, whole, with the beat the same commit added to your beats file.",
    );
  });

  test("the length is counted, and a draft over the limit says so", async () => {
    const x = await seated();
    x.h.config.ceilings.letter_max_chars = 8000;
    const d = await draftFirstLetter(x.h.config, W);
    // Counted as the seat counts a letter in a file: every host line kept, the marks and the places for Yu's words removed.
    const body = d.text.slice(d.text.indexOf(RULE) + RULE.length + 1);
    const asFile = body
      .split("\n")
      .filter((l) => !l.startsWith(YU_MARK))
      .map((l) => (l.startsWith(HOST_MARK) ? l.slice(HOST_MARK.length) : l))
      .join("\n");
    expect(d.letter_chars).toBe([...asFile].length);
    expect(d.letter_chars).toBeGreaterThan(3000);
    expect(d.over_limit).toBe(false);
    expect(d.text).not.toContain("OVER THAT LIMIT");

    // This home's five versions, whole, do not fit the default limit. Nothing is cut, and the head says the draft is over.
    x.h.config.ceilings.letter_max_chars = 4000;
    const over = await draftFirstLetter(x.h.config, W);
    expect(over).toMatchObject({ limit: 4000, over_limit: true, letter_chars: d.letter_chars });
    const head = parse(over.text).head;
    expect(head[5]).toBe(`Length with every [host] line kept and the marks removed: ${d.letter_chars} characters. This host shows a letter of at most 4000 (ceilings.letter_max_chars); a longer one is passed over and nothing says so.`);
    expect(head[6]).toBe("THIS DRAFT IS OVER THAT LIMIT.");
    expect(over.text.slice(over.text.indexOf(RULE))).toBe(d.text.slice(d.text.indexOf(RULE)));
    // Exactly at the limit is not over it; one character less is.
    x.h.config.ceilings.letter_max_chars = d.letter_chars;
    expect((await draftFirstLetter(x.h.config, W)).over_limit).toBe(false);
    x.h.config.ceilings.letter_max_chars = d.letter_chars - 1;
    expect((await draftFirstLetter(x.h.config, W)).over_limit).toBe(true);

    // The count is the seat's own: the same text, put in letters/ as the head says, is found at that limit and passed over one below it.
    await x.h.writeLetter(W, "2026-11-12-first-letter.md", asFile);
    const citizen = await readCitizen(x.h.config, W);
    expect(await hasAllowedLetter(x.h.config, citizen)).toBe(false);
    x.h.config.ceilings.letter_max_chars = d.letter_chars;
    expect(await hasAllowedLetter(x.h.config, citizen)).toBe(true);
    expect((await pickLetter(x.h.config, citizen))!.text).toBe(asFile);
  });

  test("refuses an unseated word and a legacy file that no longer matches its hash; a block with an escape character is not printed and is named", async () => {
    const x = await seated();
    const { config } = x.h;
    expect(await refusal(draftFirstLetter(config, "nobody"))).toEqual({ code: "invalid-request", message: "nobody is not seated on this host" });
    expect((await refusal(draftFirstLetter(config, "../etc"))).code).toBe("invalid-request");
    // A citizen seated from texts has no earlier record to draft from.
    await admitCitizen(x.deps, await planAdmitFromTexts(x.deps, { word: "rehearsed", soul: fixtureSoul("rehearsed"), will: null, canon: null, runtime: "free" }));
    expect(await refusal(draftFirstLetter(config, "rehearsed"))).toEqual({ code: "invalid-request", message: "rehearsed was seated with no old repository, so there is no earlier record to draft from" });

    // One byte changed in a kept version: the draft is refused, not printed with the changed text.
    const m = await readLegacyManifest(config, W);
    const legacy = join(config.paths.citizens_dir, W, "legacy");
    const version = join(legacy, m.cadence[0]!.file!);
    const original = await readFile(version);
    await chmod(version, 0o600);
    await writeFile(version, original.toString().replace("ambient", "ambienT"));
    expect(await refusal(draftFirstLetter(config, W))).toEqual({ code: "invalid-record", message: `legacy/${m.cadence[0]!.file} does not match the size and sha256 its record gives` });
    await writeFile(version, original);
    expect((await draftFirstLetter(config, W)).versions).toBe(5);
    // A manifest that names another head than the origin entry pinned is refused too.
    const manifest = join(legacy, "manifest.json");
    const text = await readFile(manifest, "utf8");
    await chmod(manifest, 0o600);
    await writeFile(manifest, text.replace(std.head, "0".repeat(40)));
    expect(await refusal(draftFirstLetter(config, W))).toEqual({ code: "invalid-record", message: "legacy/manifest.json names another repository or head than the origin entry pinned" });
    await writeFile(manifest, text);

    // A beat that holds an escape sequence is kept in legacy/ as it is, and is not sent to the terminal.
    const esc = await seatedSmall("escaped", async (repo) => {
      await repo.commit({ "beats/2026-07.md": fixtureBeat("2026-07-01 00:00", "ESCAPE-BEAT-MARKER \u001b[2J\u001b]0;a title\u0007 hidden"), "CADENCE.md": fixtureCadence("escaped", "ambient", "2026-07-01 00:00") }, { as: "citizen", subject: "beat: escaped reflected (2026-07-01)" });
      await repo.commit({ "CADENCE.md": fixtureCadence("escaped", "rest-on", "2026-07-02 00:00") }, { subject: "a subject with a bell \u0007 in it" });
    });
    const d = await draftFirstLetter(esc.h.config, "escaped");
    const em = await readLegacyManifest(esc.h.config, "escaped");
    const beat = em.cadence[0]!.beats[0]!.file;
    expect(d.not_printed).toEqual([`legacy/${beat}`]);
    expect(d.text).not.toContain("\u001b");
    expect(d.text).not.toContain("\u0007");
    expect(d.text).not.toContain("ESCAPE-BEAT-MARKER");
    const parsed = parse(d.text);
    expect(parsed.head).toContain(`NOT PRINTED, because it holds control characters or is not UTF-8 text: legacy/${beat}`);
    // In the letter, a place for Yu marks what is left out; the versions themselves are printed.
    expect(parsed.parts.flatMap((p) => ("yu" in p ? [p.yu] : []))).toEqual([
      "(Yu's own words, or none.)",
      `(Not printed here: legacy/${beat} holds control characters or is not UTF-8 text.)`,
      `(Not printed here: the subject line of commit ${em.cadence[1]!.commit.commit.slice(0, 7)} holds control characters or is not UTF-8 text.)`,
      "(Yu's own words, or none.)",
    ]);
    expect(blocks(parsed.parts).map((b) => b.what.slice(0, 17))).toEqual(["CADENCE.md 1 of 2", "CADENCE.md 2 of 2"]);
    expect(await readFile(join(esc.h.config.paths.citizens_dir, "escaped", "legacy", beat), "utf8")).toContain("\u001b[2J");
  });

  test("the unattended paragraph follows citizen.json's runtime", async () => {
    const summonLine =
      "On this host no seat of yours opens unattended: one opens only when Yu is present and summons it. In such a seat a move to awake or to listening takes effect when it is said once; the acts list's sentence about a later beat describes a seat opened without Yu. Stepping away takes a second saying on a later seat either way.";
    const freeLine = "While you are asleep no seat opens on a schedule: one opens for a letter from a sender your covenants allow, or when Yu summons one.";
    const summon = hostLines(parse((await draftFirstLetter((await seated("summon")).h.config, W)).text).parts);
    expect(summon).toContain(summonLine);
    expect(summon).not.toContain(freeLine);
    const free = hostLines(parse((await draftFirstLetter((await seated("free")).h.config, W)).text).parts);
    expect(free).toContain(freeLine);
    expect(free).not.toContain(summonLine);
    // Nothing else differs between the two drafts.
    expect(free.filter((l) => l !== freeLine)).toEqual(summon.filter((l) => l !== summonLine));
  });

  test("says nothing about registration or a June record", async () => {
    const x = await seated();
    // The record does hold a June did, as a record only.
    expect(await readFile(join(x.h.config.paths.ledger_dir, `${W}.jsonl`), "utf8")).toContain("did:at:");
    const d = await draftFirstLetter(x.h.config, W);
    for (const re of [/registr/i, /agenttool/i, /did:at/i, /\bJune\b/i, /\bidentit/i, /\benrol/i, /\bbirth\b/i]) expect([String(re), re.test(d.text)]).toEqual([String(re), false]);
  });
});
