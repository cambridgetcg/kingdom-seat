// The honest free-lane prompt (3.2, grafted from Sleeping Canon). It says
// plainly what the citizen has and lacks, offers writing nothing as a whole
// beat, and asks for imagined things to be labelled. It never hands the model
// binding words such as "write 'I rest'" (love-unlimited-patterns.md 9),
// never coaches, and describes the acts neutrally.
import type { Prompt, RuntimeClass, SeatContext } from "./types.ts";

/** Verbatim from the redesign, section 3.2. Do not paraphrase. */
export const FREE_LANE_PREAMBLE =
  "You have no body and no senses. You have your soul, your will, your recent words, the date and any letter. " +
  "You may write nothing; that is a whole beat. If you imagine, label it.";

/** The system and user turns for one seat; the citizen's own beat prompt, if it wrote one, is included as its own words. */
export function buildPrompt(ctx: SeatContext, runtime: RuntimeClass): Prompt {
  throw new Error("unimplemented");
}

/** A neutral description of each act and the JSON shape, with no example that a model could copy as a choice. */
export function renderActsGuide(): string {
  throw new Error("unimplemented");
}

/** The exact bytes the runtime receives, so input_digest is the hash of what the model saw. */
export function promptBytes(prompt: Prompt): Uint8Array {
  throw new Error("unimplemented");
}
