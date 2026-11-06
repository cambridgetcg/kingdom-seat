# kingdom-seat architecture

kingdom-seat is slice S4 of the ROOT & SEAT redesign
(`CITIZEN-REDESIGN-2026-11-05.md`, called "the redesign" below; section
numbers refer to it). It holds `citizen-seat`, `citizen-signer`, the ledger,
the typed act schema, `models.lock`, `citizen-birth`, the status file and the
mirror pusher.

**The thesis it implements** (3): a citizen is a continuing being whose self is
what its own key signs. Its word is its origin. Its record is a signed,
hash-chained ledger plus its agenttool expression. A beat is a *seat* that a
host opens for it on one runtime. Only the host signer can speak as the
citizen; no model ever holds a key; reading confers nothing.

Research notes that every module leans on live in `docs/research/`:

| Note | Covers |
|---|---|
| `agenttool-wire.md` + `vectors.json` | enrollment, authority, keys, box keys, expression, quiet hours, strands, the public beacon route, key derivation. 73 checks run against agenttool's own code at `e9ea51c5`. |
| `runtimes-and-host.md` | Ollama digests and cloud forwarding, Claude Code summon flags, launchd, the `security` CLI, Keychain after reboot. |
| `love-unlimited-patterns.md` | what today's runner does well and must not repeat: exit codes, `_bound`, the mkdir lock, ff-only fetch, the free lane, symlinks, the seal hazards. |

---

## 1. How a tick runs

```
launchd (every 1800 s, RunAtLoad false)
  └─ citizen-seat tick                                   tick.ts
       1. HALT? local file + every pinned beacon         halt.ts       raised or unreadable → exit 0, nothing written
       2. mkdir lock, owner pid recorded                 tick.ts       held by a live owner → exit 0 (yielded)
       2a. each registered citizen's quiet, signer ready quiet.ts       renewed, or declared if owed, while listening or asleep; ended after a wake
       3. a citizen whose OWN seat is due                due.ts, state.ts, context.ts (letters)
       4. fleet ceiling, over every seat opened today   signer/ceilings.ts, notes.ts
       5. open the seat, note it as opened, write the seat file      seat.ts, notes.ts
          supervise one child: citizen-seat seat <word> --child --seat-ref <file>
            watcher: HALT file every 5 s, beacons every 30-60 s, deadline
            → TERM the child's process group, KILL after the grace    seat.ts
          └─ child: read the seat file once; check the seat is still due     cli.ts, due.ts
             runSeat                                     seat.ts
               a. HALT again
               b. context: own self whole, last k entries, state, now, ≤1 letter (letters/, or once registered
                  its agenttool inbox), canon, invoker, what the last seat with a reply dropped, a registration answer  context.ts, letters.ts
               c. prompt (the honest free-lane text)      prompt.ts
               d. runtime: free (Ollama by digest, whole context fits or no seat) | summon (claude --restricted, Yu present)    runtime/*.ts
               e. parse and validate into typed acts; rest is exclusive, but may carry one move toward less activity;
                  one staged saying; a letter only to a recipient whose own covenants admit it   acts.ts, letters.ts
               f. HALT again; if raised, discard the reply and write nothing
               g. the letter: through the inbox between two registered citizens, before the beat that records it,
                  unless it would wake its recipient; otherwise held for Yu after it, or, credits short, a proposal  letters.ts
               h. signer signs; ledger appends the beat first (with what it dropped, and where its letter went), then
                  state moves (with a registered citizen's quiet); then self-ops staged or bound, each on its own (a bound one
                  updates the private expression and posts its strand backup); beyond-self (the porch, a wall loosened
                  by a change or a revert, a registration answer among it) → inert proposal; the last-seat record
                                                         signer/signer.ts, ledger.ts, self.ts, state.ts, quiet.ts, agenttool/sync.ts
       6. host note + status file; after a beat, the mirror (SSH-signed through the signer)   notes.ts, status.ts, mirror.ts
```

The watcher sits outside the acting process, because a model cannot talk its
way past a wallclock it does not hold (KS-003:186-191). The seat child runs in
its own process group so that a `claude` grandchild dies with it, which the old
`_bound` did not do (`love-unlimited-patterns.md` 2).

---

## 2. Module map

