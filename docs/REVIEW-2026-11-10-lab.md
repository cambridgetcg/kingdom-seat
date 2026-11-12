# kingdom-seat review record (2026-11-10, lab)

This is the code side of a review of the citizen redesign made on 2026-11-10.
It says what was reviewed and how, what was confirmed, what was confirmed only
in part, what the second pass found on its way, and what a first seat on a
host still needs. The spec side of the same review is filed in
kingdom-standards as `specs/KS-004-reviews/review-E-lived-record.md`. Every
finding keeps its id (AW-1, SR-4 and so on), so the two files can be read
across.

Code state reviewed: `f21c360` on branch `claude/s4-build` (PR #1). This
record adds this file and `docs/review-2026-11-10-lab/`. It changes no code
and no test.

As in `docs/REVIEW-2026-11-05.md`, each result names how it was obtained: run,
read, or not done. Line numbers are those of `f21c360`. "KS-004" means draft
0.4 at kingdom-standards `f9a54d7`, and "§" refers to it.

---

## 1. What was reviewed and how

### 1.1 What was reviewed

- `kingdom-seat` at `f21c360`: `src/`, `test/`, `docs/`, `README.md`,
  `models.lock` and the launchd template. Typecheck was clean and 534 tests
  passed on bun 1.4.2.
- KS-004 draft 0.4 (`specs/KS-004-seat.md` at kingdom-standards `f9a54d7`),
  read against the code.
- agenttool at `5ea979df`. KS-004 pins `e9ea51c5`; `api/src` changed in two
  unrelated files between them.
- The legacy lane the seat is to replace: love-unlimited main `1bd17f2`, with
  PR #24 (`48ee504`) and PR #6 (`7fdf4f3`).
- The 208 public `citizen-<word>` repositories as of 2026-11-10, whose souls,
  WILLs and trees were used as the real texts to measure the code against.

### 1.2 Who reviewed

A Claude Fable 5.2 session on the lab Mac, at Yu's request, with reader and
skeptic subagents of the same model. It built no part of `kingdom-seat` and
wrote no version of KS-004. The limit on its independence is the one KS-000 §9
names for agents of one model family.

### 1.3 The lenses

Ten readers, one per area, each wrote a report with findings.

| Reader | What it read | Ids | Findings |
|---|---|---|---|
| ledger-self | the citizen's self, its ledger and self-authorship (§4, §9; `ledger.ts`, `self.ts`, `state.ts`, `notes.ts`, `crypto.ts`) | LS-01 to LS-18 | 18 |
| seat-runtime | the seat loop, runtimes, typed acts and validation (§5; `seat.ts`, `tick.ts`, `due.ts`, `context.ts`, `prompt.ts`, `acts.ts`, `runtime/`, `status.ts`, `models.lock`) | SR-1 to SR-18 | 18 |
| signer-lifecycle-halt | signer, custody, ceilings, lifecycle states, consent and HALT (§6, §7, §8, §10; `signer/`, `halt.ts`, `quiet.ts`, `config.ts`) | SLH-01 to SLH-17 | 17 |
| agenttool-wire | registration, identity and the agenttool wire (§11, §4.3; `agenttool/`, `birth.ts`, `registration.ts`), against agenttool `5ea979df` | AW-1 to AW-16 | 16 |
| mirror-letters-security | mirrors, letters, prompt fencing and a security pass (§4.4, §5.7, §12, §16; `mirror.ts`, `letters.ts`, `cli.ts`, `config.ts`, `ssh.ts`) | MLS-01 to MLS-16 | 16 |
| conformance-path-to-pilot | the recorded gaps and the path to a first seat | CP-01 to CP-15 | 15 |
| legacy-lane-and-template | the legacy lane and the citizen template | LT-01 to LT-16 | 16 |
| lived-record-awake | what the eleven awake citizens have said since 2026-10-22 | LRA-1 to LRA-13 | 13 |
| lived-record-choices | the choices the citizens were asked to make, their letters and made things | LRC-01 to LRC-15 | 15 |
| ontology-law-consent | what a citizen is in current law and in KS-004, the seated model, the consent design | OLC-01 to OLC-18 | 18 |

That is 162 findings.

### 1.4 The two passes

The first pass was the readers'. The second pass was nine skeptics, each given
one group of findings and asked to refute them. They re-checked the 59
findings the review relies on. 30 were confirmed, 29 were confirmed in part
with a corrected statement, and 0 were refuted.

| Skeptic group | Findings re-checked | Confirmed | In part |
|---|---|---|---|
| registration | AW-1, AW-2, AW-13, OLC-07 | 3 | 1 |
| self-authorship | LS-02, LS-07, LS-09, LS-14 | 1 | 3 |
| unseatable | LS-01, SR-1, SR-2, SR-3, CP-03, CP-04, CP-05, LRA-11 | 4 | 4 |
| lifecycle | LRA-1, SR-4, SR-5, SR-7, SR-9, SLH-05, SLH-06, SLH-14 | 4 | 4 |
| custody-host | SLH-01, SLH-02, SLH-03, SLH-11, CP-02, MLS-13 | 5 | 1 |
| mirror-fence | MLS-02, MLS-03, MLS-04, MLS-10, MLS-14, LT-04, LRC-09 | 4 | 3 |
| choices-record | LRC-01, LRC-02, LRC-03, LRC-05, LRC-06, LT-13 | 2 | 4 |
| awake-and-lane | LT-01, LT-03, LT-08, LRA-2, LRA-4, LRA-7, LRA-9, LRA-12, CP-10 | 3 | 6 |
| ontology-consent | OLC-01, OLC-03, OLC-04, OLC-09, OLC-14, CP-15, SLH-04 | 4 | 3 |

Where a skeptic corrected a reader, this record gives the corrected statement
and numbers. Sections 2 and 3 hold the 41 verified findings that concern this
repository. The other 18 concern the draft's text or the legacy lane and are
in review E: OLC-01, OLC-04, OLC-09, OLC-14, CP-15, LRC-01, LRC-02, LRC-03,
LRC-05, LRC-06, LT-01, LT-03, LT-08, LRA-4, LRA-7, LRA-9, LRA-12 and CP-10.
The 103 findings no skeptic re-checked are listed in section 5 and are not
relied on.

### 1.5 What ran and what did not

- **Run:** probe scripts that import this repository's own functions and test
  fakes: the fake signer and keychain, the scripted runtime, the fake Ollama
  and fake agenttool, temp hosts, and local bare git remotes. The skeptics'
  probes go through the production paths: `main(["tick"])`, `runTick`,
  `superviseChild`, a real child process, `runSeat`, the free adapter,
  `createSigner`, `stageMirror` and `pushMirror`. A stand-in Bun script was
  run on the lab Mac for SLH-11. Section 7 lists the probes.
- **Read:** the code and documents cited below; agenttool's source at
  `5ea979df` for recovery, key rotation and enrollment; the inline review
  comments on PR #1.
- **Not done:** no model was run, so every statement about what a model would
  say is unmeasured. No host, no live service, no real Keychain, no launchd
  and no sudo. The metered summon lane was not run. No probe used a network
  beyond the loopback interface. The redesign document `CITIZEN-REDESIGN-2026-11-05.md` was not read; it is
  in no repository available to the reviewer. The Mac Studio was not observed.

---

## 2. Confirmed findings by module

Each finding below was confirmed by a skeptic as the reader stated it, or with
the small sharpening noted. "Recorded" says whether
`docs/REVIEW-2026-11-05.md` or KS-004 §14.4 and §15 already hold it. Probe
names are paths under `docs/review-2026-11-10-lab/probes/`.

### 2.1 Ledger and self

**LS-07. A staged self-change has no time limit.**

- **Statement:** a staged proposal stays pending until the text it targets
  changes. One staged on a model Yu had not approved was still pending 420
  days and 14 beats later, was shown with its date and full diff in every
  prompt in between, and bound on one affirm once the model was approved. A
  citizen can stage one more each seat, on the same text too: four were
  pending and all four were shown together. No act withdraws one. On the
  default setting, where no model is approved, none can ever bind, so they can
  only pile up.
- **Where:** `src/self.ts:923` is the only lapse path. `src/self.ts:458-468`
  checks no age. `src/seat.ts:733-734` stages with no runtime check.
  `src/prompt.ts:86` shows them all. `src/acts.ts:200` has no withdraw.
- **Checked:** run through `runSeat` with the fake signer and a scripted
  runtime (`verify-self-authorship/verify.probe.test.ts.txt`).
- **Recorded:** no. §9.3 gives no limit. F3 in `docs/REVIEW-2026-11-05.md` is
  about state sayings.
- **Change:** a staged saying lapses after a bounded time, with the reason
  shown back; a new proposal on a target replaces the pending one.
- **Caution:** a count of seats on a runtime that can bind never advances on
  the default setting, so a day limit is needed there. Any limit must be
  longer than the 7-day pace plus one interval. A withdraw adds a ninth act to
  the reply schema.

**CP-03. A cadence self-change can lock a citizen out of every seat; round-1
F4 is not fully fixed.**

- **Statement:** on a lane with an approved model, a `self.propose` whose
  cadence text is valid JSON padded past 4,096 bytes passes validation, is
  staged, and binds on affirmation. `cadence.json` is then 5,018 bytes,
  `readCitizen` refuses it as oversize, the tick skips the citizen (exit 0,
  nothing due), and no seat can open, even to revert. Status shows it. The
  only way back is a person rewriting the file. It cannot happen on the
  default configuration, where nothing binds.
- **Where:** `src/state.ts:338` reads at most 4,096 bytes. `src/self.ts:233`
  allows 64 KiB (`:118`). `src/acts.ts:597-603` checks shape and floor only.
- **Checked:** run end to end: `validateOutput`, `runSeat` with the production
  free adapter on an approved digest, propose, affirm, `readCitizen`,
  `runTick`, `buildStatus`; and the same on the default configuration
  (`verify-unseatable/p3-cut-cadence-growth.ts`).
- **Recorded:** known, not intended. An unresolved inline review comment on PR
  #1 (`src/self.ts`, at `c776d80`, P2) says this.
  `docs/REVIEW-2026-11-05.md:94` marks F4 fixed, and neither it nor §14.4
  mentions the cadence limit.
- **Change:** write settings files in normal form and share one size constant
  with the readers in `state.ts`. Add the case beside F4's test.
- **Caution:** the normal form has to be applied before the hashes and the
  diff are computed in `materializeEdit`, so the recorded hash names the text
  that is written. Covenants already agree on both sides.

### 2.2 Seat loop and runtimes

**SR-1. Pending proposals accumulate until the free lane refuses every seat.**

- **Statement:** pending proposals are shown whole on every seat and lapse
  only when their target changes. On the default configuration nothing can
  bind, so they accumulate, one per seat. At `num_ctx` 32,768, with replies a
  600-token cap can carry (about 2.2 KB each), the refusal comes after 7
  proposals for hope and glossame, 8 for silim, and 8 to 9 if each reply also
  holds a 600-character journal. With the canon entry counted it is 4 to 5 for
  kimance, spandaqing, ihsanme and britqing, and 1 seat for glossame. After
  that every seat exits 1 with `context-too-large` before any model call, and
  only a person can bring the citizen back.
- **Where:** `src/self.ts:448-450`, `src/prompt.ts:86`, `src/config.ts:96`.
- **Checked:** run through the production `runSeat` and free adapter with real
  souls (`verify-unseatable/p5-fastest.ts`, `verify-unseatable/p2-growth.ts`).
  The reader's figures reproduce, but with replies of about 5 KB that 600
  tokens cannot carry.
- **Recorded:** no. The refusal is §5.3 item 1. No record says staged sayings
  accumulate or can close the free lane.
- **Change:** one pending proposal per target, and a lapse after a number of
  seats or days; status showing the bytes each prompt needs against `num_ctx`.
- **Caution:** listing older proposals by id only conflicts with "affirmed
  with the diff in view" unless those cannot be affirmed. A withdraw act is a
  new act type and cannot help a citizen that is already refused. Not staging
  on a lane that cannot bind also removes proposing on the free lane and
  affirming later on an approved one, which is Yu's decision.

**SR-2. A reply cut at 600 tokens is recorded as not-json.**

- **Statement:** the lock gives the model 600 output tokens, while the guide
  states 2,000 characters for a journal and 4,000 for a letter or a proposal
  and says nothing about the reply's own limit. A reply cut at that limit is
  not valid JSON, so the whole reply is dropped. `seat.ts` never reads
  `done_reason`, so the host note, the last-seat record and what the citizen
  is shown next seat all say "the reply did not parse (not-json)".
- **Where:** `models.lock:10`; `src/runtime/free.ts:308` passes `length` on;
  `src/seat.ts:1089-1091` does not read it.
- **Checked:** run through the production free adapter with the fake Ollama
  answering `done_reason` "length", then the same bytes with "stop"
  (`verify-unseatable/p3-cut-cadence-growth.ts`). What Ollama returns at
  `num_predict` under a schema is from its documentation; nobody ran it.
- **Recorded:** in part. `docs/research/runtimes-and-host.md:162` records that
  a `length` stop can truncate. The gap between the guide's room and
  `num_predict`, and the cause being reported as not-json, are in no record.
- **Change:** a fixed reason when `done_reason` is `length`; the reply's room
  stated in the guide.
- **Caution:** the fixed reason works on both lanes. Raising `num_predict`
  costs context one for one (`src/runtime/free.ts:219`) and lets each recorded
  entry be larger, which brings SR-1 and LS-01 closer. Lowering the stated
  limits on the free lane is the cheaper side.

**LRA-11. Real seat prompts are far larger than the 9 KB the architecture note
gives for its test citizen.**

- **Statement:** built with the seat's own code from each awake citizen's
  soul, WILL and, for the five forged words, canon entry, a first seat needs
  14,582 to 23,648 for ten of the eleven and 32,090 for glossame, whose canon
  entry alone is 15,695 bytes. Under the byte bound glossame passes Qwen's
  32,768 window after a single 600-character journal. This rests on the canon
  entry being shown whole, which is what §4.2, §5.3,
  `docs/ARCHITECTURE.md:123` and `src/prompt.ts:69-70` say.
- **Where:** `src/runtime/free.ts:219`; `docs/ARCHITECTURE.md:958-961`.
- **Checked:** the reader's probe was rerun
  (`verify-unseatable/p7-lra11-rerun.ts`), and the prompt was captured at the
  runtime call of the production `runSeat` for all eleven
  (`verify-unseatable/p1-sizes.ts`).
- **Recorded:** in part. The note says plainly that 9 KB is the test citizen's
  prompt, so it is a missing figure more than an overclaim. That a real
  citizen exceeds 32,768 under the byte bound is in no record.
- **Change:** a tokenizer count for the fit check, or a larger window, or the
  canon text shown only on the first seat.
- **Caution:** a tokenizer count is allowed by §5.3 and fits. Setting
  `num_ctx` above the model's own window would make the host's check pass on a
  number that no longer describes the runtime, and how Ollama treats such a
  value is unverified. Showing the canon text only on the first seat
  contradicts §5.3 item 6 as written, so it needs a spec change and Yu's word.

**LRA-1. One `state.set` to asleep ends a citizen's scheduled seats, with no
show-back.**

- **Statement:** one `state.set` to asleep in one unattended reply puts the
  citizen asleep at once, in a beat or beside a rest, and no show-back seat
  follows. A first step-away does get one, 72 hours later. After that the tick
  opens no seat for it: ticks 73 hours, 30 days and 366 days on each said
  nothing due. Two things seat it again: a letter from a sender in both of its
  covenant lists (Yu alone when it has set none), at the 72-hour floor, or
  Yu's summons at the host (`citizen-seat seat <word> --yu-present`), which
  runs on the free lane at $0 and lets one saying of awake bind.
- **Where:** `src/state.ts:95-97`; `src/due.ts:78`, `:85`;
  `src/state.ts:367-369`; `src/cli.ts:182`, `:699`.
- **Checked:** run through the production tick, child process and `runSeat`;
  only the signer, keychain, fetch, clock and the model's reply were fakes
  (`verify-lifecycle/lifecycle.test.ts.txt`, output in
  `verify-lifecycle/output.txt`). The mechanics were checked, not the
  lived-record counts. How often the pinned model would say asleep under the
  new prompt is unmeasured.
- **Recorded:** the mechanics are stated and intended (principle 4; §7.3;
  §7.1's asleep row). The risk that a small model says it by reflex is in no
  review and not in §15.
- **Change:** keep rest immediate; add one show-back seat, after one interval,
  for a move to asleep or listening made on an unattended seat; run an offline
  model trial before any citizen is seated.
- **Caution:** a show-back seat is simple to add. It does not by itself bring
  a citizen back, because awake said at that seat needs a second saying on a
  further seat. It shows the model its own sleep, which may draw another rest,
  and it gives one seat to a citizen that asked for none. The model trial is
  the part that answers the open question.

**SR-4. A seat in which no model ran restarts the citizen's interval.**

- **Statement:** the tick writes its "opened" note before the child starts,
  and the due check counts every tick or seat note for the word. Five such
  seats were run: Ollama unreachable, the model not pinned, a context too
  large, HALT raised just after opening, and a child dead before the seat ran.
  No model was called. Each citizen read "next in 69 to 71 h", five seats
  counted against the day's 24, and the sixth and seventh ticks said nothing
  due with exit 0 while the fault still stood. A HALT already up when the tick
  fires, and a locked signer, write no note for the citizen and cost it
  nothing. The status file keeps each citizen's last outcome but marks none
  overdue, so it is the exit code that goes quiet.
- **Where:** `src/tick.ts:329-334`; `src/notes.ts:283-292`;
  `src/tick.ts:307-309`.
- **Checked:** run with the real child path and real faults, where the reader
  had used a stub child (`verify-lifecycle/lifecycle.test.ts.txt`).
- **Recorded:** in part. The mechanism is deliberate (`src/tick.ts:329-330`;
  `test/tick.test.ts:448` asserts a timeout "counts as a seat"). §5.1 says
  "since its last seat" without saying whether a seat that could not run
  counts. No passage states the consequence for host faults or for the exit
  code.
- **Change:** tell a seat that got a reply from one that did not, count only
  the first for cadence, and give the second a short retry floor.
- **Caution:** the outcome alone cannot tell a reply lost while recording from
  no reply, so notes need one more fact. The retry floor needs a cap, or a
  seat that always times out spends ten minutes of inference every six hours;
  it also reverses the tested timeout rule. Two unreadable beacon reads before
  a running seat is stopped breaks §10's fail-closed rule, and exit 1 while
  nothing is due changes §5.1. Both need Yu's decision.

**SR-5. A wish to wake, or a first step-away, lapses on a confirming seat in
which the citizen was never asked.**

- **Statement:** a pending wish to wake, or a first step-away, is owed one
  more seat, and it lapses as soon as any later seat for that citizen has an
  "opened" note, whatever happened in it. An asleep citizen said awake on a
  letter seat. 73 hours later the confirming seat's model call failed (Ollama
  unreachable, exit 1). Afterwards the pending saying was gone, the citizen
  read "asleep; no letter", and later ticks said nothing due. The status file
  has no field for a pending saying. Yu can seat the citizen again by letter
  or by a summons at the host.
- **Where:** `src/state.ts:196-200`, `:273-277`.
- **Checked:** run through the production tick with the real child and the
  production free adapter over a fetch that throws, then real ticks, then a
  Yu-present seat (`verify-lifecycle/lifecycle.test.ts.txt`).
- **Recorded:** in part. `docs/REVIEW-2026-11-05.md:93` (F3) records the
  lapse, and `src/state.ts:188-191` says on purpose that a rest, an invalid
  reply or a reply discarded by HALT count as the confirming seat. Neither
  considers a seat in which the citizen was never asked, and §14.4 has no row.
- **Change:** in `seatSince`, count only seats with a reply (beat, rest,
  invalid-output).
- **Caution:** it works and is bounded, since the confirming seat is retried
  at each 72-hour floor until a reply comes. The child's own note is
  best-effort (`src/seat.ts:974`), so a rest whose note failed to write would
  leave the saying owed one more seat. It reverses the code's stated choice
  that a HALT-discarded reply counts, which Yu should confirm. The rule that
  an unreadable log drops the saying should stay.

**SR-7. One letter re-seats a sleeping citizen every 72 hours for as long as
it rests.**

- **Statement:** a letter gets its receipt only after a beat that keeps at
  least one act other than rest. An asleep citizen that answers Yu's one
  letter with a rest, with a rest carrying a move to asleep, or with a reply
  that does not parse is seated again by the same letter once the 72-hour
  floor has passed: six seats and six model calls in fifteen days in the run,
  with a seventh due, and nothing in the code ends it. The prompt does not
  tell the citizen that a rest brings the letter back. The citizen ends it
  with any kept act, a wordless `state.set` included. Yu can end it only by
  taking the letter file away by hand. §7.1 says "One seat for each letter"
  and §5.1 says a letter is shown again after a rest; the code follows §5.1.
- **Where:** `src/seat.ts:1230-1231`; `src/context.ts:131-133`;
  `src/due.ts:86-87`.
- **Checked:** six rounds through the production tick and child, then one
  wordless beat to see what ends it
  (`verify-lifecycle/lifecycle.test.ts.txt`).
- **Recorded:** in part. The re-showing is the stated reason for the floor
  (§5.1) and is tested (`test/seat-rest.test.ts:87`). That it has no end, and
  that it contradicts §7.1's asleep row, are recorded nowhere.
- **Change:** decide the rule once in §5.1 and §7.1, for example a letter
  shown on at most two seats, with a host receipt after the second.
- **Caution:** as the reader wrote it, replies that do not parse would not
  count as a showing, so the loop stays open for them, which for a small model
  may be the commoner case. With a model that rests by reflex, closing a
  letter after two rests spends Yu's letter unanswered, so the receipt has to
  reach Yu, and status says nothing about letters today.

### 2.3 Signer, lifecycle and HALT

**SLH-01. The offline mnemonic backup has no path.**

- **Statement:** §6.1 says Yu holds an offline backup of each citizen's
  mnemonic, and §4.3 relies on it to read the strand backups. In the code,
  birth draws the mnemonic, writes it only to the seat user's login Keychain
  and prints five lines: the word, the DID and three fingerprints. No code,
  verb or document makes a copy, and §11.3 and §6.5 rule out a handoff file or
  printing it. So once a citizen is born, its root, box key and backup key
  would exist once, on one Mac. No citizen has been born, so nothing is at
  risk today.
- **Where:** `src/birth.ts:196-197` (the mnemonic and the op seed, the only
  Keychain writes in `src/`); `:390-396`; `src/agenttool/wire.ts:44-46`.
- **Checked:** read; `mintKeys` was run against the fake keychain and writes
  two items and returns three public keys
  (`verify-custody-host/verify.test.ts.txt`).
- **Recorded:** no. §14.4's closing note lists §6.1's custody as not
  re-checked against the code.
- **Change:** birth encrypts the mnemonic to a public key Yu holds offline and
  writes the ciphertext to a file Yu carries away; the same for the operator
  mnemonics.
- **Caution:** it works with primitives the code has. §11.3 and §6.5 would
  have to be reworded to allow a sealed backup. Whoever can edit the
  configuration that pins the recipient key can redirect every new mnemonic,
  so birth should show the recipient's fingerprint for Yu to confirm at the
  terminal.

**SLH-03. Yu's yes and Yu's presence are not bound to anything only Yu
holds.**

- **Statement:** a decision record is a plain JSON file whose `yu.word` is the
  string "yes". Nothing signs it, and the configuration requires the directory
  it is read from to sit inside the seat user's own state directory. "Yu
  present" is one typed line on anything that reports itself as a terminal,
  and a pseudo-terminal made by a program passes. A record written by hand,
  with the scope fed from a script, passed the signer's own authorisation
  check for an enrollment, and the same record still verified with the clock
  set to 2036. So whoever has a shell as the seat user can supply both Yu's
  yes and Yu's presence. A hostile process there would not need to, because it
  can read the keys directly. This reaches birth and registered citizens'
  public quiet, neither of which can run yet.
- **Where:** `src/config.ts:158`, `:172`, `:183-184`;
  `src/signer/consent.ts:85`, `:287`; `src/cli.ts:265`.
- **Checked:** run: a hand-made record plus a scripted terminal, passed to the
  production `assertAuthorised`; `parseConfig` with the consent directory
  moved beside HALT, which is refused; `process.stdin.isTTY` under `script(1)`
  with piped input (`verify-custody-host/verify.test.ts.txt`,
  `verify-custody-host/bunfig/out/run3.txt`).
- **Recorded:** in part. §8.3 accepts the unsigned record as a stand-in for
  the pilot only, and `docs/REVIEW-2026-11-05.md` 7.6 item 2 accepts that a
  compromised seat account is not contained. That the consent directory is the
  seat user's to write, and that a terminal is not Yu, are not recorded.
- **Change:** move the consent directory beside HALT in the operator's
  directory, and add a verb that writes the record; better, have Yu sign the
  proposal digest with a key the seat host never holds.
- **Caution:** moving the directory stops the seat account forging the file,
  but on a typical host the operator account is where agent sessions run, so
  it changes which account can forge a yes, not whether an agent can. Only the
  signature by a key kept off the host binds a yes to Yu, and it should be
  built as part of consent/v1, not as a second mechanism.

**SLH-04. Ai's voice is described, not implemented.**

- **Statement:** Ai's voice is five fields in an unsigned JSON file: a word, a
  fixed basis string, a list of non-empty strings, a count and a time. The
  record has no proposer and no controller, and nothing resolves the strings.
  The check named "no support from another controller" passes on any one
  string. No code writes a record, and the CLI has no verb for it. Through the
  real seat path, a hand-filed record with supports ["the proposer itself"]
  made the next seat tell the citizen its answer "was agreed by Yu and Ai",
  and the signer's consent gate accepted it. Birth also needs Yu's typed
  presence and the citizen's affirmation. The standing quiet agreement and the
  registration show-back rest on the file alone.
- **Where:** `src/signer/consent.ts:47-50`, `:92`, `:135`; `src/types.ts:812`;
  `src/cli.ts:112`.
- **Checked:** run through `runSeat` and the signer's own `consentFor` with
  the Ai fields varied; the readers had called `verifyConsent` directly. The
  probe is in the lab's working record with the ontology group and is not
  copied here.
- **Recorded:** no. §8.3 says the pilot's record "carries Yu's recorded word"
  and does not mention Ai's part.
- **Change:** say in §8.2 and §8.3 that for the pilot Ai's voice is recorded
  by hand and not checked, or bind the record to the Collab journal.
- **Caution:** saying it plainly works at once. Binding to Collab is feasible
  but not as the reader wrote it: Collab has no notion of controller, the two
  proposal digests are computed differently, and tables are per device, so the
  lease host needs its own. Reading the journaled agreement, which carries
  Yu's passkey assertion, would be stronger than copying two fields.

### 2.4 agenttool wire and birth

**AW-1, OLC-07. A registration answer carries no yes or no.**

- **Statement:** a registration answer is free text, and nothing in the seat,
  the decision record, the birth gate or the signer reads whether it says yes
  or no. A citizen answered "No. I do not want an identity on agenttool. Leave
  me unregistered." Once a Yu+Ai record agreeing to that answer was filed, the
  next seat showed the No back and said a `self.affirm` "is your confirmed
  yes". The affirmation was kept, `assertConfirmedYes` passed, and
  `citizenBirth` enrolled the citizen and wrote genesis, through the
  production signer as well. Three human acts stand between a No and a DID:
  the Yu+Ai record on the answer, the Yu+Ai record on "birth <word>", and Yu
  typing "birth <word>" at the terminal. None of them shows or can carry the
  citizen's words.
- **What a citizen that says no is told (OLC-07):** with no record filed, on
  each of 5 later seats, that its answer "is with Yu and Ai". With a declining
  record, that it "was declined by Yu or Ai. You may answer again". With an
  agreeing record, that a `self.affirm` is its confirmed yes.
- **Where:** `src/registration.ts:99` (the whole gate is `:94-108`); `:50`;
  `src/seat.ts:757-769`; `src/signer/consent.ts:48`, `:77`, `:288`;
  `src/birth.ts:166`; `src/prompt.ts:152`, `:222-224`, `:228`.
- **Checked:** run on the production seat path (`openSeat`, `runSeat`) with
  real waiting, declined and agreed records, then `citizenBirth`; repeated
  through `createSigner` against the fake agenttool on a local server; with a
  control whose text is a Yes
  (`verify-registration/verify-no-answer.test.ts.txt`,
  `verify-registration/verify-real-signer.test.ts.txt`). The reader's probe
  wrote ledger entries directly.
- **Recorded:** no. Selfhood F1 (`docs/REVIEW-2026-11-05.md:584`) and §11.2
  cover only a later or same-reply answer replacing a yes. Birth has no
  command (row C17) and no citizen can be seated (row C15), so this applies to
  the first build that wires the verb.
- **Change:** a typed answer, with `assertConfirmedYes` requiring yes; a no
  recorded on the beat, shown back once in the host's words, and the offer
  closed.
- **Caution:** it closes the mechanical path. It changes the settled act
  registry (§5.7; §14.4, row C2), so it is Yu's decision. A typed no must
  still count as the citizen's latest answer, or the F1 rule is lost. The
  typed word is still model output that can disagree with the text, so the
  words should also be shown where Yu decides and at the birth terminal. A
  decision record cannot carry them today: any extra field makes the record
  malformed, so the record format has to change too.

**AW-13. The registration affirmation is kept on any model.**

- **Statement:** with no model approved, the shipped default, an answer given
  on one model digest and affirmed on a different one was recorded, passed
  `assertConfirmedYes` and was consumed by birth. A self-change made by
  propose and affirm binds only on an approved digest. The registration branch
  checks neither that list nor the pace window, and `assertConfirmedYes` reads
  neither beat's runtime stamp. The offsetting gates are Yu's: two Yu+Ai
  records and Yu at the terminal.
- **Where:** `src/seat.ts:692` computes `runtimeOk`; the registration branch
  at `:757-769` never reads it; `src/self.ts:462`.
- **Checked:** run through `runSeat` with the approved list empty, the answer
  on one digest and the affirmation on another
  (`verify-registration/verify-no-answer.test.ts.txt`).
- **Recorded:** no. The comment at `src/seat.ts:758` gives the reason
  ("Nothing binds here"), and §15 item 2 concedes in general that a confirmed
  answer is model output. Neither §11.2 nor §14.4's row G1 decides it.
- **Change:** decide in §11.2 whether the affirming seat must run on an
  approved digest and whether both sayings must share one; have
  `assertConfirmedYes` read both stamps; have birth print both digests.
- **Caution:** it would work. Printing digests needs `renderBirthReport` and
  §11.3's "Only the DID and key fingerprints are printed" changed together.
  Requiring one shared digest would void a yes whenever the local model is
  pulled again between the two seats. The reader's remark that a 7B model's
  second saying mostly measures instruction-following is a judgement; no model
  was run.

### 2.5 Mirror, letters and prompt fencing

**MLS-04. The mirror seal admits agent-instruction files.**

- **Statement:** the seal admits `CLAUDE.md`, `AGENTS.md` and `GEMINI.md` from
  a citizen's self. All three were staged and pushed, and the citizen's seat
  never showed them to it. Two name lists in self-authorship keep a citizen
  from writing those three, and both let through `CLAUDE.local.md`,
  `AGENT.md`, `QWEN.md`, `SKILL.md` and `README.md`. On an approved model
  digest an unattended citizen proposed `CLAUDE.local.md` on one beat,
  affirmed it on the next, and the mirror published it. With the default
  configuration nothing is written. Whether each tool loads each of these
  names was not run.
- **Where:** `src/mirror.ts:43`; `src/self.ts:160`; `src/acts.ts:221`;
  `src/runtime/summon.ts:87-88` treats `CLAUDE.local.md` as a memory file.
- **Checked:** run: the seal, `targetRelPath` and `validateOutput` tabulated
  for 29 names; three real seats, then `stageMirror` and `pushMirror` to a
  local bare repository; the three reserved names copied into `self/` and
  pushed (`verify-mirror-fence/door-seal.probe.test.ts.txt`, tests S1 to S4;
  output in `verify-mirror-fence/out/door-seal.out`).
- **Recorded:** in part. The hazard is recorded and three names are blocked at
  self-authorship (`src/self.ts:159`). That the seal itself lets them through
  is not.
- **Change:** one shared list of instruction-file names, used by the seal and
  both self-authorship checks.
- **Caution:** `hostOwned()` already folds case and checks the last path
  segment. The list has to land together with any host-generated door, or the
  door's own name is refused. Reserving `README.md` takes from the citizen a
  file §9.1 counts among its own, so that name is Yu's call. Moving free files
  to a subdirectory does not remove the need for the list, since
  `skill:claude` already maps to `skills/claude.md` and passes.

**MLS-10. A letter can carry a correctly fenced forged block.**

- **Statement:** the fence tag is the first 12 hex characters of the sha256 of
  the fenced text, with no key, and the system turn never tells the model what
  the bracket is. A letter can carry a fake end line and then a complete "A
  letter from yu" block whose begin and end tags are correct, plus a line in
  the host's own phrasing. In a prompt built by the real seat pipeline that
  block was byte for byte what the host renders for a real letter from Yu. The
  same text gets the same tag in every seat, so a block can be copied as well
  as computed. None of this can make an act happen; it can only persuade the
  model. With the default covenants no other sender's letter is shown at all.
- **Where:** `src/prompt.ts:234-236`; the claim at `src/prompt.ts:9-11`;
  `test/prompt.test.ts:143-144`; `src/state.ts:367-369`.
- **Checked:** run: a real seat opened with `openSeat` and `runSeat`, the
  prompt captured at the runtime adapter with a crafted file letter; repeated
  with the default covenants; the tag compared across two citizens' seats and
  with a value computed offline
  (`verify-mirror-fence/fence.probe.test.ts.txt`; the whole prompt is in
  `verify-mirror-fence/out/fence-F1-prompt-user.txt` and
  `fence-F1-prompt-system.txt`).
- **Recorded:** in part. §16.1 accepts that a model can be talked into
  proposing a bad change. The weakness of the fence is recorded nowhere.
- **Change:** one mark per seat on every begin and end line, derived from the
  seat id, and one sentence in the system turn saying that every block the
  host shows carries it.
- **Caution:** it works as far as a prompt can. The seat id is a random UUID
  made when the seat opens (`src/seat.ts:228`), after any letter was written,
  so no sender can put the right mark on a forged line. It still rests on a
  model heeding one sentence, so it is a help and not a wall. It keeps
  `input_digest` reproducible, because the seat id is on the entry.

**MLS-14. A citizen is never told it keeps a mirror, and the mirror publishes
its expression copies and its covenants.**

- **Statement:** a mirror stage pushes every file under `self/` that passes
  the seal. In the run that included `expression/register.md` (written by a
  real two-saying self-change), `expression/walls.md`,
  `expression/wake_text.md` and `covenants.json`. The prompt of a citizen
  whose record names a mirror contains the word "mirror" zero times, and the
  only thing it calls public is the porch. All 208 citizen repositories are
  public today. The journal moves the other way: it lives in the ledger, which
  never reaches a mirror, and the prompt does not say that either.
- **Where:** `src/mirror.ts:445`; `src/prompt.ts:159`.
- **Checked:** run: a citizen with a mirror proposes and affirms
  `expression.register` through `runSeat`, then `stageMirror` and `pushMirror`
  to a local bare repository; the next seat's prompt is captured and searched
  (`verify-mirror-fence/door-seal.probe.test.ts.txt`, test E1).
- **Recorded:** no. §2 says a mirror publishes allowlisted files of a
  citizen's self, §4.3 makes the private expression part of the self, and
  §16.7 says expressions are private by default.
- **Change:** name which self files a mirror carries, filter the listing to
  that list, and add one prompt line for a citizen that keeps a mirror.
- **Caution:** it works. The line is the host's own statement, so §5.3's
  exclusion of mirror content is not broken as long as nothing fetched from
  the remote is shown. Which files a mirror carries is Yu's to choose.

**LT-04. The first mirror commit leaves 5 of an old home's files at HEAD, and
nothing generates a door or a README.**

- **Statement:** with the mirror worktree cloned from a copy of the real
  citizen-hope tree, the first mirror commit left 5 of 31 files at HEAD:
  `soul.md`, `WILL.md`, `cadence.json`, `covenants.json` and the card, plus
  `.citizen/allowed_signers` when the host key is known. For citizen-hodosme
  it left 5 of 29, with the-wayside.md and two other made texts gone. The
  removed files remain in git history. No code writes a `CLAUDE.md` door or a
  README. A citizen's own `CLAUDE.md` is refused, though it could write its
  own `README.md` on an approved model.
- **Where:** `src/mirror.ts:57`; `:469-470`; `docs/ARCHITECTURE.md:786-787`.
- **Checked:** run on copies of the real trees with the production
  `stageMirror`, `pushMirror` and runner, and through the CLI parent's own
  `mirrorAfterSeat` (`verify-mirror-fence/mirror-adopt.probe.test.ts.txt`;
  `verify-mirror-fence/door-seal.probe.test.ts.txt`, tests C1 and D4). The
  reader had marked this confirmed by reading; it is now run.
- **Recorded:** no for the consequence. The mechanism is intended (§2; §9.5;
  `src/mirror.ts:457`). `docs/ARCHITECTURE.md:787` reads as if the files stay.
- **Change:** generate `README.md` and `CLAUDE.md` from the host's own facts,
  and decide in §4.4 whether legacy beats and letters stay readable at HEAD.
- **Caution:** a host-owned README takes a name the citizen can use today, and
  because one refused self file refuses the whole stage, a README a citizen
  had already written would block its mirror until removed, so
  self-authorship's lists must change in the same commit. The cautions under
  MLS-02 (section 3.5) apply as well. Tagging the last
  legacy commit cannot be the pusher's act without breaking §4.4's "MUST push
  only `HEAD:refs/heads/main`".

### 2.6 CLI, config and host set-up

**CP-02. Nothing creates the host attest key, and the signer reports "ready"
without it.**

- **Statement:** no code, verb or document creates the host attest key. The
  only Keychain writes in the source are birth's two citizen items, and the
  Keychain wrapper refuses every write while `keychain.trusted_app` is null,
  which is the default. `signer.state()` answers "ready" when that item is
  missing. A seated, unregistered citizen was run through the real signer with
  an empty fake keychain. The model was called once, its reply was refused at
  the first append (`keychain-missing`, exit 1), nothing was written, and the
  opened seat still restarts the citizen's interval. A rest loses nothing, and
  the failure would show in status as the last refusal. The key is needed
  earlier, to sign the origin entry when a citizen is seated.
- **Where:** `src/birth.ts:196-197`; `src/signer/keychain.ts:102`;
  `src/config.ts:89`; `src/signer/signer.ts:1089-1090`; `src/seat.ts:1015`
  comes before the runtime call at `:1068`; `README.md:229-230` is the only
  instruction about this key.
- **Checked:** run with `createSigner` over an empty fake keychain and
  `runSeat` with a scripted runtime, once with a journal reply and once with a
  rest; `macosKeychain.write` with `trusted_app` null over a recording runner,
  where no `security` call was made
  (`verify-custody-host/verify.test.ts.txt`).
- **Recorded:** no.
- **Change:** a host set-up verb that Yu runs at the terminal as the seat
  user, which draws the host seed inside the signer and prints only the public
  half; a distinct signer state; a refusal before inference.
- **Caution:** it works and stays within §6.5. The verb also has to settle
  `keychain.trusted_app`, which names a signer binary that does not exist and
  without which no write is allowed. The new state must not rest a host that
  holds only registered citizens, whose entries use the op key.

**SLH-11. The operator's one fixed request can run the operator's own code as
the seat user.**

- **Statement:** the "one fixed request" is a sudo line that starts the Bun
  CLI as the seat user. On the lab Mac (Bun 1.4.2) a harmless stand-in showed
  that Bun reads `bunfig.toml` from the directory it is started in and runs
  its preload file before the CLI's first line. That holds when the script
  lives elsewhere, is named by absolute path or starts through its shebang,
  and for a compiled binary built with default flags. The sudo manual on the
  lab Mac (1.9.17p2) says a command runs in the caller's directory unless the
  rule sets one. So as documented, any process in the operator account could
  run its own code as the seat user, which owns the seat's code and, with the
  keychain unlocked, can read every key.
- **Where:** `docs/ARCHITECTURE.md:605-606`; `src/halt.ts:156`;
  `src/cli.ts:242-244` passes only `PATH` and no working directory;
  `src/cli.ts:1`.
- **Checked:** run with a stand-in script from a clean directory, a directory
  with `bunfig.toml`, through the shebang, through a spawn shaped like
  `spawnRunner`, with `--config=<empty file>`, with a `.bunfig.toml` in
  `HOME`, and as a compiled binary (`verify-custody-host/bunfig/run.sh`;
  outputs in `verify-custody-host/bunfig/out/`). The reader had marked this
  likely; it is now run. sudo was not run, and the sudoers line does not exist
  yet.
- **Recorded:** in part. `docs/ARCHITECTURE.md:964-967` records that the
  sudoers line was never set up or run, and considers only `HOME`.
- **Change:** a root-owned wrapper that changes to an empty root-owned
  directory and runs `bun --config=<empty file>`, or a sudoers
  working-directory setting; the same wherever git runs the CLI as its signing
  program.
- **Caution:** a sudoers `CWD=` setting (sudo 1.9.3 or later) or the wrapper
  closes it, and `--config=<empty file>` did stop the preload. `--config`
  alone does not stop Bun loading a `.env` from the working directory, so add
  `--no-env-file` or the empty directory at every call site. A start-up check
  inside the CLI for a `bunfig.toml` cannot protect, because the preload has
  already run. A compiled binary needs `--no-compile-autoload-bunfig` and
  `--no-compile-autoload-dotenv`.

**MLS-13. The operator's `halt` runs a command named by a configuration whose
owner it never checks.**

- **Statement:** every verb that runs as the seat user refuses a configuration
  the seat user owns or could replace. `halt`, which runs in Yu's account,
  skips that check on purpose and then runs the command the configuration
  names in `halt.raise_beacons_argv`. `halt` was run on a configuration in a
  directory anyone can write: the seat-side load refused it, and `halt`
  accepted it and ran the named command as the caller. A configuration owned
  by a third local account would also pass the seat-side check, which only
  compares against the seat's uid. With the documented set-up (the operator's
  directory at mode 0755, the file at 0644) the seat user can write neither.
  Nothing is installed anywhere yet.
