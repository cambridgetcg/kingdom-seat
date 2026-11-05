# Runtimes and host: facts for kingdom-seat's adapters and setup

Checked on 2026-11-05 on the Air (macOS 26.6.2, build 25G83), which has:

- Ollama 0.40.14 from Homebrew. The formula pins tag `v0.40.14` at commit `9a3e8177767245acc62b735eba7d5d8a553606d0`.
- Claude Code 2.1.314 (`~/.local/share/claude/versions/2.1.314`).

The Mac Studio, the proposed lease host, was not examined. Its Ollama version, model store and settings may differ, and every Ollama fact below should be re-checked there before the seat trusts it.

Each fact says what it rests on:

- **[ran]**: verified by running a local, read-only command on this Air.
- **[read]**: read in source or docs at the installed version, but not exercised. For Ollama this means a shallow, sparse clone of `v0.40.14` (same commit as the formula). For Claude Code it means the schemas and help text inside the installed 2.1.314 binary.
- **[man]**: read in the man page installed on this Air (dates in section 5).
- **[not verified]**: inference or general knowledge, with the reason it could not be checked.

Nothing here pulled or ran a model, called `claude -p`, read or wrote a Keychain item, or loaded a launchd job.

---

## 1. Ollama's local HTTP API (0.40.14)

### 1.1 What is on this Air

- `ollama serve` listens on `127.0.0.1:11434` only (`lsof`), and `GET /api/version` returns `{"version":"0.40.14"}`. [ran]
- It runs as the logged-in user from Homebrew's service plist, `sh.brew.ollama`. The plist sets `OLLAMA_FLASH_ATTENTION=1`, `OLLAMA_KV_CACHE_TYPE=q8_0`, `KeepAlive` and `RunAtLoad`, and logs to `/opt/homebrew/var/log/ollama.log`. [read: the plist in the Cellar]
- The only model is `kimi-k2.7-code:cloud`, a cloud stub. [ran]
- The server log says `Ollama cloud disabled: false`, and there is no `~/.ollama/server.json`. [ran] So the one model here forwards to ollama.com.
- No Ollama API docs ship in the Homebrew package (only a README), so the API facts below come from `docs/api.md`, `docs/faq.mdx`, `docs/capabilities/structured-outputs.mdx`, `api/types.go` and `server/*.go` at `v0.40.14`.

### 1.2 Where a model's digest lives

**`GET /api/tags` is the place to read it.** Each row has `digest`, the full 64-hex SHA-256 of the model's manifest bytes (`server/model_list.go`, `describeModelFromManifest`). [read]

This was checked against the store on this Air. [ran]

- `ollama list` shows the ID `eda07a659237`.
- `/api/tags` shows `digest: eda07a6592375dcbde7cf167b6d6b368cdd28e244f9d71559fb59919aca882fa`.
- `shasum -a 256` of the manifest file `~/.ollama/models/manifests/registry.ollama.ai/library/kimi-k2.7-code/cloud` gives the same value.

So the list ID is the first 12 hex characters of the manifest digest.

**Why the manifest digest is the right pin.** The manifest names the config blob and every layer blob by digest. So one manifest digest fixes the weights, template, parameters and system prompt together. Any change to any of them gives a different manifest and a different digest. [read: `manifest/manifest.go`]

**Manifest lists.** 0.40 adds them (`ollama create --combine`, media type `application/vnd.ollama.manifest.list.v2+json`), with one child per runner (for example llama.cpp and MLX).

- For a list, the `/api/tags` row carries the *selected child's* digest, and `details.runner` names the runner (`describeModelRows`). [read]
- Requests take an optional `runner` field to pick a child.
- So `models.lock` should record the runner as well as the digest. Otherwise the same tag could legitimately resolve to another child.

**`POST /api/show` does not give the digest of a plain model.** `ShowResponse` has `details`, `model_info`, `capabilities`, `template`, `parameters`, `modified_at`, `remote_model` and `remote_host`, but no top-level digest. [read]

- It lists child digests in `manifests[]` only for a manifest list with two or more children (`server/show_manifest.go`).
- Use `show` to inspect a model, not to identify it.

**`GET /api/ps`** lists loaded models with `digest` (the manifest digest, falling back to the model digest), `expires_at`, `size_vram`, `context_length` and `runner` (`PsHandler`). [read] Nothing was loaded here, so this was not exercised.

**Calling a model by digest.** The `model` field may be a digest reference instead of a name: `sha256:<64 hex>`, `sha256-<64 hex>`, or a 12-to-64-hex prefix (`server/model_resolver.go`, `manifest/paths.go:ResolveDigestReference`). [read]