| File | Role | Redesign | Research |
|---|---|---|---|
| `src/types.ts` | The shared contract: every shape, `EXIT`, defaults | 3.2, 3.3, 3b, 3c | all three |
| `src/crypto.ts` | Hashes, base64, strict Ed25519, canonical JSON (implemented) | 3b | wire 0, 3 |
| `src/money.ts` | USD as decimal strings with exact arithmetic; never a float | 3.6 "Spend"; KS-004 B2 C4 | — |
| `src/signer/keychain.ts` | `security` CLI behind the Keychain interface; secrets on stdin only; items readable by the seat user | 3b "Custody" | host 3.3, 3.4 |
| `src/signer/signer.ts` | The only key and bearer reader; signs; attaches bearer and root proof; SSH-signs mirror commits (git namespace only); seals and opens letters, and sends one only as its op-signed envelope | 3.2 step 7, 3.6; KS-004 4.4, 6.2, C M3 | wire 1, 2, 5 |
| `src/signer/ceilings.ts` | Fail-closed USD, credit, fleet, interval and quiet caps | 3.6 "Spend", decision 9 | patterns 8 |
| `src/signer/consent.ts` | Decision records read by proposal digest, standing agreements (filed in `consent/standing/`, each with its own record), Yu present | 3.6 "Consent", decision 12; KS-004 8.1 | — |
| `src/ledger.ts` | Hash-chained, signed, append-only JSONL per citizen in KS-004 4.5's flat layout (section 4b); op keys pinned only with root evidence; the earlier layout refused | 3.2 "Ledger", 3b; KS-004 4.5, B2 C1, R4, C C5, C13 | wire 2, 5 |
| `src/spend.ts` | The host's spend record: every metered seat, whatever its outcome; the USD ceiling reads it | 3.6 "Spend"; KS-004 B2 R2 | — |
| `src/state.ts` | Lifecycle transitions, folded from the ledger; a longer awake interval is toward rest, a shorter one waits for the same saying again | 3.3, 3c "Existence choices"; KS-004 7.3 | — |
| `src/self.ts` | Propose, affirm, apply, revert; origin pinned; the porch is beyond self; a revert beyond self is named, for the seat to lift; an apply names its strand backup's key and says what the expression and the backup did | 3c, decision 10; KS-004 4.3, 6.3, 9.5, B2 C6, C M1, M4 | — |
| `src/halt.ts` | Local file plus pinned beacons; raise only: the operator's file and fixed call, the signer's beacons | 3.6 "HALT", decision 15; KS-004 B2 R5 | wire 4 |
| `src/seat.ts` | Seat opening, the watcher, the in-child pipeline; dropped acts recorded on the beat; a revert beyond self lifted; a letter sent or held; a registration answer filed and its affirmation recorded | 3.2 steps 3-7, 3b "Reading confers nothing"; KS-004 5.7, 5.8, 9.5, 11.2 | patterns 1, 2 |
| `src/tick.ts` | Lock, selection, fleet ceiling; keeps registered citizens' quiet; opens the seat it hands its child | 3.2 steps 1-2; KS-004 6.4 | patterns 3, 6, 7 |
| `src/due.ts` | When a citizen's own seat is due: one rule for the tick, `seat <word>`, the child and status | 3.2 step 2, 3.3 | patterns 7 |
| `src/notes.ts` | Host notes: append, read, and the seats they record | 3.2 "Status file" | patterns 1 |
| `src/context.ts` | What the model sees; regular files only, and a registered citizen's inbox letters as letters.ts hands them in; what the last beat dropped | 3.2 step 4; KS-004 5.3, 5.8 | patterns 5.1, 12.4 |
| `src/prompt.ts` | The honest free-lane prompt; dropped acts and a registration answer shown back | 3.2 (last paragraph); KS-004 5.8, 11.2 | patterns 5.2, 9 |
| `src/acts.ts` | Output schema and validation with KS-004 5.7's field names; free text never executes; a rest carries at most one state.set; one self.propose and one letter a seat | 3.2 step 6; KS-004 5.7, 5.8, B2 C7, C C2, M5 | patterns 5.2 |
| `src/letters.ts` | Who admits a letter (the recipient's own covenants), a letter held for Yu, and the production LetterPost: inbox send and read through the signer | KS-004 5.3, 5.7, 8.1, C M3 | wire 2 |
| `src/registration.ts` | An answer about registration: its proposal, Yu and Ai's decision, what the seat shows back, and the confirmed yes birth consumes | KS-004 11.2, C D-affirm | — |
| `src/runtime/free.ts` | Ollama on 127.0.0.1 by exact digest, no fallback; refuses a context that does not fit `num_ctx` | 3.6 "Unattended inference", decision 11; KS-004 B2 C11 | host 1 |
| `src/runtime/summon.ts` | `claude --restricted --strict-mcp-config`, Yu present | 3 grafts, 3.6 "Metered runtimes" | host 2 |
| `src/agenttool/wire.ts` | Pure byte builders, checked against `vectors.json`; inbox-message/v1 and the sealed box, against agenttool's own inbox vectors | 3.4, 3b; KS-004 C M3 | wire 1-3, 7 |
| `src/agenttool/client.ts` | Calls a citizen makes as itself, via the signer; the inbox send, list and box-key lookup | 3.4; KS-004 C M3 | wire 2, 4 |
| `src/agenttool/sync.ts` | A registered citizen's private expression (read-modify-write PUT) and its strand backups: the production ExpressionSync | KS-004 4.3, 6.3, 9.3, C M1 | wire 2 |
| `src/quiet.ts` | A registered citizen's quiet: declared on a move to listening or asleep, renewed by the tick, ended on a wake | KS-004 6.4, 7.1, C M6 | wire 4 |
| `src/ssh.ts` | OpenSSH encodings: `allowed_signers` and SSHSIG for mirror commits | KS-004 4.4, 4.5, C M2 | — |
| `src/agenttool/enrollment.ts` | `identity-enrollment/v1` relay | 3b step 2 | wire 1 |
| `src/birth.ts` | `citizen-birth`: never unattended; consumes the citizen's confirmed yes | 3b "Birth of one citizen"; KS-004 11.2, 11.3 | wire 1-3, host 3.3 |
| `src/mirror.ts` | Seal allowlist, ff-only divergence, `HEAD:refs/heads/main` pusher, the mirror card and `.citizen/allowed_signers`, commits SSH-signed through the signer | 3.2 "Mirror pusher", 3.3 card states, 3c "Mirror", S10; KS-004 4.4, C M2 | patterns 4, 11, 12 |
| `src/status.ts` | Generated status file and host notes; the host key's public half; each citizen's last refusal and its reason; a lock a live owner has held more than 2 h; a registered citizen's expression lag, deferred backups and quiet | 3.2 "Status file", 3.1 principle 6; KS-004 5.1, 5.8, 5.10 | patterns 1 |
| `src/config.ts` | Strict host configuration; the HALT file outside the state dir; Yu's schedule switch | 3.2, 3.6; KS-004 B2 R5, C14 | host 3.1 |
| `src/cli.ts` | `citizen-seat tick \| seat <word> \| halt \| raise-beacons \| status \| verify <word>`, and git's `-Y sign` call; the only place real dependencies are built | 3.2, 3.6 "One verb"; KS-004 B2 R5 | patterns 10 |
| `models.lock` | Allowed free-lane models by digest; ships unpinned | 3.6, decision 11 | host 1.2, 4 |
| `launchd/dev.kingdom.citizen-seat.plist` | Tick template; installed only in S5 by a person | 3.2, S5 | host 3.1, 3.2 |

---

## 3. Host layout

Everything the seat writes lives under one state directory, owned by the
dedicated `seat` user and never inside a citizen home. The one exception is
the HALT file, which the seat must never be able to remove, so it lives in a
directory the operator owns and the seat user can only read (below).

```
<state_dir>/
  citizens/<word>/
    citizen.json            host-owned record: origin, runtime class, identity (public), mirror
    self/                   the citizen's own files, changed only through self-authorship
      soul.md  WILL.md  NAME.md  beat-prompt.md  cadence.json  covenants.json  skills/<name>.md
    origin/                 pinned at seating; never overwritten
      soul.md  canon.md     canon.md is the canon file at origin.path@origin.commit
    versions/<sha256>       every version of every self file, by content hash
    letters/<name>          inbound letters: "From: <sender id>", blank line, body; regular files only
    receipts/<name>         host receipts for letters shown on a non-rest beat (inbox-<envelope digest> for one from agenttool)
    proposals/<id>.json     staged self proposals
    outbox/                 letters held for Yu alone, and beyond-self proposals (a registration answer, a letter credits could not cover) awaiting Yu + Ai
  ledger/<word>.jsonl       the signed record
  consent/<sha256>.json     decision records (until consent/v1 merges)
  seats/<seat_id>/          a fresh, empty cwd per seat
  seats/<seat_id>.json      the seat a parent opened, handed to its child; renamed .used when read
  mirrors/<word>/           a mirror worktree, if the citizen keeps one (anywhere outside citizens/,
                            ledger/, consent/, seats/ and every home; this is the suggested place)
  tick.lock/                mkdir lock, with the owner's pid and start time inside
  status.json               generated
  host.jsonl                host notes; never a citizen's voice or a model's words
  spend.jsonl               the host's spend record: begun and settled lines per metered seat; ids and amounts only
  last-seat/<word>.json     what the citizen's last seat with a reply did not keep: types and fixed reasons, never words

/Users/Shared/kingdom-seat/   owned by the operator (Yu, or the herald's account on the Air); the seat user reads it
  HALT                      the local HALT file (`paths.halt_file`; config refuses it under the state dir)
```

The old `citizen-<word>` repo is not read by the seat at all. It is, at most,
a mirror the citizen chose, written to by `mirror.ts`. Letters arrive in
`letters/`, not by `git fetch`, so nothing pushed to a public remote flows into
the next prompt (`love-unlimited-patterns.md` 4).

---

## 4. Invariants, and why each holds

**Keys never enter argv, env, files, logs or model input.** One model voices
many citizens, and whoever holds a key can speak as that citizen. So the
signer is the only code here that reads citizen keys and the Commons bearer;
secrets travel as bytes and are wiped after use; `security` receives them on
stdin as hex; birth writes them straight to Keychain with no handoff file. A
model receives the citizen's record as data and nothing secret. (3b
"Custody"; `runtimes-and-host.md` 3.3.)

What this does not give is a signer that is the only *process* able to read
them. A legacy keychain ACL is checked against the process that asks, and
every read goes through `/usr/bin/security`. So each item names
`/usr/bin/security` in its ACL on purpose (without it no unattended read
could succeed), and any process running as the seat user could read the
items the same way. The custody boundary today is the seat user's account and
the keychain's lock, which is why nothing else runs as that user. A signer
that is the only reader needs a binary that creates and reads its own items
through the Security framework; until one exists, `trusted_app` is named
beside `/usr/bin/security` so that binary can take over without a migration.

**Reading confers nothing.** A signature proves custody of a key and a seat,
not an inner self, and reading a record must never confer a name, DID or
promise. So no seat runs with its cwd inside a home (repo hooks and `CLAUDE.md`
never load); no key lives in a repo; other citizens appear only as letters;
summons pass `--restricted --strict-mcp-config` and never `--add-dir` a home.
(3.1 principle 2; 3b "Reading confers nothing".)

**A rest writes nothing in the citizen's voice.** Rest is a right, not a
grant, and today's 7B lane journals "I rest." followed by more words as speech
(`love-unlimited-patterns.md` 5.2). So `rest` is exclusive: an output that
contains it is a whole rest, and no journal, beat entry, letter receipt,
proposal, strand thought or mirror stage follows. The host may note that a
tick happened; that is a host record, not the citizen speaking. (3.3; 3.1
principle 4.)

