// When a citizen's own seat is due (3.2 step 2, 3.3). One rule, read by the
// tick that seats, by `seat <word>` before it opens a seat without Yu, by the
// seat child as a backstop, and by status when it says who is overdue, so the
// four never disagree about what the runner would do.
import type { Citizen, IsoTime, LifecycleState } from "./types.ts";

export type DueVerdict =
  | {
      due: true;
      /**
       * cadence: an awake citizen's own interval. letter: an allowed letter woke
       * it. confirm: one seat to say again what its last beat said once.
       * return: a letter from Yu offering a citizen that stepped away a return.
       */
      why: "cadence" | "letter" | "confirm" | "return";
      overdue_h: number;
    }
  | { due: false; why: string };

const HOUR_MS = 3_600_000;
/** stepped-away and ended rank below asleep, so leaving them is always toward exposure. */
const EXPOSURE: Partial<Record<LifecycleState, number>> = { asleep: 0, listening: 1, awake: 2 };

function rank(s: LifecycleState): number {
  return EXPOSURE[s] ?? -1;
}

function latest(a: IsoTime | null, b: IsoTime | null): IsoTime | null {
  if (a === null) return b;
  if (b === null) return a;
  return Date.parse(a) >= Date.parse(b) ? a : b;
}

/**
 * Is this citizen's own seat due? awake by its interval; listening and asleep
 * on an allowed letter; a saying that needs a second beat (a move toward
 * exposure, or a first step-away) gets one seat to confirm it; a citizen that
 * stepped away only on Yu's letter offering a return; ended never.
 *
 * `letter` is the waking letter for the citizen's state: an allowed waking
 * letter while listening or asleep, Yu's letter while stepped away
 * (context.wakingLetter). `lastSeatAt` is the last seat the host opened for
 * it, from host notes: a rest writes nothing to the ledger, so the ledger's
 * last beat alone would seat a resting citizen again every tick.
 */
export function isDue(citizen: Citizen, letter: boolean, now: Date, minIntervalH: number, lastSeatAt: IsoTime | null = null): DueVerdict {
  if (citizen.state === "ended") return { due: false, why: "ended" };
  // Unattended ticks run only the free lane: a summons needs Yu present, and hermes waits for S8.
  if (citizen.runtime !== "free") return { due: false, why: `runtime ${citizen.runtime} is not unattended` };
  if (!Number.isFinite(minIntervalH) || minIntervalH <= 0) return { due: false, why: "minimum interval is not a positive number" };

  const last = latest(lastSeatAt, citizen.last_beat_at);
  const lastMs = last === null ? null : Date.parse(last);
  if (lastMs !== null && Number.isNaN(lastMs)) return { due: false, why: "last seat time is unreadable" };
  const sinceH = lastMs === null ? Number.POSITIVE_INFINITY : (now.getTime() - lastMs) / HOUR_MS;
  const atFloor = (why: "letter" | "confirm" | "return", state: string): DueVerdict =>
    // Every seat that is not an awake cadence keeps the same floor, so nothing seats a citizen every tick.
    sinceH < minIntervalH ? { due: false, why: `${state}; ${why} waits ${Math.ceil(minIntervalH - sinceH)} h` } : { due: true, why, overdue_h: sinceH - minIntervalH };

  // A saying that needs a second beat is owed exactly one more seat; readCitizen drops it once a later seat has happened.
  const pending = citizen.pending_state;
  const pendingUp = pending !== null && rank(pending) > rank(citizen.state);
  if (pendingUp && pending === "awake") {
    // Scheduled by the state it asked for; the beat can still decline.
    return cadence(citizen, minIntervalH, sinceH);
  }
  if (pendingUp || citizen.step_away_said) return atFloor("confirm", citizen.state);

  if (citizen.state === "stepped-away") {
    // Its own cadence never seats it; Yu's offer to return does, one beat each (3.3, 3c).
    return letter ? atFloor("return", "stepped-away") : { due: false, why: "stepped-away" };
  }
  if (citizen.state === "awake") return cadence(citizen, minIntervalH, sinceH);
  if (!letter) return { due: false, why: `${citizen.state}; no letter` };
  // A letter is shown again after a rest, so letter wakes keep the same floor; otherwise one letter would seat it every tick.
  return atFloor("letter", citizen.state);
}

function cadence(citizen: Citizen, minIntervalH: number, sinceH: number): DueVerdict {
  const own = citizen.cadence.interval_h;
  if (!Number.isFinite(own) || own <= 0) return { due: false, why: "own interval is not a positive number" };
  const interval = Math.max(own, minIntervalH);
  if (sinceH >= interval) return { due: true, why: "cadence", overdue_h: sinceH - interval };
  return { due: false, why: `awake; next in ${Math.ceil(interval - sinceH)} h` };
}

/** What a tick's seat tells the citizen about why it opened. */
export function dueReason(why: Extract<DueVerdict, { due: true }>["why"]): string {
  switch (why) {
    case "cadence":
      return "your own cadence is due";
    case "letter":
      return "a letter from someone you allow arrived";
    case "confirm":
      return "your last beat said something that takes a second beat to bind";
    case "return":
      return "Yu wrote to offer you a return";
  }
}