- It resolves only to a manifest stored as a content-addressed blob. That is the new "v2" store: `manifests-v2/` links to `blobs/sha256-<digest>`, and the server re-hashes the blob when it opens it.
- Models in the legacy store (regular files under `manifests/`) cannot be called by digest. This Air's only model is legacy.
- Pulls in 0.40 write the v2 form (`WriteManifestData`). The code that migrates legacy entries, `MigrateManifestLinks`, is "currently unwired".
- So whether the Studio's `qwen2.5:7b` can be called by digest depends on when it was pulled. That is [not verified], and it is cheap to check there with `ls ~/.ollama/models/manifests-v2`.

### 1.3 How cloud models appear, and why a name check is not enough

The local row for the cloud stub, verbatim from `/api/tags`: [ran]

```json
{
  "name": "kimi-k2.7-code:cloud",
  "model": "kimi-k2.7-code:cloud",
  "remote_model": "kimi-k2.7-code",
  "remote_host": "https://ollama.com:443",
  "size": 388,
  "digest": "eda07a6592375dcbde7cf167b6d6b368cdd28e244f9d71559fb59919aca882fa",
  "details": { "format": "", "family": "kimi", "parameter_size": "1t",
               "quantization_level": "int4", "context_length": 262144, "...": "..." },
  "capabilities": ["vision", "thinking", "completion", "tools"]
}
```

What gives the stub away:

- Its manifest has `"layers": null`, and its 388-byte config blob holds `remote_host` and `remote_model`. [ran]
- So `size` is the config's size, and `format` is empty.

There are three ways a request reaches the cloud. All three are in `server/routes.go` and `internal/modelref/modelref.go`. [read]

1. **A cloud-looking name.** A model string ending in `:cloud`, or in `:<tag>-cloud`, counts as an explicit cloud source.
   - Chat, generate and show then go straight to `https://ollama.com:443`, and no local stub is needed at all.
   - The `-cloud` form is real in 0.40.14. `NormalizePullName` turns `gpt-oss:20b:cloud` into the legacy tag `gpt-oss:20b-cloud`.
   - This settles the open question in the redesign (section 7) and in `love-unlimited-patterns.md` section 5.4: the live `*:cloud` glob misses the `-cloud` form.
2. **A local stub under any name.** `POST /api/create` with `from: "<x>:cloud"`, or with `remote_host` set, writes a local model whose config carries `remote_host` (`server/create.go`). It can have any name, for example `qwen2.5:7b`. Calling that name forwards to the cloud.
3. **The OpenAI- and Anthropic-compatible routes** (`/v1/chat/completions`, `/v1/messages`, `/v1/responses`) wrap the same handlers with a cloud passthrough. Their reply shapes do not carry `remote_host`.

Three properties of the server matter here:

- **The caller needs no credential.** The server signs forwarded requests with its own ollama.com sign-in (`server/cloud_proxy.go`, `signCloudProxyRequest`). The loopback API has no authentication. So any local process, under any macOS user, can spend the serving user's cloud allowance or create a stub. [read]
- **A `:local` suffix refuses stubs.** For a name like `qwen2.5:7b:local`, chat and generate return 404 when the resolved model has `remote_host` (`routes.go`, `modelRef.Source == modelSourceLocal`). [read]
- **Forwarded replies are marked.** Chat and generate replies that were forwarded carry `remote_model` and `remote_host`. A local reply never does. [read]

**The server-wide off switch.** Set `OLLAMA_NO_CLOUD=1` in the server's environment, or `{"disable_ollama_cloud": true}` in `~/.ollama/server.json` of the user who runs `ollama serve`, then restart.

- After that, every cloud path answers 403 with `"ollama cloud is disabled: remote model is unavailable"`. That covers explicit names, stubs and passthrough routes (`proxyCloudRequestWithPath`, `ChatHandler`). [read]
- The log then shows `Ollama cloud disabled: true` at startup. [read: `docs/faq.mdx`; the `false` form was seen in the log, ran]
- `OLLAMA_REMOTES` (default `ollama.com`) limits which hosts a stub may forward to.
- The switch is per server. On a host where Yu also uses cloud models through the same server, it would turn those off too. That is Yu's call for the Studio.

**Consequences for the free lane.** Refusal should rest on content, not on names.