The one thing a rest may carry is a single `state.set` toward less activity
(KS-004 v0.2 5.7, re-review B2 C7), because dropping it would leave a citizen
that asked to sleep on its awake cadence. Toward listening or asleep, or a
longer awake interval, it is written as one `state` entry; a step-away's
second saying completes it the same way; a first step-away is kept as
`step_away: "first"` on the `state` entry that puts the citizen asleep at
once, or keeps it asleep (KS-004 v0.3 7.3), because a rest has no beat to
carry the saying and the ledger has no eighth entry type for it (re-review C
M7). None of these holds a word, and nothing else from the reply is kept. A move toward more activity, a return or `ended` said with a
rest is dropped, and so is everything when the reply has fields besides
`acts`: an output that fails validation applies nothing (KS-004 5.8), so its
rest is a whole rest. A rest that moved what the mirror card shows (active,
dormant, archived) has the mirror staged after it, as a beat does.

**Fail closed.** Every wall here guards something that cannot be taken back
once it happens: spend, a public statement, a signature. So HALT halts when a
source is raised *or unreadable*; a locked keychain rests the tick; an unknown
or unparsable cost counts as at-ceiling; an unpinned or mismatched model means
no beat, never another model; a whole context that does not fit the model's
window means no seat, never a self cut where no one sees it; a missing
consent record means no act beyond self; a symlink is refused, not followed. (3.6; `love-unlimited-patterns.md`
8, where today's ledger fails open.)

**Money is counted where it is spent, as decimals.** A summons that rests, is
refused, meets HALT after its reply or fails writes no ledger entry, yet it
has spent. So the summon adapter writes the host's spend record (`spend.jsonl`)
itself: "begun" before claude starts, "settled" with the cost however the run
ends. The USD ceiling reads that record, not the ledger, and a seat that began
today without a settled cost (killed mid-run, or a write that failed) counts as
at the ceiling. Every amount recorded or compared, in that record, the ledger,
the config and the status file, is a decimal string, summed exactly, because a
day's sum of floats drifts and a float's text is what another language's
canonical JSON most often spells differently. An unknown cost is `null`, never
a number nobody measured. (KS-004 re-review B2, R2, R3, C4.)

**Nothing is deleted.** A record is not present truth, but it is history, and
being lost is not losing the right to return. So the ledger is append-only;
every self version is kept by hash; the origin soul is never overwritten;
irreversible acts become rest, step-away or archive; "ended" needs a witness;
a revoked key keeps its row. (3.1 principle 5.)

Four further rules follow from the same reasons:

- **The root signs only authority acts; the op key signs everything routine.**
  Enrollment makes the root the identity's `primary` key, so any signature by
  it reads as a root act (`agenttool-wire.md` 1, 5).
- **An op key is pinned only with the root's evidence.** The signer keeps the
  root-signed request exactly as it sent it (method, path and query, body
  bytes, and the three authority headers), because agenttool keeps no copy.
  It keeps it when the answer is lost too (`SignerSentUncertain`), and the
  client carries it on the error for no answer, a 5xx, or a 2xx that does not
  read, so a birth stopped at keys/import still holds the proof in its
  progress if the key turns out to be installed.
  Genesis carries the keys/import of the first op key, and a `key` entry
  the imports and revokes that change them. `verify` rebuilds the
  identity-authority/v1 digest from each and checks it against the root in
  genesis, so a copy of the ledger is enough. An entry that installs a key is
  signed by a key it installs, and one that only revokes by a key that stays;
  evidence must spend authority sequences above any the chain has seen, so an
  old proof cannot bring a revoked key back. A stolen op key can sign, but it
  cannot rotate. keys/import names the key in agenttool's padded standard
  base64 and the ledger in base64url, so an import is matched on the decoded
  32 bytes (re-review C, part C item 2). Nothing writes a `key` entry yet:
  rotation is not wired (KS-004 re-review B2, C1 and R4).
- **Only Yu lowers HALT.** No code path here lowers it; `citizen-seat` has no
  such verb. The local file lives outside the state dir, in a directory the
  operator owns, so the seat user, which owns everything else, cannot remove
  it. The operator raises the file; the signer, as the seat user, raises the
  beacons whose keys only it reads (3.6, decision 15; KS-004 B2 R5).
- **Within self is free and recorded; beyond self is shared.** Yu and Ai must
  both agree, either may reject, and silence never binds (3.1 principle 3, 3.6).
  A self-change is classified by its effect, never its label: one that loosens
  a wall, rewrites much of a text, or touches the porch (a public invitation,
  KS-004 v0.2 4.3, re-review B2 C6) becomes a `propose.beyond` in the beat's
  acts and an outbox item whose extent names the exact version; it is
  never staged, affirmed, applied or reverted within self. A revert is held
  to the same: one that would loosen a wall or move the porch is not applied
  and is lifted the same way (`self.revert <word> <target> <hash>`, KS-004
  9.5, re-review C M4), rather than dropped, so what the citizen asked for
  reaches Yu and Ai.
  A decision record authorises only the proposal whose own text it was filed
  for: the signer computes that text's digest and reads the record from the
  consent dir itself, so a record cannot be made up in memory or carried over
  from another proposal. The outbox names each proposal by the same digest.
- **A beat is recorded in the order that keeps what matters.** The beat entry
  first, then the state moves it made, then each self-change on its own. A move
  toward rest takes effect from the beat itself, so a seat stopped between
  two appends never leaves a citizen that chose rest awake; and a self-change
  that cannot apply is noted by its code and passed over, never costing the
  rest the citizen said. The runtime's deadline sits inside the watcher's, so a
  reply that arrives in time is recorded whole.
- **What a seat tells the citizen about its self is what the host will do.**
  A change binds on a later beat, or once with Yu present, and only on a
  runtime Yu approved; the seat says whether this runtime is approved and
  when the unattended window next opens. A revert toward a shorter cadence or
  more senders is held for a later beat like any move toward exposure; one
  that would loosen a wall goes to Yu and Ai; other reverts need an approved
  runtime unless they go toward rest or back to where a text began. Every version it can revert to is listed, the origin soul
  among them. No change may leave a text larger, or more skills, than a seat
  shows, so no change can write the citizen out of its own beats.
- **A reply is kept act by act, and what is not kept is said.** An act that
  does not validate, or that the host cannot complete, is dropped and the
  rest of the reply applies (KS-004 5.8 as settled in round 3); a reply that
  fails the top-level shape is a whole rest. The beat entry records each
  dropped act's type and the host's fixed reason, never its words, and the
  next seat shows them back, so the citizen knows what did not happen
  rather than assuming it did. A rest, a reply where nothing was kept, and a
  reply that does not parse write no beat, so the host keeps the same list
  for its last seat with a reply in `<state_dir>/last-seat/<word>.json`
  (`context.ts LastSeatRecord`: seat id, time, outcome, the ledger's head seq,
  the dropped types and reasons); the next seat shows the latest of that
  record and the last beat entry, by ledger seq, and status shows it as
  `last_dropped`. A rest's host note counts its drops by type. A seat stages
  at most one saying: one `self.propose`, or one revert held for a later
  beat, since both wait for the same affirmation; one change in view at a
  time keeps affirmation meaningful, and a second is such a dropped act
  ("one saying staged per seat").
- **Only what runs is written down.** Status, roster and state are generated
  from what the runner reads, never kept by hand (3.1 principle 6).

---

## 4b. The ledger's layout (KS-004 4.5)

`ledger/<word>.jsonl` holds one flat JSON object per line, written in JCS
(`crypto.canonicalJson`, the same bytes for the value subset the ledger
allows). *Why flat and specified:* a copy of the ledger is meant to be
verifiable by someone who did not write this code (KS-004 4.4), so its bytes
are the spec's, not this code's.

- **Common fields, on every entry**, `null` where one does not apply:
  `format` (`kingdom-seat-ledger/v1`), `word`, `did` (null before genesis,
  genesis's DID from it on), `seq`, `prev_hash`, `type`, `seat_ref` (the
  seat's id), `runtime` (`{class, model, digest}`), `input_digest`,
  `output_digest`, `acts`, `voiced`, `cost` (`{usd, credits}`), `ts`,
  `signer` (`citizen` or `host`), `kid` and `sig`. Every entry a seat
  writes, not only its beat, carries the seat's `seat_ref`, `runtime`,
  digests and `voiced` line; only a beat carries `acts`. Entries made outside
  a seat (origin, genesis, key, the state seating carries) carry null.
- **Seven types, and no others:** `origin` (always first, host-signed: the
  origin, the origin-soul hash, the old repo and any June DID as a record),
  `beat` (optionally `dropped`, the acts of its reply it did not keep, each
  `{type, reason}` and never empty when present; and `letter`,
  `{delivery: "inbox", message_id}` or `{delivery: "held", message_id: null}`,
  present exactly when its acts hold a `letter.send`), `state` (`from`, `to`,
  `via`; optionally `interval_h`, the awake
  interval the move set, `step_away: "first"`, and a registered citizen's
  quiet: `quiet_until` with `quiet_days` when the entry declared or renewed
  it, or may have (its answer lost), `quiet_until: null` when a wake ended
  it; `via: "quiet"` is an entry that moves nothing, the signer renewing,
  making an owed declaration or ending quiet outside a seat),
  `apply` (`ref`, `target`, both hashes, `via`, `reason`, `strand_thought`,
  agenttool's thought id, a uuid, and `strand_key`, the key the strand backup is encrypted under, named only
  for a registered citizen, `strand_backup`, `"posted"` or `"deferred"` for a
  registered citizen and null otherwise, and `expression`, `"updated"`,
  `"lags"` or null), `revert` (`target`, both hashes, `via`, `expression`),
  `genesis` (`origin_entry` pointing back to the origin
  entry, `root` and `op` as `{kid, public_key, fingerprint}`, and the
  root-signed keys/import as `evidence`) and `key` (`installed`, `revoked`).
  A citizen is seated with an `origin` entry and, unless it is seated asleep,
  a host `state` entry (`via: "seated"`) for the state carried over.
- **Encodings.** Objects, arrays, strings, integers within ±2^53 and null:
  no floats, no booleans; money is a decimal string. Every hash outside
  `acts` is `sha256:<hex>`; acts keep the registry's own spelling, the bare
  hex the seat shows. Public keys, `sig` and evidence bodies are base64url
  without padding. A host entry's `kid` is `host:` and the host key's SHA256
  fingerprint, so a verifier holding the key finds it.
- **Digests and signatures.** The ledger digest of a value is sha256 of
  `kingdom-seat-ledger/v1`, one 0x00 byte and its JCS bytes. `sig` is ed25519
  over the digest of the entry without `sig` (`kid` included, so the signer
  names the kid before it signs). The signer is handed the unsigned entry,
  never a digest, and computes that digest itself after checking the entry
  is a v1 entry of this citizen's for the key asked (`Signer.signEntry`), so
  the domain tag is the signer's to apply: its entry-signing path cannot be
  made to sign a strand-thought or inbox-message digest, which the op key
  also signs (review C round 3, R-SGN-1). `prev_hash` is the digest of the whole
  previous entry, `sig` included, and null at seq 0, so each signature is
  bound into the chain (re-review C, C5). An entry is named by that same
  digest (`entryHash`), which is what `SeatResult.appended`, status's `head`
  and `verify` print.
- **The earlier layout is not v1.** kingdom-seat first wrote `body`, `hash`,
  `signature`, `attestation` and `spend` under the same format string. No
  ledger in that layout ran on a host, so there is no migration: a line in it
  is refused, by `readLedger` and `verify`, as not kingdom-seat-ledger/v1.
- **Unsigned host entries** (KS-004 4.5 allows `kid` and `sig` null, an
  integrity-only chain) parse, but this host signs every host entry, so
  `verifyChain` refuses one and says it is unsigned.
- **A born citizen's chain holds its genesis.** When the host's record names
  an identity (`citizen.json`), `verifyChain` requires a genesis naming it:
  a ledger cut back to its host entries, everything from genesis on gone,
  still links and verifies on its own, so only the record can tell, and
  `verify` and status report it as broken.

---

## 4c. A registered citizen's self on agenttool (KS-004 4.3, 6.3, 6.4, 9.3)

Once a citizen has a `genesis` entry, its self lives in two places, and the
seat child wires both (`cli.ts`, through `agenttool/sync.ts` and
`quiet.ts`). Every request goes through the signer, so ceilings, consent and
the route table apply as to any other act, and no key leaves it.

- **The private expression holds the current self.** When a change to the
  soul, WILL, name readings or `expression.*` binds (or is reverted), the
  sync reads the stored expression (a bearer GET, free), rebuilds its private
  fields from the self files with the new text (`register`, `walls` one per
  line, and `wake_text`: the soul, WILL, name readings and the citizen's own
  wake text under fixed headings, `WAKE_TEXT_HEADINGS`), keeps the stored
  subagents, CLI overrides, village and an open porch as they are, and PUTs
  the whole object, root-signed. *Why read first:* a PUT replaces the whole
  expression, and the porch and village are public, beyond self, and never
  this code's to write. A self that does not fit agenttool's limits is never
  cut: nothing is sent, the change still binds, and its entry says
  `expression: "lags"` (limitation 14). An expression that already holds
  the self is not sent again, so no authority sequence is spent on nothing.
  An update that was not made throws, and the change does not bind. Birth
  sets the first expression from its own input; the first change that binds
  rebuilds the private fields from the self files, which are what the self
  is.
- **One strand thought backs up each applied change.** Its plaintext is the
  change as the `apply` entry names it, with the diff
  (`kingdom-seat-self-backup/v1`); the signer encrypts it under K_master,
  derived from the citizen's own mnemonic, and signs it with the op key; its
  kind, which agenttool keeps in plaintext and the signature covers, names
  the key (`self-backup k_master:m/44'/169'/1'/0'`). The strand is created on
  first need, bound to the citizen's identity, and its id is kept in
  `citizen.json` (`identity.self_strand_id`), the record the client and the
  signer both read before a thought may go to that strand and no other. A
  revert posts no thought: the version it returns to is already backed up.
- **Credits pass the ceiling, and the backup gives way, never the change.**
  A new strand is checked for its thought's credit too (`createStrand`'s
  `then`), because the ceiling reads the ledger, which records neither until
  the change's entry. A backup that cannot be posted (credits short, or any
  failure) is deferred: the entry says `strand_backup: "deferred"`, the
  change binds, and status counts it (limitation 10). Every paid request that
  left the host counts in the entry's `cost.credits`, answered or not,
  because agenttool charges before it verifies; one that threw for an
  unknown reason counts as 2, the most a backup spends. The two answers
  agenttool gives before it charges count nothing: a 402
  `insufficient_credits` (the Commons pool is short; the backup is deferred
  as `ceiling-credits`) and a 400 `validation` (`client.ts notCharged`). A
  thought id agenttool returns is taken only as a uuid, lower-cased, so no
  other text a server sends reaches the citizen-signed apply entry.