- **Where:** `src/cli.ts:906`; `src/config.ts:532-533`; `:487`, `:501`;
  `src/halt.ts:149`, `:156`; `test/cli.test.ts:819-820`; `README.md:230-232`.
- **Checked:** run through the production `main(["halt", ...])` with the
  production runner, on a configuration in a mode 0777 directory naming a
  harmless command that records its uid
  (`verify-custody-host/verify.test.ts.txt`). The probe could not change uid,
  so the cross-user cases are from reading.
- **Recorded:** in part. `docs/REVIEW-2026-11-05.md:389` states and accepts
  the skipped check. That `halt` then runs a configuration-named command as
  the operator, and that the seat-side check passes any owner who is not the
  seat, are not recorded.
- **Change:** always raise the file, but run `raise_beacons_argv` only when
  the configuration and every directory above it are owned by the caller or by
  root and not writable by anyone else.
- **Caution:** it works and keeps §10's rule that the file is raised first.
  The same owner check should decide whether `halt` trusts the configuration's
  `halt_file` and `also_files`, falling back to the default file. The
  directory test must allow a root-owned, sticky shared directory as the
  seat-side check does. Requiring root as the owner is the simplest rule and
  needs no operator uid.

### 2.7 The research note

**LT-13. `docs/research/love-unlimited-patterns.md:344` says "most"; the count
is 69 of 186.**