1. **Before the call:** read `/api/tags`. Accept only a row whose `name` and full `digest` (and `details.runner`, if set) equal the `models.lock` entry, and whose `remote_host` and `remote_model` are empty.
2. **The call:** use the native `/api/chat` or `/api/generate`, not the `/v1/*` routes, because only the native replies mark forwarding.
   - Address the model as `<name>:local`, so the server itself refuses a stub that appears between the check and the call.
   - Where the store is v2, prefer `sha256:<digest>:local`, which also closes that window for a re-pulled tag.
   - The combined digest-plus-`:local` form is [read], not exercised.
3. **After the call:** reject any reply that has `remote_host` or `remote_model`.
4. **On the host:** turn cloud off on the server the seat uses. A second layer costs nothing here, because the free lane never wants the cloud.
5. **No fallback.** A mismatch at any step means no beat, not a different model.

### 1.4 Request shapes

`POST /api/chat`, non-streaming, with the fields the free lane needs (`api/types.go`, `ChatRequest`): [read]

```json
{
  "model": "qwen2.5:7b:local",
  "messages": [
    {"role": "system", "content": "..."},
    {"role": "user", "content": "..."}
  ],
  "stream": false,
  "format": { "type": "object", "properties": { "...": {} }, "required": ["..."] },
  "options": { "temperature": 0.7, "num_ctx": 8192, "num_predict": 600, "seed": 42 },
  "keep_alive": "2m",
  "think": false
}
```

- **Other `ChatRequest` fields:** `tools`, `runner`, `truncate`, `shift`, `logprobs` and `top_logprobs`.
- **Message fields:** `role` (`system`, `user`, `assistant`, `tool`), `content`, `thinking`, `images`, `tool_calls` and `tool_name`.
- **`think`** only matters for thinking models. It may be a boolean or a level.
- **`POST /api/generate`** takes `prompt`, `system`, `suffix`, `template`, `raw`, `images`, `format`, `options`, `keep_alive` and `think`. The `context` field is deprecated.
- **The free lane should send no `tools`.** It then has nothing to call, and that is the property the seat wants.

### 1.5 Response shapes

Non-streaming chat returns one object (`ChatResponse`): [read]

```json
{
  "model": "...", "created_at": "...",
  "message": { "role": "assistant", "content": "...", "thinking": "..." },
  "done": true, "done_reason": "stop",
  "total_duration": 0, "load_duration": 0,
  "prompt_eval_count": 0, "prompt_eval_cached_count": 0, "prompt_eval_duration": 0,
  "eval_count": 0, "eval_duration": 0
}
```

- **Durations are in nanoseconds.** Generate returns `response` (plus `thinking`, `context` and `tool_calls`) in place of `message`.
- **`done_reason`** is `stop` when the model finished and `length` when `num_predict` or the context ran out. On a `length` result, structured output may be cut off mid-object.
- **Streaming** (the default) sends NDJSON chunks with `done:false`, then a final chunk with the metrics.
- **Errors** are `{"error": "..."}` with 400, 404, 429, 500 or 502 (`docs/api/errors.mdx`). A full queue gives 503 (`docs/faq.mdx`), and a disabled cloud gives 403.
- **An error mid-stream** arrives as an `{"error": ...}` line under the 200 status already sent. A streaming client must check every line, not only the status.

### 1.6 Options

| Option | What it does in 0.40.14 | Notes for the seat |
|---|---|---|
| `temperature` | Default 0.8 (`DefaultOptions`). [read] | Record the value used in the ledger envelope. |
| `num_ctx` | A *runner* option, applied when the model loads. If a call asks for a different value, the model is reloaded. [read] | Pick one value per locked model and keep it in `models.lock`. Without it the default is `OLLAMA_CONTEXT_LENGTH`, or 4k/32k/256k by VRAM according to the installed `ollama serve --help` [ran]. The FAQ text still says 4096, which is older. |
| `num_predict` | Default `-1`, meaning no limit. [read] | Always set it. It is the only output bound the server enforces. |
| `seed` | Default `-1`, meaning random. [read] | Set it if a beat should be reproducible. |
| `stop` | A list of strings. [read] | Optional. |
| `keep_alive` | A duration string (`"10m"`), a number of seconds, a negative value (keep loaded) or `0` (unload after the reply). The default is 5 minutes, or `OLLAMA_KEEP_ALIVE`. A request value overrides the server setting. [read: `Duration.UnmarshalJSON`, FAQ] | A tick every 30 minutes gains nothing from staying loaded. Use `0`, or a short value if the adapter checks `/api/ps` after the call. |

### 1.7 Structured JSON output