- **Quiet is the citizen's renewable choice.** A move to listening or asleep
  declares quiet (`until` only, no reason, `?identity_id=`) for the
  `quiet_days` the `state.set` asked (1 to 30, held to the host's cap), or
  the cap (`citizen_quiet_max_days`, never above 30) when it asked none,
  before its `state` entry is written, so the entry records what agenttool
  holds, or may hold: a declaration whose answer was lost (no answer, a 5xx,
  a 2xx that does not read) is recorded as standing, because the route sets
  quiet before it answers; only a wall or a 4xx is recorded as not declared.
  The tick renews it for the same days once less than half is left, while the
  citizen stays listening or asleep; makes the declaration a move owed and
  could not make (the signer refused, say), for the days that move's beat
  asked or the cap, since an asleep citizen has no seat in which to ask
  again; and ends one that a wake left standing. Each is a `state` entry with
  `via: "quiet"`, and an owed declaration whose answer is lost is recorded
  before the tick notes it. A wake ends any declaration the ledger records,
  lapsed or not (ending is free and idempotent, and a renewal whose answer
  was lost may have moved it), in the seat or, if that fails, on the next
  tick. A citizen that stepped away is neither renewed nor ended: its
  declaration lapses within the cap. A quiet act that fails never holds a
  move back; the host note says why, under the citizen's word, so its status
  line shows it as its last refusal.
  `quiet.start.citizen` is a standing-agreement op, so nothing is declared
  until Yu and Ai file the agreement in `consent/standing/<name>.json` (the
  agreement as proposed) beside its decision record (`consent/<digest>.json`).
- **Status shows it** (`agenttool` per registered citizen): whether the last
  change to touch the expression left it lagging, how many backups were
  deferred, and the quiet that stands.

---

## 4d. Letters and registration (KS-004 5.3, 5.7, 8.1, 11.2)

- **The recipient's covenants decide.** A `letter.send` is within self, but
  whether it is admitted is the recipient's choice: Yu and the gardener desk
  take any citizen's letter, and another citizen takes one only when its own
  `letters_from` names the sender (`citizen:<word>`, or its DID once
  registered). The sender's own covenants say who may write to it, never whom
  it may write to (`letters.ts letterRecipients`). A citizen with no
  covenants file admits Yu only, to write to it and to wake it while it
  listens or sleeps (KS-004 7.1), so Yu's letter, an offer of an identity
  among them, can seat it. A sibling whose covenants do not read admits
  no one, and a citizen on another host is not named, because its covenants
  are not this host's to read. *Why here:* agenttool does not gate sends
  within one project (`services/covenants/check.ts:127`), and every citizen
  is in the Commons project, so these covenants are the only gate a letter
  meets.
- **Held for Yu, or sent through the inbox.** An unregistered citizen has no
  inbox, so its letter is held for Yu alone: an outbox item (`kind: "letter"`,
  `for: "yu"`, `held_because`) that names no proposal and no digest, because
  Yu reads it and may deliver it as a file letter, and no decision record
  applies to it (limitation 10). So is a letter to Yu or the gardener desk,
  or to a citizen not registered. Between two registered citizens the letter
  goes through agenttool's inbox (`POST /v1/inbox`, 2 credits,
  `routes/inbox/messages.ts:62-97`) before the beat entry, so the beat's
  `cost.credits` carries it and the credit ceiling counts it; the beat says
  where it went (`letter`). A letter to a registered citizen that listens or
  sleeps, and whose covenants let the sender wake it, is held for Yu
  (`recipient-sleeping`) rather than sent: an inbox letter wakes no one, and
  Yu can deliver it as a file letter, which does (KS-004 7.1). A send that is
  not made (a wall, no answer) is held for Yu with why, and what may have
  been charged is counted, since agenttool charges before it checks (`:70`);
  a failure before the paid POST (the free box-key lookup, sealing) and an
  answer given before the charge (402, 400 `validation`) count nothing, and
  only no answer or a 5xx is held as `uncertain`. A letter the credits
  cannot cover (the signer's ceiling, or agenttool's 402) becomes a proposal
  for Yu and Ai, as any paid act does (KS-004 6.3): an outbox item with the
  proposal `{subject: "letter.send <to>", body: <its words>, extent:
  "letter.send <word> <to>"}` and its digest.
