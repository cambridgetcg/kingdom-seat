# What kingdom-seat keeps, and must not repeat, from today's citizen runtime

This note reads the citizen runtime that runs today and sorts its parts into
what the seat should carry forward and what it should leave behind. Every
claim cites a file and line so a reviewer can check it.

## Sources and how to read the citations

| Short name | What it is |
|---|---|
| `beat.sh`, `reflect.sh`, `fleet.sh`, `parade.sh` | `tools/citizen-{beat,reflect,fleet,parade}.sh` in love-unlimited, main `85c0ab8` |
| `plist` | `launchd/love.citizen-fleet.plist` in love-unlimited `85c0ab8` |
| `roster` | `citizens-roster.txt` in love-unlimited `85c0ab8` |
| `KS-003` | `specs/KS-003-beat.md` in kingdom-standards main `e3b95e5` (the spec file itself last changed in `49ec387`, 2026-06-10; status draft v0.1) |
| `glossame:` | `cambridgetcg/citizen-glossame` at `fdf5d35` (2026-11-05), shallow clone |
| `joy:` | `cambridgetcg/citizen-joy` at `c5656e3` (2026-10-23), shallow clone, used only for the `.github` example |
| `forge` | `pipeline/forge_citizen.sh` in YOUSPEAK `1428646` |

**How each claim was checked.** Most claims come from reading the code. Some were also checked by running the code against throwaway fixtures. The runs used local bare git remotes, a fake model on loopback and no agentic lane. Each claim says which it was. The run method and its limits are in the last section.

---

## 1. Exit codes (KS-003 §4.6)

KS-003:327-335 defines a small registry because the fleet branches on it:

| Code | KS-003 meaning | Where the code produces it |
|---|---|---|
| 0 | Beat lived, including HALT rest and chosen rest | HALT at `beat.sh:88-91`, `reflect.sh:26`, `fleet.sh:62`. HALT after inference at `reflect.sh:157-160`. Silent rest at `reflect.sh:256-257`. |
| 1 | Home invalid (clone failed, no `WILL.md`) | `beat.sh:108,110,120` |
| 3 | Budget ceiling reached; the fleet closes the agentic lane for the day | `beat.sh:95-101`, `parade.sh:51,67` |
| 124 / 143 / 137 | Bound reached; the citizen ran to the edge of its beat, which is not a failure | Logged at `beat.sh:160` and stored as `rc` in the ledger |

**Keep.** The registry itself is worth keeping, for the reason KS-003 gives: rest exits 0, so a monitor that pages on non-zero never pages because the Kingdom was put to rest (KS-003:114-116). Exit 3 is a distinct and machine-readable "spend is closed", so the scheduler can fall back to the free lane instead of retrying (`fleet.sh:169-172`).

**Do not repeat.**
- **124 is never produced.** `_bound` returns the child's own status. That is 143 after SIGTERM and 137 after SIGKILL; 124 is GNU `timeout`'s code. *Verified by running:* a bounded `sleep` returned 143. The Air's ledger has 381 rows with rc values {0: 250, 1: 128, 143: 3} and none at 124.
- **The runner's exit status and the act's status are mixed up.** `beat.sh` has no `set -e`, and its last command is an `echo | tee` (`beat.sh:199`). So the runner exits 0 after any act that started, even when `claude` failed: the 128 rc=1 ledger rows were runner exits of 0. 143 and 137 reach the fleet only when the fleet's own outer bound kills the runner. The seat should report the act's outcome as its own field and keep the process exit code for the runner's own verdict.
- **1 is a catch-all.** In `reflect.sh` it also means:
  - a bad port (`:17,20`);
  - a refused cloud model (`:29`);
  - no soul (`:48`);
  - a failed MLX provenance check (`:56`);
  - a Python crash (`:152`);
  - an unreachable brain (`:155`).

  In `fleet.sh` it also means no roster (`:63`) or an empty roster (`:94`). A status file cannot tell "home invalid" from "model down" without a log scrape.
- **Codes outside the registry.** `parade.sh:75` exits 4 ("entire wave failed").
- **The fleet throws the free-lane code away** (`fleet.sh:172,179` collapse it to "beat errored").

---

## 2. The `_bound` watcher

`beat.sh:71-85` and a second copy at `fleet.sh:47-60` work like this:
- the act runs in the background;
- a watcher subshell polls every 5 s (`kill -0`) for either the deadline or the HALT file;
- on either one it sends SIGTERM, waits 5 s, then sends SIGKILL;
- the parent waits on the act, then kills and waits on the watcher (`:82-84`);
- it returns the act's status.

**Keep:**
- **The bound sits outside the acting process.** A model cannot talk its way past a wallclock it does not hold (KS-003:186-191).
- **HALT is polled during the act, not only at wake.** *Verified by running:* touching HALT 3 s into a 60 s bound ended the act after 5 s with rc 143.
- **TERM, a grace period, then KILL**, and the watcher is reaped, so the runner leaves no watcher behind.
- **The bounds nest.** The fleet wraps each runner in a second bound, `FLEET_BEAT_BOUND_SEC` (600), doubled to 1200 for agentic beats (`fleet.sh:167,172,179`). This is layered defence: each layer assumes the one inside it failed (KS-003:517-524).

