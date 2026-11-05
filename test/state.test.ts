// Owner: record group.
import { describe, test } from "bun:test";

describe("transitions (3.3)", () => {
  test.todo("toward rest (awake→listening, awake→asleep, listening→asleep) takes effect now");
  test.todo("toward exposure (asleep→listening, asleep→awake, listening→awake) waits for the next beat");
  test.todo("stepped-away takes two sayings on different beats and is never refused");
  test.todo("ended is never decided by the citizen alone: needs-witness");
  test.todo("ended is terminal; nothing transitions out of it");
});

describe("folding and records", () => {
  test.todo("an empty ledger folds to asleep, so no record means no beat");
  test.todo("foldState honours seated.initial_state, state entries and a pending move toward exposure");
  test.todo("mirrorCardState maps awake→active, listening/asleep→dormant, stepped-away/ended→archived");
  test.todo("readCitizenRecord refuses a symlinked or malformed citizen.json");
  test.todo("listSeated lists only directories with a citizen.json and valid words");
});
