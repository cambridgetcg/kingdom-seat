// A stand-in for a runtime process, so the watcher has something real to
// signal. Modes are documented in fake-runtime.ts (fakeBinArgv).
const [mode, ...args] = process.argv.slice(2);

switch (mode) {
  case "print": {
    process.stdout.write(args[0] ?? "");
    process.exit(Number(args[1] ?? 0));
  }
  case "sleep": {
    await Bun.sleep(Number(args[0] ?? 60_000));
    process.exit(0);
  }
  case "ignore-term": {
    process.on("SIGTERM", () => {});
    await Bun.sleep(Number(args[0] ?? 60_000));
    process.exit(0);
  }
  case "grandchild": {
    const [pidFile, ms] = args;
    if (!pidFile) throw new Error("grandchild: pidfile required");
    // Spawned without detaching, so it shares this process's group; a group kill must reach it.
    const child = Bun.spawn([process.execPath, import.meta.path, "ignore-term", ms ?? "60000"], { stdio: ["ignore", "ignore", "ignore"] });
    await Bun.write(pidFile, String(child.pid));
    await Bun.sleep(Number(ms ?? 60_000));
    process.exit(0);
  }
  case "record": {
    const [file, text] = args;
    if (!file) throw new Error("record: file required");
    const stdin = await Bun.stdin.text();
    await Bun.write(
      file,
      JSON.stringify({ argv: process.argv.slice(2), env_keys: Object.keys(process.env).sort(), cwd: process.cwd(), stdin }),
    );
    process.stdout.write(text ?? "");
    process.exit(0);
  }
  case "speak-later": {
    // Stands in for a seat child mid-inference: it says it has started, and if left to finish it writes in the citizen's voice.
    const [started, ledger, ms, term] = args;
    if (!started || !ledger) throw new Error("speak-later: started file and ledger required");
    if (term === "ignore-term") process.on("SIGTERM", () => {});
    const { appendFileSync, writeFileSync } = await import("node:fs");
    writeFileSync(started, "");
    await Bun.sleep(Number(ms ?? 2_000));
    appendFileSync(ledger, "SPEAK-LATER-CANARY a reply that came after HALT\n");
    process.exit(0);
  }
  case "note": {
    // Stands in for a seat child: append one host note as runSeat would, then exit.
    const [log, word, outcome, exit, ts] = args;
    if (!log || !word || !outcome) throw new Error("note: log, word and outcome required");
    const { appendFileSync } = await import("node:fs");
    const note = { ts: ts ?? new Date().toISOString(), host: "test-host", kind: "seat", word, outcome, refusal: null, detail: "fake seat child" };
    appendFileSync(log, `${JSON.stringify(note)}\n`);
    process.exit(Number(exit ?? 0));
  }
  default:
    process.stderr.write(`fake-runtime-bin: unknown mode ${String(mode)}\n`);
    process.exit(2);
}