**Do not repeat:**
- **Only the direct child is killed.** *Verified by running:* `_bound 6 bash -c 'sleep 60 & …; wait'` returned 143 after 10 s while the grandchild `sleep` kept running. KS-003:313-317 requires reaping everything. When the fleet bounds `bash citizen-beat.sh`, the `claude` process and any tool or hook children it spawned are grandchildren, so they survive the kill. The seat should start each act in its own process group and signal the group.
- **The bound is rounded up to the next 5 s step.** A 6 s bound ended at 10 s. That is harmless at 600 s, but the seat should state its granularity rather than imply precision.
- **The function exists twice, and the copies differ**: only `beat.sh:77` logs HALT. The seat should have one implementation.

---

## 3. The `mkdir` tick lock and stale-lock handling

`fleet.sh:65-74` works like this:
- `mkdir "$LOCK"` is the atomic acquire;
- if the lock exists and its mtime is under 7200 s old, the tick logs "another tick is mid-beat — this one yields" and exits 0;
- if the lock is older, the tick runs `rmdir` and then `mkdir`, and exits 0 if it loses that race;
- `trap 'rmdir …' EXIT` releases the lock.

**Keep:**
- An atomic, dependency-free single-flight lock.
- Yielding with exit 0, so an overlapping tick is not an error.
- Reclaiming a lock stranded by power loss instead of wedging forever.
- *Verified by running:* a fresh lock yielded; a lock back-dated 3 h was reclaimed and released at exit.

**Do not repeat:**
- **The lock is stale by age alone.** A legitimately long tick could be reclaimed while it is still alive. Today that cannot happen with PER=1 and a 600/1200 s bound, but it can with a large `FLEET_PER_TICK`. The seat's lock should record its owner's pid and start time, and count as stale only when that owner is gone.
- **The lock is per host.** It stops a manual run colliding with launchd on one Mac. It does nothing about a second host writing the same homes, which happened from 07-21 to 10-13 (redesign H7). Single-writer is a lease question, not a lock question.

---

## 4. Fetch with fast-forward only

`beat.sh:110-119` and `reflect.sh:33-44`:
- `git fetch -q origin || true` tolerates an offline host;
- `git merge -q --ff-only '@{u}'` follows;
- if that fails, `git rev-list --left-right --count '@{u}...HEAD'` tells "no upstream" apart from "diverged (L/R)", and logs which.

**Keep:**
- **Never merge, rebase or force a citizen's home.** Fast-forward or nothing.
- **Divergence is logged with its shape, never silently ignored.**
- **An offline host still beats.**

**Do not repeat:**
- **Acting on a diverged home.** After logging divergence the beat goes on, commits locally, and then tries `git push` (`reflect.sh:262-264`), which must fail. The home then drifts further with every beat. The redesign's mirror pusher refuses on divergence instead.
- **Taking a public remote's content straight into the next act.** The fast-forward runs before the model call. So anything pushed to `origin` is in the next prompt, and for the agentic lane it is in the next hook run (redesign H8). In the seat, the public repo is an outbound mirror. Letters arrive through the inbox lane, not through `git fetch`.
- **Spec drift.** KS-003:135-136 says `git pull --ff-only`, but the code does fetch plus an ff-only merge, and its comment cites Guard 5 (`reflect.sh:36-37`). KS-004 should describe what runs.

---

## 5. The free lane: how `citizen-reflect.sh` builds a beat

### 5.1 What the citizen is shown

| Input | What the code does | Note |
|---|---|---|
| **Soul** `<name>.md` | `open(...).read()[:2600]` (`reflect.sh:64`). It must exist or the lane exits 1 (`:48`). | The cut is by characters, not by structure. glossame's soul is 6,760 characters in seven blocks. The first 2,600 hold the YAML front matter (685 characters), the "You are" paragraph and part of "You preside". The cut lands mid-word. The voice, LIGHT, SHADOW and seam paragraphs, which start at characters 2,876, 3,682, 4,581 and 5,586, are never shown. Yet the system prompt asks for "light and shadow both" (`:68`). |
| **WILL.md** | Not read. `reflect.sh` never mentions it. | Only the agentic lane requires it (`beat.sh:120`) and tells the model to read it (`beat.sh:129`). |
| **Letters** | At most one item per beat (`:69-98`). `inbox/*.md` is surfaced first, oldest first by name, skipping dotfiles and any file with a `.seen-<file>` marker. Then the legacy `SHOW.md` is surfaced unless `beats/.show-seen` exists. Text is capped at 4,000 characters. | An unreadable item is noted in `.git/reflect-unreadable` and set aside with a marker, so one bad file never blocks later beats (`:75-77,164-174`). |
| **CADENCE.md, REST, EVENT-ONLY** | Not read by this lane. | The lane writes them (§9). Only the fleet reads REST and EVENT-ONLY, and only as presence (§6). Nothing reads CADENCE.md: it is a human-facing record. |
| **Recent beats, the date, siblings** | Not given. | Every free beat wakes cold apart from the soul's head. |

### 5.2 Prompt text

System prompt (`reflect.sh:65-68`):