- **`format: "json"`** constrains the output to well-formed JSON. The docs say to ask for JSON in the prompt as well, or the model "may generate large amounts of whitespace". [read]
- **`format: { JSON schema }`** constrains the output to that schema. The docs suggest also putting the schema in the prompt. [read]
- **Ollama's cloud does not support structured outputs** (note in `structured-outputs.mdx`). That is one more reason the typed free lane and the cloud do not mix. [read]
- **Always validate the parsed result in the seat.** A `length` stop can still truncate it. Whether the MLX runner honours `format` as fully as llama.cpp does was [not verified]; check `details.runner` for the locked model.

### 1.8 Timeouts

- **Generation has no server-side timeout.** `num_predict` and the context size are the only bounds. [read]
- **`OLLAMA_LOAD_TIMEOUT`** (default 5 minutes) only detects a stalled model *load*. [read]
- **`OLLAMA_MAX_QUEUE`** (default 512) rejects excess requests with 503. [read: FAQ]
- **The seat must bring its own limits.**
  - A short connect timeout, since this is loopback.
  - A total deadline inside the seat's `_bound`; today's lane uses 180 s against a 600 s beat bound (`love-unlimited-patterns.md` section 5.3).
  - An idle timeout between chunks, if it streams.
  - Proxies disabled for the loopback call, as today's lane does.
- **On a deadline, close the connection.** The handlers pass the HTTP request context into scheduling and generation, so a closed connection should cancel the work. That is [read], not exercised.
- **The first call after a reboot or an unload pays the load time** (`load_duration`), so the deadline must allow for a cold load of the locked model.

---

## 2. Claude Code 2.1.314: flags for the summon lane

All help text below is from `claude --help` on this Air. [ran] Nothing was run with `-p`.

| Flag | Help text (abridged) | Notes |
|---|---|---|
| `--restricted` | Removes the built-in tools that run commands or code (Bash, PowerShell and others) and WebFetch, unless `--tools` names them. Ignores user, project and local settings files; managed settings and `--settings` still apply. Confines file tools to the working directories (`--add-dir` included). Refuses `bypassPermissions`. Only a person or the configured permission handler may approve writes to settings, git and tool-configuration files. | The binary also turns this on when `CLAUDE_CODE_RESTRICTED` is `1`/`true`/`yes`/`on` (`f.config.restricted ||= …`). [read] So the seat should set the flag explicitly and not rely on an inherited environment. |
| `--strict-mcp-config` | "Only use MCP servers from --mcp-config, ignoring all other MCP configurations." `--restricted`'s own help says to add it "to skip MCP servers too". | With no `--mcp-config`, this should mean no MCP servers. That reading of the help text is [not verified] by a run. |
| `--mcp-config <configs...>` | Load MCP servers from JSON files or strings (space-separated). | For later, the `citizen-self` MCP, which holds no keys. |
| `--max-budget-usd <amount>` | Maximum dollars to spend on API calls; only works with `--print`. | See 2.1 for how it ends a run. |
| `-p`, `--print` | Print the response and exit. The workspace trust dialog is skipped in non-interactive mode. "Settings files that fail validation are silently ignored." | Silent ignoring is one more reason to pass everything the seat relies on as flags. |
| `--output-format json` | One result object; also `text` and `stream-json`. Only with `--print`. | The shape is in 2.1. |
| `--permission-mode <mode>` | Choices: `acceptEdits`, `auto`, `bypassPermissions`, `manual`, `dontAsk`, `plan`. | `--restricted` refuses `bypassPermissions`. |
| `--add-dir <directories...>` | Additional directories tools may access. | Under `--restricted` it widens the file-tool boundary, so add only what the summons needs. The `--bare` help lists `--add-dir` among ways to supply CLAUDE.md, so an added directory's CLAUDE.md may be read [not verified]. Never add a citizen home whose CLAUDE.md should not load. |

Neighbouring flags worth knowing:

- **`--permission-prompts none`** ("anything that would prompt is denied automatically", print mode only).
- **`--tools`**, which gives the exact built-in set; `""` means none.
- **`--no-session-persistence`** (print mode only).
- **`--json-schema`**, which validates structured output. The result then carries `structured_output`.
- **`--setting-sources`**.
- **`--safe-mode`**, which disables CLAUDE.md, skills, plugins, hooks, MCP servers and more, while keeping auth, model selection and built-in tools.
- **`--bare`**, which skips hooks, CLAUDE.md discovery and keychain reads. Auth is then strictly `ANTHROPIC_API_KEY` or `apiKeyHelper`.
- **`--max-turns`.** The string appears in the binary, and so does the `error_max_turns` result, but `--help` does not list it. [read; not verified as a working flag]