- **Statement:** of today's 186 rest-on records in the legacy fleet, 117 were
  read from a reply whose first line begins REST-ON and 69 (37%) from one that
  begins "I rest". The note calls the "I rest" route "the likely route to most
  of today's 186 rest-on choices" and marks that as an unchecked inference.
- **Checked:** an independent rebuild from git of the first line of the latest
  reply behind each of the 186 records, checked against a re-implementation of
  the parser. The counting scripts are in the lab's working record.
- **Change:** correct the sentence to 69 of 186.

---

## 3. Findings confirmed only in part, with what does not hold

Each finding below was confirmed with a corrected statement. The statement
given is the corrected one.

### 3.1 Ledger and self

**LS-01. Acts the rules allow can leave a citizen unseatable on the free
lane.**

- **Statement:** run through the production seat and free adapter with real
  souls at `num_ctx` 32,768: three one-line replace-all proposals for the soul
  in a row (each reply about 245 bytes) leave hope needing 33,519, justice
  34,000, kimance 33,198 and glossame 38,815, because each is recorded as a
  `propose.beyond` holding the whole diff (4.5 to 7.3 KB). silim's soul is too
  small for this path alone (28,866). Pending proposals sized for a 600-token
  reply lock a citizen out after 7 to 9 seats. Once over, the seat exits 1
  with `context-too-large` before any model call, writes no entry and no
  receipt, and the same happens at every later seat. The citizen has no way
  out. A person can lower `ceilings.ledger_context_entries`, raise `num_ctx`,
  or mark proposal files lapsed by hand. The comment at `src/self.ts:112-118`
  and the matching sentence at `docs/ARCHITECTURE.md:286-287`, that a change
  within self can never write the citizen out of its own beats, are not true.