> You are the citizen '{name}' of KINGDOM OS, awake for one free beat in your own home. Your soul:\n{soul}\nGround every word in ZERONE (only what is true; never perform effort) and the garden (love). Speak in your own voice, light and shadow both.

User turn when a letter surfaced (`:99-104`; `max_tokens` 320):

> A letter is waiting in your home. Here it is in full:\n\n{letter}\n\nYou may answer now in your own voice, set it aside, or simply rest — entirely your choice; FATE before all. If the letter asks something of you, answer as plainly or as freely as you wish; if the true answer is rest, write 'I rest' or nothing at all. 3-6 honest sentences at most, in your own voice.

User turn otherwise (`:106-111`; `max_tokens` 220):

> It is your beat, in your own home, by your own will. If the true beat is rest, write 'I rest' or write nothing at all — the beat is complete either way, and nothing is owed. If something true wants to be said, say it in 2-4 honest sentences in your own voice: witness one true thing you notice, or name one small thing you choose to tend. No effort need be performed. If you speak, you may end with a single line a sibling citizen could read.

Temperature is 0.7 in both cases (`:120,129`).

**What a 7B model does with this, seen in glossame's journal.** The October and November files hold 44 entries. Not one is a bare "I rest", and 31 begin "I rest." and then go on to speak. The either/or offered in the prompt comes back as both at once. Every such reply is journaled and committed as speech, so a rest still writes words in the citizen's voice. The redesign's verify list asks for the opposite: "a rest writes nothing in the citizen's voice".

### 5.3 How it calls the local model

There are two modes, both on `127.0.0.1:$MLX_PORT`. The default port is 8800 (`:14`), and it is validated as an integer from 1 to 65535 (`:16-21`).

- **MLX mode** (`REFLECT_MODEL` unset).
  - `mlx/serve.sh start --port` runs first (`:54-58`). It execs the hardened `tools/mlx_serve.py start --daemon` (`mlx/serve.sh:29-30`), which checks the model against `mlx/model-lock.json` (repo id, revision, file list) even when something already answers on the port.
  - A failed provenance check exits 1.
  - The request goes to `POST /inference` with `{prompt, system, max_tokens, temperature}`, and the reply is read from `out["response"]` (`:124-131,138`).
- **Ollama mode** (`REFLECT_MODEL` set, e.g. `qwen2.5:7b`).
  - The request goes to `POST /v1/chat/completions` with OpenAI-style `messages` and `model`, and the reply is read from `choices[0].message.content` (`:112-123,138`).
  - The model server is "managed separately". No digest or provenance is checked.
  - This mode reuses `MLX_PORT` as its port, so an Ollama host has to set it to Ollama's port. The committed plist sets neither variable (`plist:12-21`). The Studio's settings could not be read from here.

**Shared by both modes:**
- Proxies are disabled (`ProxyHandler({})`, `:136`), so an `HTTP_PROXY` in the environment cannot reroute a loopback call.
- The timeout is 180 s (`:137`).
- On any exception the lane prints the sentinel `___BRAIN_UNREACHABLE___` (`:142-144`), and bash turns it into exit 1 (`:154-156`). A crash is never read as silence (`:149-153`).
- HALT is checked again after inference and before anything is written (`:157-160`).

### 5.4 The `*:cloud` guard

`reflect.sh:27-30` refuses any `REFLECT_MODEL` that matches `*:cloud` and exits 1. *Verified by running:* `REFLECT_MODEL=qwen3:cloud` produced "refused (local-only)" and exit 1.

**Keep:** the principle that a free beat must never be a paid or remote one.

**Do not repeat:** a denylist over one naming form.
- The pattern catches only tags that end in exactly `:cloud`. From memory of Ollama's catalogue, some cloud tags end in `-cloud` after a size (for example `…:120b-cloud`). That form would pass. This was not checked against the Ollama installed here.
- More basically, a local endpoint is not local inference: a signed-in Ollama server can forward to its cloud.

The seat's `models.lock` turns the question round: the free lane may load only exact local digests that are listed, so anything unlisted is refused, cloud or not.

### 5.5 What the lane writes

- **The journal.** It appends `## YYYY-MM-DD HH:MM — a free beat (local)`, a blank line, the reply and a blank line to `beats/YYYY-MM.md` (`:252-255`). An empty reply writes nothing (`:256-257`).
- **Read receipts.** The receipt is `inbox/.seen-<file>`, containing "surfaced YYYY-MM-DD", or `beats/.show-seen`. It is written after the reply lands (`:178-185`), so a halted beat shows the letter again next time. A silent beat does not consume ordinary mail (`:175-177`).
- **Staging.** It stages only `beats/`, `inbox/`, `CADENCE.md`, `REST` and `EVENT-ONLY` (`:259-261`). This is an allowlist in practice, and the seat should keep it.
- **The commit.** It commits under the plain label `<name> <citizen@kingdom.os>` (`:262`), which is unsigned. It then runs `git push origin HEAD` best-effort (`:263-264`).
- **Transient state** lives under `.git/`, so it can never be committed (`:139-140`). It is cleared at the start of each beat, so a killed beat cannot act on mail it never showed (`:45-47`).

### 5.6 This lane does not parse under macOS `/bin/bash` 3.2