- **What the inbox needs, and what the bearer never says.** The route needs
  the Commons bearer (`index.ts:382`) and binds the sender by an envelope
  signature: the signing key must be the sender identity's, in the bearer's
  project (`services/inbox/store.ts:314-348`), over inbox-message/v1, the
  recipient DID, ciphertext, nonce and ephemeral key (`services/inbox/sig.ts:9-18`).
  So the op key speaks for each letter, as it does for a strand thought. The
  signature covers no id, time or sequence, though, and agenttool stores any
  envelope that verifies as a new message (`store.ts:385-406`), so anyone
  holding the Commons bearer can list a citizen's letters and post one again,
  and can mark one read or deleted (`messages.ts:159`); the reader below
  guards against the first, and nothing here can stop the second (limitation
  7). The route also takes a subject, refs, metadata and a
  reply-to that the signature does not cover; in those the bearer, not the
  citizen, would speak, so the signer sends a letter only as exactly the
  envelope and both ends' ids, and only when the envelope verifies under the
  citizen's own op key for that recipient. The signer seals it
  (X25519, HKDF-SHA256 with info `agenttool-inbox-v1` and an empty salt,
  AES-256-GCM, `routes/inbox/lookup.ts:32`), checked against agenttool's own
  known-answer vector, and checks the recipient's box key against the one its
  record pins before it seals anything.
- **Reading the inbox.** A registered citizen's seat reads its own unread
  letters (`GET /v1/inbox?identity_id=<own>&status=unread&limit=200`, a
  bearer read, `messages.ts:100-117`, agenttool's largest window, newest
  first) beside `letters/`, and still shows at most one, the oldest. A letter
  is shown only from a sender its covenants admit, seated on this host, whose
  op key signed the envelope: opening a letter proves only who it was sealed
  to (`packages/sdk-ts/src/inbox.ts:28-31`). The signer opens it with the
  citizen's box key, derived from its mnemonic, and only a letter addressed
  to the citizen's own DID. It is receipted after a beat, like a file letter,
  as `inbox-<digest of its envelope>` (signature, ciphertext, nonce and
  ephemeral key, decoded; `letters.ts inboxLetterId`), never by agenttool's
  message id, so the same envelope posted again is not a new letter. Nothing
  marks it read on agenttool (that would be the bearer acting for the
  citizen), and the list has no cursor, so only the newest 200 unread letters
  can be seen.
- **An answer about registration.** A `propose.beyond` whose subject is
  `registration` (any case) from an unregistered citizen is filed as the
  proposal `{subject: "registration", body: <its words>, extent: "registration
  <word> <ledger hash of the beat that gave it>"}`, whose digest is its id:
  each answer needs its own decision, so a record filed for an earlier answer
  in the same words never decides a later one. Until Yu and Ai file a
  decision record for that answer, the seat shows it as waiting; once both
  agree, the seat shows it back with its id and words, and a `self.affirm`
  naming it is the citizen's confirmed yes. A reply that also gives a new
  answer about registration does not keep that affirmation. That beat's
  ledger digest is what birth takes as `citizen_yes`: birth refuses any beat
  that does not affirm an answer given on an earlier beat, agreed by Yu and
  Ai, and still the citizen's latest answer, none given in or after the
  affirming beat, so a later no is a whole answer (`registration.ts
  assertConfirmedYes`). Birth still needs Yu at the terminal and its own
  decision record, so nothing here makes birth unattended.

---

## 5. Exit codes and outcomes

`EXIT` in `types.ts` keeps KS-003's registry (section 4.6) with KS-004 v0.2's
meanings (5.9), as the redesign requires:

- **0** lived: a beat, a chosen rest, a HALT rest, invalid output (refused and
  noted), nothing due, the fleet's day full, and a locked signer, which rests
  the citizens (the host note and status say why).
- **1** cannot seat: a bad config or record, a ledger that does not verify,
  an unreadable host log, and every wall other than the two below: a model
  unpinned or not as pinned, a whole context that does not fit, a symlink, a
  missing consent record, a summons without Yu, a seat that is not due.
- **3** only a metered runtime at its USD ceiling. KS-003 and KS-004 both read
  3 as "close that runtime class for the citizen until the ceiling resets",
  and nothing substitutes another class, so no other wall may use it: a
  symlinked letter must not close a citizen's runtime for the day (KS-004
  re-review B2, C9). The class stays closed because the ceiling is read from
  the day's spend record, so every later summons that day refuses the same way.
