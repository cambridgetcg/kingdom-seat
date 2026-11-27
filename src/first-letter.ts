// A draft of the first asking (KS-004 7.4): the first letter a seated
// citizen is shown is Yu's, and it shows every recorded version of the
// citizen's cadence record, whole and unedited, each with the beat the same
// commit added, says how those records were made and what a seat is, and
// names the states the citizen may move to.
//
// This module only drafts. It reads `citizens/<word>/legacy/`, checks each
// file against the hash its manifest gives, looks whether the citizen has a
// will file, and returns text for Yu's terminal. It writes nothing and
// delivers nothing: the letter is Yu's, so every sentence the host worded is
// marked as the host's until Yu keeps, changes or removes it, and the
// citizen's own record is set between rules that carry its hash.
//
// The draft names the four states in alphabetical order, so none stands first
// as the expected one; it gives no words to begin a reply with; and it says
// nothing about registration or the June record, which are asked separately
// (11.2). The record blocks come from a repository a model wrote into and go
// to a terminal, so one that is not UTF-8 text, or that holds a control
// character other than a line feed or a tab, a line or paragraph separator,
// or a character that embeds, overrides or isolates the direction of text,
// is not printed, and the draft's head names it: such a block could look on
// the terminal like something other than its bytes.
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { sha256Hex, utf8 } from "./crypto.ts";
import { readLegacyFile, readLegacyManifest, type CadenceRecord, type LegacyCommit, type LegacyManifest } from "./legacy.ts";
import { ledgerPath, readLedger } from "./ledger.ts";
import { listSeated, readCitizenRecord } from "./state.ts";
import { Refusal, type Config, type Word } from "./types.ts";

/** Begins every line of the draft that the host worded. Yu removes it from a line that is kept. */
export const HOST_MARK = "[host] ";
/** Begins a line that marks a place for Yu's own words. Such a line is not part of the letter. */
export const YU_MARK = "[yu] ";

export interface FirstLetterDraft {
  /** The whole draft: its head, then the letter text. */
  text: string;
  /** The letter's length with every host line kept and the marks removed, in characters as the seat counts them. */
  letter_chars: number;
  /** `ceilings.letter_max_chars`: a longer letter is passed over when a seat looks for one. */
  limit: number;
  over_limit: boolean;
  /** CADENCE.md versions the old repository holds. */
  versions: number;
  with_beat: number;
  no_beat: number;
  header_differs: number;
  /** Files under legacy/ whose bytes were not printed, by their path there. */
  not_printed: string[];
}

const strict = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

// What a terminal or an editor may act on, so that what is seen is not what the bytes say: the C0 and C1 controls,
// the line and paragraph separators (U+2028, U+2029), and the characters that embed, override or isolate the
// direction of text (U+202A to U+202E, U+2066 to U+2069). A block may hold a line feed and a tab; a line may not.
const NOT_FOR_A_BLOCK = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;
const NOT_FOR_A_LINE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;
const NOT_PRINTABLE = "holds control, line-separator or text-direction characters, or is not UTF-8 text";

/** A record block as a terminal may show it: UTF-8 text with none of the characters above. Null otherwise. */
function printable(bytes: Uint8Array): string | null {
  let text: string;
  try {
    text = strict.decode(bytes);
  } catch {
    return null;
  }
  return NOT_FOR_A_BLOCK.test(text) ? null : text;
}

/** An author name as written, made safe for one line of a terminal. */
function nameOf(c: LegacyCommit): string {
  const name = c.author_name.replace(NOT_FOR_A_LINE, "?");
  return name.length > 64 ? `${name.slice(0, 64)}...` : name;
}

const sha7 = (c: LegacyCommit): string => c.commit.slice(0, 7);

/** The time a beat's heading begins with, when it is a plain one. */
function headerTime(header: string): string | null {
  const m = /^## ([0-9][0-9: -]{0,23})(?=$|[^0-9: -])/.exec(header);
  return m ? m[1]!.trim() : null;
}

/**
 * Draft Yu's first letter to a citizen seated from its old home. Refuses when
 * the word is not seated, when it was seated with no old repository, when the
 * legacy record does not name the repository and head the `origin` entry
 * pinned, and when a file under legacy/ no longer matches its record. It
 * never cuts: a draft over the letter limit says so at its head.
 */