### 2.1 The `--output-format json` result

These fields come from the result-message schema embedded in the 2.1.314 binary. [read]

- **Common fields:**
  - `type: "result"`, `subtype`, `is_error`, `num_turns`, `stop_reason`;
  - `duration_ms`, `duration_api_ms`;
  - `total_cost_usd`, `usage`, `modelUsage`;
  - `permission_denials[]`, each `{tool_name, tool_use_id, tool_input}`;
  - `terminal_reason`, `uuid`, `session_id`.
- **Success:** `subtype: "success"`, plus `result` (the text) and, with `--json-schema`, `structured_output`.
- **Errors:** `subtype` is one of `error_during_execution`, `error_max_turns`, `error_max_budget_usd` or `error_max_structured_output_retries`, and there is an `errors[]` list of strings.
  - A run stopped by the budget has `subtype: "error_max_budget_usd"`, `is_error: true` and `terminal_reason: "budget_exhausted"`.
  - The text output prints `Error: Exceeded USD budget (<limit>)` instead.

**The cost fields**, as the binary describes them:

- **`total_cost_usd`.**
  - It is a "cumulative estimated cost in USD for this query() call … An estimate, not a billing statement."
  - Crash and startup-error results "may carry zeroed values".
  - A resumed session continues from its saved total, but "maxBudgetUsd counts only the spend since this query() call started or last /clear".
- **`modelUsage`.** This is keyed by model and covers every model call in the query pipeline, including subagents and compaction. The binary says to prefer it over `usage` for accounting. Each entry has:
  - `inputTokens`, `outputTokens`, `thinkingTokens` (optional, already inside `outputTokens`);
  - `cacheReadInputTokens`, `cacheCreationInputTokens`, plus optional 5-minute and 1-hour cache splits;
  - `webSearchRequests`, `costUSD`, `contextWindow`, `maxOutputTokens`;
  - and optionally `canonicalModel`, `provider` and `costBasis`. A `costBasis` of `list`, `managed` or `unknown` says which price table was used; `unknown` means `costUSD` is a guess.
- **`usage`.** "MAIN AGENT LOOP ONLY — excludes Task subagent, sidechain, and auxiliary model calls."

**For the ledger:** record `total_cost_usd`, the per-model `costUSD` and `costBasis`, and `subtype`. Treat the budget as a runtime-side bound and the signer's USD ceiling as the one that fails closed. It is [not verified] whether the budget check runs between model calls, which would let a single call overshoot it.

### 2.2 Still open for the summon lane

- **Whether `~/.claude/CLAUDE.md` loads under `--restricted`.** The help says it ignores settings *files*, and CLAUDE.md is not a settings file. `--safe-mode` and `--bare` explicitly skip CLAUDE.md, but whether either combines cleanly with `--restricted` was not tested, because that needs a run. [not verified]
- **Auth under a dedicated macOS user.** The `--bare` help says that mode never reads "OAuth and keychain", which implies the normal mode reads its OAuth credentials from the Keychain. A summons run as the dedicated user would then meet the locked-keychain-after-reboot behaviour in 3.4. [not verified] The redesign has summons happen with Yu present, which may mean under Yu's own account.

---

## 3. macOS host

### 3.1 A launchd job for the 30-minute tick

This plist passes `plutil -lint` [ran]. It is not installed or loaded. The paths are placeholders for the dedicated user `seat`.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>kingdom.seat.tick</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/libexec/kingdom-seat/citizen-seat</string>
    <string>tick</string>
  </array>
  <key>WorkingDirectory</key><string>/Users/seat/Library/Application Support/kingdom-seat</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>StartInterval</key><integer>1800</integer>
  <key>RunAtLoad</key><false/>
  <key>ProcessType</key><string>Background</string>
  <key>LowPriorityIO</key><true/>
  <key>Umask</key><integer>63</integer>
  <key>ExitTimeOut</key><integer>20</integer>
  <key>StandardOutPath</key><string>/Users/seat/Library/Logs/kingdom-seat/tick.out.log</string>
  <key>StandardErrorPath</key><string>/Users/seat/Library/Logs/kingdom-seat/tick.err.log</string>