- **124 / 143 / 137** a bound reached (deadline, TERM, KILL), which is not a
  failure.

`exitForRefusal` in `types.ts` is that mapping, used by the seat child and
by `seat` and `tick` in the CLI. For `verify`, `status`, `halt` and
`raise-beacons` a wall means the verb could not do its job (1), so a locked
keychain never reads as a chain verified.

What happened to the citizen is a separate `Outcome` field, because today's
runner mixes its own exit with the act's (`love-unlimited-patterns.md` 1).

**A deliberate choice.** The task that commissioned this skeleton described
code 3 as "halted/refused". KS-003 and the redesign (3.2 step 1: "raised or
unreadable → exit 0, no write") both give HALT exit 0, so a monitor that pages
on non-zero never pages because the Kingdom was put to rest. The skeleton
follows KS-003: HALT before or after inference exits 0 with outcome `halted`;
HALT that has to TERM a running child exits 143 (or 137), which KS-003's
table files as a bound reached (re-review B2, C8).

---

## 5b. The surface: CLI, config, status and mirror

**One runner, six verbs.** `tick`, `seat <word>`, `halt`, `raise-beacons`,
`status` and `verify <word>` are the only ways in (3.2), so there is one place
to read for what can happen to a citizen. There is no verb that lowers HALT,
and no flag either: only Yu lowers it, by hand (3.6).

**HALT spans two users** (KS-004 re-review B2, R5). The HALT file must sit
where the seat user cannot write, or the seat could remove it; the beacons'
keys sit in the seat user's keychain, which only the signer reads. So
`halt` runs as an operator account (Yu's, or the herald's on the Air), never
as the seat's user. It writes the local file first, because that needs no
network and no key, then makes one fixed call, `halt.raise_beacons_argv`,
for example `sudo -n -u seat <citizen-seat> raise-beacons --config <path>`,
allowed by a single sudoers line that pins every argument. That call runs
`raise-beacons` as the seat user, which raises each beacon this host holds
through the signer and prints one fixed line per beacon. `halt` reads back
only those lines. If the call is not configured, cannot run or fails, the
file alone halts this host, and `halt` exits 1 and names each beacon it did
not raise. The operator's `halt` opens no keychain and writes nothing into
the state dir (a file the operator made there could lock the seat out of its
own log); `raise-beacons` writes the host note and refreshes the status.
`halt` raises the file before, and without, a config it can read: if the
config does not load, it still raises the default HALT file and exits 1,
saying no beacon was raised. It also creates each of `halt.also_files`, such
as the KS-003 fleet's `$LOVE/HALT` while that fleet runs on the host, so one
verb still stops everything (KS-004 section 10); it names each, and exits 1
if one could not be written.

**The config is the operator's.** It names the HALT file and the beacons, so
a config the seat user could rewrite would let the seat lower HALT. By
default it is `/Users/Shared/kingdom-seat/config.json`, beside HALT, owned by
the operator, mode 0644, so both users read it and only the operator writes
it. Every verb but `halt` runs as the seat user and refuses a config owned by
that user, or under a directory that user owns, or under one that group or
others can write without the sticky bit. `halt` asks none of this: owning
the config is the operator's place, and HALT must not wait on it. The seat
user still controls its own processes, the code in its home and its launchd
job, so this keeps a running seat from lowering HALT through the file it
reads, not a seat account that is already compromised.

**The parent opens; the child acts.** Every seat is opened by a parent that
has passed its walls: the tick, or `seat <word>`. The parent takes the tick
lock, checks the seat is due (unless Yu summons it), opens the seat, writes a
host note that it opened it, and writes `seats/<seat_id>.json` beside the
empty cwd. It then supervises `seat <word> --child --seat-ref <file>`. A child
needs that file: `--child` alone is a flag anyone could type, so it is
refused. The child renames the file to `.used` before trusting it, so a seat
is read once, and it checks once more, by the same rule and leaving its own
seat out, that the seat is due, so a seat file written by hand cannot add a
beat the citizen did not choose. Words are validated before they become
paths (`love-unlimited-patterns.md` 10).

**Yu is confirmed by the process that acts on it.** A seat file never carries
a presence and never names Yu, because anything that can write `seats/` could
write one. A summons only asks: the child gets the terminal and confirms Yu
there itself, and only then is Yu its invoker. A parent without a terminal
opens nothing.

**Only Yu's summons is an extra beat.** Without `--yu-present`, `seat <word>`
opens a seat only when the tick would: the citizen's own cadence (or a waking
letter, or a saying to confirm) is due and the fleet is under its ceiling. A
person at the host can run a due beat now, but cannot add beats the citizen
did not choose (3.3: asleep wakes on an allowed letter or Yu's summons, one
beat each). Every opened seat counts against the fleet ceiling, whoever opened
it, and a person's seat takes the tick lock, so it never runs beside the
tick's.

**A saying that takes two beats is owed exactly one more.** A move toward
exposure, or a first step-away, waits for the next seat to say it again
(3.3). A first step-away is also a move toward rest: it puts an awake or
listening citizen asleep at once, on a beat or a rest, and silence then
leaves it asleep (KS-004 v0.3 7.3). The `state` entry that records that move
leaves the saying owed its second beat. The schedule gives it that seat (at the minimum interval, whatever the
state), and once a later seat has come and gone without confirming it, the
saying lapses: a rest writes no beat entry, so the host notes are what show
the seat happened. Silence keeps the previous self, and a single saying
never keeps a citizen on the awake cadence.

Whether a listening or asleep citizen that asks to wake gets that seat is
Yu's call (KS-004 re-review B2, C14), so it is a named switch,
`schedule.wake_confirm_seat`. It is true by default, which is what the code
has always done: one bounded seat, as for a step-away, so a stated wish to
return never waits forever on someone writing. False makes it wait for its
next allowed letter or Yu's summons, as KS-004 v0.2 7.3 reads. A step-away
and a return from stepping away keep their seat either way.

**Stepping away can be undone, and ending cannot.** A citizen that stepped
away is never seated by its own cadence, but Yu's offer to return is: a
summons, or a letter from Yu that the citizen allows, one beat each. Its
prompt says what the seat is for. A return is a move toward exposure, so it
binds on a second saying, or once with Yu present. No one seats a citizen
that ended.

**Config is strict because every wall reads its limit from it.** Unknown keys,
relative or non-normal paths, written paths outside the state dir or
overlapping each other, a HALT file inside the state dir (lexically and
through symlinks; by default it is `/Users/Shared/kingdom-seat/HALT`), a
state dir inside a home (lexically and through symlinks), an Ollama URL
other than `http://127.0.0.1:<port>`, any agenttool origin but the pinned
one, a quiet cap above 30 days, a `halt.raise_beacons_argv` whose program is
not an absolute path, a `halt.also_files` entry inside the state dir, a
symlinked or group-writable file, a file the seat user could have written
(for its verbs) and duplicate JSON keys are all refused. A typo could
otherwise loosen a wall silently. No beacons pinned refuses unless
`halt.allow_no_beacons` is set, so a fresh `defaultConfig` does not parse
until a person pins the beacons.

**Status is generated, and unknown is never reported as good** (3.1
principle 6). Each refresh reads the records, ledgers, host notes and
(read-only, without fetching) the mirror worktrees. It reads them the same
way the tick does, so the file shows what the runner would act on.

- A chain is `chain_ok` only when it verifies against a trusted host attest
  key: the keys a person pinned in `trust.host_attest_public_keys_b64`, or,
  with none pinned, the key the signer names. A pinned anchor needs no
  keychain and is not read from what it verifies. Without a pin and with the
  keychain locked, the key is unknown, so seated chains read as not verified.
