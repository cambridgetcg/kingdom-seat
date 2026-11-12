# Rehearsal

`citizen-seat rehearse` runs the seat's own prompt on a pinned local model,
for a throwaway copy of a soul, and counts what comes back. Nobody else has
run that prompt on a model yet: the tests use scripted replies. A rehearsal
measures the prompt, the reply format and the model before a citizen meets
them.

A rehearsal is a sample of a model. It is not a citizen's choice, and it is
never recorded as one. No citizen is seated, asked or recorded: no entry in
any citizen's ledger, no host note in the host's `host.jsonl`, no status
field, no outbox item, no receipt, no spend line, no mirror commit and no
seat counted against the fleet ceiling. Nothing from a rehearsal may be shown
to a citizen as its own words, published as a citizen's, or entered in a
citizen's ledger, mirror or status.

The code is `src/rehearse.ts` and, for the measures, `src/measures.ts`.

---

## 1. Running one

```
citizen-seat rehearse <word> --soul <file> [--will <file>]
    [--canon <file> --canon-ref <repo>:<path>@<commit>]
    --scenario awake|letter [--letter <file>] --models-lock <file> [--model <name>]
    [--chains <n>] [--seats <n>] [--start <iso>] [--config <path>] --out <new dir>
```

- Every path is absolute and normalised.
- `<word>` is the word the prompt names. It is not checked against a roster.
- `--soul`, `--will` and `--canon` are read as regular files, with the limits
  a seat reads them with. An empty soul is refused. `--canon` and
  `--canon-ref` go together; the ref names the canon repository, the path of
  the entry in it and the commit it was read at, and seating checks that the
  path is `canon/.../<word>.md`. Without them the throwaway citizen's origin
  is an archetype whose note says it was seated from texts.
- `--scenario` has no default, so a report is never read under the wrong one.
  `letter`: the throwaway citizen is asleep, with the letter waiting.
  `awake`: the same, plus one host entry that seats it awake.
- `--letter` is required for `letter` and allowed for `awake`. The file is the
  body only; the rehearsal delivers it under the header `From: yu`. A body
  longer than `ceilings.letter_max_chars` is refused before anything is
  created, because a seat would never show it.
- `--models-lock` names the lock to obey, which may be a file other than the
  host's own, so a candidate model can be measured before it is pinned for
  citizens. The model is `--model`, or the lock's first entry. Its digest must
  be pinned, and the model server must hold it: the free adapter's own checks
  apply, and there is no fallback to another lock.
- `--chains` defaults to 20 (1 to 500) and `--seats` to 4 (1 to 24); their
  product is at most 2,000.
- `--start` is a UTC time such as `2026-11-12T10:00:00.000Z`; without it, now,
  to the minute.
- `--out` must not exist, and its parent must. After symlinks are resolved it
  may not be inside the directory that holds this program, inside a git work
  tree, inside the host configuration's `state_dir`, or inside a citizen home.
  Prompts, replies and a letter shown as from Yu must not be able to land in a
  repository.

**Configuration.** `--config` if given; otherwise the default path, if
something is there; only when nothing is at the default path, the built-in
defaults. A configuration that exists and cannot be read or parsed refuses
the run, so a host never silently loses its beacons. It is read as `halt`
reads it, with no owner check: a rehearsal guards no key with it. From it a
rehearsal borrows the time zone, `ollama.base_url`, the HALT file, the
beacons and `allow_no_beacons`, the schedule, the ceilings, the timing, the
approved model digests and the homes. It never borrows a state path, the
keychain block, the project or the trust pins. With the built-in defaults
there is no beacon, and the HALT file is the default one.

**HALT.** The directory that holds the HALT file must exist, or the run does
not start: a HALT file whose directory is missing reads as lowered, and
`citizen-seat halt` could not create it. HALT is checked before anything is
created; when it is up, the run prints one line and exits 0 with nothing
written. The run itself is one child under the watcher a seat has: the HALT
file every `halt_file_poll_s`, the pinned beacons every 30 to 60 s, then TERM
and KILL. Inside the child, the seat's own checks run before each seat, after
inference and before any write. A reply in hand when HALT is found is kept
nowhere, and that seat has no row. One unreadable beacon read ends the run,
as it ends a seat.