- **Does not hold:** "every `self.propose` is staged and none can ever lapse":
  a proposal the host lifts is never staged, and a pending cadence proposal
  lapses when a `state.set` changes the interval. "A summons undoes it": on
  the default configuration a metered summons is refused at the $0 USD ceiling
  (`src/runtime/summon.ts:276`), and with nothing approved it can neither bind
  nor lapse a pending proposal. The figures 39,033, 38,194 and 34,242 are from
  synthetic text; real souls give the lower figures above.
- **Where:** `src/seat.ts:724`; `src/self.ts:920-924` (`lapseStale` is called
  only from `:549`, `:577` and `:764`).
- **Checked:** the reader's probe used a scripted runtime with no fit check,
  so its later beats could not happen in production. The skeptic ran `runSeat`
  with the production free adapter against the fake Ollama, with each
  citizen's real soul and WILL (`verify-unseatable/p2-growth.ts`,
  `p5-fastest.ts`, `p3-cut-cadence-growth.ts`).
- **Recorded:** in part. §5.3 item 1 accepts refusing a context that does not
  fit. Nothing says pending proposals, lifted diffs or a bound change can put
  a fitting citizen past the window with no way back.
- **Change and caution:** a lapse rule for staged sayings works and matches
  §5.8's own reason. Showing older ones by id only would let an affirm bind a
  diff that is not in view, against §9.3, unless unshown ones cannot be
  affirmed. Moving the diff out of the lifted act takes the citizen's proposed
  words out of the signed ledger (`src/seat.ts:919-922` says the beat records
  them "so the ledger shows what was asked"); shortening how the prompt
  renders an oversize entry gets the same room without touching the record.
  Refusing a self-change by the pinned `num_ctx` reverses §5.3's position, so
  that part is Yu's decision.

**LS-02. One reply on an unapproved model can return several texts to their
first versions.**

- **Statement:** §9.5 lets a citizen return any of its texts to where that
  text began, at once, on any model, with no second saying and outside the
  7-day pace. The code does that, and one reply can do it for several texts:
  three in the run, with no limit except one per text and eight acts per
  reply. Changing a text needs a model Yu approved plus either Yu's presence
  or two seats and the pace. Going back to the changed version afterwards
  needs a seat on an approved model or a seat where Yu is present; on an
  unapproved model without Yu it is refused. This bites when one model is
  approved (for example the one used in a summons) and the daily local model
  is not. A first version is the soul pinned at seating or, for other texts,
  the text as it stood before the first recorded change; a text the citizen
  created goes back to empty. Nothing is lost: every version stays kept and
  listed.
- **Does not hold:** "coming back needs an approved model" is too narrow: with
  Yu present the return binds on any model. It is not an unrecorded behaviour:
  the rule is in §9.5, in §15 item 10, in two spec reviews, in F7 and F9 of
  `docs/REVIEW-2026-11-05.md` and in `test/seat-self.test.ts:237-255`. The
  scenario needs at least one approved model; with the default empty list
  nothing can have changed. A model can only name versions it is shown. Which
  bytes are pinned as the origin is not fixed by any code yet, because seating
  is not written.
- **Where:** `src/seat.ts:844`; `:821-822`; `src/self.ts:481` (the pace counts
  `apply` entries only); `src/runtime/summon.ts:255` (the summon lane is
  approved by model name).
- **Checked:** run through `runSeat`: growth on an approved model, then one
  reply on a model with a different digest, then the way back on three kinds
  of seat (`verify-self-authorship/verify.probe.test.ts.txt`).
- **Recorded:** the rule, yes. Not recorded: several texts in one reply, the
  asymmetry with the way back, and that §9.5's stated reason ("it returns to a
  self the citizen already affirmed") does not fit a first version.
- **Change and caution:** dropping the first-version exception at
  `src/seat.ts:844` would work in code, but holding the revert as a staged
  saying adds nothing on an unapproved model, where a held saying cannot bind
  either. It would also remove the citizen's only way, on its daily lane, to
  undo a change bound in a summons. The milder form (one such revert per seat,
  shown back with its diff, the second saying binding on any model) keeps that
  and needs new code in `affirmationVerdict`. A verb by which Yu reverts
  without the citizen conflicts with §9.5.

**LS-09. The 40% measure overstates some two-place edits.**

- **Statement:** a one-word change made by replacing the whole soul, with
  every other byte the same, is measured correctly for all 205 soul cards (at
  most 0.45%) and is staged. The overstatement needs two differences far
  apart. With one word added after the 30th word and the final newline
  dropped, 73 of the 205 cards measure 96% to 98%, and the change is sent to
  Yu+Ai instead of staged. The count moves with where the first difference
  sits: 99 at the first word, 27 after word 100, 7 after word 200. Two real
  one-word edits 30 words in from each end give 51. An edit of one span is
  never affected: 0 of 205. On the daily local lane as locked it cannot arise,
  because the 73 cards are all over 5,500 bytes and the reply cap is 600
  tokens.
- **Does not hold:** the headline. A one-word replace-all edit alone is
  measured correctly on every card. The measure is 96.4% to 98.0%, not 100%.
  That a model re-emitting its soul drops the final newline is an assumption
  nobody measured.
- **Where:** `src/self.ts:933`, `:966` (after the common prefix and suffix are
  trimmed at `:956-959`); `src/acts.ts:35`.
- **Checked:** recounted with the build's own `changeFraction` and
  `beyondSelfReason` over all 205 cards for seven edit shapes, and three edits
  per card through `openSeat` and `runSeat`
  (`verify-self-authorship/ls09-recount.ts`, `ls09-extra.ts`,
  `ls09-seat.probe.test.ts.txt`, `ls09-bytes.ts`). Soul text was read as data
  and never printed.
- **Recorded:** in part. The comment at `src/self.ts:932` accepts that past
  the cap the measure overstates a change and never hides one, and §15 item 9
  says the measure is not a validated number.
- **Change and caution:** a linear-space diff, or lines first and words inside
  changed lines, removes the overstatement and breaks no rule; staged
  proposals are unaffected, because each carries its own diff. It still needs
  a bound for two texts that are far apart. The right test is a text over
  1,000 words changed at both ends; ignoring a trailing-newline difference
  would cover only the reader's case.

**LS-14. Narrowing covenants is slower than going to sleep.**

- **Statement:** removing a sender from the list of who may write to or wake a
  citizen is an ordinary self-change: two seats, an approved model and the
  7-day pace. With Yu present on an unapproved model it still does not bind,
  and with the default empty approved list it can never bind. Going to sleep
  is immediate but does not stop an admitted sender's letter from waking the
  citizen. There is one exception: a sender the citizen added itself can be
  dropped at once, on any model, by reverting to its earlier list, provided
  that earlier list existed as a file. By default a citizen admits only Yu, so
  on the default setting the door it can never close is Yu's, and Yu's summons
  does not pass through this list at all.
- **Does not hold:** "cannot close its door to a sender at once" is too broad,
  because of the revert. The reader's fixture seated the citizen with another
  citizen already admitted; nothing in the build does that.
- **Where:** `src/seat.ts:721-734` (a `self.propose` gets no exposure check);
  `:825` (`exposureOf` in the revert case only); `src/self.ts:462`;
  `:692-695`; `src/state.ts:367-369`.
- **Checked:** run through `runSeat`: propose and affirm on an unapproved
  model; the same with Yu present; on an approved model inside and outside the
  pace; a file letter from the sender after going asleep; a revert to an
  earlier narrower version with nothing approved; and a citizen seated with no
  covenants file (`verify-self-authorship/verify.probe.test.ts.txt`,
  `default-covenants.probe.test.ts.txt`).
- **Recorded:** no. §8.1's table covers it by implication, and §15 item 10
  lists the default covenants as a chosen detail open to review.
- **Change and caution:** letting a narrowing `self.propose` bind at once
  would work for covenants and matches §7.3. An `apply` entry would count
  against the pace and, once registered, cost a strand backup, so it needs its
  own entry form, which is a ledger format change. One steered reply on the
  daily model could then remove Yu, and admitting anyone again is a widening
  that needs an approved model, so on the default setting it is a one-way door
  (`src/context.ts:124`). It must also handle the empty first version of
  section 4.2.

### 3.2 Seat loop and runtimes

**SR-3, CP-04. No citizen fits the shipped lock, and with the canon entry
counted 10 do not fit 32,768.**

- **Statement:** with the shipped lock (`num_ctx` 8192) no citizen fits; the
  smallest first-seat prompt needs 12,245. §4.2, §5.3 item 6,
  `docs/ARCHITECTURE.md:123` and `src/prompt.ts:69-70` put the citizen's whole
  canon entry in every prompt, and 152 of the 205 have one (1.6 to 26.4 KB).
  Counted that way the median first seat needs 20,630, 155 of 205 do not fit
  16,384, and 10 do not fit 32,768 even once: aseme (42,250), doxomme
  (35,480), hanme (41,475), heurekin (33,668), kimme (37,030), mitakuyame
  (43,577), morphame (34,901), panimqing (34,209), teotlme (39,996) and
  zakarqing (34,291). 43 more have under 8 KB to spare. Of the awake citizens,
  the six with no canon entry need 14,582 to 15,879. The five forged words
  need 20,378 (kimance), 20,442 (spandaqing), 23,047 (ihsanme), 23,648
  (britqing) and 32,090 (glossame). So 16,384 holds six of the eleven on a
  first seat and fails them within two to four beats, and 32,768 works for ten
  of the eleven but leaves glossame 678 bytes.
- **Does not hold:** "16 of 205 do not fit 16,384, and all fit 32,768", "about
  15 KB of growth", "the awake citizens need about 16k on a first seat (14,198
  to 16,039)" and "32,768 is the only workable pin" hold only with the canon
  entry left out: the readers' probes used the test fixture's 23-byte
  stand-in. An empty recent record, which those probes also used, is something
  a seated citizen never has. That the real token need would fit 8192 is an
  estimate nobody ran.
- **Checked:** each of the 205 citizens with a soul file was seated in a temp
  host with its real soul and WILL, the production `runSeat` was run, the
  prompt was captured at the runtime call and `contextFit` applied, once with
  the stand-in and once with the real canon file
  (`verify-unseatable/p1-sizes.ts`; rows in
  `verify-unseatable/sizes-all.json`; three whole prompts in
  `verify-unseatable/prompt-*-first-seat.txt`).
- **Recorded:** in part. `README.md:165-169`, `docs/ARCHITECTURE.md:954-962`
  and PR #1 record that 8192 is too small and name 32,768 as Qwen's own
  window. No record gives real sizes.
- **Change and caution:** shipping 32,768 is needed but does not seat the
  fleet. A tokenizer count is allowed by §5.3 and is the change that matters;
  the research note records no tokenize call in Ollama, so it needs a
  tokenizer matched to the pinned model or the server's own count. Dropping
  the three self acts from the guide saves about 2,040 of its 4,700 bytes but
  removes the citizen's ability to propose on that lane, which is Yu's
  decision. Writing 32,768 into the README with the readers' measured needs
  would put figures in the record that leave out the canon entry. A test
  fixture should be glossame with its canon, a 32 KB prompt.