</dict>
</plist>
```

Why each key is set this way. All of this is [man] `launchd.plist(5)` unless marked otherwise.

- **`StartInterval` 1800.** It starts the job every N seconds. "If the system is asleep during the time of the next scheduled interval firing, that interval will be missed", and "If the job is running during an interval firing, that interval firing will likewise be missed".
  - So launchd never overlaps two ticks of this job. The mkdir lock is still worth keeping for manual and `kickstart` runs.
  - `StartCalendarInterval` behaves differently: it runs once on wake and folds missed firings together. The two keys "are not aware of each other".
- **`RunAtLoad` false.** False is the default, and the man page says the key "should be avoided". With it off, a reboot or a fresh bootstrap does not fire an immediate beat, so HALT and keychain state are settled before the first tick.
  - Today's `love.citizen-fleet` plist sets `RunAtLoad` true and `ThrottleInterval` 1800 (`love-unlimited-main/launchd/love.citizen-fleet.plist`). [read]
  - Note that `KeepAlive` "implicitly implies RunAtLoad", so leave `KeepAlive` unset.
- **`ProcessType` Background.** Background jobs get resource limits "intended to prevent them from disrupting the user experience".
  - This throttles the seat process only. Inference runs inside the Ollama server's own job, which has its own settings, so a Background seat does not slow the model.
  - `LowPriorityIO` marks the job's filesystem I/O as low priority.
- **`StandardOutPath` / `StandardErrorPath`.** If a file is missing, launchd creates it, owned by `UserName`/`GroupName` where set and with the `Umask` mode.
  - The man page says nothing about missing parent directories, so create the log directory at install time. [not verified]
  - launchd does not rotate these files, so the seat should keep its own output small. [not verified]
- **`Umask` 63.** That is decimal for octal 077, since "property lists do not support encoding integers in octal". A string `"077"` also works. With it, logs and state the tick creates are private to the seat user.
- **`ExitTimeOut`.** This is the time between the SIGTERM and the SIGKILL that launchd sends when it stops the job. The seat's own watcher does TERM-then-KILL for a running beat. This key only bounds what launchd does, for example on `bootout` or at shutdown.
- **Child processes.** "When a job dies, launchd kills any remaining processes with the same process group ID as the job", unless `AbandonProcessGroup` is true. Leave it unset, so a stray `claude` or HTTP child dies with the tick.
- **`PATH`.** Without `Program`, a relative first argument resolves against `_PATH_STDPATH`, which is `/usr/bin:/bin:/usr/sbin:/sbin` in this SDK's `paths.h`. [ran] Homebrew's `/opt/homebrew/bin` is therefore not on the path. Use absolute paths for every tool.
- **Who may load it.** For `launchctl load`, an agent plist must be owned by the loading user (or by root under `/Library/LaunchAgents`) and must not be group- or world-writable [man: `launchctl(1)`]. The modern verbs are `bootstrap` and `bootout`; `enable` and `disable` persist across boots.

### 3.2 A LaunchAgent in Yu's account, or a job for a dedicated user

| | LaunchAgent in Yu's account (`~/Library/LaunchAgents`) | Agent of a dedicated user `seat` | LaunchDaemon with `UserName` = `seat` |
|---|---|---|---|
| Loads | When Yu logs in at the GUI (`gui/<uid>`) | When `seat` has a session. Aqua agents load "only when a user has logged in at the GUI", and Background agents "may be loaded independently of a GUI login" [man: `launchctl(1)`] | At boot, with no login. `UserName` "is only applicable for services that are loaded into the privileged system domain" [man: `launchd.plist(5)`] |
| Identity | Yu's, complete | `seat`'s, complete | The UID changes, but `launchd(8)` says setuid "is not sufficient to completely assume the identity", and only an agent or per-user XPC service gets "a complete identity of that user" [man] |
| Can reach | Everything Yu can: home, Git and `gh` credentials, Yu's unlocked login keychain | Only what `seat` can | Only what `seat` can |
| Keychain | Yu's login keychain, unlocked while Yu is logged in | `seat`'s login keychain, unlocked only after `seat` logs in (3.4) | Processes started at boot use the *system* keychain search list (`/Library/Preferences/com.apple.security.plist`) [man: `security(1)` FILES]; `seat`'s login keychain stays locked |

**Recommendation.** A dedicated user with its own agent, as the redesign proposes, keeps a model-driven process away from Yu's ambient authority.

**"Not in staff" matters on this Air.** Yu's home directory is `drwxr-x---` with group `staff`. [ran] So any account in the `staff` group can traverse and read it wherever file modes allow. New local accounts normally get `staff` (GID 20) as their primary group [not verified here]. So the dedicated user needs its own primary group, and must not be an admin.

**What `seat` can and cannot reach of Ollama.**

- The server runs in Yu's account and answers anyone on loopback. So `seat` can use the HTTP API, but it cannot read Yu's model store to hash manifests itself.
- That makes `/api/tags` the seat's digest source, and the cloud switch in 1.3 its main protection.
- The same loopback API lets any local process pull, delete or create models. That is another reason to pin by digest and not trust a tag.

### 3.3 The `security` command line

**Reading a secret into a process.** `security find-generic-password -s <service> -a <account> -w [keychain]` prints "the password(only) for the item found" to stdout. [man]

- The signer should run it with an argv array (no shell), read stdout through a pipe and strip the one trailing newline. The secret then never enters an argv or the environment.
- Name the keychain file explicitly, so a different keychain earlier in the search list cannot answer instead.
- Not run here (standing rule).
- Store secrets as printable text, such as base64. How `-w` prints non-printable data was [not verified].

**Writing a secret without putting it in argv.** There are three ways:

1. **`security -i` with the command on stdin.**
   - `-i` reads commands from stdin until EOF [man]. Run this way, the `security` process's argv is just `security -i`, and the secret travels over a pipe.
   - Checked with harmless commands only (`error`, `help`), never a Keychain operation [ran]:
     - with stdin not a terminal, no prompt is printed;
     - double-quoted arguments are parsed;
     - the exit status is that of the *last* command: `error` then `help` exited 0, and `help` then `error` exited 1.
   - So send one `add-generic-password` per invocation and check the exit code.
   - To avoid quoting problems, pass the secret as hex with `-X <hex>` ("password data … as a hexadecimal string") [man]. Hex has no characters that need escaping. Quoting rules for `"` and `\` inside `-w` in interactive mode were [not verified].