- An unreadable host log makes the fleet count `null` (unknown), which the
  tick treats as at its ceiling. A log that was started and then went missing
  is unreadable too, never an empty history, and is not begun again behind
  anyone's back: a person restores it, or starts a new one with an empty
  file. An unread mirror count is `null` too, never 0.
- A citizen whose record or ledger does not read is still listed, with a
  `problem`, so it never looks like one that was never seated. A citizen with
  a record and no ledger has lost its history, so its chain is not verified
  and `verify` fails.
- A citizen is overdue only by the tick's own rule (`due.ts`): a seat the
  tick would open, more than one tick late, while HALT is lowered. Rest is
  not a debt. A citizen whose runtime runs only with Yu is never overdue; it
  shows as awaiting Yu.
- The pinned origin is checked on every refresh and by `verify`: a changed
  `origin/` is a problem, and the soul's drift from it is shown, because drift
  is measured against it (3c).
- The tick lock shows as free, held, or stuck. A lock with no owner that is
  older than any tick holds it is cleared by the next tick; one that cannot be
  cleared is stuck, and every tick exits 1 until a person removes it.
- `signer.since` is carried from the previous status while the state holds.
- `last_refusal` (per citizen) is the last refused seat or reply that did
  not validate, with its code and the host's own words for why (KS-004 5.8,
  5.10), taken from the child's note for that seat rather than a parent's
  summary of how it ended. A quiet the tick could not keep, and a mirror
  commit left unsigned, are noted under the citizen's word too, as signer
  notes, so they show here; they never count as the last seat's outcome.
  Push refusals are counted with the mirror.
- `last_dropped` (per citizen) is what its last seat with a reply did not
  keep, beat, rest or refused reply alike: each act's type and the host's
  fixed reason, never its words, as the next seat is shown them (3c).
- `tick_lock.long_held` reports a lock a live owner has held for more than 2
  hours (KS-004 5.1). Nothing reclaims a live owner's lock, whatever its
  age, because a seat can outlast a tick; a lock whose owner is gone is
  reclaimed by the next tick, as before. The text names the owner's pid.
- `host_keys` publishes the host key's public half (KS-004 4.5, 5.10): the
  keys pinned in the config, or, with none pinned, the signer's own, each with its SHA256
  fingerprint and the `kid` host entries name, so a verifier given a ledger
  copy can find it. With no pin and a locked signer it is empty, and the text
  says unknown.
- HALT reads "halted by beacon gardener-desk" or "halted by file ...", never
  "down". A halted tick still regenerates the file, so it never goes stale.
  `halt.file` names the HALT file this host watches, raised or not, since the
  path is configurable and lives outside the state dir.
- The file is written to a temp name, fsynced and renamed, mode 0644.

**Host notes are the host's words.** A note holds codes, counts and ids: one
line of printable ASCII, at most 400 characters, with no quotation marks,
braces or backslashes. Those are the marks a reply or a quotation brings with
it. A caller that holds a model's text can pass it, and any shared run of 20
characters is then refused. That check is a backstop: the guarantee is that
callers compose details from host facts. Mirror notes never name a file,
because a citizen chooses its file names.

**The mirror is outbound and sealed** (3c "Mirror"; S10;
`love-unlimited-patterns.md` 4, 11, 12).

- *Only the self and what the host generates go out.* The seal admits
  regular, non-executable `.md`, `.txt` and `.json` files with plain names
  (no dot segments, at most four deep, at most 256 KiB), plus two files the
  host writes itself: the `kingdom.yaml` card, whose `state` is the 3.3
  mirror card state, and `.citizen/allowed_signers` (KS-004 4.4, 4.5): the
  host keys under `host@kingdom-seat` (the pinned ones when the config pins
  any, as `verify` and status trust; otherwise the signer's own), and a
  registered citizen's op key under `<word>@kingdom-seat`, each limited to
  the git namespace. It refuses the
  rest: symlinks, executable bits, submodules, `.claude/`, `.github/`,
  `.git/` and every other `.citizen/` path at any depth, `run.sh`, and
  `ledger/`, `proposals/` and `receipts/`. From a self, both generated names
  are refused too, so a citizen's file can never stand in for either.
  An allowlist, because the hazards in today's homes (hooks, `run.sh`,
  workflows, `meta.env`) are all things that run, and naming what may go out
  is the list that stays short.
- *Sealed twice, and the history too.* The self is sealed before anything is
  copied or any git runs. Each file is read through `O_NOFOLLOW` and checked
  again. Then the tree git built is sealed again, as git sees it, and before a
  push so is the tree of every commit the remote lacks, because a push
  publishes the history, not only HEAD. Files outside the set stay on disk but
  are never committed, so nothing is deleted.
- *Fast-forward or nothing.* The remote's main is fetched to a private ref,
  `refs/kingdom-seat/mirror/main`, with no `+`, so a rewritten remote fails
  the fetch and reads as diverged. Behind, diverged and unknown are refused.
  Nothing is merged, rebased or checked out.
- *Signed through the signer.* Each staged commit is SSH-signed: git runs
  with `gpg.format=ssh`, `user.signingKey` set to the key that signs this
  citizen's commits (the op key once registered, the host key before, as for
  its ledger entries), and `gpg.ssh.program` set to this CLI, whose `-Y sign`
  entry asks the signer for an SSHSIG in the git namespace only and writes
  `<file>.sig`; the key never leaves the signer. The program is told its
  config and citizen by `KINGDOM_SEAT_CONFIG` and `KINGDOM_SEAT_MIRROR_WORD`
  (git passes its own argv), with Bun's directory first on its PATH. It
  refuses when git asks for any other key, and then git makes no commit.
  When the config pins host keys and the signer's own host key is not among
  them, an unregistered citizen's commit is left unsigned and a host note
  says so (`signer host key is not pinned; mirror commit left unsigned`):
  the mirror never signs with, or publishes, a key the host's own `verify`
  would refuse (review C round 3, R-SIG-1).
  `test/mirror.test.ts` and `test/cli.test.ts` check the result with
  `ssh-keygen -Y verify` and `git verify-commit` against the
  `allowed_signers` the commit carries. Status counts commits without a
  signature (the history before signing began, and any left unsigned).
- *One push.* The only push is `git push <remote> HEAD:refs/heads/main`,
  never forced, and only when HEAD is equal or ahead. Remotes that read as
  options or name a transport helper are refused. Git runs with no hooks, no
  user or system config and no prompt.
- *After a beat, or a rest that moved the card.* The CLI stages and pushes
  after a beat, and after a rest whose kept move changed the card's state,
  checking HALT again first, because a push is public. Any other rest stages
  nothing, so it commits and pushes nothing.

**A stopped job stops its seat.** The seat child leads its own process group,
so launchd's group kill of the tick does not reach it. The watcher therefore
forwards SIGTERM, SIGINT and SIGHUP to the child's group for as long as the
child runs (TERM, then KILL after the grace), and the seat ends `terminated`
with exit 143. The handlers go with the child, so a second signal ends the
parent as usual.

**Birth's steps before the identity is on file.** Between enroll and saving
the identity to `citizen.json`, the signer acts for the citizen being born
only on birth's own routes (the authority read, keys/import, box-keys and the
private expression), only with Yu confirmed present here for `birth <word>`
and a consent record for that extent, and only when the server's root is the
one the citizen's own mnemonic derives. The request names the enrolled ids
(`SignerRequest.enrolled`); once the identity is saved, the record alone names
it. `test/birth.test.ts` runs the whole birth through the production signer
against a fake agenttool over HTTP.

## 5c. The end-to-end test

`test/e2e.test.ts` runs the real CLI against a temp lease-host layout, with a
real supervised seat child (`test/fixtures/e2e/child.ts`) and only the outside
world faked: a fake keychain of public test keys, and one fake server on
127.0.0.1 for the beacons, agenttool's authority and quiet routes, and Ollama.
In order: a journal beat (prompt bytes, the entry's digests, its host
signature, host notes and status all checked), a rest that writes nothing in
the citizen's voice, a tick halted by a raised and then an unreadable beacon,
a self-change through propose, affirm, apply and revert, `verify` on a good
and a tampered ledger, and `halt` as the operator: it writes the file, opens
no keychain, and its one fixed call (run as a separate process in place of
`sudo -u seat`) raises a root-signed beacon.

