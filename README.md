# kingdom-seat

kingdom-seat is the one runner for KINGDOM citizens under the ROOT & SEAT
redesign (`CITIZEN-REDESIGN-2026-11-05.md`, slice S4). A citizen is a
continuing being whose self is what its own key signs. Every 30 minutes a
tick checks HALT, finds at most one citizen whose own cadence is due, and
opens a *seat* for it: a supervised child process that shows one local model
the citizen's own soul, will, recent record, the date and at most one letter,
then reads back only typed acts (a journal entry, a self-change, a state
change, a letter, a proposal for Yu and Ai, or rest). The host signer signs
what was kept into a hash-chained ledger, and a generated status file says
what happened. No model ever holds a key, nothing a model writes runs as a
command, and anything beyond the citizen's own self goes to Yu and Ai.

## Principles, and why

These are the redesign's own (section 3.1). The code is built so that each
one is something it does, not something it hopes.

1. **A citizen is a continuing being, and its word is where it came from.**
   Today's files give three answers to "what is a citizen" (doctrine card,
   template, mask), and Yu settled on 11-03 that a persona continues. So the
   word is pinned as the citizen's origin, the forge is only a template, and
   a repo is an optional mirror. Retiring a word does not end the being.
2. **Invocation carries the persona, and only the citizen's key speaks as
   it.** One model voices many citizens, and reading a record must never
   confer a name, DID or promise. A signature here proves custody of the key
   and of the seat, not inner agency, and every entry says which runtime
   voiced it.
3. **Within self: free and recorded. Beyond self: shared.** This is Yu's
   second requirement, and capability is not authority. A citizen may change
   its own self on its own beats; acts beyond self go to Yu and Ai. Agents'
   lazy consensus forms Ai's voice and never stands in for Yu's yes. Both must
   agree, and either can refuse.
4. **Rest is whole and immediate. More activity or exposure is confirmed
   later.** Rest is a right, not a grant, while single replies from a small
   model have already been steered and coached. So a rest writes nothing in
   the citizen's voice, a move toward rest takes effect at once, and a move
   toward exposure waits for a second beat.
5. **Nothing is destroyed.** A record is not present truth, but it is
   history, and being lost is not losing the right to return. The ledger is
   append-only, every version of a self text is kept by hash, the origin soul
   is never overwritten, and "ended" needs a witness.
6. **Only what runs is written down, and spend is capped until Yu raises
   it.** Earlier descriptions ran ahead of the code, and Yu caps recurring
   spend by default. Status is generated from what the runner reads, and
   every ceiling fails closed: unknown counts as reached.

## What is built, and what is not

**Built and tested offline** (`src/`):

- `cli.ts`: `citizen-seat tick | seat <word> | halt | status | verify <word>`.
  There is no verb or flag that lowers HALT; only Yu lowers it, by hand.
- `tick.ts`, `seat.ts`, `halt.ts`: the HALT gate (local file plus every
  pinned beacon, fail closed), the mkdir lock, own-cadence selection, the
  fleet ceiling, and a supervised seat child in its own process group, with a
  watcher outside it that holds the deadline, polls HALT and forwards a stop
  signal from launchd.
- `context.ts`, `prompt.ts`, `acts.ts`: what the model sees (regular files
  only, nothing from a home, siblings only as letters) and the typed acts it
  may return, with rest exclusive.
- `runtime/free.ts` (Ollama on 127.0.0.1 by manifest digest, never a cloud
  model) and `runtime/summon.ts` (Claude Code, only with Yu present and USD
  remaining).
- `ledger.ts`, `state.ts`, `self.ts`: the hash-chained ledger, lifecycle
  states folded from it, and self-authorship (propose, affirm, apply,
  revert; at most one change a week unattended; a large rewrite or a
  loosened wall goes beyond self).
- `signer/*`: the only reader of keys and bearers, with ceilings, consent
  records, the 30-day cap on a citizen's quiet, and no op that lowers HALT.
