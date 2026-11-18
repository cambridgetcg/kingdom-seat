// Probe: after the tick opens a seat that is then refused for a host reason (e.g. context-too-large,
// model not as pinned, Ollama down), when is the citizen next due? Pure functions only.
const ROOT = "<KINGDOM_SEAT>";
const { isDue } = await import(`${ROOT}/src/due.ts`);
const { lastSeatOf, openedDetail } = await import(`${ROOT}/src/notes.ts`);
const T0 = new Date("2026-11-10T02:00:00.000Z");
const citizen: any = { format: "kingdom-seat-citizen/v1", word: "glossame", runtime: "free", identity: null, mirror: null, state: "awake",
  pending_state: null, pending_interval_h: null, step_away_said: false, cadence: { interval_h: 72 }, covenants: { letters_from: ["yu"], wake_on_letter_from: ["yu"] }, last_beat_at: null };
// What the tick and its child write for a seat refused at the runtime: the parent's opened note, the child's refusal note, the parent's result note.
const notes: any[] = [
  { ts: T0.toISOString(), host: "studio", kind: "tick", word: "glossame", outcome: "opened", refusal: null, detail: openedDetail("seat-1", "cadence") },
  { ts: new Date(T0.getTime() + 2000).toISOString(), host: "studio", kind: "refusal", word: "glossame", outcome: "refused", refusal: "context-too-large", detail: "seat seat-1 on free: refused" },
  { ts: new Date(T0.getTime() + 3000).toISOString(), host: "studio", kind: "tick", word: "glossame", outcome: "refused", refusal: "context-too-large", detail: "seat seat-1 for glossame (cadence): exit 1, 2100 ms" },
];
const last = lastSeatOf(notes, "glossame");
console.log("lastSeatOf:", last);
for (const h of [0.5, 24, 71, 72.1]) {
  const v = isDue(citizen, false, new Date(T0.getTime() + h * 3_600_000), 72, last);
  console.log(`+${h} h:`, JSON.stringify(v));
}