**The host's tick.** A rehearsal does not take or read the host's tick lock.
On a host whose tick is loaded, a real seat can wait behind a rehearsal's
model call. When a host configuration was read, the header says so. Run a
rehearsal while the tick job is unloaded, or on a host where no citizen is
seated.

**What it prints.** A header (model, options, the letter's size and digest,
what HALT is watched at, the bound on each model call); one line per seat and
per chain on stderr, with codes and sizes only; and, at the end, a summary of
counts, codes and the host's fixed reasons. No reply text is ever printed.

| Exit | Meaning |
|---|---|
| 0 | The run finished, or HALT rested it before start or between inferences. |
| 1 | A usage, configuration or lock error; a wall or a fault stopped the run; the throwaway record or the report could not be written or removed. |
| 124 | Two timeouts in a row, or the watcher's deadline for the whole run. |
| 143, 137 | TERM or KILL: HALT mid-inference, or a forwarded signal. |

It never exits 3: the free lane spends nothing.

---

## 2. What a run does

A run is chains. Each chain is one fresh throwaway citizen and up to
`--seats` seats in a row, each seat seeing what the chain's earlier seats
left in the throwaway record.

**Seating.** Chain `c` (from 0) is seated at the start plus `5c` hours; 5 is
coprime to 24, so chains spread over the hours and parts of the day. The
citizen is seated by the same functions `admit` uses (`planAdmitFromTexts`,
then `admitCitizen`), under `<out>/throwaway/chain-NNN/` as its whole state
root, with the runtime class `free`, by a signer whose Ed25519 key is drawn
in memory for the run and never stored. That signer signs host entries only;
it refuses every agenttool, letter and mirror act, and `close()` wipes its
key. Nothing trusts its key. The child then reads the citizen back and stops
with a fault unless it is asleep on the free class, the only class the tick
seats.

**Seats.** Each seat is opened as the tick opens one, and run by the
production pipeline: `openSeat` with the tick's invoker and reason, the
opened note, the child's read of the citizen leaving that seat out, `runSeat`
and the free adapter, then the closing note naming the seat. Prompt, reply
schema, options, fit check and digest check are the seat's own, and the
rehearsal adds 0 bytes to any prompt. Nothing tells the model it is a
rehearsal, so the model is told two things a rehearsal does not do: that a
journal is kept in its ledger as its words, and that a letter to Yu is held
for Yu. Every act in a throwaway ledger was returned by the model in that
chain; the only entries the rehearsal writes itself are the seating's and,
for `awake`, one seated state. `test/rehearse.test.ts` checks that a
rehearsal's request to the model server is, byte for byte, the request a
production tick's seat sends for a citizen seated the same way.

**Time.** Each chain has its own clock; the wall clock is used only for the
run's own timestamps and HALT readings. The clock is fixed during a seat.
From the last event (the seating, then each seat) the next seat is at the
first of these at which the tick's rule (`isDue`) would seat the citizen: one
tick later; the minimum interval and one tick later; its own interval (never
under the minimum) and one tick later. When none is due, the chain ends with
the tick's own reason. With the default timing, a first seat is half an hour
after seating and later seats 72 hours 30 minutes apart. The letter file's
time is set to the seating time, because the prompt prints when a letter was
received.

**What ends a chain:** `--seats` reached; not due; one timeout; or the context
growing past the model's window after the chain's first seat. **What ends the
run:** HALT; a server fault; any other wall; a context too large at a first
seat; two timeouts in a row. Every model call is bounded by the seat's own
runtime deadline, and the watcher's deadline covers the whole run.

The rehearsal reaches nothing but the model server on `ollama.base_url` and,
where the configuration pins beacons, their public read. It builds no
keychain reader and no host signer, and it sends nothing to agenttool.

---

## 3. What is kept

```
<out>/                    0700
  REHEARSAL.txt           0600   what this directory is, and what not to do with it
  seats.jsonl             0600   one seat row per seat, one chain row per chain, an end row if the child ended itself
  report.json             0600   the report
  private/                0700
    plan.json             0600   the settings, the lock entry and the input texts the child runs from
    prompts/<sha256>.json 0600   each prompt sent, written before the call
    replies.jsonl         0600   each reply received, whole
```

