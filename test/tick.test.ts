// Owner: seat group.
import { describe, test } from "bun:test";

describe("lock", () => {
  test.todo("acquireTickLock is atomic: a second acquire while the owner is alive yields null");
  test.todo("a lock whose owner pid is gone is reclaimed; one whose owner is alive is never reclaimed by age");
  test.todo("releaseTickLock never removes a lock owned by another pid");
});

describe("selection", () => {
  test.todo("isDue: awake by its own interval, never more often than 72 h");
  test.todo("isDue: listening and asleep only on an allowed letter; stepped-away and ended never");
  test.todo("selectDue picks the most overdue, ties by word, and null when none is due");
  test.todo("one tick dispenses at most one seat, never the same citizen twice");
});

describe("runTick", () => {
  test.todo("HALT raised: exit 0, outcome halted, lock never taken");
  test.todo("lock held: exit 0, outcome yielded");
  test.todo("nothing due: exit 0, outcome nothing-due, no seat");
  test.todo("fleet ceiling reached or host log unreadable: outcome fleet-ceiling, no seat");
  test.todo("a due citizen gets one supervised seat and one host note");
});
