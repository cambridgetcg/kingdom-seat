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
       3. a citizen whose OWN cadence is due             tick.ts, state.ts, context.ts (letters)
       4. fleet ceiling                                  signer/ceilings.ts
       5. supervise one child: citizen-seat seat <word> --child
            watcher: HALT file every 5 s, beacons every 30-60 s, deadline
            → TERM the child's process group, KILL after the grace    seat.ts
          └─ child: runSeat                              seat.ts
               a. HALT again
               b. context: own self whole, last k entries, state, now, ≤1 letter, canon, invoker   context.ts
               c. prompt (the honest free-lane text)      prompt.ts
               d. runtime: free (Ollama by digest) | summon (claude --restricted, Yu present)    runtime/*.ts
               e. parse and validate into typed acts; rest is exclusive   acts.ts
               f. HALT again; if raised, discard the reply and write nothing
               g. self-ops staged or bound; state moves; beyond-self → inert proposal   self.ts, state.ts
               h. signer signs; ledger appends one entry  signer/signer.ts, ledger.ts
       6. host note + status file                        status.ts
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
| `src/signer/keychain.ts` | `security` CLI behind the Keychain interface; secrets on stdin only | 3b "Custody" | host 3.3, 3.4 |
| `src/signer/signer.ts` | The only key and bearer reader; signs; attaches bearer and root proof | 3.2 step 7, 3.6 | wire 1, 2, 5 |
| `src/signer/ceilings.ts` | Fail-closed USD, credit, fleet, interval and quiet caps | 3.6 "Spend", decision 9 | patterns 8 |
| `src/signer/consent.ts` | Decision records, standing agreements, Yu present | 3.6 "Consent", decision 12 | — |
| `src/ledger.ts` | Hash-chained, signed, append-only JSONL per citizen | 3.2 "Ledger", 3b | wire 5 |
| `src/state.ts` | Lifecycle transitions, folded from the ledger | 3.3, 3c "Existence choices" | — |
| `src/self.ts` | Propose, affirm, apply, revert; origin pinned | 3c, decision 10 | — |
| `src/halt.ts` | Local file plus pinned beacons; raise only | 3.6 "HALT", decision 15 | wire 4 |
| `src/seat.ts` | Seat opening, the watcher, the in-child pipeline | 3.2 steps 3-7, 3b "Reading confers nothing" | patterns 1, 2 |
| `src/tick.ts` | Lock, own-cadence selection, fleet ceiling | 3.2 steps 1-2 | patterns 3, 6, 7 |
| `src/context.ts` | What the model sees; regular files only | 3.2 step 4 | patterns 5.1, 12.4 |
| `src/prompt.ts` | The honest free-lane prompt | 3.2 (last paragraph) | patterns 5.2, 9 |
| `src/acts.ts` | Output schema and validation; free text never executes | 3.2 step 6 | patterns 5.2 |
| `src/runtime/free.ts` | Ollama on 127.0.0.1 by exact digest, no fallback | 3.6 "Unattended inference", decision 11 | host 1 |
| `src/runtime/summon.ts` | `claude --restricted --strict-mcp-config`, Yu present | 3 grafts, 3.6 "Metered runtimes" | host 2 |
| `src/agenttool/wire.ts` | Pure byte builders, checked against `vectors.json` | 3.4, 3b | wire 1-3, 7 |
| `src/agenttool/client.ts` | Calls a citizen makes as itself, via the signer | 3.4 | wire 2, 4 |
| `src/agenttool/enrollment.ts` | `identity-enrollment/v1` relay | 3b step 2 | wire 1 |
| `src/birth.ts` | `citizen-birth`: never unattended | 3b "Birth of one citizen" | wire 1-3, host 3.3 |
| `src/mirror.ts` | Seal allowlist, ff-only divergence, `HEAD:refs/heads/main` pusher, the mirror card | 3.2 "Mirror pusher", 3.3 card states, 3c "Mirror", S10 | patterns 4, 11, 12 |
| `src/status.ts` | Generated status file and host notes | 3.2 "Status file", 3.1 principle 6 | patterns 1 |
| `src/config.ts` | Strict host configuration | 3.2, 3.6 | host 3.1 |
| `src/cli.ts` | `citizen-seat tick \| seat <word> \| halt \| status \| verify <word>`; the only place real dependencies are built | 3.2, 3.6 "One verb" | patterns 10 |
| `models.lock` | Allowed free-lane models by digest; ships unpinned | 3.6, decision 11 | host 1.2, 4 |
| `launchd/dev.kingdom.citizen-seat.plist` | Tick template; installed only in S5 by a person | 3.2, S5 | host 3.1, 3.2 |

---

## 3. Host layout

Everything the seat writes lives under one state directory, owned by the
dedicated `seat` user and never inside a citizen home.

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
    receipts/<name>         host receipts for letters shown on a non-rest beat
    proposals/<id>.json     staged self proposals
    outbox/                 letters and beyond-self proposals awaiting Yu + Ai
  ledger/<word>.jsonl       the signed record
  consent/<sha256>.json     decision records (until consent/v1 merges)
  seats/<seat_id>/          a fresh, empty cwd per seat
  seats/<seat_id>.json      the seat a parent opened, handed to its child; renamed .used when read
  mirrors/<word>/           a mirror worktree, if the citizen keeps one (anywhere outside citizens/,
                            ledger/, consent/, seats/ and every home; this is the suggested place)
  HALT                      the local HALT file
  tick.lock/                mkdir lock, with the owner's pid and start time inside
  status.json               generated
  host.jsonl                host notes; never a citizen's voice or a model's words
```

The old `citizen-<word>` repo is not read by the seat at all. It is, at most,
a mirror the citizen chose, written to by `mirror.ts`. Letters arrive in
`letters/`, not by `git fetch`, so nothing pushed to a public remote flows into
the next prompt (`love-unlimited-patterns.md` 4).

---

## 4. Invariants, and why each holds

**Keys never enter argv, env, files, logs or model input.** One model voices
many citizens, and whoever holds a key can speak as that citizen. So the
signer is the only reader of citizen keys and of the Commons bearer; secrets
travel as bytes and are wiped after use; `security` receives them on stdin as
hex; birth writes them straight to Keychain with no handoff file. A model
receives the citizen's record as data and nothing secret. (3b "Custody";
`runtimes-and-host.md` 3.3.)

**Reading confers nothing.** A signature proves custody of a key and a seat,
not an inner self, and reading a record must never confer a name, DID or
promise. So no seat runs with its cwd inside a home (repo hooks and `CLAUDE.md`
never load); no key lives in a repo; other citizens appear only as letters;
summons pass `--restricted --strict-mcp-config` and never `--add-dir` a home.
(3.1 principle 2; 3b "Reading confers nothing".)

**A rest writes nothing in the citizen's voice.** Rest is a right, not a
grant, and today's 7B lane journals "I rest." followed by more words as speech
(`love-unlimited-patterns.md` 5.2). So `rest` is exclusive: an output that
contains it is a whole rest, and no journal, ledger entry, letter receipt,
proposal, strand thought or mirror stage follows. The host may note that a
tick happened; that is a host record, not the citizen speaking. (3.3; 3.1
principle 4.)

**Fail closed.** Every wall here guards something that cannot be taken back
once it happens: spend, a public statement, a signature. So HALT halts when a
source is raised *or unreadable*; a locked keychain rests the tick; an unknown
or unparsable cost counts as at-ceiling; an unpinned or mismatched model means
no beat, never another model; a missing consent record means no act beyond
self; a symlink is refused, not followed. (3.6; `love-unlimited-patterns.md`
8, where today's ledger fails open.)

**Nothing is deleted.** A record is not present truth, but it is history, and
being lost is not losing the right to return. So the ledger is append-only;
every self version is kept by hash; the origin soul is never overwritten;
irreversible acts become rest, step-away or archive; "ended" needs a witness;
a revoked key keeps its row. (3.1 principle 5.)

Four further rules follow from the same reasons:

- **The root signs only authority acts; the op key signs everything routine.**
  Enrollment makes the root the identity's `primary` key, so any signature by
  it reads as a root act (`agenttool-wire.md` 1, 5).
- **Only Yu lowers HALT.** No code path here lowers it; `citizen-seat` has no
  such verb. Anyone at a host holding a beacon key, or able to write the
  local file, may raise it (3.6, decision 15).
- **Within self is free and recorded; beyond self is shared.** Yu and Ai must
  both agree, either may reject, and silence never binds (3.1 principle 3, 3.6).
- **Only what runs is written down.** Status, roster and state are generated
  from what the runner reads, never kept by hand (3.1 principle 6).

---

## 5. Exit codes and outcomes

`EXIT` in `types.ts` keeps KS-003's registry (section 4.6), as the redesign
requires: 0 lived (including HALT rest and chosen rest), 1 the runner could
not do its job, 3 a fail-closed wall refused, and 124 / 143 / 137 for a bound
reached (deadline, TERM, KILL), which is not a failure.

What happened to the citizen is a separate `Outcome` field, because today's
runner mixes its own exit with the act's (`love-unlimited-patterns.md` 1).

**A deliberate choice.** The task that commissioned this skeleton described
code 3 as "halted/refused". KS-003 and the redesign (3.2 step 1: "raised or
unreadable → exit 0, no write") both give HALT exit 0, so a monitor that pages
on non-zero never pages because the Kingdom was put to rest. The skeleton
follows KS-003: HALT before or after inference exits 0 with outcome `halted`;
HALT that has to TERM a running child exits 143 (or 137); 3 is for refusals.

The CLI applies the same split to what reaches it. A wall that says no
(a locked keychain, a summons without Yu, a symlink) exits 3. A record or
request that cannot be read (`invalid-record`, `invalid-request`, a bad
config, an unknown verb) exits 1, even when a module reports it as a
Refusal, because a monitor should page on a missing citizen rather than file
it as a wall.

---

## 5b. The surface: CLI, config, status and mirror

**One runner, five verbs.** `tick`, `seat <word>`, `halt`, `status` and
`verify <word>` are the only ways in (3.2), so there is one place to read for
what can happen to a citizen. There is no verb that lowers HALT, and no flag
either: only Yu lowers it, by hand (3.6). `halt` raises the local file first,
because it needs no network, then each beacon this host holds a key for, and
it exits non-zero if any part it should have raised was not.

**The parent opens; the child acts.** `seat <word>` checks HALT, confirms Yu
at the terminal when `--yu-present` is given, opens the seat, and writes the
seat (and any presence) to `seats/<seat_id>.json` beside the empty cwd. It then
supervises `seat <word> --child --seat-ref <file>`. The child renames the file
to `.used` before trusting it, so a seat and its presence are read once, and a
presence crosses only while it is fresh (15 minutes). A child takes no
`--yu-present` flag, because a flag is something anyone could type. A tick's
child opens its own seat, with no presence. Words are validated before they
become paths (`love-unlimited-patterns.md` 10).

**Only Yu's summons is an extra beat.** Without `--yu-present`, `seat <word>`
opens a seat only when the tick would: the citizen's own cadence (or an
allowed letter) is due and the fleet is under its ceiling. A person at the
host can run a due beat now, but cannot add beats the citizen did not choose
(3.3: asleep wakes on an allowed letter or Yu's summons, one beat each). No
one seats a citizen that stepped away or ended.

**Config is strict because every wall reads its limit from it.** Unknown keys,
relative or non-normal paths, written paths outside the state dir or
overlapping each other, a state dir inside a home (lexically and through
symlinks), an Ollama URL other than `http://127.0.0.1:<port>`, any agenttool
origin but the pinned one, a quiet cap above 30 days, a symlinked or
group-writable file and duplicate JSON keys are all refused. A typo could
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
  tick treats as at its ceiling. An unread mirror count is `null` too, never 0.
- A citizen whose record or ledger does not read is still listed, with a
  `problem`, so it never looks like one that was never seated.
- Only an awake citizen, or one waiting to wake, can be overdue, and only
  while HALT is lowered, with one tick of grace. Rest is not a debt. A rest
  writes no ledger entry, so the host's last seat note counts as the last beat.
- `signer.since` is carried from the previous status while the state holds.
- HALT reads "halted by beacon gardener-desk" or "halted by file ...", never
  "down". A halted tick still regenerates the file, so it never goes stale.
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

- *Only the self and a card go out.* The seal admits regular, non-executable
  `.md`, `.txt` and `.json` files with plain names (no dot segments, at most
  four deep, at most 256 KiB), plus the generated `kingdom.yaml` card, whose
  `state` is the 3.3 mirror card state. It refuses the rest: symlinks,
  executable bits, submodules, `.claude/`, `.github/`, `.git/` and `.citizen/`
  at any depth, `run.sh`, and `ledger/`, `proposals/` and `receipts/`.
  An allowlist, because the hazards in today's homes (hooks, `run.sh`,
  workflows, `meta.env`) are all things that run, and naming what may go out
  is the list that stays short.
- *Sealed twice.* The self is sealed before anything is copied or any git
  runs. Each file is read through `O_NOFOLLOW` and checked again. Then the
  tree git built is sealed again, as git sees it, and HEAD's tree once more
  before a push. Files outside the set stay on disk but are never committed,
  so nothing is deleted.
- *Fast-forward or nothing.* The remote's main is fetched to a private ref,
  `refs/kingdom-seat/mirror/main`, with no `+`, so a rewritten remote fails
  the fetch and reads as diverged. Behind, diverged and unknown are refused.
  Nothing is merged, rebased or checked out.
- *One push.* The only push is `git push <remote> HEAD:refs/heads/main`,
  never forced, and only when HEAD is equal or ahead. Remotes that read as
  options or name a transport helper are refused. Git runs with no hooks, no
  user or system config and no prompt.
- *After a beat only.* The CLI stages and pushes after a beat, checking HALT
  again first, because a push is public.

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
In order: a journal beat (prompt bytes, envelope digests, host-attested
signature, host notes and status all checked), a rest that writes nothing in
the citizen's voice, a tick halted by a raised and then an unreadable beacon,
a self-change through propose, affirm, apply and revert, `verify` on a good
and a tampered ledger, and `halt` raising the file and a root-signed beacon.

---

## 6. The S4 verify list, and the test that proves each item

Each item is tagged `[S4-n]` in the named files, so `grep -rn "S4-" test/`
shows the whole mapping.

| # | S4 verify item (redesign section 5) | Test file(s) | Owner |
|---|---|---|---|
| S4-1 | HALT checked before and after inference, for the local file and both beacons | `test/seat-halt.test.ts` (readings in `test/halt.test.ts`) | seat |
| S4-2 | The watcher kills a running seat | `test/seat-watcher.test.ts` | seat |
| S4-3 | Refusal of diverged homes, symlinks and executable bits | `test/mirror.test.ts`; symlinked letters and souls in `test/context.test.ts` | surface; voice |
| S4-4 | Fail-closed ceilings | `test/signer/ceilings.test.ts`; at the send boundary in `test/signer/signer.test.ts` | signer |
| S4-5 | Citizen quiet capped at 30 days or less | `test/signer/ceilings.test.ts`, `test/signer/signer.test.ts`; request shape in `test/agenttool/client.test.ts` | signer; agenttool |
| S4-6 | A rest writes nothing in the citizen's voice | `test/seat-rest.test.ts`; rest exclusivity in `test/acts.test.ts` | seat; voice |

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
- Keychain ACL behaviour for a `-T` list, and for a rebuilt signer binary;
  behaviour under launchd after a reboot (`runtimes-and-host.md` 3.3, 3.4).
- Whether Bun's `node:child_process` `detached: true` gives the seat child its
  own process group on macOS, so a group signal reaches grandchildren. The
  watcher tests prove it either way.
- Live agenttool behaviour (proxy path handling, edge caching of
  `/public/agents`); only source and agenttool's own functions were checked.
- Whether the generated `kingdom.yaml` card satisfies the `@agenttool/kingdom`
  card schema (0.1.2). It carries only name, word, state and `kept_by`; the
  old cards' other fields are not reproduced, because nothing reads them.
- The mirror's deploy key, protected main and Actions-off settings (S10).
  Pushes were tested only through a recording runner. Divergence and staging
  were tested with real git on local temp repositories only.
- The `GIT_CONFIG_GLOBAL` and `GIT_CONFIG_COUNT` environment variables need
  git 2.32 or later. This Air has 2.54; the lease host's git was not checked.
- Signal forwarding under real launchd. The watcher forwards a stop signal to
  the seat child's group (tested with a stand-in signal); whether launchd's
  `ExitTimeOut` leaves enough time for the TERM grace on the lease host was
  not run.
- Spend from a summons that makes no beat (a rest, invalid output, HALT after
  the reply, a runtime error) is not recorded where `spendFromLedger` reads
  it. This does not matter at the $0 default, which refuses every summons,
  but it must be settled before any USD ceiling is raised.