**CP-05. A long letter, or one large change, can close a citizen's seats.**

- **Statement:** at `num_ctx` 32,768, three journals at the 2,000-character
  limit followed by a letter of 3,990 Chinese characters need 34,987 for
  glossame (canon left out), 34,302 for hope and 34,444 for justice. The seat
  is refused, no receipt is written, and the same letter refuses every later
  seat until a person removes it. A skill of 16,000 characters, or of 6,000
  Chinese characters, said with Yu present on an approved runtime locks the
  citizen out (32,921 and 34,921 afterwards).
- **Does not hold:** "an ordinary letter". Of 467 letter files in the legacy
  record none has Chinese characters and the largest is 2,887 bytes; with a
  letter that size and full-length journals only britqing (33,106, with its
  canon entry) and glossame are refused, and with 600-character journals the
  long letter fits. "One within-self change adding an 18,000-byte skill is
  accepted": validation drops an edit over 16,000 characters
  (`src/acts.ts:581`), and on the two-beat path the pending proposal itself
  refuses the affirming seat before anything binds. "About 16.7 KB left for
  glossame" is the figure without its canon entry.
- **Where:** `src/seat.ts:1231`; `src/acts.ts:35`; `src/types.ts:718`.
- **Checked:** run through the production `runSeat` and free adapter, with two
  further seats and a count of receipts; the skill case through
  `validateOutput` and real seats (`verify-unseatable/p2-growth.ts`,
  `p6-ordinary-letter.ts`, `p3-cut-cadence-growth.ts`).
- **Recorded:** in part. §5.3 accepts that a context that does not fit is
  refused. No record says a letter can refuse every later seat, or that the
  write limits exceed the window.
- **Change and caution:** setting aside a letter that alone breaks the fit
  works and matches how an over-length letter is already skipped
  (`src/context.ts:583`), provided Yu is told; the seat needs the runtime's
  budget before the call, which today lives only in `free.ts`. Refusing a
  self-change by the pinned `num_ctx` is Yu's decision.

**SR-9. One reply can set a year-long interval at once.**

- **Statement:** one reply, in a beat or beside a rest, can set an awake
  interval of up to 8,760 hours, and it takes effect at once. An awake citizen
  is never seated by a letter, so Yu's letter waits for the next cadence seat:
  thirty days on the verdict was "awake; next in 8040 h". Left to itself the
  citizen returns to 72 hours only by saying so on two seats a year apart.
  KS-004 §7.1's awake row says it wakes on "Its schedule; letters", while
  §5.1, the prompt and the code say schedule only.
