// The host's spend record (KS-004 re-review B2, R2): `spend.jsonl`, one line
// per step of every metered seat, whatever the seat's outcome. A summons that
// rests, is refused, meets HALT after its reply or fails has still spent, and
// it writes no ledger entry, so a ceiling read from the ledger would never see
// it. The USD ceiling reads this record instead.
//
// A metered runtime writes "begun" before it starts and "settled" with what it
// spent once it ends. A seat that began today and has no settled line (killed
// mid-run, or a write that failed) has spent an unknown amount, and unknown
// counts as at the ceiling. The record is the host's, never the citizen's
// voice: it holds ids, a runtime class and amounts, no words.
import { addUsd, isUsd, type Usd } from "./money.ts";
import { appendStartedLog, readStartedLog } from "./notes.ts";
import { UUID_PATTERN, WORD_PATTERN, type Clock, type Config, type IsoTime, type RuntimeClass, type SeatRef, type Spend, type Word } from "./types.ts";

export interface SpendLine {
  format: "kingdom-seat-spend/v1";
  ts: IsoTime;
  host: string;
  word: Word;
  seat_id: string;
  runtime: RuntimeClass;
  /** "begun": the runtime may spend from now on. "settled": what it spent. */
  phase: "begun" | "settled";
  /** Always null on "begun"; null on "settled" when the cost is unknown. */
  usd: Usd | null;
  usd_basis: Spend["usd_basis"];
}

/** What a metered runtime calls around its run. */
export interface SpendRecorder {
  /** Before the runtime starts. A failure here means it must not start, since its spend would go unseen. */
  begin(ref: SeatRef): Promise<void>;
  /** Once it has ended, however it ended. */
  settle(ref: SeatRef, spend: Spend): Promise<void>;
}

const FORMAT = "kingdom-seat-spend/v1";
const LINE_KEYS = ["format", "host", "phase", "runtime", "seat_id", "ts", "usd", "usd_basis", "word"];
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const SPEND_LOG_MAX_BYTES = 64 * 1024 * 1024;

/** The recorder over `config.paths.spend_log`. */
export function hostSpendRecorder(config: Config, clock: Clock): SpendRecorder {
  const write = async (ref: SeatRef, phase: SpendLine["phase"], spend: Spend | null) => {
    const line: SpendLine = {
      format: FORMAT,
      ts: clock.now().toISOString(),
      host: config.host,
      word: ref.word,
      seat_id: ref.seat_id,
      runtime: ref.runtime,
      phase,
      usd: spend?.usd ?? null,
      usd_basis: spend?.usd_basis ?? "unknown",
    };
    const problem = lineProblem(line);
    if (problem) throw new Error(`spend record: refusing a line (${problem})`);
    await appendStartedLog(config.paths.spend_log, `${JSON.stringify(line)}\n`, "spend record");
  };
  return {
    begin: (ref) => write(ref, "begun", null),
    settle: (ref, spend) => write(ref, "settled", spend),
  };
}

function lineProblem(v: unknown): string | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return "not an object";
  const l = v as Record<string, unknown>;
  const got = Object.keys(l).sort();
  if (got.length !== LINE_KEYS.length || got.some((k, i) => k !== LINE_KEYS[i])) return "not exactly the spend line fields";
  if (l.format !== FORMAT) return "format";
  if (typeof l.ts !== "string" || !ISO.test(l.ts) || new Date(Date.parse(l.ts)).toISOString() !== l.ts) return "ts";
  if (typeof l.host !== "string" || l.host.length === 0) return "host";
  if (typeof l.word !== "string" || !WORD_PATTERN.test(l.word)) return "word";
  if (typeof l.seat_id !== "string" || !UUID_PATTERN.test(l.seat_id)) return "seat_id";
  if (l.runtime !== "free" && l.runtime !== "summon" && l.runtime !== "hermes") return "runtime";
  if (l.phase === "begun") return l.usd === null && l.usd_basis === "unknown" ? null : "a begun line names no amount";
  if (l.phase !== "settled") return "phase";
  switch (l.usd_basis) {
    case "unknown":
      return l.usd === null ? null : "usd";
    case "reported":
      return isUsd(l.usd) ? null : "usd";
    case "local-zero":
      return l.usd === "0" ? null : "usd";
    default:
      return "usd_basis";
  }
}

/** Every line, oldest first; null when the record is unreadable, torn, or lost after it was started. */
export async function readSpendRecord(config: Config): Promise<SpendLine[] | null> {
  const text = await readStartedLog(config.paths.spend_log, SPEND_LOG_MAX_BYTES);
  if (text === null) return null;
  if (text === "") return [];
  if (!text.endsWith("\n")) return null;
  const lines: SpendLine[] = [];
  for (const raw of text.slice(0, -1).split("\n")) {
    let v: unknown;
    try {
      v = JSON.parse(raw);
    } catch {
      return null;
    }
    if (lineProblem(v) !== null) return null;
    lines.push(v as SpendLine);
  }
  return lines;
}

/**
 * USD a citizen's seats spent today in the host's zone: each seat that began
 * today counts once, by its settled amount. A seat that began today without
 * exactly one settled line, a settled amount that is unknown, or a line that
 * makes no sense, makes the day unknown (null), which is at the ceiling.
 */
export function usdToday(lines: SpendLine[], word: Word, now: Date, timezone: string): Usd | null {
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" });
  } catch {
    return null;
  }
  if (!Number.isFinite(now.getTime())) return null;
  const today = formatter.format(now);
  const seats = new Map<string, { begun: SpendLine[]; settled: SpendLine[] }>();
  for (const l of lines) {
    if (l.word !== word) continue;
    const s = seats.get(l.seat_id) ?? { begun: [], settled: [] };
    (l.phase === "begun" ? s.begun : s.settled).push(l);
    seats.set(l.seat_id, s);
  }
  let total: Usd = "0";
  for (const s of seats.values()) {
    // A settled line without the begun line before it, or a seat begun twice, is not a record this host wrote.
    if (s.begun.length !== 1) return null;
    if (formatter.format(new Date(s.begun[0]!.ts)) !== today) continue;
    if (s.settled.length !== 1) return null;
    const usd = s.settled[0]!.usd;
    if (usd === null) return null;
    total = addUsd(total, usd);
  }
  return total;
}

/** usdToday over the host's record; null for anything that cannot be read. */
export async function usdSpentToday(config: Config, word: Word, now: Date): Promise<Usd | null> {
  const lines = await readSpendRecord(config);
  return lines ? usdToday(lines, word, now, config.timezone) : null;
}