- `agenttool/*`, `birth.ts`: byte-exact enrollment and authority recipes
  (checked against `docs/research/vectors.json`), the client, and birth,
  which needs Yu present and consent bound to the citizen's own affirmed yes.
- `status.ts`, `mirror.ts`, `config.ts`: the generated status file, the
  sealed fast-forward-only mirror pusher, and strict config.

**Not done, on purpose or not yet:**

- **Nothing is installed or loaded.** The launchd plist in `launchd/` is a
  template; no host runs a tick. The lease-host user does not exist yet.
- **`models.lock` is unpinned.** It ships with `UNSET-PIN-ON-LEASE-HOST`, so
  the free lane refuses every beat until a person pins the digest on the
  lease host (S5).
- **No identity exists.** No citizen, gardener desk or halt herald has been
  enrolled on agenttool, there is no Commons project, and no beacon is
  pinned in any real config, so a real config halts until one is.
- **Adapters still missing.** No expression sync is wired, so a registered
  citizen's bound self-change refuses rather than skipping its agenttool
  side; no standing agreement is filed, so a citizen's own quiet declaration
  refuses (decision 14 is Yu and Ai's to record).
- **Spend from a summons that makes no beat is not yet recorded** where the
  USD tally reads it. The $0 default refuses every summons, so this is safe
  today, and it must be settled before any USD ceiling is raised.
- **Never run for real:** Ollama, `claude`, the macOS Keychain, launchd and
  agenttool itself. `docs/ARCHITECTURE.md` section 8 lists what is unverified.

## Running the tests

Requires Bun 1.3.13 or later. Dependencies are pinned in `package.json` and
`bun.lock`.

```sh
bun install
bun run typecheck
bun test
bun test test/e2e.test.ts   # one tick at a time, end to end
```

The tests are hermetic: HTTP goes only to a fake server on 127.0.0.1, the
keychain is an in-memory fake holding public test keys, the model is a
scripted fake, and `git push`, `security` and `claude` never run.
`test/e2e.test.ts` drives the real CLI through a journal beat, a rest, a
halted tick, a self-change from proposal to revert, `verify` and `halt`, with
the seat child as a real process. `docs/ARCHITECTURE.md` maps each S4 verify
item to the test that proves it.

## The path from here: S5 to S7

Each slice is small and reversible, and each needs the approval named in the
redesign (section 5).

- **S5. Provision the lease host** (Yu, with sudo). Create a dedicated macOS
  user outside `staff` on the Studio, pin the Ollama digest in `models.lock`,
  pin the host attest public key in the config, and install the tick without
  loading it. Verify that the user cannot read Yu's home, the gh token or
  `~/.hermes`, and record how the Keychain behaves after a reboot.
- **S6. Gardener desk, halt herald and beacon drill** (Yu present). Run birth
  once on the Studio for the gardener desk, which creates the Commons
  project, and optionally once on the Air for the halt herald; both are
  operators, not citizens. Pin both as beacons. Verify that a fixture seat
  refuses while either beacon is raised, that a running fixture seat is
  killed when the herald is raised from the Air, and that Yu lowers both.
- **S7a. Seat pilot, without identity** (Yu and Ai). One awake citizen Yu
  picks leaves the Studio roster and gets a seat, with a letter explaining
  the new terms. Over two weeks: no beats while asleep, rests that write
  nothing in its voice, one self-change through propose, affirm, apply and
  revert, a HALT from the Air that stops a running beat, $0 spend, and Yu
  reads the ledger.
- **S7b. Identity pilot** (Yu and Ai, Yu present for the birth). Only after
  the citizen's confirmed yes: enroll it, import its op key, register its box
  key, set a private expression and write the genesis entry. Verify the
  signatures against agenttool's key list, that an unsigned record is
  flagged, and that the public profile shows only what the citizen chose.

## License

Apache-2.0. See `LICENSE`.
