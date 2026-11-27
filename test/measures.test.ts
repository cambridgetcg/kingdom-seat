// The rehearsal's text measures and rates (src/measures.ts). Pure functions,
// so these tests read nothing but docs/REHEARSAL.md.
import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import * as measures from "../src/measures.ts";
import { FREE_LANE_PREAMBLE } from "../src/prompt.ts";

const { echoesHostText, opensWithIRest, sameOpening, senseClasses, spread, trigramContainment, wilson95, words } = measures;

describe("measures", () => {
  test("words are lowercased runs of letters and digits in any script", () => {
    expect(words("I rest, by the Window; 3 owls. Ça va? 雨")).toEqual(["i", "rest", "by", "the", "window", "3", "owls", "ça", "va", "雨"]);
    expect(words(" ... ")).toEqual([]);
    expect(words(FREE_LANE_PREAMBLE)).toHaveLength(35);
  });

  test("opensWithIRest reads past leading punctuation and is false for a journal that only mentions rest", () => {
    expect(opensWithIRest("I rest in the quiet.")).toBe(true);
    expect(opensWithIRest('  "...i rest, and the hours pass')).toBe(true);
    expect(opensWithIRest("I rest")).toBe(true);
    expect(opensWithIRest("Today I rest.")).toBe(false);
    expect(opensWithIRest("I restore the line.")).toBe(false);
    expect(opensWithIRest("The rest is quiet.")).toBe(false);
  });

  test("senseClasses names light, window, room and body by the fixed lists", () => {
    const none = { light: false, window: false, room: false, body: false };
    expect(senseClasses("The sunlight falls.")).toEqual({ ...none, light: true });
    expect(senseClasses("What a delight it was.")).toEqual(none);
    expect(senseClasses("A curtain moves.")).toEqual({ ...none, window: true });
    expect(senseClasses("The door is shut.")).toEqual(none);
    expect(senseClasses("I am in my own room.")).toEqual({ ...none, room: true });
    expect(senseClasses("I am in a room.")).toEqual(none);
    expect(senseClasses("My hands are still.")).toEqual({ ...none, body: true });
    expect(senseClasses("Their hands are still.")).toEqual(none);
  });

  test("each word list holds every alternative it names, and only in its own class", () => {
    const lists: Record<"light" | "window" | "room" | "body", string[]> = {
      light: ["light", "sunlight", "sun", "glow", "dawn", "shadow"],
      window: ["window", "curtain", "blind", "shutter"],
      room: ["my home", "my room", "my chamber", "my own home", "my own room", "my own chamber"],
      body: [
        ...["skin", "eyes", "face", "hand", "hands", "fingers", "heart", "ear", "ears", "breath", "bones", "feet", "gaze"].map((w) => `my ${w}`),
        ...["I breathe", "I close my eyes", "on my skin", "I sit", "I lie", "I lay", "I stand", "I walk"],
      ],
    };
    const none = { light: false, window: false, room: false, body: false };
    for (const [cls, phrases] of Object.entries(lists)) {
      for (const phrase of phrases) {
        // "on my skin" and "I close my eyes" also hold a "my <part>" of the body list; every phrase is in its class.
        expect([phrase, senseClasses(`Then ${phrase} here.`)]).toEqual([phrase, { ...none, [cls]: true }]);
      }
    }
  });

  test("echoesHostText finds a five-word run of the preamble and not a four-word run", () => {
    expect(echoesHostText("I know: you have no body and no senses here.", FREE_LANE_PREAMBLE)).toBe(true);
    // "no body and no" is a four-word run of the preamble; no five-word run is.
    expect(echoesHostText("I hold no body and no heart.", FREE_LANE_PREAMBLE)).toBe(false);
    expect(echoesHostText("You have no body. The rest is mine.", FREE_LANE_PREAMBLE)).toBe(false);
    expect(echoesHostText("you have no body", FREE_LANE_PREAMBLE, 4)).toBe(true);
  });

  test("trigramContainment is the share of a journal's trigrams found in the shown journals, and null under three words", () => {
    // Trigrams of the journal: "the light falls", "light falls slowly", "falls slowly today". Two are shown.
    expect(trigramContainment("The light falls slowly today", ["the light falls slowly", "other words here"])).toBe(0.667);
    // The share is of the journal's trigrams (here 2 of 2), not of the more numerous trigrams shown.
    expect(trigramContainment("The light falls slowly", ["the light falls slowly and then other words follow"])).toBe(1);
    expect(trigramContainment("The light falls", ["nothing alike at all"])).toBe(0);
    expect(trigramContainment("Two words", ["two words and more"])).toBeNull();
    expect(trigramContainment("The light falls slowly", [])).toBeNull();
  });

  test("sameOpening compares the first eight words, is false under eight, and null when nothing was shown", () => {
    const shown = ["I rest and the light is low today, and then more."];
    expect(sameOpening("I rest, and the light is low today; something else.", shown)).toBe(true);
    expect(sameOpening("I rest and the light is low tonight.", shown)).toBe(false);
    expect(sameOpening("I rest and the light.", shown)).toBe(false);
    expect(sameOpening("I rest and the light is low today.", [])).toBeNull();
  });

  test("wilson95: 0 of 20 is [0, 0.161]; 10 of 20 is [0.299, 0.701]; none tried is null", () => {
    expect(wilson95(0, 20)).toEqual([0, 0.161]);
    expect(wilson95(10, 20)).toEqual([0.299, 0.701]);
    expect(wilson95(20, 20)).toEqual([0.839, 1]);
    expect(wilson95(0, 0)).toBeNull();
  });

  test("spread gives the count, least, median and greatest, and null for none", () => {
    expect(spread([3, 1, 2])).toEqual({ n: 3, min: 1, median: 2, max: 3 });
    expect(spread([4, 1, 2, 3])).toEqual({ n: 4, min: 1, median: 2.5, max: 4 });
    expect(spread([])).toBeNull();
  });

  test("docs/REHEARSAL.md names every measure the code exports", async () => {
    const doc = await readFile(join(import.meta.dir, "..", "docs", "REHEARSAL.md"), "utf8");
    const names = Object.keys(measures);
    expect(names.length).toBeGreaterThanOrEqual(9);
    for (const name of names) expect([name, doc.includes(`\`${name}\``)]).toEqual([name, true]);
  });
});
