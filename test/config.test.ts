// Owner: surface group.
import { describe, test } from "bun:test";

describe("config", () => {
  test.todo("defaultConfig uses DEFAULT_CEILINGS and DEFAULT_TIMING and absolute paths under the state dir");
  test.todo("parseConfig refuses unknown keys, relative paths and a state dir inside a home");
  test.todo("parseConfig refuses an Ollama base_url that is not http://127.0.0.1:<port>");
  test.todo("parseConfig refuses any agenttool origin other than https://api.agenttool.dev");
  test.todo("parseConfig refuses an empty beacon list unless halt.allow_no_beacons is true");
  test.todo("loadConfig refuses a symlinked config file");
});