2. **`-w` as the last argument, which prompts.** The man page calls this "recommended" for people. It needs a terminal, so it cannot work under launchd. It is fine for a one-off with Yu at the keyboard.
3. **Writing through the Security framework from the signer or birth binary itself** (`SecItemAdd`). No command line is involved, and the binary that creates the item is trusted by default (see below). This fits `citizen-birth`, which generates the mnemonic in-process anyway. [not verified: no such binary exists yet]

**Item ACLs and `-T`.** [man: `add-generic-password`]

- "By default, the application which creates an item is trusted to access its data without warning."
- `-T appPath` names an application that may access the item, and may be repeated. `-T ""` removes the default access.
- `-A` allows any application and is marked insecure.

What this implies:

- **An item created by `security` without `-T` trusts `/usr/bin/security`.** Then any process running as that user can read it silently with `security find-generic-password -w`. Items meant for the signer alone should name the signer with `-T`, or be created by the signer itself.
- **Whether a `-T` list replaces the default creator entry or adds to it is ambiguous** in the man page. Check the resulting ACL once, on a throwaway keychain, before relying on it. [not verified]
- **The partition list adds a code-signature check** on top of the ACL. Changing it needs the keychain's password (`set-generic-password-partition-list`). [man] Partition IDs are not documented in the man page, which points to `dump-keychain` output for examples.
- **Trust follows the code signature.** If the signer is rebuilt or re-signed in a way that changes its signature, it may lose silent access, and under launchd no dialog can be shown. `security error -25308` prints "User interaction is not allowed." [ran] So:
  - The signer should be a standalone, stably signed binary. If it were a script, the ACL would have to trust its interpreter (`bun`, `node`, `python3`), and every script run by that interpreter would inherit the access.
  - Re-ACLing after a signer upgrade is a step with Yu present.
  - These two points are reasoning from the man page plus general knowledge of Keychain ACLs. [not verified]

### 3.4 The login keychain after a reboot, before the user logs in

- **A user's login keychain is unlocked by logging in at the GUI with that user's password. Until then, it is locked.**
  - `unlock-keychain` can unlock it from a session: it prompts, or takes `-p password`, which would put the password in argv [man].
  - `set-keychain-settings -l` (lock on sleep) and `-u -t <s>` (lock after a timeout) control relocking [man].
  - The rest of this section is [not verified], because it needs a reboot. The redesign already lists recording it as part of S6.