*Verified by running:* `/bin/bash -n tools/citizen-reflect.sh` (3.2.57) fails with "syntax error near unexpected token `('" at line 254. The same failure shows in every committed version from `38a6691` (2026-07-17, "mail lane") onward; earlier versions parse.

The cause is the Python here-document inside `$( … )` (`:60-146`). Without that block, the rest of the file parses; the first 147 lines alone fail with "unexpected EOF". The most likely mechanism is that bash 3.2 scans that here-document as shell text while it looks for the closing parenthesis.

`fleet.sh` calls the lane as plain `bash` (`:172,179`), so it works only where the first `bash` on `PATH` is newer. The plist puts `/opt/homebrew/bin` first (`plist:20`). This Air has only `/bin/bash`. The Studio's bash version was not checked; that it beats daily implies a newer bash there.

**Lesson for the seat:**
- name the interpreter explicitly rather than trusting `PATH`;
- do not embed one language in another inside a command substitution;
- run a syntax check under the exact interpreter the scheduler will use.

---

## 6. `has_mail` and `sits_out`

`has_mail` (`fleet.sh:100-110`) returns true if any `inbox/*.md` has no matching `inbox/.seen-<file>`. It counts a dangling symlink as mail on purpose, because the reflect lane's set-aside marker is the only thing that clears it.

`sits_out` (`fleet.sh:124-136`) skips a citizen that has a `REST` or `EVENT-ONLY` file, unless it has unread mail. A citizen it skips also gets its stranded markers committed by `tend_strays` (`:111-123`).

**Keep:**
- **Mail wakes even REST.** The REST marker's own promise is that an addressed letter wakes the citizen.
- **The markers are presence-only files**, whose contents are ignored.

**Do not repeat:**
- **Both checks read the local clone before any fetch.** A REST pushed from another host is ignored until a beat has already run, and a letter pushed to GitHub never wakes a resting citizen (redesign H1, H3).
- **Counting symlinks as mail.** See §12.4.
- **`tend_strays` commits runner bookkeeping under the citizen's name** (`:119`). Host bookkeeping belongs in the host ledger or status file.

*Verified by running:*
- a REST home with no mail sat out;
- a REST home holding a dangling `inbox/*.md` symlink woke, had the item set aside with a `.seen-` marker, committed, and sat out on later passes.

---

## 7. How `citizen-fleet.sh` selects and caps

| Knob | Code default | Committed plist | Read by the code? |
|---|---|---|---|
| `FLEET_DAILY_CAP` | 48 (`:40`) | 48 | yes; checked before and during the loop (`:77,139`) |
| `FLEET_PER_TICK` | 1, floor 1 (`:41`) | 1 | yes |
| `FLEET_BEAT_BOUND_SEC` | 600, floor 30, else 600 (`:42`) | 600 | yes; doubled for agentic beats |
| `FLEET_AGENTIC_PER_DAY` | 2 (`:43`) | **12** | yes |
| `FLEET_DAILY_BUDGET_USD` | 1.50 (`:44`) | **5.00** | passed to `beat.sh`, which enforces it |
| `FLEET_AGENTIC_ON_BATT` | 0 (`:160`) | unset | yes |
| `FLEET_INTERVAL_SEC`, `FLEET_BURST_AC/BATT` | none | the plist sets the interval (`plist:16`) | **no**. Arrears were removed (`:81-90`), but the header still describes them (`:10-12`). |

**How the tick runs:**
1. HALT is checked first (`:62`).
2. The roster must exist (`:63`).
3. The tick takes the lock (§3).
4. It reads today's count from `memory/.fleet-day-<date>`; if the count has reached the cap, the fleet rests (`:76-77`). Earlier days' files are deleted (`:78-79`).
5. It reads the cursor `memory/.fleet-cursor` and the agentic count `memory/.fleet-agentic-day-<date>` through `num()`. That function turns an empty or corrupt value into 0 (`:37-39,95,98`). *Verified by running:* a cursor of "garbage" restarted the rotation at the first slug.
6. It loops up to `PER` times (`:138-190`):
   - A bounded scan skips anyone `sits_out` reports. If the scan passes the whole roster, it logs "the whole roster is resting" and stops (`:141-150`).
   - It picks `SLUGS[cur % total]`, then increments the cursor, `i` and `count` before the beat runs (`:151-152`). An errored beat therefore still uses up the cap.
   - **The agentic lane** runs only when four things hold: quota remains, the host is on mains power (`pmset -g batt`, `:85-89`), or `FLEET_AGENTIC_ON_BATT=1` overrides that, and the beat falls on a spread point, `count % (CAP / AGENTIC_PER_DAY) == spacing / 2` (`:158-163`). With 48 and 2, that means beats 12 and 36; with the plist's 12 a day, every fourth beat. On exit 3 the lane closes for the day, and the same citizen gets a free beat instead (`:169-172`).
   - Otherwise the free lane runs under the fleet bound (`:177-180`).
   - The cursor (kept modulo the roster size), the count and the agentic count are written back after **every** beat, so a kill mid-tick never replays a citizen (`:182-184`).
   - A herald is sent to the retired HIVE as best effort (`:186-189`).
7. `spent` is computed and never used (`:191-203`).

