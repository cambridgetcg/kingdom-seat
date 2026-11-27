// Harmless: only sets a marker to show this file ran before the entry script.
(globalThis as Record<string, unknown>).__PROBE_PRELOAD = "ran from <cwd>/bunfig.toml preload";