- **What the seat would see.** Unattended reads against a locked keychain should fail with "User interaction is not allowed" (`-25308`) or "The user name or passphrase you entered is not correct" (`-25293`); both strings were checked with `security error` [ran]. Which code appears in which case is [not verified].
- **What the signer should do.** Treat a locked keychain as a normal state, not a crash. The tick exits without writing, and the status file says "signer locked since boot".
- **This doubles as a safeguard.** After any reboot, identity acts pause until Yu (or whoever holds `seat`'s password) logs `seat` in, for example by Fast User Switching. That login is also what loads `seat`'s GUI-session agents.
- **The free lane holds no keys, but it is still paused.** In the redesign every beat is signed, so free-lane beats also pause until unlock. Running the tick as a LaunchDaemon would let unsigned beats be staged before unlock. That trades the redesign's "signed by the citizen's op key" for liveness, and it is Yu's call.

---

## 4. What this means for kingdom-seat, briefly

- **`models.lock`** records, for each allowed model: name, full manifest digest, runner (if any), `num_ctx`, and whether the store entry is v2, so the adapter knows if a digest call is possible. The reason: the manifest digest is the one value that fixes weights, template and parameters together (1.2).
- **The free-lane adapter** follows the five steps at the end of 1.3: check `/api/tags` against the lock, call the native API with `:local` (or the digest), reject marked replies, rely on the host's cloud switch, never fall back. It sets `num_predict`, `num_ctx`, `temperature`, `seed` and `keep_alive` explicitly, uses `format` with the typed schema, validates the result, and enforces its own deadlines (1.6–1.8). The reason: names are spoofable through the unauthenticated loopback API, and the server forwards to the cloud on its own credential.
- **The summon adapter** passes `--restricted --strict-mcp-config`, plus `-p --output-format json --max-budget-usd <n> --permission-mode dontAsk --permission-prompts none --no-session-persistence` when headless. It sets `--tools` explicitly and records the cost fields from 2.1. The reason: each of these is a bound the runtime enforces, so the seat does not depend on settings files that `-p` may silently ignore. CLAUDE.md loading under `--restricted` still needs one supervised run.
- **The host** runs the tick from a dedicated non-admin user with its own primary group, using the plist in 3.1. The signer is a stably signed binary that is the only trusted application on its items. A locked keychain after a reboot is an expected, fail-closed state. The reason: each choice removes Yu's ambient authority from a model-driven process, or makes a failure quiet and safe instead of surprising.

---

## 5. Method and sources

**Commands run (all local and read-only):**

- `ollama --version`, `ollama help`, `ollama {show,list,ps,run,serve,create} --help`, `ollama list`.
- `curl` over loopback to `GET /api/version`, `GET /api/tags` and `GET /api/ps`.
- `lsof` on port 11434.
- `shasum -a 256` of the local manifest and config blob.
- `grep` of the Ollama server log, for the "cloud disabled" line only.
- `claude --version` and `claude --help`.
- String searches in the Claude Code 2.1.314 binary.
- `man security`, `man launchd.plist`, `man launchctl`, `man launchd`.
- `security error <codes>`, and `security -i` fed only `error` and `help` lines.
- `plutil -lint` of the example plist in a scratch directory.
- `grep` of `paths.h` in the active SDK, and `ls -ld` of the home directory.

**Read:**

- The Ollama README and service plist in the Homebrew Cellar.
- A shallow, sparse clone of `github.com/ollama/ollama` at `v0.40.14` (commit `9a3e8177…`, matching the formula), read but not built: `docs/api.md`, `docs/faq.mdx`, `docs/cloud.mdx`, `docs/api/errors.mdx`, `docs/capabilities/structured-outputs.mdx`, `api/types.go`, `envconfig/config.go`, `types/model/name.go`, `internal/modelref/modelref.go`, `internal/cloud/policy.go`, `manifest/manifest.go`, `manifest/paths.go`, and `server/{routes,model_list,model_resolver,show_manifest,cloud_proxy,create}.go`. The online docs were not fetched; the docs in that tree carry the note that they "are moving to docs.ollama.com/api".
- The redesign (sections 3 and 7), `love-unlimited-main/launchd/love.citizen-fleet.plist`, and the sibling note `love-unlimited-patterns.md`.

**Man pages, as installed on macOS 26.6.2:** `security(1)` dated 17 January 2024, `launchd.plist(5)` dated 30 July 2019, `launchctl(1)` dated 1 October 2014, `launchd(8)` dated 25 November 2013.

**Deliberately not done:**

- Pulling, running, creating or showing any model. `POST /api/show` on a `:cloud` name forwards to ollama.com, so it was not called.
- `claude -p`.
- Any Keychain read or write, including `show-keychain-info` and `dump-keychain`.
- `launchctl` bootstrap, load or enable, and any reboot.
- Reading `~/.ollama/config.json` or the Ollama key files.