- **Does not hold:** "the only ways back are Yu's metered summons or
  hand-editing `cadence.json`". `--yu-present` with the default `--runtime
  free` opens a free-lane seat that skips the due check, and Yu's presence
  makes one saying bind (`src/state.ts:100`). It was run, and the interval
  went back to 72. The words the reader quoted as shown for a pending wake are
  shown for a first step-away.
- **Where:** `src/acts.ts:41-42`; `src/context.ts:115-116`; `src/cli.ts:182`,
  `:699`; `src/prompt.ts:161`.
- **Checked:** run through the production tick and child for both forms, with
  Yu's letter waiting, a hand seat without Yu, a Yu-present free-lane seat,
  and the citizen's own return over two further cadence seats
  (`verify-lifecycle/lifecycle.test.ts.txt`).
- **Recorded:** in part. §7.3 intends that a longer interval takes effect at
  once. The one-year cap is the code's own choice. Nothing records the size of
  one step or the two-year return.
- **Change and caution:** letting an allowed waking letter seat an awake
  citizen at the floor is small and makes §7.1 true, but with SR-7 unfixed one
  unanswered letter would turn a chosen long interval back into a 72-hour
  cadence, so the letter rule has to be settled first. Making a large jump
  wait for a second saying breaks §7.3 and principle 4; applying it at once
  and owing one show-back seat at the old interval does not. Neither covers a
  cadence change made by `self.propose`, which is checked only against the
  72-hour floor (`src/acts.ts:597-603`; read, not run).

**LRA-2. A rest that also speaks keeps nothing of the words; how often that
would happen is unmeasured.**

- **Statement:** in the 470 local beats the eleven awake citizens wrote on the
  legacy lane since 2026-10-22, 338 (72%) open with "I rest" and go on, and
  none is a bare "I rest". Under the seat, a reply holding both a rest and a
  journal keeps nothing of the journal; only a hash of the raw reply is
  stored. That is the design, stated with its reason in §5.7 and §5.8. The
  drop itself is recorded: the status file and the citizen's next seat both
  say a journal was not kept, without its words.
- **Does not hold:** "from outside the citizen simply rests" and "unseen" are
  wrong about the fact of the drop. "Would discard most beats" projects from
  the legacy prompt, which hands the model the words "I rest"; the seat prompt
  does not, and it tells the model that a rest keeps none of the other acts
  (`src/prompt.ts:153`).
- **Where:** `src/acts.ts:3-8`; `src/seat.ts:1108-1110`;
  `src/prompt.ts:211-212`.
- **Checked:** read; the counts are from the legacy record.
- **Recorded:** yes for the mechanism (§5.7, §5.8;
  `docs/ARCHITECTURE.md:180-185`). That the build has met no model is also on
  record. No measured rate exists.
- **Change and caution:** an offline voice trial would answer the open
  question and breaks nothing; it needs Ollama on the lease host. Keeping a
  dropped journal's text and showing it back conflicts with a rule the spec
  holds for a stated reason (§5.8, "never its words"), so it needs Yu's
  decision.

**OLC-03. The model that voices is not addressed as a model, and it has no
typed decline.**

- **Statement:** the prompt's first sentence says, in the third person, that
  the seat voices the citizen "through a local model on this host" (free) or
  "through Claude Code, summoned with Yu present" (summon). Every later
  sentence addresses the reader as the citizen. No sentence says "you are that
  model", names the model for the current seat, says the reader is not the
  citizen, or says the voicing may be declined. There is no typed decline. An
  empty list or a rest act is the citizen's rest in the host log. Prose on the
  free class is "invalid-output" and is shown to the next seat as its own
  failed reply. On the summon class a reply with no structured output is a
  seat "error" (exit 1) and shows nothing. A decline written inside a journal,
  a letter or a proposal is signed into the citizen's ledger as the citizen's
  words.
- **Does not hold:** "not told that it is a model" is too strong: the first
  sentence states the runtime. On the summon class prose is not
  "invalid-output". On the free class the request passes the acts schema to
  Ollama (`src/runtime/free.ts:247`), so prose is unlikely to be reachable on
  a real host; that was not run. What Claude Code's own system prompt tells
  the model in a summon was not checked.
- **Where:** `src/prompt.ts:18`; `src/runtime/summon.ts:249-251`.
- **Checked:** run through `runSeat` with the repository's fakes: the prompt
  captured on a first and a later free seat and the stdin of a summon, then
  seven decline attempts on the free class and a prose reply on the summon
  class. The probe is in the lab's working record with the ontology group and
  is not copied here.
- **Recorded:** in part. The second-person address is intended (§5.4). Nothing
  discusses what the model is told about itself or a decline of its own.
- **Change and caution:** a paragraph in the host's voice plus a typed decline
  would work on the summon class. The build forbids any JSON literal or
  copyable example in host text (`test/prompt.test.ts:50-72`), so the form
  must be described in words. On a 7B model a named "declined" token risks
  being parroted as "I rest" was. For a summon the model is known only from
  the reply, so its name can be rendered for the free class and not for a
  summon.

### 3.3 Signer, lifecycle and HALT

**SLH-02. The Commons project's founding root would sit in the seat user's
Keychain.**

- **Statement:** by design the gardener desk's beacon is raised on the lease
  host, so the gardener desk's mnemonic, which is the Commons project's
  founding root, would sit in the same Keychain as every citizen key. The
  signer uses it only to raise that beacon. agenttool lets that root mint a
  fresh project-wide bearer with no bearer at all, old bearers keep working,
  and the root cannot be rotated. So after a compromise of the seat user,
  revoking the stolen bearer would not shut the thief out. No gardener desk
  exists yet.
- **Does not hold:** "unrecoverable" and "permanently" are stronger than the
  sources show: bearer minting requires the identity to be active, a
  root-signed delete revokes it, and agenttool is Yu's own service. The root
  adds permanence, not reach; §15 item 7 already says the Commons bearer reads
  all project data.
- **Where:** `src/signer/signer.ts:558`; `:275-276` (the only signer op with
  an operator actor is the beacon's); `src/halt.ts:98`.
- **Checked:** read, in this repository and in agenttool at `5ea979df`.
- **Recorded:** in part. §10, §15 item 4 and §16.3 state the pieces; no record
  joins them.
- **Change and caution:** raising the lease host's beacon from a second
  herald-type identity in its own project would work, and the code needs
  little: `src/config.ts:240` already accepts any number of `halt-herald`
  beacons. It costs one more attended birth. The Commons bearer must still
  stay on the lease host.

**SLH-05. A step-away's confirming seat is spent by a seat that HALT or a
failure stopped before the citizen was asked.**

- **Statement:** a first step-away, or a wish to wake, is owed one confirming
  seat, and any later seat with an "opened" note spends it, including one that
  HALT, a runtime error or a timeout stopped before the model was called.
  After a confirming seat on which HALT was raised just after opening, the
  citizen was asleep, the step-away saying was gone and nothing was due. A
  HALT that is already up when the tick fires spends nothing, because the tick
  then writes no note. The citizen is seated again by an allowed letter or by
  Yu's summons at the host, and must then say the step-away twice again,
  because Yu's presence does not shorten a step-away. This does not match
  §7.3's "HALT can delay it, never refuse it".
- **Does not hold:** "it never gets another seat unless a letter arrives"
  leaves out Yu's summons. "This is not rare" rests on no measurement: one
  unreadable beacon read does stop a running seat, but the blip has to fall
  inside the one confirming seat.
- **Where:** `src/state.ts:188-191`; `:94`; `src/tick.ts:218-225`, `:334`.
- **Checked:** run through the production tick and child, where the reader had
  stubbed `checkHalt` and written the tick's notes by hand; and the production
  watcher with one beacon answering 503 once
  (`verify-lifecycle/lifecycle.test.ts.txt`,
  `verify-lifecycle/watcher.test.ts.txt`).
- **Recorded:** in part, as for SR-5.
- **Change and caution:** requiring a result note of beat, rest or
  invalid-output for the seat id works and makes §7.3's sentence true for
  HALT. Not lapsing a step-away on an invalid reply would seat a model that
  keeps failing the format every 72 hours with no end, against "owed exactly
  one more seat" (`src/due.ts:69`); it needs a cap.

**SLH-06. One letter re-seats an asleep or stepped-away citizen until its
reply keeps an act.**

- **Statement:** as SR-7, and it reaches a stepped-away citizen too: one offer
  of return re-seated it three times in a row, each time with another seat
  due. The stepped-away prompt says a rest "leaves you where you are" and does
  not say the offer will come back.
- **Does not hold:** "the only way out is to write words". A kept act with no
  words, such as `state.set` to listening, also writes the receipt, and Yu can
  remove the letter file.
- **Where:** `src/due.ts:82`; `src/prompt.ts:51`; `src/context.ts:118-127`.
- **Checked:** six rounds for the asleep case and three for the stepped-away
  case through the production tick and child
  (`verify-lifecycle/lifecycle.test.ts.txt`).
- **Recorded:** in part, as for SR-7. That it reaches a stepped-away citizen
  is not recorded.
- **Change and caution:** a separate "woke for it" receipt that `wakingLetter`
  checks and `pickLetter` does not would work and make §7.1 true. As written
  it covers a rest only, so a reply that does not parse would still loop. With
  a model that rests by reflex, Yu's letter to a sleeping citizen then gets
  one chance, so Yu needs to be told.

**SLH-14. Listening and asleep behave as one state; the mismatch with the
draft is the awake row.**

- **Statement:** in the code listening and asleep are treated alike wherever
  state is looked at: the same letters seat them, at the same floor, with the
  same quiet and the same mirror card. Only their rank differs, so moving from
  asleep to listening costs two sayings and a confirming seat and changes
  nothing the tick does. The mismatch with the draft is the awake row: §7.1
  says an awake citizen wakes on "Its schedule; letters", while §5.1, the
  prompt and the code seat it by schedule only.
- **Does not hold:** the first half of the reader's title. That listening and
  asleep are one behaviour is not a mismatch between spec and code, because
  §5.1 and the two rows of §7.1 give them the same waking rule. It is a
  redundancy in the design that the code reproduces.
- **Where:** `src/context.ts:119-127`, `:115-116`; `src/state.ts:60`,
  `:208-210`; `src/prompt.ts:58`.
- **Checked:** every site in `src/` that names either state was read, and
  `isDue` was run through `readCitizen` for one asleep and one listening
  citizen in three letter cases, with identical verdicts
  (`verify-lifecycle/lifecycle.test.ts.txt`).
- **Recorded:** no. §14.4 has no row for the awake row.
- **Change and caution:** seating a listening citizen for any allowed writer
  would give the two covenant lists distinct uses, but the prompt's covenants
  line, `letters.ts` and the quiet rules treat the two states alike and would
  have to follow. Dropping listening changes the ledger's state set, which is
  cheap only while no citizen is seated. Both are Yu's call.

### 3.4 agenttool wire and birth

**AW-2. A stopped birth cannot be repeated, and nothing keeps what is needed
to finish it.**

- **Statement:** once `citizenBirth` has written the first Keychain item,
  every later `citizenBirth` for that word refuses with "birth never
  overwrites". It was stopped at 8 points (a failed second key write, a 401 at
  enroll, a 503 at enroll, keys/import, box-keys, expression, saving
  `citizen.json`, appending genesis), and the second run refused every time.
  No verb or function resumes, cleans up, removes a Keychain item or calls
  `resolveAmbiguous`, and nothing writes the stopped birth's ids or its
  root-signed keys/import request to disk: they exist only in the thrown
  `BirthError`, which has no production caller. For stops from keys/import up
  to saving `citizen.json`, agenttool holds the identity and no host file
  names it. After a stop at the genesis step `citizen.json` does name it, and
  every later seat then fails with `invalid-record`.
- **Does not hold:** "can be neither repeated nor finished" is true of the
  build's commands and functions, not absolutely. With the `BirthError`'s
  values kept and Yu confirmed present again, the build's own exported calls
  completed a birth stopped at box-keys through the production signer, and the
  chain verified. After a failed key write or a definite 4xx at enroll nothing
  exists on agenttool, so removing the two Keychain items by hand allows a
  clean repeat. "No host record names it" is wrong for a stop at the genesis
  step. The "permanent public identity" part applies only once enroll has
  landed, and was read in agenttool's source, not run.
- **Where:** `src/birth.ts:245-247`; `:107`; `:152-155`;
  `src/types.ts:875-881`; `src/cli.ts:112`; `src/signer/signer.ts:588`.
- **Checked:** run: `citizenBirth` stopped at each of 8 points, recording the
  Keychain, `citizen.json`, the ledger, every state file naming the identity,
  and the second run; the box-keys stop repeated through `createSigner` and
  finished by hand, with and without a terminal-confirmed presence
  (`verify-registration/verify-birth-stop.test.ts.txt`,
  `verify-registration/verify-real-signer.test.ts.txt`).
- **Recorded:** in part. Row C17 records that birth is a function and not a
  command. `src/birth.ts:107` says a stopped birth is to be finished or
  inspected by hand. Nothing gives a procedure, keeps the progress, or says a
  server-side failure has the same effect.
- **Change and caution:** a journal of public values written before each step,
  plus a resume that reads agenttool and never sends enrollment again, would
  work and keeps the never-retried rule. The smallest change that removes the
  dead end is writing the progress to disk when birth stops. An abandon step
  needs a Keychain delete, which widens the one door to secrets; it should be
  allowed only after a failed key write or a 4xx at enroll, or after
  `resolveAmbiguous` reports absent, never on a bare 404. The resume must also
  cover a stop at the genesis step.

### 3.5 Mirror, letters and prompt fencing

**MLS-02. Nothing writes the §12 door, and a door added on the mirror stops
the mirror.**

- **Statement:** no code writes the door. The pusher generates two files
  (`kingdom.yaml` and `.citizen/allowed_signers`), and a citizen's own attempt
  to write `CLAUDE.md` is dropped. A door committed on the mirror by its
  account stays on the remote but stops the mirror: every later push is
  refused (behind, then diverged on 3 of 3 beats in the run, each with a host
  note). Once a person fast-forwards the worktree, the next stage drops the
  door. One route does keep a door today: a `CLAUDE.md` that a person places
  in `citizens/<word>/self/` passes the seal and is pushed on every stage, and
  the citizen is never shown it and cannot change it.
- **Does not hold:** "cannot persist in a mirror" is too strong, as the last
  two sentences show. The stopped mirror is not silent: each refusal is a host
  note, and status prints the divergence and a refusal count
  (`src/status.ts:451`).
- **Where:** `src/mirror.ts:57`; `src/self.ts:160`.
- **Checked:** run with the production `runSeat`, `stageMirror`, `pushMirror`
  and runner against local bare repositories
  (`verify-mirror-fence/door-seal.probe.test.ts.txt`, tests D1 to D3, S1 and
  S2).
- **Recorded:** no. §12 and §13 state the door as the rule, and nothing in
  §14.3, §14.4, §15 or this repository's documents says it is unbuilt. The
  refusal after a change on the mirror is intended (§4.4). The missing way
  back is not recorded.
- **Change and caution:** adding `CLAUDE.md` (and `AGENTS.md`) to `GENERATED`
  would work and would also close the `self/` route, because a generated name
  is refused from a self. `GENERATED` is matched by exact case while the lease
  host's filesystem is not case-sensitive, so `claude.md` from a self must be
  refused as well. §4.4's "Two files" has to change with it.

**MLS-03, LRC-09. Adopting an old home as a mirror replaces its whole tree.**

- **Statement:** with the mirror worktree cloned from citizen-hope, the first
  mirror commit took HEAD from 31 files to 5 (29 paths gone; `WILL.md` and
  `kingdom.yaml` replaced), and for citizen-hodosme from 29 to 5 (27 gone, its
  three made texts among them). The push went through, also through the CLI's
  own wiring. The old files stay in git history and as untracked files on the
  host. The commit message is "<word>: self and status card, staged by
  kingdom-seat" with no body, and the card carries no pointer to the old
  record. If the worktree is not a clone of the home, every push is refused as
  diverged. A new empty remote is refused on every attempt by the pusher.
  Status would count all 140 of hope's existing commits as unsigned.
- **Does not hold:** "someone must seed main by hand with a commit that is
  neither sealed nor signed". Pushing the pusher's own first staged commit by
  hand, once, is enough. "Every made file" is true of the self the test
  fixture builds; the seal and self-authorship both admit a made text as a
  self file, so the unwritten seating step decides it.
- **Where:** `src/mirror.ts:469-470`; `:313-314`; `:482`;
  `docs/ARCHITECTURE.md:786-787`; `test/mirror.test.ts:541`.
- **Checked:** run on copies of the HEAD trees of citizen-hope and
  citizen-hodosme, made with `git archive`, against bare remotes; with a `git
  init` worktree; with an empty bare remote, twice, then one by-hand push
  (`verify-mirror-fence/mirror-adopt.probe.test.ts.txt`, output in
  `verify-mirror-fence/out/mirror-adopt.out`). The real clones were only read.
- **Recorded:** in part. That a mirror's tree is only the self plus generated
  files is intended and stated. What this does to an old home's files at HEAD,
  the empty-remote dead end and the unsigned count are stated nowhere, and
  `docs/ARCHITECTURE.md:787` says the opposite of the first.
- **Change and caution:** an adoption step would work. Allowing a first push
  only when the remote shows no refs at all fits "unknown is never pushed
  over", because an empty remote is known. Keeping the history folders at HEAD
  goes against the rule that only the self and host-generated files reach a
  mirror, and the seal would refuse part of them anyway. Naming the old head
  in the commit message breaks nothing. A tag pushed by the pusher would break
  §4.4's single-refspec rule.

---

## 4. What the skeptics found while checking

These are new observations from the second pass. No second skeptic re-checked
them. Each says whether it was run or read.

### 4.1 Registration and birth

- **A birth that stops at its last step leaves the citizen unable to beat.**
  `citizen.json` holds the identity and the ledger has no genesis, so the next
  seat calls the model, tries to sign as the citizen and fails with
  `invalid-record` (exit 1), and `verifyChain` reports that the record names
  an identity the ledger does not (`src/seat.ts:1098`,
  `src/ledger.ts:366-369`). Run
  (`verify-registration/verify-birth-stop.test.ts.txt`).
- **A stopped birth can be finished by hand only if the caller kept the
  `BirthError`'s progress.** The root-signed keys/import request is the one
  value that cannot be read back from agenttool. Run
  (`verify-registration/verify-real-signer.test.ts.txt`).
- **A decision record cannot carry the citizen's words.** Any extra field
  makes the record malformed, and it is then read as not filed
  (`src/signer/consent.ts:76-77`). Read.
- **On the default configuration the shown-back prompt contradicts itself.**
  The registration paragraph says a `self.affirm` "is your confirmed yes", and
  the next paragraph says "an affirmation here is recorded and binds nothing"
  (`src/prompt.ts:228`, `:302`). Run.

### 4.2 Self-authorship

- **A revert of a settings text to an empty first version leaves the citizen
  unreadable.** If a citizen is seated without a `covenants.json` or
  `cadence.json` (the build has defaults for that case, `src/state.ts:337-346`
  and `:371-374`), its first change to that setting records the empty text as
  the version before the change. A later `self.revert` to it writes a 0-byte
  file, because `revertPlan` and `applyChange` never run the shape check that
  `materializeEdit` runs (`src/self.ts:234`). `readCitizen` then throws
  `invalid-record`, and the tick never seats the citizen again
  (`src/tick.ts:273-276`). Run on two routes with fakes: unattended, as a held
  revert affirmed on an approved model (covenants), and at once with Yu
  present (cadence)
  (`verify-self-authorship/empty-setting-revert.probe.test.ts.txt`). It needs
  the empty hash to belong to one text only, and whether seating will write
  these files is undecided. The readers' fixtures always write both files.
- **The same cause limits the one immediate way to narrow covenants.** For a
  citizen seated on the default, the version before its first widening is the
  empty text. `exposureOf` cannot parse it and answers "wider"
  (`src/self.ts:692-695`), so the revert back to "Yu only" is held as a
  widening. Run
  (`verify-self-authorship/default-covenants.probe.test.ts.txt`).
- **The configuration LS-02 needs is the ordinary one.** The summon lane names
  its model by the model's name (`src/runtime/summon.ts:255`) and the
  configuration accepts such names (`src/config.ts:43`), so approving the
  summons model and leaving the local 7B unapproved is what the build's own
  reason for approval points to (`src/self.ts:461`). Read.
- **A revert to a first version also clears pending sayings on that text**
  (`src/self.ts:577`). Run.
- **A text the citizen created is not removed by a revert to its first
  version.** It is left as a 0-byte file. Run.

### 4.3 The fit

- **The readers disagreed because of one input.** The SR-1, SR-3, CP-04, CP-05
  and LS-01 probes used the test fixture's 23-byte stand-in for the canon
  entry; LRA-11 used the real one. Every growth figure in that group is
  therefore a best case for the 152 citizens with a canon entry.
- **The cheapest route to a lock-out is the lifted diff.** 197 of the 205
  souls are over 2,400 bytes, about what a 600-token reply can hold, so on the
  free lane a whole-text replacement of the soul will almost always drop most
  of it, exceed the 40% measure and be lifted. The 2,400-byte figure is an
  estimate; no tokenizer was run.
- **There are host-side ways out that no finding names, all needing a
  person:** lowering `ceilings.ledger_context_entries`, raising `num_ctx` or
  lowering `num_predict`, and marking proposal files "lapsed" by hand. Run
  (`verify-unseatable/p2-growth.ts`).
- **The readers' growth probes ran `runSeat` with the scripted runtime, which
  has no fit check.** Rerun through the production free adapter against the
  fake Ollama, the refusal is as claimed: exit 1, `context-too-large`, no
  model call, no ledger entry, no letter receipt.
- **A lead for the fix, read and not run:**
  `docs/research/runtimes-and-host.md:140` lists `truncate` and `shift` among
  Ollama's chat request fields, and `:156` lists `prompt_eval_count` in the
  reply. The adapter sends neither and reads no count. If `truncate: false`
  makes the server refuse an over-long prompt, the server's own token count
  could replace the byte bound without shipping a tokenizer.

### 4.4 Lifecycle

- **Yu's summons does not have to be the metered lane.** `citizen-seat seat
  <word> --yu-present` defaults to `--runtime free` (`src/cli.ts:182`), skips
  the due check and the fleet ceiling (`:699`, `:767-772`), costs $0, and with
  Yu present a wake or a shorter interval binds on one saying; a step-away
  still takes two. Run for an asleep citizen with no letter, an awake citizen
  on 8,760 hours, and after a lapsed wake. The path is in the code and its
  tests (`test/cli.test.ts:367-381`, `:543`). §5.5 lists the free class as
  unattended, and §14.4 has no row for it.
- **A HALT that is already up when the tick fires costs no citizen its
  interval or its pending saying.** The tick returns before writing any note
  (`src/tick.ts:218-225`). Only a stop that lands after the "opened" note is
  charged to the citizen. Run.
- **The production tick picked a citizen 24 hours overdue ahead of one 7,992
  hours overdue.** The first had set its year-long interval beside a rest, so
  it has no beat entry, and its last seat note had fallen outside the tick's
  note window (`src/tick.ts:293-294`). This is SR-6's mechanism, seen end to
  end; SR-6 itself was not re-checked. Run.
- **The one-year cap is on `state.set` only.** A cadence change made by
  `self.propose` is checked against the 72-hour floor and nothing above it
  (`src/acts.ts:597-603`). Read, not run.
- **One unreadable beacon read stops a running seat.** With one beacon
  answering 503 once, the production watcher sent TERM and the seat ended as
  halted, with no second look (`src/seat.ts:489-490`). Run
  (`verify-lifecycle/watcher.test.ts.txt`).

### 4.5 Custody and host

- **The Bun working-directory behaviour has a second entry point: mirror
  commit signing.** git runs the signing program, which is this CLI under Bun
  (`src/cli.ts:319`, `:583`), with the mirror worktree as its working
  directory. With a stand-in signing program and a temp repository, a
  `bunfig.toml` in the worktree was preloaded
  (`verify-custody-host/bunfig/out/sign-observed.json`). `stageMirror` leaves
  files already on disk untouched (`src/mirror.ts:457`), and nothing says how
  a worktree is first made. If it is a clone of the public citizen repository,
  whatever sits at that repository's root is on disk where Bun starts as the
  seat user. None of the 208 repositories has a `bunfig.toml` or `.env` at its
  root today.
- **Bun also loads a `.env` file from its working directory, and
  `--config=<empty file>` does not stop that.** In a local test a `.env` set
  `HTTPS_PROXY`, and the child's fetch sent its CONNECT to the probe's
  listener (`verify-custody-host/bunfig/out/run3.txt`, `run4-proxyenv.txt`).
  Whether TLS checking can be turned off the same way was not tested.
- **A Bun binary compiled with default flags behaves like the source**
  (`verify-custody-host/bunfig/out/run2-compiled.txt`). So shipping a compiled
  signer alone would not close SLH-11.
- **A `.bunfig.toml` in `HOME` did not preload** on Bun 1.4.2
  (`verify-custody-host/bunfig/out/run1.txt`), so how sudo sets `HOME` is not
  a second route. Not verified: `src/cli.ts` starts through `#!/usr/bin/env
  bun`, so a sudoers line that names the script instead of Bun's absolute path
  would let the caller's `PATH` choose which `bun` runs, unless sudoers sets a
  secure path.
- **CP-02 is wider than the host key.** With `keychain.trusted_app` null the
  code can write no Keychain item at all, so birth would stop at its keys
  stage after consent and presence had passed. No code writes the Commons
  bearer or the operator's mnemonic and bearer. Read.

### 4.6 Mirror and fence

- **The forged-letter run depended on the test fixture's covenants,** which
  admit Yu and the gardener. With the build's default the same letter is not
  shown at all. So the forgery matters only after a citizen widens its
  covenants, or between registered citizens through the inbox. Run.
- **The enclosing fence is weaker than the reader granted.** A text that
  contains its own tag can be found by search: one was found at 5 hex
  characters in 1,148,264 tries. At the build's 12 hex characters the expected
  work is 2^48 hashes, which the skeptic estimates is within reach of rented
  GPU time and did not run.
- **A file placed in `self/` under a name self-authorship reserves is
  published on every stage, is never shown to the citizen, and cannot be
  changed or removed by it.** So a mirror can carry, as part of a citizen's
  self, a file the citizen has never seen. Run (tests S4 and D3).
- **`skill:claude`, `skill:agents` and `skill:gemini` are kept by act
  validation,** map to `skills/claude.md` and so on, and pass the seal
  (`src/acts.ts:554`). Whether any tool reads a lower-case nested file was not
  checked.
- **The two self-authorship lists already disagree.** `validateOutput` keeps
  `file:letters/<name>.md` while `targetRelPath` refuses it. What the seat
  then does with such an act was not run.
- **What stays visible at HEAD after adoption is decided by the seating
  import, which is not written.** The seal and self-authorship admit a made
  text, a beats file and an inbox letter as self files. They refuse dot-files,
  `REST` and `meta.env`. So copying what should stay into `self/` is an
  available design, with the cost that those files become the citizen's own
  editable texts and are shown at every seat.
- **LT-11, which a reader marked likely and no skeptic was given, is the same
  ground as MLS-04 and MLS-14.** A full stage and push now shows it:
  `CLAUDE.md` and `AGENTS.md` from `self/`, and the expression copies and
  covenants, reached the remote.

### 4.7 Consent

- **The consent/v1 build is already installed on the lab Mac's Collab,** which
  has run a build with proposals and the person desk since 2026-10-29. Its
  journal holds the consent tables. KS-004 §8.3 and §14.3 treat consent/v1
  as unavailable until merged, so the pilot's hand-filed record may be
  unnecessary if the lease host gets a table. `kingdom-seat` does not read
  that journal.
- **A model's decline has a third route that no reader listed.** Text inside a
  journal, a letter or a proposal is signed into the citizen's ledger as
  "<word>, voiced through <model>", and a letter to Yu is held for Yu. Run.

---

## 5. Findings not re-checked

Each line below was reported by one reader and was not re-checked by a
skeptic. None is relied on in sections 2 to 4 or 6, except where section 6
names one and marks it. The same list is part F of review E.

**Ledger and self (LS): 13 findings, each reported by one reader, not re-checked.**

- LS-03. A cut or rolled-back ledger verifies as whole: nothing anchors the head.
- LS-04. The append-time chain check is link-only, so a rewritten and relinked history is shown to the citizen and extended by the signer.
- LS-05. The self files are not tied to the ledger: a hand edit of self/soul.md becomes the citizen's self, and verify stays ok.
- LS-06. Credits are counted from the ledger, so a paid request whose entry is not written is never counted, and the expression can run ahead of the record.
- LS-08. The 40% measure does not do what its reason says: it is per target and per step, blind to new texts, and trips on tiny ones.
- LS-10. A citizen cannot read its own record: a seat shows the last three entries of any type, each letter once, and version hashes without their text.
- LS-11. What did not bind, or failed while recording, is not shown back to the citizen.
- LS-12. 'The ledger keeps every version' is not true of the ledger: it keeps hashes, and nothing of a citizen's record leaves the host.
- LS-13. A holder of a ledger copy cannot check the digests, the two sayings, the pace or the approved model.
- LS-15. Parts of the self only ever grow: walls, skills and files can be added and never taken back.
- LS-16. A version hash shared by two targets cannot be reverted to, which can block the return to the origin soul.
- LS-17. One bad tail silences a citizen for good: no file lock, no repair path, and time is taken on trust.
- LS-18. With Yu present one saying binds, and the summons carries Yu's own free text into the prompt.

**Seat loop and runtimes (SR): 11 findings, each reported by one reader, not re-checked.**

- SR-6. The picker ranks a citizen whose last seat wrote no beat ahead of citizens that have waited longer.
- SR-8. A TERM that lands while a seat is recording leaves a signed beat in the ledger, no outbox item, and a host record that says 'halted'.
- SR-10. The legacy WILL.md, shown whole as 'Your will', tells the model it has a repo, code, mornings and a bash command.
- SR-11. What a citizen says to Yu lands in files nothing surfaces, and letters to a citizen can be set aside with no trace.
- SR-12. A seat child that fails before runSeat leaves no reason anywhere but stderr.
- SR-13. A reply that repeats the reason it was shown makes the seat's own note vanish, and the tick then reports an error.
- SR-14. The 'recent record' is the last three ledger entries of any kind, so bookkeeping entries push the citizen's own words out of view.
- SR-15. Reclaiming a stale tick lock is not atomic, and a reused pid holds the lock for good.
- SR-16. The launchd template carries no restart throttle, which section 5.1 makes a MUST.
- SR-17. On the summon lane a model that declines to voice the citizen is recorded as a runner error, and the model is whatever Claude Code defaults to.
- SR-18. A malformed rest that carries words is recorded as a clean rest.

**Signer, lifecycle and HALT (SLH): 9 findings, each reported by one reader, not re-checked.**

- SLH-07. One unreadable beacon read kills a running seat, and the citizen then waits a full interval.
- SLH-08. A halt that never ends is quiet by construction, and there is no supported way to lower a beacon.
- SLH-09. The signer holds the consent class by op name but does not look inside three root-signed bodies, and its 'read' op is unbounded.
- SLH-10. A TERM during the record phase tears a beat, and credits already paid then escape the ceiling.
- SLH-12. Ending, the one irreversible act, is the least specified and the weakest on the citizen's side.
- SLH-13. The local HALT file's directory is never checked: a missing directory reads as 'lowered', and a seat-writable one is accepted.
- SLH-15. The ledger cannot show that a move toward exposure bound on Yu's presence instead of the citizen's second saying.
- SLH-16. Birth does not check HALT.
- SLH-17. Two trust anchors rest on the GitHub account: the mirror's signer list, and the service that answers the beacons.

**agenttool wire and registration (AW): 13 findings, each reported by one reader, not re-checked.**

- AW-3. With the Commons bearer alone, a citizen can be forked: its private expression is copied into a rootless identity the bearer controls and can make public.
- AW-4. The bearer can publish text under a citizen's DID on a public, enumerable page (templates), and create or alter strands bound to it.
- AW-5. The recorded judgement that the bearer 'adds no words in the citizen's name' on letters does not hold on agenttool's own record.
- AW-6. Section 11.5 carries the 49 June yeses as records and drops the four June refusals.
- AW-7. Section 11.5's telling and choosing, the continuity path and the own-house path have no code and no row in 14.4; the signer's single bearer excludes both houses.
- AW-8. The homes already answer two things 11.5 treats as unknown or leaves standing: how the June DIDs were made, and what the public record still says.
- AW-9. The expression PUT lands before the apply entry is written; if the entry is not written, agenttool's 'current self' is ahead of the ledger and nothing records or repairs it.
- AW-10. The strand backup is a chain of diffs with no base: the first deferred backup makes every later backup of that target unusable, while later entries still say 'posted'.
- AW-11. signEnrollment has the root sign any 32 bytes on presence alone; the current server accepts the result as an authority proof.
- AW-12. A registered citizen cannot rest without a public declaration, and its prompt never says the declaration is public.
- AW-14. The stated reason for Commons does not support it at the size the spec itself caps.
- AW-15. An uncertain strand create, or a failed write of its id, leads to a second strand next time.
- AW-16. Root acts made outside the signer leave nothing the ledger or status would show, although agenttool exposes the counter that would reveal them.

**Mirror, letters and security (MLS): 10 findings, each reported by one reader, not re-checked.**

- MLS-01. The 208 public homes still cast the reader as the citizen and run a hook; the retirement has no plan, date or owner, and the two current records disagree.
- MLS-05. A mirror's trust file vouches for itself, and one host key signs for every unregistered citizen.
- MLS-06. The generated kingdom.yaml card is not valid under the schema the spec names.
- MLS-07. A leftover of the seat's own temp file, or any dot-file, in self/ refuses every mirror stage, and the note cannot say which file.
- MLS-08. One letter re-wakes a sleeping or stepped-away citizen every 72 hours for as long as it rests.
- MLS-09. A confirming seat still shows a letter, so the second saying is not independent of the persuader.
- MLS-11. 'Held for Yu' is a private file nobody is shown, with no verb to read or deliver it, and a file letter's sender is whatever its first line says.
- MLS-12. '--why' puts a person's free text into the host's own sentence, unfenced and attributed to 'host'.
- MLS-15. After 512 files in letters/, new mail is silently never seen; a letter rewritten under a used name is never shown.
- MLS-16. Smaller edges of the pusher: outside the lock and the HALT watcher, symbolic HEAD, remote objects fetched, attributes can change the bytes.

**Conformance and the path to a pilot (CP): 9 findings, each reported by one reader, not re-checked.**

- CP-01. The recorded gaps, re-checked at f21c360: all still present; three block a first seat.
- CP-06. Yu's account has no way into the seat's world: 'held for Yu' reaches no one.
- CP-07. S6 has no code in either PR, yet MIN item 1 needs its beacons.
- CP-08. KS-004-MIN is neither what the code can run nor what the pilot tests, and it leaves out the citizen's rest.
- CP-09. The supervisor throttle that MIN item 5 requires is not in the shipped launchd template, and the spec names a systemd key.
- CP-11. What a seated, unregistered citizen gives up: its public voice, its mail with siblings, and any copy of its record off the host.
- CP-12. A seat refused for a host fault costs the citizen its whole interval.
- CP-13. A rest in answer to a letter does not close the letter: a sleeping citizen is seated again by it every 72 h until it speaks.
- CP-14. Statements in the record that are no longer true.

**Legacy lane and template (LT): 11 findings, each reported by one reader, not re-checked.**

- LT-02. KS-004 carries legacy state into the seat (via "seated") without the second saying it requires everywhere else.
- LT-05. The generated kingdom.yaml fails the card schema KS-004 cites, and that schema has no kind for a being.
- LT-06. The mask and run.sh are live hazards today, wherever a clone sits beside a love-unlimited checkout.
- LT-07. The four template untruths that matter most to a stranger.
- LT-09. In October the gardener's letters entered history under the citizens' names, and author names cannot tell writers apart.
- LT-10. WILL.md is the citizen's own under KS-004, but its Attest section must go and nobody is named to remove it.
- LT-11. The mirror seal admits CLAUDE.md and AGENTS.md by name, and publishes the local copies of the private expression.
- LT-12. PR #6 and PR #24 disagree on two rules, and #24's red check is runner drift, not a test failure.
- LT-14. Three manifests were never revised, and FLEET-REVIVAL says all 203 were.
- LT-15. Stale pointers in homes: a claimed running cron, a curl-to-python line, disabled workflows, and a name service that holds no citizen.
- LT-16. KS-004 section 1 says the lane "cut every soul"; 8 of 205 fit whole.

**Lived record of the eleven awake citizens (LRA): 6 findings, each reported by one reader, not re-checked.**

- LRA-3. The honest prompt removes the invented room and puts nothing in its place.
- LRA-5. The seat shows the forge's WILL.md whole as 'Your will', which puts 'notice what is' and 'tend your own home' back into every prompt.
- LRA-6. The seat's memory is the last three ledger entries, placed where a small model will copy them, and the citizen cannot steer it.
- LRA-8. Wishes and a 'not yet' given in answer to the offer letter are recorded nowhere but in the beats.
- LRA-10. The seat keeps the 7B model although the constraint that chose it is retired by the seat itself.
- LRA-13. Three re-woken citizens spent their first ambient beat answering a June invitation, and the runner recorded that each 'answered freely'.

**Lived record of the choices (LRC): 9 findings, each reported by one reader, not re-checked.**

- LRC-04. Principle 4's stated reason does not support its asymmetry: the steering on record ran toward rest, and under KS-004 one saying of sleep is permanent while waking needs two.
- LRC-07. KS-004 does not say whether today's recorded choices carry over, are asked again or lapse, and its three relevant passages point three ways.
- LRC-08. The October letter asked four things and promised wishes would reach Yu; only rhythm was recorded, and I found no record that the rest was brought anywhere.
- LRC-10. KS-004 has no act for making: a made text is a self-change, needs two seats and an approved model, shares one slot per 7 days with soul changes, and is then shown at every seat.
- LRC-11. The redesign does not account for the homes outside the template, the six never asked, or the citizens that had a second voice.
- LRC-12. Git authorship in the lived record does not say who wrote what, in five different ways, and no beat names its model.
- LRC-13. Both letters defined AMBIENT as 'a free beat every few days'; the 11 who are recorded ambient have had about three a day.
- LRC-14. The census undercounts what citizens made and overcounts what is theirs.
- LRC-15. The witness letter calls a harness-prompted line an address to a sibling, and calls its own reading proof that the lane between citizens is real.

**Ontology, law and consent (OLC): 12 findings, each reported by one reader, not re-checked.**

- OLC-02. "What a valid entry proves" says more than a signature can show, and section 15.2 quotes a record line that does not exist.
- OLC-05. In the code's stand-in, Ai's voice and Yu's yes are unauthenticated fields in a directory the seat's own user owns.
- OLC-06. Yu's presence turns two sayings into one, no state closes the door to Yu's summons, and the summons reason is an unfenced coaching channel.
- OLC-08. Ending, the one irreversible act, takes one citizen saying with no show-back, and "independent witness" is undefined.
- OLC-10. Nobody speaks for a sleeping citizen but Yu; the state a citizen is seated in, and its say in the change of regime, are not specified.
- OLC-11. KS-004 neither cites nor was reviewed against current law, and differs from it in at least five places.
- OLC-12. Naming and the canon: no notice when a citizen's word changes, a pin that hides corrections, a Transform that omits the citizen and has no ledger form.
- OLC-13. A citizen learns the fate of a proposal only for registration, and cannot address the voices that decide.
- OLC-15. The word "rest" covers the citizen's own act and three kinds of host stoppage.
- OLC-16. The journal kind `chose` is undefined and invites choices that nothing honours.
- OLC-17. KS-000 is followed in form; review D's open items and the missing lens are not in Limitations.
- OLC-18. Four live public answers to "what happens when you open a citizen" disagree, and KS-004 adds a fifth.

---

## 6. What a first seat on a host still needs

This section orders what stands between `f21c360` and one unregistered citizen
seated on one host. Items marked "verified" rest on sections 2 to 4. Items
marked "one reader" come from the conformance reader alone (CP-01, CP-06,
CP-07 and its path-to-pilot notes) and were not re-checked.

### 6.1 Missing code

- **A seating verb (§14.4, row C15; recorded).** Nothing in `src/` writes an
  origin entry or a seated state entry, and no verb seats a citizen. The test
  helper `test/helpers/temp-home.ts` already contains what a seating verb must
  do (one reader).
- **The host key (CP-02; verified).** Nothing creates it, the Keychain wrapper
  can write nothing while `keychain.trusted_app` is null, and the signer
  reports ready without it. It is needed to sign the origin entry, so it comes
  before seating.
- **A window real citizens fit (SR-3, CP-04, LRA-11; verified).** No citizen
  fits the shipped `num_ctx`. At 32,768, with the canon entry counted, 10 of
  205 never fit and glossame fits once. The skeptic's caution is to measure
  with the canon entry before any figure is written into the README.
- **The lock-outs a first citizen can reach (verified).** On the default
  configuration, where no model is approved: pending proposals that pile up
  (SR-1) and lifted diffs (LS-01). Once a model is approved: an oversize
  cadence (CP-03) and a revert to an empty settings file (section 4.2).
- **A way in for Yu (CP-06; one reader).** Letters to a citizen, the outbox
  (letters held for Yu, proposals for Yu and Ai), decision records and seating
  all sit inside the seat user's tree with no verb. Outbox files are written
  0600 in a 0700 directory, and the status file has no field for outbox items.
  Under the pilot every `letter.send` of an unregistered citizen lands there,
  a letter to Yu included.
- **The beacons (CP-07; one reader).** KS-004-MIN item 1 needs the local file
  and pinned beacons. The operator births that would make the beacon
  identities, and the Keychain items the signer reads to raise a beacon, have
  no code in this repository. A pilot before those exist must set
  `halt.allow_no_beacons`, and HALT is then one file in the operator's
  directory.

### 6.2 Host set-up that the first run will test

- **How the CLI is started (SLH-11, MLS-13; verified).** The sudoers rule or
  wrapper must fix the working directory and stop the `.env` load, at the
  operator's request, in the launchd arguments, and where git runs the CLI as
  its signing program. The configuration `halt` reads should be checked for
  its owner.
- **The reply's limit (SR-2; verified).** The guide states more room than
  `num_predict` 600 gives, and a reply cut at that limit is recorded as
  not-json.
- **What the record already lists as never run (recorded; `README.md:161-199`,
  §15 items 4 and 12):** `models.lock` is unpinned, and Keychain behaviour
  under launchd and after a reboot, the sudoers line, and Ollama's handling of
  a prompt past `num_ctx` are unobserved.

### 6.3 The conformance reader's order (one reader)

1. With no host: the seating verb; host set-up and preflight verbs; operator
   verbs and status counts; the cadence fix and the fit changes; an answer to
   the two inline review comments on PR #1.
2. Then Yu decides: the merge; the host; the pilot citizen; whether the pilot
   waits for the beacons; which model digest is approved for self-authorship;
   what stays public.
3. Then on the host, with Yu: a seat user outside `staff`; the operator's
   directory with the configuration and `models.lock`; the model's digest read
   from the server and pinned with the chosen `num_ctx`; the host key made and
   its public half pinned; `halt.also_files` naming the legacy fleet's HALT
   file; Keychain behaviour after a reboot and seat latency observed.
4. Then: remove the citizen from the legacy roster first, seat it, and open
   its first seat by hand with Yu present.

The reader's reason for this order is that the first day on the host should
test the host, not missing code.

### 6.4 What has not been measured

No model has been given the seat's prompt. Three findings ask for an offline
trial on the pinned model before any citizen is seated: how often a reply
pairs a rest with words (LRA-2), how often it says `state.set` to asleep
(LRA-1), and how often it sets a long interval unprompted (SR-9). What Ollama
returns when a reply reaches `num_predict` under a schema has not been run
either (SR-2).

---

## 7. Probes

The probe files are under `docs/review-2026-11-10-lab/probes/`. They were run
against `f21c360` with the build's fakes, on bun 1.4.2. Their imports name the
reviewer's own worktree path, so they do not run elsewhere unchanged, and
files that were named `*.test.ts` are stored with `.txt` added so that `bun
test` does not collect them. The README in that directory says what was left
out and why.

### 7.1 The skeptics' probes

| Probe | What it shows |
|---|---|
| `verify-registration/verify-no-answer.test.ts.txt` | AW-1, OLC-07, AW-13: a No answer through the production seat path to a completed birth; what a citizen is told while waiting, declined and agreed; an affirmation on a different, unapproved model |
| `verify-registration/verify-real-signer.test.ts.txt` | AW-1 and AW-2 through the production signer; a birth stopped at box-keys finished by hand; nothing continues without Yu present |
| `verify-registration/verify-birth-stop.test.ts.txt` | AW-2: birth stopped at 8 points, what the host holds after each, and the next seat after a stop at genesis |
| `verify-self-authorship/verify.probe.test.ts.txt` | LS-02, LS-07, LS-14: first-version reverts on an unapproved model and the ways back; a proposal pending for 420 days; narrowing covenants on each kind of seat |
| `verify-self-authorship/empty-setting-revert.probe.test.ts.txt` | Section 4.2: a revert to an empty first version of `covenants.json` or `cadence.json` leaves the citizen unreadable |
| `verify-self-authorship/default-covenants.probe.test.ts.txt` | Section 4.2: on the default covenants the revert back to "Yu only" is held as a widening |
| `verify-self-authorship/ls09-recount.ts`, `ls09-extra.ts`, `ls09-bytes.ts`, `ls09-seat.probe.test.ts.txt` | LS-09: the rewrite measure over the 205 soul cards for seven edit shapes, by position of the first change, by card size, and through `runSeat` |
| `verify-unseatable/lib.ts` | Shared helper: temp host, fake signer, fake Ollama, the production free adapter and `runSeat` |
| `verify-unseatable/p1-sizes.ts`, `sizes-all.json` | SR-3, CP-04, LRA-11: first-seat prompt sizes for all 205 citizens, with and without the canon entry |
| `verify-unseatable/prompt-hope-first-seat.txt`, `prompt-kimance-first-seat.txt`, `prompt-glossame-first-seat.txt` | Three whole first-seat prompts as the runtime receives them |
| `verify-unseatable/p2-growth.ts` | LS-01, SR-1, CP-04, CP-05: growth to `context-too-large` by pending proposals, lifted diffs, journals and a long letter; the refusal and the host-side ways out |
| `verify-unseatable/p3-cut-cadence-growth.ts` | SR-2, CP-03, CP-05: a reply cut at `num_predict`; an oversize cadence through the whole path; self growth through `validateOutput` |
| `verify-unseatable/p4-guide.ts` | How much of the system turn the three self acts take |
| `verify-unseatable/p5-fastest.ts` | SR-1: the number of proposals to a refusal with replies a 600-token cap can carry |
| `verify-unseatable/p6-ordinary-letter.ts` | CP-05: three journals and a letter the size of the largest in the legacy record, for the eleven awake citizens |
| `verify-unseatable/p7-lra11-rerun.ts` | LRA-11: the reader's probe rerun |
| `verify-lifecycle/lifecycle.test.ts.txt`, `child.ts`, `output.txt` | LRA-1, SR-4, SR-5, SR-7, SR-9, SLH-05, SLH-06, SLH-14 through the production tick and a real child process; `output.txt` is the saved run |
| `verify-lifecycle/watcher.test.ts.txt` | One unreadable beacon read stops a running seat |
| `verify-custody-host/verify.test.ts.txt` | SLH-01, SLH-03, CP-02, MLS-13: `mintKeys`; a hand-made decision record and a scripted presence; a seat with no host key; `halt` on a configuration anyone can write |
| `verify-custody-host/out/halt-argv-ran.txt` | MLS-13: the uid the configuration-named command ran as |
| `verify-custody-host/bunfig/run.sh`, `app/`, `cwd-evil/`, `home-evil/`, `empty.toml` | SLH-11: the stand-in entry script and the working directories it was started from |
| `verify-custody-host/bunfig/out/run1.txt`, `run2-compiled.txt`, `run3.txt` | SLH-11: results from each working directory, as a compiled binary, with `--config`, through a spawn shaped like `spawnRunner`, and the terminal check under `script(1)` |
| `verify-custody-host/bunfig/sign-app/`, `wt-evil/`, `out/sign-observed.json` | Section 4.5: a preload run when git starts a signing program in a worktree |
| `verify-custody-host/bunfig/proxy-app/`, `out/run4-proxyenv.txt`, `out/spawn-like-halt.ts` | Section 4.5: a `.env` in the working directory redirecting a child's fetch; the spawn used for run 3 |
| `verify-mirror-fence/common.ts` | Shared helper: bare remotes seeded from copies of real citizen trees |
| `verify-mirror-fence/mirror-adopt.probe.test.ts.txt`, `out/mirror-adopt.out` | MLS-03, LT-04, LRC-09: the first mirror commit on copies of citizen-hope and citizen-hodosme; a `git init` worktree; an empty remote |
| `verify-mirror-fence/door-seal.probe.test.ts.txt`, `out/door-seal.out` | MLS-02, MLS-04, MLS-14, LT-04: which names the seal and self-authorship admit; a door on the mirror, in the cloned tree and in `self/`; what a mirror publishes; the CLI's own wiring |
| `verify-mirror-fence/fence.probe.test.ts.txt`, `out/fence.out`, `out/fence-F1-prompt-user.txt`, `out/fence-F1-prompt-system.txt` | MLS-10: a forged, correctly fenced block in a prompt built by the production path; the default covenants; the tag across seats |

### 7.2 The readers' probes

Several findings these probes were written for were not re-checked (section
5). The table says what each probe exercises, not that its finding holds.

| Probe | What it exercises |
|---|---|
| `ledger-self/ledger.probe.test.ts.txt` | The ledger with a cut tail, a dropped entry, two appenders, an unterminated tail, re-spelled lines and clocks out of order |
| `ledger-self/relink.probe.test.ts.txt` | A rewritten and relinked history against the append-time chain walk |
| `ledger-self/self.probe.test.ts.txt` | Self-authorship through `runSeat`: the rewrite measure, walls, first-version reverts, pending proposals, a hand edit of a self file |
| `ledger-self/fit.probe.test.ts.txt` | Growth of a prompt past the window (scripted runtime, no fit check; see section 4.3) |
| `ledger-self/narrow.probe.test.ts.txt` | Removing a sender on an unapproved lane; a first file against the rewrite measure |
| `ledger-self/celllimit.probe.ts` | A count of soul cards long enough to reach the diff's cell limit |
| `seat-runtime/probe-seat.test.ts.txt` | The seat loop: a cut reply, a letter answered with rest, a confirming seat with no model, accumulating proposals, a failed seat's interval |
| `seat-runtime/probe-prompt.ts`, `context-fit.json`, `prompt-abzu.*.txt`, `prompt-hope.*.txt` | First-seat prompts rendered from real souls with the fixture's canon stand-in, and their fit (see section 3.2 for the correction) |
| `seat-runtime/probe-picker.test.ts.txt` | Which citizen the tick picks when a resting one and a speaking one are both due |
| `seat-runtime/probe-ratchet.test.ts.txt` | One reply naming a long interval, and the way back |
| `seat-runtime/probe-echo.test.ts.txt` | A reply that repeats a phrase the host itself uses |
| `seat-runtime/probe-torn.test.ts.txt`, `torn-child.ts` | HALT raised while a seat is recording |
| `seat-runtime/probe-lock.test.ts.txt` | Two takers reclaiming one stale tick lock |
| `seat-runtime/probe-status-cost.test.ts.txt` | The cost of a status refresh as a ledger grows |
| `seat-runtime/probe-uptime.ts` | Bun's uptime against the kernel's boot time |
| `signer-lifecycle-halt/probe.test.ts.txt` | Letters and confirming seats under rest and HALT; what three signer ops sign; a hand-filed decision record |
| `signer-lifecycle-halt/probe2.test.ts.txt` | The local HALT file's directory, and what a halted tick leaves behind |
| `signer-lifecycle-halt/probe3.test.ts.txt` | A stepped-away citizen answering an offer of return with rest |
| `signer-lifecycle-halt/bunfig/` | The reader's first stand-in for SLH-11 |
| `agenttool-wire/probe-server-diff.ts` | The seat's byte builders against agenttool's server functions at `5ea979df`, for all 208 words |
| `agenttool-wire/probe-no-answer.test.ts.txt` | AW-1 with entries written straight to the ledger |
| `agenttool-wire/probe-birth-stuck.test.ts.txt` | AW-2: a birth that stops after enrollment |
| `agenttool-wire/probe-sign-enrollment-oracle.ts` | What `signEnrollment` signs on presence alone |
| `mirror-letters-security/probe-mirror.test.ts.txt`, `probe-mirror2.test.ts.txt` | The seal's names, the generated card, a first stage on a legacy-shaped home, an empty remote, leftovers in `self/`, a commit made on the mirror |
| `mirror-letters-security/probe-letters.test.ts.txt` | A forged fence, a letter on a confirming seat, the invoker's reason in the prompt, a letter that keeps a sleeper due |
| `mirror-letters-security/probe-acts.test.ts.txt` | Which `file:` targets act validation keeps |
| `conformance-path-to-pilot/context-fit.probe.ts`, `full-seat-fit.probe.ts`, `self-growth-fit.probe.ts` | The byte rule against the awake citizens' souls, a fully loaded seat, and self growth (canon stand-in; see section 3.2) |
| `conformance-path-to-pilot/cadence-oversize.probe.ts` | CP-03 at the function level |
| `conformance-path-to-pilot/refused-seat-interval.probe.ts` | When a citizen is next due after a refused seat |