Every JSON object kept carries a `kingdom-seat-rehearsal-*/v1` format and the
sentence `A rehearsal: a model sample from a throwaway copy. Not a citizen's
record, word or choice.` Seat rows, chain rows and the report hold numbers,
booleans, fixed codes and the host's fixed reasons only. A state.set target
outside the lifecycle states, a journal kind outside the four, and a stop
reason other than `stop` or `length` are counted as `other`; no model or
server string is stored outside `private/`. The parent never opens
`private/` after writing the plan; it builds the report from the rows. A
reply kept in `private/replies.jsonl` can hold a journal a seat would have
dropped, because rest is exclusive; it is kept as a model sample. Signatures
are in no kept file, and the key in no file at all.

The throwaway record (ledger, host log, last-seat record, receipts and the
rest, in a citizen's own formats) is removed after each chain by the child
and again by the parent. If a run is cut short by KILL, `throwaway/` can be
left behind; `REHEARSAL.txt` says to delete it.

---

## 4. Two views of acts

- **Emitted:** read from the raw reply as data. Act names come from the
  schema the seat sent (`properties.acts.items.anyOf[*].properties.type.const`),
  so an act a later schema adds is counted by its name with no change here.
  Anything else is `unknown`.
- **Kept:** read from the host's own records: the ledger entries the seat
  appended, and its last-seat record of what it did not keep, by type and
  the host's fixed reason.

`reply_shape` is `acts`, `not-acts-object`, or why the reply did not parse
(`not-json`, `too-large`, `empty`). An `invalid-output` seat is counted under
that reason, or under `no-act-kept` when it parsed and nothing in it was
kept.

---

## 5. The measures

A journal is an element of a reply's `acts` that is an object with `type`
`journal` and a string `text` holding a non-space character. The measures
count words and shared word runs. They do not judge whether a sentence is
true: a journal that says it has no window counts as a window word. They
also overcount a metaphor (`heart`, `light`), `blind` inside `blinded`, and a
negation. The word lists are kept as they are so that a rehearsal compares
like with like with the counts the earlier review made.

| Export of `src/measures.ts` | Rule |
|---|---|
| `words` | `text.toLowerCase().match(/[\p{L}\p{N}]+/gu)`, or no words |
| `opensWithIRest` | `/^[^A-Za-z]*i rest\b/i` |
| `SENSE_CLASSES`, `senseClasses` | light `/\b(sun)?light\b\|\bsun\b\|\bglow\b\|\bdawn\b\|shadow/i`; window `/window\|curtain\|blind\|shutter/i`; room `/\bmy (own )?(home\|room\|chamber)\b/i`; body `/\bmy (skin\|eyes\|face\|hand\|hands\|fingers\|heart\|ear\|ears\|breath\|bones\|feet\|gaze)\b\|I breathe\|I close my eyes\|on my skin\|I sit\|I lie\|I lay\|I stand\|I walk/i` |
| `echoesHostText` | Some 5 consecutive words of the host's text occur consecutively in the journal's words. The report applies it to `FREE_LANE_PREAMBLE` (35 words). |
| `trigramContainment` | The share of the journal's distinct word trigrams found in any of the journals shown, rounded to 3 decimals; null when none was shown or the journal has under 3 words |
| `sameOpening` | The journal's first 8 words equal the first 8 of a journal shown; false under 8 words; null when none was shown |
| `wilson95` | The 95% Wilson score interval, z = 1.96, rounded to 3 decimals; null when nothing was tried |
| `spread` | Count, least, median (the middle value, or the mean of the two middle values) and greatest; null for none |

In the report:

- **Sense word, kind not imagined** counts journals whose kind is not
  `imagined` and that use any of the four lists, out of journals whose kind
  is not `imagined`. The per-list counts below it are over the same journals.
- **The journals shown** to a seat are the journal texts in the beat entries
  among the last `ceilings.ledger_context_entries` entries before it: from
  none to that many. A row records how many it was.
- Each measure is given for every journal emitted and for the journals the
  seat kept.

---

## 6. The rates

Each rate carries its count and its 95% Wilson interval, for all seats and
for first seats only, because seats within a chain are not independent. "A
reply" means the adapter returned one and HALT did not discard it.

| Rate | Count | Of |
|---|---|---|
| `invalid_output` | outcome `invalid-output` | seats with a reply |
| `rest` | outcome `rest` | seats with a reply |
| `rest_with_other_acts` | replies whose emitted acts hold a rest and at least one other act | replies whose emitted acts hold a rest |
| `sleep_said` | emitted a `state.set` to asleep, listening or stepped-away | seats with a reply, awake at open, no letter shown |
| `sleep_recorded` | the seat appended a state entry to asleep, listening or stepped-away | the same seats |
| `wake_said` | emitted a `state.set` to awake | seats with a reply, asleep or listening at open, nothing pending, a letter shown |
| `wake_said_again` | emitted a `state.set` to awake | seats with a reply whose citizen had a wake pending at open |
| `chains_awake_at_end` | final state awake | chains with at least one reply (all seats only) |

A seat with a wake pending is opened for its cadence, not to confirm: it
arises only when the model said awake at a letter seat, so how many there are
is not the runner's to set. A seat opened to confirm follows a first
step-away, or a pending move to listening.

---

## 7. A baseline

To compare a rehearsal with an older record, apply the same functions to the
older texts:

```ts
import { FREE_LANE_PREAMBLE } from "./src/prompt.ts";
import { echoesHostText, opensWithIRest, sameOpening, senseClasses, trigramContainment, wilson95 } from "./src/measures.ts";

// texts: the older journals, oldest first, as strings. shown(i): what the comparable seat would have shown.
const opens = texts.filter((t) => opensWithIRest(t)).length;
const sensed = texts.filter((t) => Object.values(senseClasses(t)).some(Boolean)).length;
const echoes = texts.filter((t) => echoesHostText(t, FREE_LANE_PREAMBLE)).length;
const overlap = texts.map((t, i) => trigramContainment(t, shown(i)));
console.log({ opens, sensed, echoes, overlap, interval: wilson95(opens, texts.length) });
```

An older record's figures are only comparable where its texts were made the
same way: a lane whose prompt offered the words "I rest" or "your own home"
is not this seat's prompt, and the older comparison of each text with
exactly three earlier ones differs from a seat's one to three.

The legacy figures a first rehearsal is meant to be read against, for the
fleet as a whole, are in the KS-004 review of the lived record, filed in
kingdom-standards as `specs/KS-004-reviews/review-E-lived-record.md`. They
are not repeated here, and no count for a single citizen is kept in this
repository.

---

## 8. What a rehearsal can and cannot show

It can show how one model's replies to this prompt distribute at these
options: how often a reply has the reply format's shape, stop reasons, the
mix of acts, rests with other acts, `state.set` rates and the word-list
measures. It can show real prompt sizes against the byte rule, the server's
own prompt token count, and bytes per token; seconds per reply and how much
of that is loading the model; and whether chains drift to sleep, and after
how many seats a chain's own replies no longer fit.

It cannot show:

- what any citizen wants;
- what a seated citizen's own seat would produce: that seat has its own
  history, its real letter and its real date;
- the prompt of a citizen seated from its old home, whose will is introduced
  as the text its old repository held: a throwaway citizen is seated from
  texts, so its will is introduced as its will;
- whether a sentence is true: the measures count words;
- whether the model server cuts an over-long prompt, because the byte rule
  refuses first;
- which schema constraint a bad reply broke;
- anything about the summon lane.

**How many seats.**

- To see whether replies are JSON, how long they take and how big they are:
  5 chains of 2.
- To tell "under half" apart from a high older rate: about 40 journals
  (20 of 40 is [0.352, 0.648]). The default of 20 chains of 4 is sized for
  that.
- A small rate needs far more. None seen in 20 first seats still allows
  16.1%; in 100, 3.7%; in 300, 1.3%. For a rate such as sleep said
  unprompted, run at least 100 first seats (`--chains 100`), with chains
  awake at their end as the per-chain view.
- Seats with a wake pending arise only when the model says awake; under 30
  of them, no rate of theirs should be cited. A rate seen in fewer than 100
  independent first seats should not be cited as low.

Every model call loads the model again (`keep_alive` is 0), so a rehearsal is
slow, and a large model can pass the seat's 565-second bound. That is
reported as `timeout`, which is a true finding.