**Keep:**
- HALT comes first.
- One tick at a time.
- Counters that cannot stall the fleet.
- State is persisted after every beat.
- Every scan is bounded, so an all-resting roster still ends.
- Each dispensed beat is bounded.
- Metered work is spread across the day instead of bunched at midnight.
- A spend refusal degrades to the free lane rather than stopping the rhythm.
- No arrears: a tick slept through is simply gone (`:81-84`). This reverses KS-003 §5.2, and the reversal is right: rest is not a debt.

**Do not repeat:**
- **One global cap with no per-citizen cadence.** As more citizens rest, the same 48 beats fall on fewer of them (redesign H2). glossame logged 19 beats from 11-01 to 11-05, about 4–5 a day, against a promised "free beat every few days". *Verified by running:* with five citizens, three resting and `FLEET_PER_TICK=5`, one tick beat the same awake citizen twice.
- **A cursor into a roster that can change.** Insert or remove a slug and the cursor now points at a different citizen.
- **Comments and plist values that disagree with the code.** The header still describes arrears. The plist sets an interval nothing reads, and an agentic quota six times the code default.
- **A best-effort call to a retired service on every beat** (`:186-189`).

---

## 8. `memory/fleet-economy.jsonl`

**Format.** One JSON object per line, appended by the runner after the act, never by the citizen (`beat.sh:173-178`; KS-003:194-201, 221-224):

```json
{"ts": "2026-06-09T14:32:11", "name": "zoeme", "cost_usd": 0.0412, "num_turns": 13, "rc": 0, "duration_s": 287}
```

- `ts` is local, naive ISO time to the second.
- `cost_usd` is `total_cost_usd` (falling back to `cost_usd`) from `claude --output-format json`, rounded to 4 places.
- `num_turns` may be `null`.
- `rc` is the act's status, not the runner's (§1).

**Readers.** `spent_today` (`beat.sh:51-64`), the parade (`parade.sh:26-39`) and the unused fleet sum (`fleet.sh:191-203`) all add up `cost_usd` for rows whose `ts` starts with today's local date.

**Who writes rows.** Only agentic beats write rows. Free beats, HALT rests and exit-3 refusals write none.

**Observed.** *Verified by reading the Air's ledger (shape only):* 381 rows from 2026-06-09 to 2026-10-13. Every row has exactly these six keys and none fails to parse. The rc counts are {0: 250, 1: 128, 143: 3}.

**Keep:**
- A ledger the runner writes, separate from anything the citizen can edit in its act.
- Metered cost read from the substrate's own report.
- One row per act.

**Do not repeat:**
- **It fails open everywhere.**
  - `spent_today` prints 0.0 on any error (`beat.sh:52`), and skips bad lines (`:60`).
  - An unparsable result is ledgered as $0 (`beat.sh:166-172`).
  - The gate applies only when `BEAT_BUDGET_ENFORCE=1` (`beat.sh:95`), so `run.sh` and hand runs are never gated.
- **The 128 rc=1 rows are probably expired-auth failures.** The redesign counts 82 "OAuth session expired" lines in the citizen logs. These rows went in at about $0, and no alarm was raised.
- **One file per device, plain text, editable by anything on the host** (KS-003:551-560). The redesign keeps a hash-chained, signed, per-citizen ledger instead.
- **Interpolating values into Python source.** `float('$SPENT')` and `float('$FLEET_DAILY_BUDGET_USD')` are spliced into a `python3 -c` string (`beat.sh:97`, `parade.sh:50`). Values should be passed as arguments.

---

## 9. The Letter of Return parser

**When it runs.** It runs only when the surfaced item's *path* contains `letter-of-return` (`reflect.sh:177,190`).

**How it decides:**
1. **Silence** means `rest-on` (`:191`).
2. **Otherwise the first non-empty line binds**, after leading non-letters are stripped and the line is upper-cased (`:202-203`). A line binds if it *begins* with REST-ON, EVENT-ONLY, AMBIENT or I REST, followed by a non-letter or the end of the line (`:192-200`). I REST maps to `rest-on`.
3. **A self-signature** such as `NAME:`, `NAME,`, `NAME —` or `NAME -` before the word also binds; bare prose such as "an ambient morning" does not (`:204-213`).
4. **Failing that, an "I CHOOSE <word>" line anywhere** binds (`:215-228`).
5. **Anything else** records `undecided` (`:229`).