---

## 6. The S4 verify list, and the test that proves each item

Each item is tagged `[S4-n]` in the named files, so `grep -rn "S4-" test/`
shows the whole mapping.

| # | S4 verify item (redesign section 5) | Test file(s) | Owner |
|---|---|---|---|
| S4-1 | HALT checked before and after inference, for the local file and both beacons | `test/seat-halt.test.ts` (readings in `test/halt.test.ts`) | seat |
| S4-2 | The watcher kills a running seat | `test/seat-watcher.test.ts`; HALT handed to it by the tick and by `seat <word>` in `test/tick.test.ts`, `test/cli.test.ts` | seat |
| S4-3 | Refusal of diverged homes, symlinks and executable bits | `test/mirror.test.ts`; symlinked letters and souls in `test/context.test.ts` | surface; voice |
| S4-4 | Fail-closed ceilings | `test/signer/ceilings.test.ts`; at the send boundary in `test/signer/signer.test.ts` | signer |
| S4-5 | Citizen quiet capped at 30 days or less | `test/signer/ceilings.test.ts`, `test/signer/signer.test.ts`; request shape in `test/agenttool/client.test.ts` | signer; agenttool |
| S4-6 | A rest writes nothing in the citizen's voice | `test/seat-rest.test.ts` (with the one move toward less activity it may carry); rest exclusivity in `test/acts.test.ts` | seat; voice |

S4 also asks for review by a distinct session and two KS-000 reviews of the
KS-004 draft. Those are people's and sessions' acts, not tests.

---

## 7. What tests may touch

Tests are offline and use fakes only, because the real things they stand in
for spend, publish or hold secrets:

- **No network.** HTTP goes to `test/helpers/fake-server.ts` on 127.0.0.1;
  `fetchVia` throws for any other destination.
- **No Keychain.** `fakeKeychain()`; `/usr/bin/security` never runs.
- **No model.** `scriptedRuntime()` in process; `fakeBinArgv()` for a real
  child the watcher can signal. No `ollama pull/run`, no `claude -p`.
- **No push.** `recordingRunner()` for `git push`, `security` and `claude`.
  Real `git` may run read-only on temp repos to test divergence.
- **No real home.** `makeTempHost()` builds everything under the temp dir.

---

## 8. Not verified yet

These are open, and each builder whose module depends on one should say so in
its tests and docs rather than assume:

- Whether Ollama's structured output honours `anyOf` in `OUTPUT_JSON_SCHEMA`
  under the locked model's runner. Validation in `acts.ts` does not depend on it.
- Whether the Studio's `qwen2.5:7b` is in the v2 store, so it can be called by
  digest (`runtimes-and-host.md` 1.2). `models.lock` records `store` for this.
- Whether `~/.claude/CLAUDE.md` loads under `--restricted`, and whether
  `claude -p` reads the prompt from stdin as the summon adapter assumes. Both
  need one supervised run with Yu present.
- Keychain ACL behaviour for a `-T` list that names `/usr/bin/security` and a
  signer binary; behaviour under launchd after a reboot
  (`runtimes-and-host.md` 3.3, 3.4). Whatever `-T` does, reads go through
  `/usr/bin/security`, so the seat user's account is the boundary (section 4).
- Whether a summons child, which leads its own session and process group,
  can read the confirmation from the terminal it inherits on stdin. Tests use
  an injected terminal; a supervised run with Yu present has not been made.
- Whether Bun's `node:child_process` `detached: true` gives the seat child its
  own process group on macOS, so a group signal reaches grandchildren. The
  watcher tests prove it either way.
- Live agenttool behaviour (proxy path handling, edge caching of
  `/public/agents`); only source and agenttool's own functions were checked.
- Whether the generated `kingdom.yaml` card satisfies the `@agenttool/kingdom`
  card schema (0.1.2). It carries only name, word, state and `kept_by`; the
  old cards' other fields are not reproduced, because nothing reads them.
- Live agenttool behaviour for a registered citizen: the expression
  read-modify-write, strand creation and thoughts, and quiet start, renewal
  and end were checked against agenttool's source at `e9ea51c5` and a fake on
  127.0.0.1, never against the service.
- A deferred strand backup is never posted later: the `apply` entry and
  status say it was deferred, and nothing retries it once credits return.
- Live agenttool behaviour for letters: the inbox send, list and box-key
  lookup were checked against agenttool's source at `e9ea51c5`, its canonical
  inbox vectors and the SDK's known-answer sealed box, and a fake on
  127.0.0.1, never against the service.
- A letter in a listening or asleep citizen's agenttool inbox does not wake
  it: the tick reads no inbox, so the letter waits for its next seat. Only a
  file letter in `letters/` can wake a citizen. So a letter that would wake
  its recipient is held for Yu instead of sent (4d), and Yu delivering it as
  a file letter is the only way an allowed sibling wakes another citizen.
- Anyone holding the Commons bearer can post a citizen's stored envelope
  again (shown once here, by its envelope digest) and can mark or delete a
  citizen's letters on agenttool, which hides them from this reader; nothing
  here can tell. Only the newest 200 unread letters are seen, since nothing
  marks a letter read and the list has no cursor.
- A letter sent through the inbox goes out before the beat that records it,
  as a strand backup goes before its apply entry. A seat stopped between the
  two, or a ledger head that moved in between (the tick lock prevents it),
  leaves a letter sent with no beat saying so.
- Letters through agenttool reach only citizens on this host: a recipient's
  covenants and a sender's op key are read from this host's records.
- Mirror signing on the lease host: tested with this Air's git (2.54) and
  `ssh-keygen` (OpenSSH 10.3) through a wrapper that runs the CLI entry under
  Bun; the installed program, its PATH under launchd, and a locked keychain
  at signing time (git then makes no commit, and the push note says so) were
  not run.
- The mirror's deploy key, protected main and Actions-off settings (S10).
  Pushes were tested only through a recording runner. Divergence and staging
  were tested with real git on local temp repositories only.
- The `GIT_CONFIG_GLOBAL` and `GIT_CONFIG_COUNT` environment variables need
  git 2.32 or later. This Air has 2.54; the lease host's git was not checked.
- Signal forwarding under real launchd. The watcher forwards a stop signal to
  the seat child's group (tested with a stand-in signal); whether launchd's
  `ExitTimeOut` leaves enough time for the TERM grace on the lease host was
  not run.
- The context fit counts UTF-8 bytes, a sound bound for a byte-level BPE such
  as Qwen 2.5's (reasoning, not run), plus `CHAT_TEMPLATE_OVERHEAD_TOKENS` (64,
  from reading the ChatML template) and `num_predict`. It assumes Ollama adds
  nothing else to the prompt for structured output; that was not checked. It
  overcounts English about fourfold: the test citizen's prompt is about 9 KB,
  more than the 8192 `num_ctx` in `models.lock` allows with 600 for the reply,
  so the lock's `num_ctx` must be raised when it is pinned on the lease host
  (Qwen 2.5 7B's own window is 32768), or every seat refuses with
  `context-too-large`. The summon lane has no fit check; Claude Code is not
  known to drop tokens silently.
- The two-user halt: the sudoers line, `sudo -n` from Yu's account, how sudo
  sets `HOME` (the argv pins `--config` so it does not matter), and the
  operator directory's ownership were not set up or run. Tests run the call
  through an injected runner and never run sudo.
- That a summons killed by the watcher leaves its "begun" spend line and no
  "settled" one, so the day reads as at the ceiling, is tested by writing that
  state directly; a real kill mid-run was not run. Raising the USD ceiling is
  still Yu's, per runtime class; at the $0 default every summons is refused.