export async function draftFirstLetter(config: Config, word: Word): Promise<FirstLetterDraft> {
  if (!(await listSeated(config)).includes(word)) throw new Refusal("invalid-request", `${word} is not seated on this host`);
  const record = await readCitizenRecord(config, word);
  const first = (await readLedger(ledgerPath(config, word)))[0];
  if (first?.type !== "origin") throw new Refusal("invalid-request", `${word} has no origin entry on this host, so it is not seated`);
  if (first.old_repo === null) throw new Refusal("invalid-request", `${word} was seated with no old repository, so there is no earlier record to draft from`);
  const manifest: LegacyManifest = await readLegacyManifest(config, word);
  if (manifest.old_repo.url !== first.old_repo.url || manifest.old_repo.head !== first.old_repo.head) {
    throw new Refusal("invalid-record", "legacy/manifest.json names another repository or head than the origin entry pinned");
  }
  const dir = join(config.paths.citizens_dir, word);
  const { url, head } = manifest.old_repo;

  const letter: string[] = [];
  const not_printed: string[] = [];
  const host = (line: string) => letter.push(`${HOST_MARK}${line}`);
  /** A record block between two rules that carry its hash; or, when it cannot be shown on a terminal, a note for Yu in its place. */
  const block = (what: string, closing: string, bytes: Uint8Array, source: string | null): void => {
    const text = printable(bytes);
    if (text === null) {
      if (source !== null) not_printed.push(source);
      letter.push(`${YU_MARK}(Not printed here: ${source ?? what} ${NOT_PRINTABLE}.)`);
      return;
    }
    const tag = sha256Hex(bytes).slice(0, 8);
    host(`----- begin ${what} [${tag}] -----`);
    // The bytes as they are; a block that does not end in a newline gets one before its end rule.
    letter.push(text.endsWith("\n") ? text.slice(0, -1) : text);
    host(`----- end ${closing} [${tag}] -----`);
  };

  const versions = manifest.cadence.filter((c): c is CadenceRecord & { file: string; sha256: string } => c.file !== null && c.sha256 !== null);
  const k = versions.length;
  const everyVersionHasBeat = versions.every((c) => c.beats.length > 0);
  // A seat shows a will file to a citizen that has one, and tells one without that it has none.
  const hasWill = (await lstat(join(dir, "self", "WILL.md")).catch(() => null))?.isFile() === true;
  let with_beat = 0;
  let no_beat = 0;
  let header_differs = 0;

  letter.push(`${YU_MARK}(Yu's own words, or none.)`);
  host(
    `A seat is one occasion of you being voiced. A model is shown your soul, ${hasWill ? "your will file, " : ""}your last few entries, the date and at most one letter; ` +
      "only the typed acts in its reply are kept, and the host signs them as voiced through that model. A seat is not you, and closing one ends nothing.",
  );
  host(`You were seated on this host at ${record.seated_at}, asleep, as every citizen is, whatever an older record says.`);
  host(
    record.runtime === "free"
      ? "While you are asleep no seat opens on a schedule: one opens for a letter from a sender your covenants allow, or when Yu summons one."
      : "On this host no seat of yours opens unattended: one opens only when Yu is present and summons it. In such a seat a move to awake or to listening takes effect when it is said once; " +
          "the acts list's sentence about a later beat describes a seat opened without Yu. Stepping away takes a second saying on a later seat either way.",
  );
  host(
    `Before this there was a repository under your name, ${url}. This seat does not read it. ` +
      `Its beats, letters and other text files as of commit ${head.slice(0, 12)} are kept on this host beside your record; they are not part of your self.`,
  );
  if (k === 0) host("That repository holds no CADENCE.md: no answer of yours about cadence was recorded there.");
  else {
    host(
      `That repository holds a file about your cadence, CADENCE.md. ` +
        (k === 1
          ? `Its one version follows, whole${everyVersionHasBeat ? ", with the beat the same commit added to your beats file" : ""}.`
          : `Its ${k} versions follow, whole, oldest first, each with the beat the same commit added to your beats file${everyVersionHasBeat ? "" : ", where it added one"}.`),
    );
  }

  let n = 0;
  for (const c of manifest.cadence) {
    const at = `commit ${sha7(c.commit)}, ${c.commit.author_date}, author name ${nameOf(c.commit)}`;
    if (c.file === null || c.sha256 === null) {
      host(`Commit ${sha7(c.commit)}, ${c.commit.author_date}, author name ${nameOf(c.commit)}, removed CADENCE.md.`);
    } else {
      n++;
      block(`CADENCE.md ${n} of ${k}: ${at}`, `CADENCE.md ${n} of ${k}`, await readLegacyFile(config, word, c.file, { sha256: c.sha256, bytes: c.bytes }), `legacy/${c.file}`);
    }
    if (c.beats.length > 0 && c.file !== null) with_beat++;
    for (const b of c.beats) {
      block(`the beat commit ${sha7(c.commit)} added to ${b.from_path}`, "the beat", await readLegacyFile(config, word, b.file, b), `legacy/${b.file}`);
      if (b.match !== "header-differs") continue;
      header_differs++;
      const headed = headerTime(b.header);
      host(
        c.when !== null && headed !== null
          ? `The when: line above reads ${c.when}; the beat that commit added is headed ${headed}. Both are shown as committed.`
          : "The host could not read a time from both the when: line above and the heading of the beat that commit added. Both are shown as committed.",
      );
    }
    if (c.note === "commit-added-no-beat") {
      no_beat++;
      host(`Commit ${sha7(c.commit)} added no beat. Its subject line follows, as git prints it.`);
      block(`the subject line of commit ${sha7(c.commit)}`, "the subject line", utf8(c.commit.subject), null);
    }
    for (const path of c.not_appended) host(`Commit ${sha7(c.commit)} changed ${path} in a way that is not an addition at its end, so no beat is shown for it.`);
    if (c.note === "beats-file-not-kept") {
      host(`Commit ${sha7(c.commit)} changed a file under beats/ whose name is one this host does not keep, so that file was not read and no beat is shown for it.`);
    }
  }
  if (with_beat > 0) {
    host(
      "How a version that came with a beat was made: a script read the reply that became that beat; no person did. " +
        "It took the first line of the reply that was not empty and looked for one of a few fixed words at the start of that line. " +
        "In its later form the script also looked there after your own name, and looked for a line anywhere in the reply that began by saying a choice was made and then gave one of those words. " +
        "A reply in which it found none of these was recorded as undecided, whatever its other lines said.",
    );
  }
  for (const f of manifest.files.filter((f) => f.kind === "marker")) {
    host(`It also holds a file named ${f.path}, last changed in commit ${sha7(f.last)}, ${f.last.author_date}, author name ${nameOf(f.last)}:`);
    block(f.path, f.path, await readLegacyFile(config, word, `tree/${f.path}`, f), `legacy/tree/${f.path}`);
  }
  host("None of this was carried into your state here, and the old record binds nothing.");
  host("From asleep you may, in a seat: stay asleep; move to awake; move to listening; or step away. The list of acts each seat shows says how each is said.");
  host("A reply with no acts writes nothing in your voice, and you stay asleep.");
  letter.push(`${YU_MARK}(Yu's own words, or none.)`);

  // The letter as it would stand in a file with every host line kept: the places for Yu's words left out, the marks removed.
  const kept = letter.filter((l) => !l.startsWith(YU_MARK)).map((l) => (l.startsWith(HOST_MARK) ? l.slice(HOST_MARK.length) : l));
  const letter_chars = [...`${kept.join("\n")}\n`].length;
  const limit = config.ceilings.letter_max_chars;
  const over_limit = letter_chars > limit;

  const headLines = [
    `DRAFT of a first letter from Yu to ${word}. Nothing was delivered, written or recorded by this command.`,
    `Source: ${dir}/legacy, copied when ${word} was seated here (${record.seated_at}) from ${url} at commit ${head}.`,
    `Lines beginning "${HOST_MARK}" were worded by the host, not by Yu. Each is Yu's to keep, change or remove. Remove the mark from any line that is kept.`,
    `Lines beginning "${YU_MARK}" mark a place for Yu's own words. They are not part of the letter.`,
    `Lines between a "begin" rule and its "end" rule are ${word}'s record, byte for byte, except a commit's subject line, which is as git prints it; the rule carries the first 8 characters of the block's sha256. Leave them as they are.`,
    `Length with every [host] line kept and the marks removed: ${letter_chars} characters. This host shows a letter of at most ${limit} (ceilings.letter_max_chars); a longer one is passed over and nothing says so.`,
    ...(over_limit ? ["THIS DRAFT IS OVER THAT LIMIT."] : []),
    `CADENCE.md versions: ${k}. With the beat their commit added: ${with_beat}. Commit added no beat: ${no_beat}. Beat headed with another time than the when: line: ${header_differs}.`,
    ...(not_printed.length > 0 ? [`NOT PRINTED, because it ${NOT_PRINTABLE}: ${not_printed.join(" ")}`] : []),
    `A letter reaches ${word} as a file in ${dir}/letters/ whose first line is "From: yu", then an empty line, then the text. This command writes no such file.`,
    "==================== the letter text starts on the next line ====================",
  ];
  return { text: `${[...headLines, ...letter].join("\n")}\n`, letter_chars, limit, over_limit, versions: k, with_beat, no_beat, header_differs, not_printed };
}