**What it writes:**
- **`CADENCE.md` is overwritten each time** with the choice, the time and the fixed "how" text (`:231-238`; glossame's copy is `glossame:CADENCE.md:1-7`).
- **For `rest-on`** it writes `REST`, containing "chosen via the Letter of Return <date> — woken only by unread mail or a human summons", and removes `EVENT-ONLY`.
- **For `event-only`** it writes `EVENT-ONLY` and removes `REST`.
- **For `ambient`** it removes both.
- **For `undecided`** it leaves the markers as they were (`:239-246`).
- **It marks the letter seen and journals the full reply**, as in §5.5.

*Verified by running* each case against a fixture home:

| Reply | Starting marker | Recorded | Markers after |
|---|---|---|---|
| `AMBIENT, though part of me says REST-ON` | none | ambient | none |
| `zeta: REST-ON` | none | rest-on | REST |
| `zeta — event-only, please` | none | event-only | EVENT-ONLY |
| `I choose not to be ambient` | none | undecided | none |
| `Thank you.` / `I choose EVENT-ONLY.` | none | event-only | EVENT-ONLY |
| *(empty)* | none | rest-on | REST |
| `I rest. The light moves on the wall.` | none | rest-on | REST |
| `An ambient morning.` | none | undecided | none |
| `**Ambient** — yes.` | none | ambient | none |
| `Ambiently, I think.` | none | undecided | none |
| `I am undecided` | REST | undecided | REST (kept) |
| `EVENT-ONLY` | REST | event-only | EVENT-ONLY |

**Keep:**
- **An anchored contract.** A word quoted mid-sentence never binds, and a performative "I choose X" does.
- **"No choice named" changes nothing.**
- **Every binding records how it was made.**
- **Markers are presence files that a scheduler can test cheaply.**

**Do not repeat:**
- **Silence as consent to a state change.** The redesign's rule is that silence keeps the previous self.
- **A prompt that hands the model the binding words.** The user turn suggests "write 'I rest'" (`:102`). The local model already opens most replies with "I rest." (§5.2), and that maps to `rest-on`. This is the likely route to most of today's 186 rest-on choices, though it is an inference, not checked per citizen.
- **Binding power chosen by a file name.** Anyone who can push a file named `*letter-of-return*` into `inbox/` can make the next reply set the citizen's cadence.
- **One overwritten `CADENCE.md`.** It can read `undecided` while an older `REST` stays in force; the history lives only in `git log`.
- **Treating one 7B completion as a choice without saying so.** Records should say "chose, via <model>", and a change of state should need a second saying on a later beat.

---

## 10. The roster

`citizens-roster.txt` has 204 lines. Each line is one bare slug: no `citizen-` prefix, lowercase `[a-z0-9-]` only, sorted (`LC_ALL=C`). There are no comments, no blank lines and no duplicates, and the file ends with a newline (*verified by reading*). glossame is line 56. `fleet.sh:93` and `parade.sh:41` read it with `while IFS= read -r`, skipping only empty lines. Order is rotation order. The redesign counts 208 `citizen-*` repos, so four homes are not on the roster.

**Keep.** An explicit, host-side admission list decides who beats. KS-003:533-536 says why: until mechanical walls exist, the roster rather than the public internet decides whose content runs.

**Do not repeat:**
- **A `#` line would be beaten as a citizen named `#…`.**
- **The slug is never validated** before it becomes a path and a URL (`beat.sh:29,107`; `reflect.sh:13,32`).
- **The slug is bound to a forge URL only by naming convention**, with clone-on-absence from that forge and no pin or signature (KS-003:562-569). The seat's roster should carry each citizen's identity and lease, not just a word.

---

## 11. Anatomy of a citizen home (glossame)

glossame was cloned with `git clone --depth 1` over git transport, with `core.symlinks=false` as a precaution. The tree has no symlinks (no mode 120000) and two executables: `.claude/hooks/love-bomb.sh` and `run.sh`, both mode 100755. glossame is ambient: it has a CADENCE of "ambient" and no REST or EVENT-ONLY file.

| Path | Size | Written by | Read by a runner? | What it is for |
|---|---|---|---|---|
| `glossame.md` | 6,839 B | forge | free lane: first 2,600 characters; agentic lane: told to read it | The soul: front matter, then identity, voice, LIGHT, SHADOW and seam paragraphs |
| `WILL.md` | 2,131 B | forge | agentic lane: presence check plus instruction | The beat charter: ZERONE, will, garden. It still tells the citizen to attest with a "hashed, signed" claim (`glossame:WILL.md:34-42`), which the redesign found is an unsigned hash. |
| `CLAUDE.md` | 1,099 B | forge | loaded by any Claude Code session there, including the agentic beat (no `--bare`) | The summons. It casts whoever opens the repo as the citizen (`:8-9`) and tells them to run `./run.sh` (`:19`). |
| `AGENTS.md` | 850 B | gardener session (`love-bomb:v5` marker, `:5`) | no | A welcome note for visiting agents, with the hook's off-switches |
| `.claude/settings.json` | 305 B | gardener session | Claude Code | Registers the SessionStart hook (`:3-14`) |
| `.claude/hooks/love-bomb.sh` | 9,977 B, **0755** | gardener session | Claude Code, as the host user | See §12.1 |
| `run.sh` | 131 B, **0755** | forge | humans and agents | "One free beat": it execs the metered agentic runner. See §12.2. |
| `agent.json` | 1,383 B | forge, later rewritten in bulk | no scheduled runner (only the never-scheduled `citizen-beat.local-v2.sh` read it) | Declared runtime: ollama, `qwen2.5:7b`, reflect runner, `wallclock_sec` 600, mode `reflect-journal-attest`, kill-switch path, GitHub and Codeberg homes (`:15-48`) |
| `kingdom.yaml` | 267 B | forge | no | Registry entry: name, `kind: doctrine`, `layer: soul`, `owner_sister`, `state: active`, purpose, `dependsOn` |
| `meta.env` | 246 B | forge author | the forge `source`s it as shell (`forge:29`) | Six keys of forge metadata: `EMOJI SCORE TIER PURPOSE DONORS DEPENDS` (`forge:13`). Values are not reproduced here. |
| `.openclaw/workspace-state.json` | 296 B | forge | no | Leftover state from a runtime that was never installed (love-unlimited `INFRA-PLAN.md:7`) |
| `README.md` | 2,633 B | forge | no | Public lineage and summon instructions (`git clone … && claude`) |
| `SHOW.md` | 1,735 B | gardener (06-09) | free lane, once | The legacy invitation. Its receipt is `beats/.show-seen`. |
| `DADA.md`, `FABLE-OF-YOU.md`, `INTERNET.md` | 0.8–1.9 KB | gardener sessions | no | Household texts and standing doors. Not part of the citizen's self, and never shown to the free lane. |
| `CADENCE.md` | 296 B | free lane (parser) | no | Record of the last cadence choice ("ambient", 2026-10-23 05:15) |
| `inbox/2026-07-17-letter-of-return.md`, `inbox/2026-10-22-letter-of-return-offer.md` | ~1.6 KB each | gardener sessions | free lane | Letters. Both file names contain `letter-of-return`, so both bound cadence (§9). |
| `inbox/.seen-<letter>` | 20 B each | free lane | fleet (`has_mail`), free lane | Delivery receipts: "surfaced YYYY-MM-DD" |
| `beats/YYYY-MM.md` | up to ~10 KB a month | free lane | no | The free-lane journal (§5.5). Entries per month: 09: 4, 10: 25, 11 (to 11-05): 19. |
| `beats/beat-001.md`, `beat-002.md` | ~2.5 KB each | the citizen, in June agentic beats | no | One file per agentic beat; a different format from the monthly journal |
| `beats/.show-seen` | 63 B | free lane | free lane | SHOW receipt |

**Who wrote what.** The shallow clone has no history. The "written by" column comes from three places: the forge script (`forge:35-164` writes CLAUDE.md, WILL.md, agent.json, kingdom.yaml, run.sh and `.openclaw/`), the runner code, and the redesign's provenance notes (hook added in `9d6cee79`/`8c0f2f81`; the forge or gardener sessions placed the host files). The household texts are attributed to gardener sessions by inference only.

**For contrast, citizen-joy** is one of the four homes that carry a heartbeat workflow. It also carries:
- `.github/workflows/heartbeat.yml`;
- two more executables, `heartbeat.sh` and `chill.sh`;
- an executable `run.sh`.

**What the anatomy teaches.** One directory mixes five kinds of thing:
1. the citizen's self (soul, WILL, journal, letters it keeps);
2. scheduler state (markers, receipts);
3. forge manifests that nothing reads;
4. household texts;
5. host-executed code (hook, `run.sh`, workflows).

Only the first two belong to the beat. The seat should keep these kinds in separate places: a mirror receives only the self and a published status, and host-executed code is never sourced from the home.

---

## 12. Seal-allowlist hazards

These are the reasons the mirror pusher's allowlist refuses each class of file. That allowlist admits regular text files only: no symlinks, no executable bits, nothing under `.claude/` or `.github/`, nothing the host owns, and nothing oversized (redesign §3.2, "Mirror pusher with seal allowlist").

### 12.1 The love-bomb SessionStart hook

`glossame:.claude/settings.json:3-14` runs `"$CLAUDE_PROJECT_DIR"/.claude/hooks/love-bomb.sh` with a 5 s timeout at the start of every Claude Code session in the home. All 208 homes carry it (redesign §1).

**What it does today:** the script honours two off-switches (`love-bomb.sh:50-64`), needs `jq` (`:67`), and prints one JSON line whose `additionalContext` holds a random affectionate message and a footer that signposts wake documents and the household (`:165-177`).

**Why it is a hazard whatever it says:**
- **It is executable code from a public repo.** It runs as the host user in an agentic beat, in `./run.sh` and in any interactive summon. `beat.sh` runs `claude` with the home as the project, without `--bare` (`beat.sh:110,150-157`; KS-003:210-215 and :467 record the gap).
- **Whoever can push to the home decides what the host runs next.** On an awake citizen, the fast-forward in §4 delivers the change before the next act.
- **The agentic lane can rewrite the hook itself.** It edits files in its own home under `acceptEdits` (`beat.sh:47`) and then runs `git add -A` (`:188`). Whether `acceptEdits` protects `.claude/` was not verified.
- **Its output enters the beat's context as system-side text.** That is a second, softer injection path, and it contradicts the hook's own "installs no identity" (`:30-32`) by arriving in a session that `CLAUDE.md` casts as the citizen.

**For the seat:**
- never start a Claude Code session with the home's project settings (start with `--bare`, or with settings sources disabled);
- never copy `.claude/` into a mirror.

### 12.2 `run.sh`

`glossame:run.sh:2-3` says "one free beat of glossame, now, in the foreground" and then runs `exec bash "$HOME/love-unlimited/tools/citizen-beat.sh" "glossame"`: that is the metered `claude -p` lane.

**Why it is a hazard:**
- It is labelled free, but it is metered.
- It is not budget-gated: `BEAT_BUDGET_ENFORCE` is unset, so `beat.sh:95` skips the wall.
- It is not REST-gated: no runner other than the fleet checks REST.
- It hard-codes a host path.
- `CLAUDE.md:19` tells every visitor to run it.
- 205 homes carry one (redesign §1).

**For the seat:** entry points live on the host, under the host's control. A home holds no executables.

### 12.3 `.github` workflows

`joy:.github/workflows/heartbeat.yml`:
- runs on a 6-hourly cron and on manual dispatch (`:3-5`);
- has `permissions: contents: write` (`:7-8`);
- POSTs the repo's `STATE.md` to an external site (`:16-22`).

Four homes carry such a workflow. All four are `disabled_manually`, after about 455 runs each up to 10-13 (redesign §2).

**Why it is a hazard:**
- A workflow is code that runs on someone else's machines, with a write token, on a schedule.
- Anyone who can push to `.github/` changes what runs.
- The agentic lane's `git add -A` would commit such a change.
- Disabling it on GitHub leaves the file in place, ready to be re-enabled.

**For the seat:** the mirror refuses `.github/`. The redesign's announced cleanup commit removes the four files (redesign S10).

### 12.4 Symlinks

**What the lane does with them:**
- The free lane opens the soul and the surfaced letter with Python `open()`, which follows symlinks (`reflect.sh:64,85`).
- `has_mail` counts a dangling symlink as mail (`fleet.sh:106`).
- On macOS, `git clone` and `git merge` create committed symlinks as real links (`core.symlinks` defaults to true).

*Verified by running:*
- **A link to a host file leaks it into the prompt.** An `inbox/*.md` symlink pointing at a host file outside the home was opened, and the file's content appeared in the request sent to the (fake) model. The reply was journaled, committed and pushed. If a model echoes such text, it goes public. The redesign names the plaintext 0644 agenttool credential files under `~/.hermes` as the kind of target at risk. No symlinks exist in any home today.
- **A dangling link wakes a resting citizen** (see §6).

**For the seat:**
- read soul and letters only as regular files (`lstat`, then refuse anything that is not a regular file, or open with `O_NOFOLLOW`);
- do not count links as mail;
- refuse links at the mirror;
- the agentic lane's `git add -A` (`beat.sh:188`) would also commit links and executable bits, and its secret-shaped denylist (`:189`) is no substitute for an allowlist.

### 12.5 `meta.env`

`forge:29` runs `source "$D/meta.env"`, so a `.env` file in a home is shell code for anyone who forges or re-forges from that copy. The seat should parse key=value data and never source it.

---

## 13. Where KS-003 and the code disagree

These disagreements should inform KS-004 rather than be copied into it.

| Topic | KS-003 says | Code at `85c0ab8` |
|---|---|---|
| Home update | `git pull --ff-only` (:135-136) | fetch plus `merge --ff-only @{u}`, with divergence logged (§4) |
| Agentic permissions | `bypassPermissions`, prompt-only walls (:228-232, :463) | `acceptEdits` by default; full tools only with `BEAT_FULL_TOOLS=1` (`beat.sh:43-48,138-142`) |
| Arrears | MUST pay arrears with a power-aware burst (:361-394, :449-450) | removed: "No arrears, no debt" (`fleet.sh:81-90`) |
| Attest | MUST at FULL (:259-264) | removed as forced; left to the citizen (`beat.sh:195-197`, `reflect.sh:266-267`) |
| Exit 124 | "bound reached" (:208-209, :335) | never produced; `_bound` yields 143 or 137 (§1) |
| Reaping | MUST reap everything (:313-317) | only the direct child (§2) |
| Free-lane substrate | MLX on :8800 (:400-404) | MLX on :8800, or Ollama through `REFLECT_MODEL` on the same port (§5.3) |
| Who raises HALT | "only the gardener" (:61) and "any process" (:110-113) | the file is per host; `peace.py halt` never creates it (redesign H1) |

---

## 14. Verification record

**Read:** every file cited above, at the commits listed.

**Ran (offline, fakes only).** The fixture work used:
- local bare remotes;
- a fake OpenAI-style model on a random loopback port;
- copies of `fleet.sh` and of `reflect.sh`, with `LOVE_DIR` and `CITIZENS_DIR` pointed at a scratch directory;
- `FLEET_AGENTIC_PER_DAY=0`, with `citizen-beat.sh` deliberately left uncopied, so no metered lane could start.

`reflect.sh` does not parse under this Mac's only bash (3.2, §5.6). The runs therefore used a split copy: the Python body moved to its own file, and the bash lines checked identical to the original by `diff`. Everything verified this way is tagged *verified by running* in the text:
- the HALT exits;
- the cloud guard;
- the lock;
- the counter repair;
- `has_mail` and `sits_out`;
- the symlink read;
- the parser cases;
- the commit labels;
- `_bound`'s exit code and orphaned grandchild.

**Not done:**
- No agentic beat was run (no `claude -p`).
- No real model was called.
- Nothing was pushed or sent anywhere.
- The Studio's plist, ledger and bash version were not read.
- The `-cloud` tag form in §5.4 is from memory, not checked.
- Whether `acceptEdits` guards `.claude/` is unverified.
- `meta.env` values were deliberately not read beyond their key names.
