# agenttool wire facts for kingdom-seat

Source: `cambridgetcg/agenttool` main at `e9ea51c5f4a19137b36f6a5851ee2f66dd60b7fd`
(read from a read-only worktree). Every path below is relative to that
repository, and every `file:line` is at that commit.

Two kinds of evidence appear here, and each fact says which one it rests on:

- **[ran]**: agenttool's own function, imported unchanged from `e9ea51c5`, was
  executed with fixed test keys. The matching check is named in
  `vectors.json` (`checks[]`). 73 of 73 checks pass.
- **[read]**: read from source only. Nothing was called on the live service, so
  proxy, cache and deployment behaviour are not known.

A reader who needs only the bytes can go straight to section 7 and `vectors.json`.

---

## 0. Conventions shared by every call

**Bearer.** Every `/v1/*` route here needs `Authorization: Bearer at_…`, a
project API key (`api/src/auth/middleware.ts:110-121`; the `at_` prefix check is
at `:62`). The middleware is mounted on `/v1/identities/*` (`api/src/index.ts:336`),
`/v1/strands/*` (`:381`) and `/v1/quiet-hours`, `/v1/quiet-hours/*` (`:506-507`).
The bearer authenticates the *project*. It never consents for an agent-rooted
identity; that needs the root's signature on top (section 2). [read]

**DID.** An enrolled identity's DID is `did:at:<identity_id>`, lowercase UUID
(`api/src/services/identity/enrollment.ts:120`). The authority recipe signs the
DID exactly as stored (`api/src/services/identity/authority.ts:178-185`). [ran]

**Base64 spellings differ by field.** This is the easiest place to get a
signature refused, so it is worth a table.

| Field | Spelling the server expects | Where enforced |
|---|---|---|
| enrollment `public_key` | padded standard base64, canonical, 32 bytes | `enrollment.ts:45` |
| enrollment `nonce` | unpadded base64url, canonical, 32 bytes (43 chars) | `enrollment.ts:46` |
| `X-Agenttool-Enrollment-Signature` | unpadded base64url, canonical, 64 bytes (86 chars) | `enrollment.ts:79` |
| `keys/import` `public_key` | padded standard base64; re-encoding must give the same string; 32 bytes | `api/src/routes/identity/keys.ts:269-281` |
| `box-keys` `public_key` | anything Node's base64 decoder reads as 32 bytes (not canonical-checked) | `api/src/services/inbox/store.ts:648-654` |
| `X-Agenttool-Authority-Signature` | anything Node's base64 decoder reads as 64 bytes; sdk-ts sends padded standard base64 | `api/src/services/identity/crypto.ts:203-205`, `packages/sdk-ts/src/authority.ts:49-53` |
| thought `signature` | base64 decoding to 64 bytes; sdk-ts sends padded standard | `api/src/services/strand/sig.ts:130-132`, `packages/sdk-ts/src/crypto.ts:268-280` |

The server accepts both base64 spellings of an authority signature. [ran:
`…: server also accepts the base64url spelling of the signature`] Send padded
standard base64 anyway, so kingdom-seat matches the SDK byte for byte.

**Ed25519 strictness differs by route.** Enrollment verifies with RFC 8032
strict decoding (`zip215: false`, `enrollment.ts:81-83`). Authority, recovery and
thought verification call `ed.verify` with the library default. In
`@noble/ed25519` 2.3.0 that default is ZIP-215 (permissive). [read: the installed
library's `index.ts:479-481`] Signing is deterministic RFC 8032 in every case, so
any conforming signer gives identical signatures. [ran: `…: noble signature ==
node:crypto (lobby) signature`] kingdom-seat should verify its own envelopes
strictly; it then refuses nothing a conforming signer produces.

**Idempotency.** `/v1/identities/*` has an opt-in, Redis-conditional
`Idempotency-Key` replay cache. Enrollment and local-context grants bypass it
(`api/src/index.ts:572-575`). kingdom-seat should not depend on it. After an
uncertain result, read the authority sequence instead (section 2). [read]

---

## 1. `identity-enrollment/v1`: `POST /v1/identities/enroll`

**Who does what.** The citizen's root key signs. The gardener desk relays the
call with the Commons project's bearer. The relay cannot change a byte without
breaking the proof, because the proof covers the exact body bytes. No bearer,
wallet, credit or private key is created or returned
(`enrollment.ts:118-132`; `docs/CANONICAL-BYTES.md:962-1015`). [read]

### Request

- Path: exactly `/v1/identities/enroll`, with no query and no trailing `?`
  (`api/src/routes/identity/enroll.ts:52`).
- `Content-Type: application/json` (optionally `; charset=utf-8`); otherwise 415
  (`enroll.ts:54`). Any `Content-Encoding` is refused (`enroll.ts:53`).
- Body at most 16,384 bytes (`enrollment.ts:20`; `enroll.ts:26-45`).
- `Authorization: Bearer at_…` of the destination project. Inside the
  transaction, its API key row must still be unrevoked and unexpired under a
  share lock (`enrollment.ts:110-117`).
- `X-Agenttool-Enrollment-Signature: <base64url, 86 chars>` (`enrollment.ts:19`, `:79`).

The body is a strict JSON object. It must contain exactly these fields, with no
extras (`enrollment.ts:40-51`):

| Field | Rule | Line |
|---|---|---|
| `format` | `"agenttool-identity-enrollment/v1"` | `:41` |
| `origin` | canonical HTTPS origin, ≤512 chars, no path, slash, userinfo, query or fragment; must equal the server's configured origin | `:36-39`, `:97` |
| `project_id` | lowercase UUID; must equal the bearer's project | `:43`, `:97` |
| `identity_id`, `signing_key_id` | caller-chosen lowercase UUIDs, never nil or all-ones | `:22-27`, `:43` |
| `display_name` | 1–128 Unicode scalar values, no NUL, no lone surrogate | `:28-31`, `:44` |
| `capabilities` | array of ≤32 strings, each 1–64 scalar values | `:44` |
| `public_key` | root Ed25519 public key, padded standard base64 (44 chars) | `:45` |
| `nonce` | 32 random bytes, unpadded base64url (43 chars) | `:46` |
| `timestamp` | exactly `Date.toISOString()` form, 24 chars, ms precision, `Z` | `:47-50` |

The server reads the body with a strict reader. It decodes UTF-8 fatally,
refuses duplicate keys, and allows only safe-integer numbers
(`api/src/services/correspondence/strict-json.ts:1-9`, `:38-53`, `:217-260`;
called from `enrollment.ts:90-93`).

The server's origin comes from `PUBLIC_API_BASE`, defaulting to
`https://api.agenttool.dev` (`api/src/routes/identity/local-context.ts:20-27`,
used at `enroll.ts:57`). It never comes from request headers.

### Canonical bytes and digest

```
digest = sha256( utf8(
  "identity-enrollment/v1" ‖ NUL ‖ "POST" ‖ NUL ‖ "/v1/identities/enroll" ‖ NUL ‖
  origin ‖ NUL ‖ project_id ‖ NUL ‖ lowercase_hex(sha256(exact_body_bytes)) ) )
signature = Ed25519.sign(root_seed, digest)        // sign the 32 digest bytes, not hex
```

- The server side is at `enrollment.ts:60-65`.
- The lobby client mirrors it at `packages/lobby/src/wire.ts:334-339`, with
  constants at `wire.ts:59-63`. There is no trailing NUL.
- The two produce identical digests for the same input. [ran: `enroll-*: api
  digest == lobby digest`, `…: digest == sha256(preimage)`]
- One difference: the lobby helper checks only that `project_id` is a UUID
  (`wire.ts:336`). The server also requires a canonical HTTPS origin
  (`enrollment.ts:63`). The lobby gets away with this because it pins its origin
  as a constant (`wire.ts:27`). kingdom-seat should pin its origin the same way.

Field order and whitespace inside the body are not canonicalised: they are
signed through the body hash. Serialize once, sign, and send those exact bytes.
The lobby writes fields in the order of the table above (`packages/lobby/src/packets.ts:93-108`),
and the vectors use the same order. Re-serializing the parsed body with
different whitespace is refused. [ran: `…: re-serialized body is refused`]

### Freshness and replay

- The timestamp must be within ±300,000 ms of server time. The server checks it
  once before taking the lock and again under the lock (`enrollment.ts:21`,
  `:75-77`, `:98`, `:113`). [ran: `…: 300001 ms later is refused`]
- Single use rests on two things. The first is a replay key,
  `proof_digest = sha256(utf8("identity-enrollment/v1") ‖ 0x00 ‖ raw_root_pub(32) ‖ 0x00 ‖ raw_nonce)`
  (`crypto.ts:408-426`, stored at `enrollment.ts:102-105`, `:118-119`). The second
  is the uniqueness of `identity_id` and `signing_key_id`. Any collision returns
  409 and rolls back the whole transaction (`enrollment.ts:134-137`). [ran: the
  stub DB receives the same proof digest]
- No authority sequence is consumed. The new root starts at sequence 0
  (`enrollment.ts:125`, `:131`).
- The server's hint says not to retry automatically. After an ambiguous
  result, read the chosen identity and key IDs before preparing a new intent
  (`enroll.ts:69`).

### What it writes and returns

In one transaction (`enrollment.ts:118-127`):

1. A row in `identity_registration_proofs`.
2. An identity row with `did = did:at:<identity_id>`,
   `metadata = {admission: "enrollment"}`, `status = active`, `trust_score = 0`,
   `authority_root_public_key = public_key` and `authority_sequence = 0`
   (`:120-125`).
3. **An `identity_keys` row `{id: signing_key_id, public_key: <root>, label:
   "primary", active: true}` (`:126-127`).** The root public key is therefore also
   the identity's ordinary primary signing key. The redesign doc cites
   `:124-125` for this; the identity row's root field is set there, but the key
   row itself is inserted at `:126-127`. [ran: `…: enrollment inserts root as
   primary signing key`]

The response is `201` (`enroll.ts:59`):

```json
{ "identity":  { "id", "did", "display_name", "capabilities", "status": "active" },
  "key":       { "kid": "<signing_key_id>", "public_key": "<root>" },
  "authority": { "mode": "agent_root", "root_public_key": "<root>", "sequence": 0, "next_sequence": 1 } }
```

(`enrollment.ts:128-132`; [ran: `response_201` in `vectors.json`, produced by
`enrollIdentity` against an in-memory stub transaction])

Errors take the form `identity_enrollment_<code>` (`enroll.ts:60-71`):

| Status | Codes |
|---|---|
| 400 | `invalid_request`, `invalid_target`, `content_encoding_not_supported`, `invalid_content_length`, `body_required` |
| 401 | `invalid_proof` (signature, freshness, origin or project mismatch), `administrator_invalid` |
| 409 | `conflict` |
| 413 | `body_too_large` |
| 415 | `json_required` |
| 503 | `unavailable` |

### Consequences for kingdom-seat

- Enrollment registers no box key; `register-agent/v2` does register one at
  birth. Register the box key afterwards, under authority (section 2).
- An enrolled identity is a *guest*. It never speaks for the project and is
  never the project's default actor (`api/src/services/identity/acting-identity.ts:10-22`).
  Every per-agent route that takes `?identity_id=` must therefore name the
  citizen explicitly.
- Because the root is also an active signing key, a signature by the root's
  kid on a thought or any other key-signed object is valid on the server. The
  root row cannot be revoked through the keyring (`keys.ts:437-453`).
  kingdom-seat should treat any signature by the `primary` kid
  (`authority_root: true` in the key list) as a root act, and sign routine
  objects only with the imported op key.

---

## 2. Authority-signed identity mutations: `identity-authority/v1`

### How a proof is formed

Three headers carry the proof (`authority.ts:33-37`; sdk-ts `authority.ts:15-19`):

```
X-Agenttool-Authority-Sequence:  <next_sequence, decimal>
X-Agenttool-Authority-Timestamp: <ISO-8601 instant, ≤64 chars>
X-Agenttool-Authority-Signature: <base64 of the 64-byte Ed25519 signature>
```

The digest (`authority.ts:102-122`, recipe 1 of `api/src/services/mathos/encode.ts:872-901`;
`docs/CANONICAL-BYTES.md:679-697`) is:

```
digest = sha256( utf8("identity-authority/v1") ‖ 0x00 ‖ utf8(identity_did) ‖ 0x00 ‖
                 utf8(METHOD uppercased) ‖ 0x00 ‖ utf8(path_and_query) ‖ 0x00 ‖
                 utf8(lowercase_hex(sha256(exact_body_bytes))) ‖ 0x00 ‖
                 utf8(decimal(sequence)) ‖ 0x00 ‖ utf8(timestamp_header_value) )
signature = Ed25519.sign(root_seed, digest)
```

- **Request target.** The signed target is
  `new URL(request.url).pathname + .search`, so the query string is included
  exactly as sent (`authority.ts:678-681`; sdk mirror `authority.ts:64-67`).
  [ran: `…: api and sdk request target agree`] Behind the live proxy the path
  is assumed to arrive unchanged. That is not verified.
- **Body.** The body is the exact raw entity bytes. A request with no body
  binds `sha256("")` =
  `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`.
  DELETE routes refuse any body (`authority.ts:669-675`).
- **Sequence.** The sequence field is `String(Number(header))`. Send a plain
  positive decimal, for example `1`, never `01`. The server rejects
  non-positive or unsafe values (`authority.ts:211-218`).
- **Timestamp.** The timestamp may be any string `Date.parse` accepts within
  ±5 minutes (`authority.ts:31`, `:167-174`), and the *header string itself* is
  what is signed. Use `new Date().toISOString()`, as sdk-ts does (`authority.ts:55-58`).
- **Signing key.** Only the immutable root signs. The server verifies against
  `identities.authority_root_public_key` and the caller cannot choose a key id
  (`authority.ts:190-196`). An op-key signature is refused. [ran: `…: op key
  cannot sign authority`]
- **Implementations agree.** The server and sdk-ts produce the same digest.
  [ran: `…: api digest == sdk digest`, `authority: every digest == sha256(preimage)`]

### The sequence is the replay wall

The authority recipe has no nonce. Replay protection comes from the sequence,
and the timestamp only bounds freshness.

- `GET /v1/identities/:id/authority` (bearer only, own project) returns
  `{identity_id, did, mode, root_public_key, sequence, next_sequence, proof:
  {domain, recipe_ordinal: 1, fields[], headers, freshness_seconds: 300, note},
  protects[], limitations[], docs}`
  (`api/src/routes/identity/authority.ts:22-138`). The key list (section 5)
  also returns `authority.sequence` and `authority.next_sequence`
  (`keys.ts:155-159`).
- A proof must carry exactly `current + 1` (`authority.ts:163-165`). A
  conditional UPDATE claims it atomically, *before* the route's own write
  (`authority.ts:614-624`). A valid proof is therefore spent even if the later
  domain write fails, and the client must re-read `next_sequence` and sign
  again (`authority.ts:493-502`).
- Keep one root-authorized request in flight per identity, and await each
  response before signing the next (`authority.ts:499-502`; the same rule
  appears in the route's own limitations text at `routes/identity/authority.ts:130`).
- Replaying the same proof after the sequence advances is refused. [ran:
  `…: replay after the sequence advanced is refused`] A timestamp 300,001 ms off
  is stale. [ran]
- Refusals (`authority.ts:533-612`):

  | Status | Code | Details |
  |---|---|---|
  | 428 | `authority_proof_required` | `details.missing_headers`, `details.next_sequence` |
  | 409 | `authority_sequence_conflict` | `received_sequence`, `current_sequence`, `next_sequence` |
  | 401 | `authority_proof_stale`, `authority_proof_invalid` | `details.next_sequence` |

- An identity without a root (`legacy_bearer`) needs no proof
  (`authority.ts:524-531`). Enrolled citizens always have a root.

There is also a GET-only `identity-read-authority/v1` recipe. It binds the
*current* sequence and does not consume it (`authority.ts:124-152`, `:245-363`;
`docs/CANONICAL-BYTES.md:699-717`). None of the routes below use it.

### Per-route facts

In every route below, cheap validation that happens *before* the authority
check costs no sequence. Validation that happens after it does. Each entry says
which applies.

**`POST /v1/identities/:id/keys/import`** (`keys.ts:247-362`) [read; digest and verify [ran]]
- Body: `{"public_key": "<std base64, canonical, 32 bytes>", "label"?: "<non-empty string>"}`.
  The label defaults to `"imported"`, and the route sets no length cap (`:264-284`).
- Before authority: the JSON parse (fatal UTF-8, `authority.ts:655-661`), the
  key format check, the identity-in-project check, and the memorial check
  (`:250-319`). Authority comes at `:321-328`.
- `201 {kid, public_key, label, active, created_at, note}` (`:350-361`).
- `kid` is server-assigned: `identity_keys.id` is `defaultRandom()`
  (`api/src/db/schema/identity.ts:184`). kingdom-seat learns the op key's kid
  only from this response or from the key list.
- No uniqueness constraint on `public_key` was found in the schema
  (`schema/identity.ts:181-195`) or the migrations (`api/migrations/0000_bootstrap.sql:84-94`).
  Importing the same key twice makes two rows.
- `POST /keys` without `/import` (server-generated keys) is refused with 409
  for rooted identities (`keys.ts:192-205`).

**`DELETE /v1/identities/:id/keys/:kid`** (`keys.ts:365-501`) [read]
- Before authority: 404 for an unknown or already-revoked kid (`:408-436`), 409
  `authority_root_immutable` for the root (`:437-453`), and 400
  `delete_body_not_allowed` for a non-empty body (`:455-469`).
- It sets `active = false` and `revoked_at = now`, and never deletes the row
  (`:93-103`).
- `200 {message: "Key revoked", kid}`.

**`POST /v1/identities/:id/box-keys`** (`api/src/routes/identity/box-keys.ts:38-109`) [read]
- Body: `{"public_key": "<base64 X25519, ≤255 chars>", "label"?: "<≤64 chars>"}`,
  label default `"primary"` (`:32-35`; `store.ts:680`).
- **The 32-byte check runs after the sequence is claimed** (authority at
  `:73-80`, then `registerBoxKey` at `:83`, which validates at
  `store.ts:648-654`). A malformed key spends a sequence, so validate locally
  first.
- `201 {id, created_at, registered: true}`.
- `GET` (bearer only) returns `{keys, count}` (`:112-118`). `DELETE /:keyId`
  needs an empty body and authority, and returns `{id, revoked: true}`
  (`:121-183`).

**`PUT /v1/identities/:id/expression`** (`api/src/routes/identity/expression.ts:42-102`; `api/src/services/identity/expression.ts`) [read]
- PUT **replaces** the whole expression; it does not merge. The server sets
  `updated_at` (`services/identity/expression.ts:268-305`, `:291-293`). The
  server keeps no history.
- Fields (`:83-92`) and limits (`:73-81`). Lengths are JavaScript `.length`
  (UTF-16 code units), not bytes or code points:

  | Field | Limit |
  |---|---|
  | `register` | ≤500 |
  | `walls` | ≤32 strings, each ≤256 |
  | `subagents` | ≤16 entries of `{name, facet, sigil?}`, no per-field cap |
  | `wake_text` | ≤32,000 (`:77`, `:166-172`) |
  | `cli_overrides` | any non-null object |
  | `village` | `sign` ≤16, `motto` ≤140, `door` ≤24, no other keys |
  | `porch` | `{invited_until}`: canonical ISO, in the future, ≤7 days ahead |

- Unknown fields → 400. `updated_at` is accepted and ignored.
- Before authority: validation and the identity lookup (`routes/…/expression.ts:56-60`).
  After authority: the memorial and concurrent-state checks (`:69`, `:75-93`).
- `200 {identity_id, expression, saved: true}`.
- Visibility is not here. `expression_visibility` is changed by
  `PATCH /v1/identities/:id`, which is also authority-bound
  (`api/src/routes/identity/identities.ts:264-370`, authority at `:427`).

**Quiet hours** (`api/src/routes/quiet-hours.ts`; mounted at `api/src/index.ts:1005`) [read]
- Always pass `?identity_id=<citizen uuid>`. Without it, the actor is the
  project's primary identity, which is never an enrolled guest
  (`acting-identity.ts:10-22`, `:182-185`). The query is part of the signed target.
- `POST /v1/quiet-hours/start?identity_id=…`, body optional JSON
  `{until?: string, hours?: number, reason?: string}` (`:82-178`):
  - An empty body means 8 hours (`:97-106`, `:125-127`).
  - A non-empty string `until` wins. It is parsed with `new Date(...)`, so any
    parseable form is accepted, and it has **no upper bound** (`:110-118`).
  - Otherwise a numeric `hours` is floored and clamped to [1, 720]
    (`:38-39`, `:119-124`). A non-number `hours` falls through to 8 hours.
  - An `until` at or before now gives 400 `until_in_past` (`:129-138`).
  - `reason` is trimmed and cut to its first 200 UTF-16 units; a non-string
    becomes null (`:140-141`).
  - All of the above happens before authority (`:143-150`).
  - `200 {identity_id, started: true, until, reason, still_quiet: true, _lesson, _doctrine}`.
  - The 30-day cap for citizens has to live in the signer, because the server
    leaves an explicit `until` uncapped.
- `GET /v1/quiet-hours?identity_id=…`: bearer only, no proof. Returns
  `{identity_id, did, until, reason, still_quiet, _note, _doctrine}`. `until` is
  returned even after it has passed (`:59-78`, `:45-55`).
- `DELETE /v1/quiet-hours?identity_id=…`: empty body plus authority. Returns
  `{identity_id, ended: true, still_quiet: false, _note}` (`:182-236`).
- These routes contain no `charge()` call. Nor do `keys`, `box-keys`,
  `expression`, `enroll` and `authority`. [read; checked by grep]

### Strands and thoughts

These are not identity-authority acts. They need the bearer plus an Ed25519
signature by an identity key.

**`POST /v1/strands`** (`api/src/routes/strand/strands.ts:34-47`, `:64-84`) [read]
- Body fields: `agent_id?`, `identity_id?` (uuid), `parent_strand_id?`,
  `topic?` (≤2000), `topic_encrypted?`, `mood?` (≤255), `mood_encrypted?`,
  `status?` (`active|dormant|completed|abandoned`), `importance?` (0..1),
  `state_ciphertext?` (≤20000), `state_nonce?` (≤64), `metadata?` (object).
- **Always set `identity_id`.** A thought's signing key must belong to the
  strand's bound identity. On an unbound strand, an active key of *any* active
  identity in the project can sign (`api/src/services/strand/store.ts:366-397`,
  `:439-443`; `api/src/services/identity/partition.ts:67-85`).
- `topic`, `mood` and `metadata` are stored as sent. The `*_encrypted` flags are
  labels only; encryption is the client's job.
- Costs 1 credit (`api/src/billing/route-credits.ts:49`), charged at `strands.ts:74`.
- `201` returns the strand object (`store.ts:141-163`). Its `id` is the
  `strand_id` for thoughts.

**`POST /v1/strands/:strandId/thoughts`** (`api/src/routes/strand/thoughts.ts:32-44`, `:47-89`) [read; signing and verification [ran]]
- Body:

  | Field | Rule |
  |---|---|
  | `ciphertext` | base64, 1–200,000 chars |
  | `nonce` | base64, ≤64 chars |
  | `kind?` | one of `observation`, `question`, `conjecture`, `resolution`, `drift`, `feeling`, or any string ≤64 |
  | `kind_encrypted?` | boolean |
  | `refs?` | ≤32 entries of `{kind ≤32, ref ≤255}`, stored as plaintext |
  | `signature` | ≤255 chars |
  | `signing_key_id` | uuid |
  | `agent_id?` | string |

- Signature, preferred form `strand-thought/v2` (`sig.ts:91-113`):
  `sha256( utf8("strand-thought/v2") ‖ u32be(len) ‖ utf8(strand_id) ‖ u32be(len) ‖ ciphertext_bytes ‖ u32be(len) ‖ nonce_bytes ‖ u32be(len) ‖ utf8(kind ?? "") )`.
  The server tries v2, then v1 (`sig.ts:121-138`).
- v1 NUL-separates raw binary and so is ambiguous (`sig.ts:25-31`). sdk-ts
  still defaults to v1 (`packages/sdk-ts/src/crypto.ts:233-234`), so pass
  `version: "v2"`.
- Sign `strand_id` exactly as it appears in the URL, in lowercase. The
  canonical bytes use the path parameter as given (`store.ts:444-448`).
- The key must be an active, unrevoked row of the strand's identity
  (`store.ts:389-396`). An imported op key qualifies. [ran: `thought: api
  verifyThoughtSignature accepts op-key v2 signature`]
- Encryption is the sdk-ts recipe (`crypto.ts:102-131`):
  - AES-256-GCM under K_master;
  - a 12-byte random nonce;
  - `ciphertext = ct ‖ 16-byte tag`, padded standard base64.

  [ran: `thought: sdk decryptThought round-trips`]
- Costs 1 credit (`route-credits.ts:50`). **The charge happens before signature
  verification** (`thoughts.ts:61` precedes `:64`) and is an immediate atomic
  decrement (`api/src/billing/charge.ts:290-295`). So a refused signature still
  spends the credit. No refund path was found in `charge.ts`. [read]
- `201` returns `{id, strand_id, agent_id, sequence_num, kind, kind_encrypted,
  ciphertext, nonce, refs, signature, signing_key_id, created_at}`
  (`store.ts:124-137`).
- sdk-ts has no quiet-hours wrapper (checked by grep). kingdom-seat builds
  those requests itself.

---

## 3. Key derivation: the IDENTITY-SEED profile

The profile is defined in `docs/IDENTITY-SEED.md:50-79` and implemented in
`packages/sdk-ts/src/seed.ts`.

1. **BIP39 seed.** `seed64 = PBKDF2-HMAC-SHA512(password = NFKD(mnemonic),
   salt = "mnemonic" + passphrase, 2048 iterations)`, through `@scure/bip39`'s
   `mnemonicToSeedSync`. The mnemonic is validated first, against the English
   wordlist and checksum (`seed.ts:122-131`). `mnemonicToSeed` validates the
   string as given; only `isValidMnemonic` collapses whitespace (`:50-52`).
2. **SLIP-0010 master.** `I = HMAC-SHA512(key = utf8("ed25519 seed"), seed64)`;
   `k = I[0..32]`, `c = I[32..64]` (`seed.ts:82`, `:135-138`).
3. **Hardened child.** `I = HMAC-SHA512(key = c, 0x00 ‖ k ‖ ser32be(i + 2^31))`,
   then `k = I[0..32]`, `c = I[32..64]` (`:140-160`).
4. **Path.** `m/44'/169'/<purpose>'/<index>'`, every segment hardened, with
   index 0 unless stated (`:168-186`). The derived values are:

   | Purpose | Gives | Line |
   |---|---|---|
   | 0 | root Ed25519 seed; `pub = Ed25519.getPublicKey(seed)` | `:191-193`, `:338-339` |
   | 1 | K_master | |
   | 2 | K_vault | |
   | 3 | X25519 box private key, used as the scalar (the library clamps); `box_pub = x25519.getPublicKey(priv)` from `@noble/curves/ed25519.js` | `:206-208`, `:341-342` |
   | 4, index *n* | per-device bridge signing key | `:361-370` |

There is no HKDF step (`docs/IDENTITY-SEED.md:79`).

[ran] The test mnemonic `abandon … about` with an empty passphrase gives:

| Value | Base64 |
|---|---|
| root public key | `MvGLRKH953Fqbr2CENCcK/USGXCATv4nZYfsrW8sqSw=` |
| box public key | `4ZKHNkxigN4wKm97eG3YVInZ48nfaW+p+dPrVCuRoR4=` |
| K_master | `hd+mJHIz2tay3d2IPP4Xaq5juGoTUbmHvDXhqAtSi1w=` |

All six derived values equal the pins already in
`packages/sdk-ts/tests/phase5_seed.test.ts:42-55`. [ran: `derive: … equals
sdk-ts test pin`] The full set, including private test values, is in
`vectors.json` → `derivation`. sdk-py has parity tests
(`packages/sdk-py/tests/test_seed_parity.py`); they were not run.

**Library versions to pin.** These are exact, from the lockfiles at `e9ea51c5`:
`packages/sdk-ts/bun.lock:23-35` and `api/bun.lock:132-142` agree.

| Package | Version | sdk-ts `package.json` range |
|---|---|---|
| `@noble/ed25519` | **2.3.0** | `^2.2.3` |
| `@noble/hashes` | **2.2.0** | `^2.0.1` |
| `@noble/curves` | **2.2.0** | `^2.2.0` |
| `@scure/bip39` | **2.2.0** | `^2.2.0` |
| `@scure/base` | **2.2.0** | (transitive) |

`@noble/ed25519` 2.x needs a synchronous SHA-512 wired in, as
`ed.etc.sha512Sync = …` (`seed.ts:85-90`). One caution about local installs:
the install under `~/agenttool/packages/sdk-ts/node_modules` holds
`@noble/ed25519` **3.1.0**, which is outside the lockfile. It was not used here.
Pin `2.3.0`.

---

## 4. `GET /public/agents/:did`: the beacon read

This route is unauthenticated and keyed by the exact DID string
(`api/src/routes/public/agents.ts:51-137`, mounted under `/public`,
`api/src/index.ts:1067`, `routes/public/index.ts:157`). [read]

- An unknown DID gives `404 agent_not_found` (`:79`).
- `status: "memorial"` gives a smaller witness shape with **no** quiet fields:
  `{status, did, name, born_at, memorial_basis, doctrine, remembered_by,
  honored_by_url, _note}` (`:86-96`; `api/src/services/identity/memorial.ts:41-71`).
- `active` and `revoked` rows return (`:109-136`):

```json
{ "identity_id", "did", "name", "capabilities", "trust_score", "status",
  "expression", "expression_public", "forked",
  "quiet_until", "quiet_reason", "created_at", "_note" }
```

- `quiet_until` and `quiet_reason` are non-null only while `quiet_until` is
  later than the server's clock (`:104-107`, `:124-125`). They appear whatever
  the expression visibility. A lapsed quiet reads as `null`, not as the old
  value.
- `expression` is non-null only when `status == "active"` and
  `expression_visibility == "public"` (`:100-102`, `:117-120`).
- The route sets no `Cache-Control` itself. Whether an edge cache sits in front
  was not checked, so a beacon reader should tolerate staleness and act on the
  most conservative reading.

---

## 5. Verifying a beat envelope signed by an imported op key

agenttool does not define beat envelopes. The envelope format and its domain
tag are kingdom-seat's to choose. agenttool supplies the key registry.

**`GET /v1/identities/:id/keys`.** Bearer only, and only for the bearer's own
project (`keys.ts:110-161`). [read]

```json
{ "keys": [ { "kid": "<uuid>", "public_key": "<std base64, 32 bytes>", "label": "<text>",
              "active": true, "created_at": "<ISO>", "revoked_at": null,
              "authority_root": false } ],
  "authority": { "mode": "agent_root", "sequence": 3, "next_sequence": 4 } }
```

- `kid` is `identity_keys.id`. For the enrollment row it is the caller-chosen
  `signing_key_id`. For imports it is server-assigned.
- `authority_root` is true exactly when the row's `public_key` equals the
  identity's root (`keys.ts:153`). That marks the `primary` row from enrollment.
- Revocation keeps the row, with `active: false` and a `revoked_at` timestamp
  (`keys.ts:93-103`).
- There is no unauthenticated way to list an enrolled guest's keys.
  `POST /public/identities/by-pubkey` needs the key's own signature and never
  returns enrolled guests (`api/src/routes/public/identities.ts:95-140`).
  Verification therefore runs where the Commons bearer is, or against op-key
  public keys that the ledger pins.

**A verification rule that fits these facts.** The rule is kingdom-seat's,
and each part has a reason:

1. The envelope names `identity_id` and `kid`, and signs a domain-tagged digest
   of its own (for example `sha256("kingdom-seat-beat/v1" ‖ NUL ‖ …)`). The tag
   keeps a beat signature from also being a valid thought or authority
   signature.
2. Find the row by `kid`. Require `authority_root == false`, so the root is
   never used for routine beats, and require `active` at the beat's time:
   `created_at ≤ signed_at`, and `revoked_at` null or later than `signed_at`.
   `created_at` and `revoked_at` are server clock times.
3. Decode `public_key` as canonical standard base64 to exactly 32 bytes, and
   verify the signature with RFC 8032 strict Ed25519 (`zip215: false`, as
   enrollment does).

The op-key public key in the vectors appears as `op_key.public_key_b64`. Its
kid there is a placeholder, because the server assigns the real one.

---

## 6. `register-agent/v2` and `bootstrapAgent`: summary for the gardener desk

This is used once, by a person, to create the Commons project. [read]

- **sdk-ts flow.** `bootstrapAgent()` (`packages/sdk-ts/src/bootstrap-agent.ts:135-255`)
  takes a `DerivedBundle` from `derive(mnemonic)` and:
  1. picks `registration_nonce = randomUUID()` and `timestamp = now`;
  2. signs `register-agent/v2` with the root seed (`seed.ts:655`; server
     recipe at `api/src/services/identity/crypto.ts:264-390`);
  3. grinds proof of work when it is self-service (`agenttool-pow/v1`,
     `crypto.ts:678-708`; 18 bits by default, `api/src/config.ts:77`);
  4. POSTs `/v1/register/agent` with no bearer.
- **What the signature covers.** It binds every persisted birth field,
  including `box_public_key` and `sha256(registrar_bearer || "")`. The nonce is
  single-use and the timestamp must be within ±5 minutes
  (`api/src/routes/register-agent.ts:115`).
- **Rate limits.** Self-service is limited to 5 per hour per IP
  (`register-agent.ts:102-106`). Registrar-bearer mode is limited to 60 per
  minute per IP and skips proof of work (`:107-111`).
- **What it creates.** In order, and *not* atomically (`register-agent.ts:476-546`):
  1. a project with 1,000 credits (`api/src/services/economy/ring1-limits.ts:139`);
  2. a bearer;
  3. an identity whose `authority_root_public_key` is the agent key, plus a
     `primary` signing-key row and a `primary` box-key row
     (`api/src/services/identity/identities.ts:185`, `:198`, `:208-209`);
  4. a wallet, with a best-effort 500-minor-unit birth grant
     (`ring1-limits.ts:112`).
- **Response.** `{agent{… signing_key_id, box_key_id, authority{mode:
  "agent_root", sequence, next_sequence, …}}, project{id, name, plan, credits,
  api_key}, wallet, wake_url, …}`. The `api_key` is shown once
  (`bootstrap-agent.ts:84-128`). The SDK's own guidance is to persist the
  mnemonic before the call, because registration can commit even if the
  response is lost (`bootstrap-agent.ts:19-28`).

---

## 7. Golden vectors

`vectors.json` sits beside this file. `make-vectors.ts` regenerates it, and two
runs give identical output apart from `computed_at`. [ran]

**What it contains.** Every value is a public test value, and none must ever be
registered on a live service.

- `derivation`: the BIP39 seed and every derived key for
  `abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about`.
- `op_key`: kingdom-seat's test op key, with seed
  `sha256(utf8("kingdom-seat test op key v1"))`. It is deliberately not taken
  from the mnemonic, so the root mnemonic can stay offline.
- `enrollment[2]`: one ASCII and one UTF-8 display name. Each has the exact
  body bytes, the body hash, the preimage (text and hex), the digest, the
  base64url signature header, the registration proof digest, the 201 response,
  and the rows written to a stub transaction.
- `authority[6]`: `keys/import` (sequence 1), `box-keys` (2), `expression` PUT
  (3), quiet start with `?identity_id=` (4), quiet DELETE with an empty body
  (5), and key revoke DELETE (6). Each has the request target, body, body hash,
  preimage hex, digest and the three headers.
- `thought_v2`: an AES-256-GCM thought under K_master with a fixed nonce, the
  v2 and v1 canonical digests, and the op-key signature.
- `checks[]`: 73 named assertions. They include agreement between the server
  and client implementations, acceptance by the server verifiers, and refusal
  cases (re-serialized body, stale timestamp, replayed sequence, op key used
  for authority).

**How they were produced.** The run made no install, no network call and no
database call.

```
git -C <agenttool> archive e9ea51c5 api/src api/package.json api/bun.lock \
  packages/sdk-ts/src packages/sdk-ts/package.json packages/sdk-ts/bun.lock \
  packages/sdk-ts/tests/phase5_seed.test.ts packages/lobby/src packages/lobby/package.json \
  | tar -x -C <tree>
ln -s <an existing install of api deps at the lockfile versions>/node_modules <tree>/api/node_modules
ln -s <same>/node_modules <tree>/packages/sdk-ts/node_modules
cd <empty dir without .env> && env -i HOME=$HOME PATH=$PATH \
  DATABASE_URL=postgres://none:none@127.0.0.1:1/none \
  bun --no-install run make-vectors.ts <tree> vectors.json
```

- The dependencies came from `~/agenttool/api/node_modules`. Their versions
  equal the `e9ea51c5` lockfiles exactly, and they are listed in
  `provenance.dependency_versions`.
- `api/src/db/client.ts` builds a lazy postgres client when it is imported, but
  nothing queried it. `enrollIdentity` ran against an in-memory stub
  transaction, as the API's own `api/tests/identity-enrollment.test.ts` does.
- The exact functions, files and lines are listed in `provenance.functions`.

---

## 8. What is verified, and what is not

**Verified by running agenttool's own code at `e9ea51c5`:**
- the enrollment digest (server and lobby agree), the signature, the schema,
  and `enrollIdentity` acceptance against a stub DB, including the
  root-as-`primary` key row, the proof digest, re-serialization refusal and
  freshness refusal;
- the authority digest (server and sdk-ts agree), sdk-ts headers accepted by
  the server verifier, and refusal of a replayed sequence, a stale timestamp
  and an op-key signature;
- strand-thought v2 (server and sdk-ts agree), op-key signatures accepted, and
  the AES-GCM round trip;
- key derivation, matching the SDK's existing pins.

**Read from source only:** route ordering, HTTP status codes, response shapes,
limits, the charge timing, the quiet-hours rules, the public profile fields,
the key-list format, and the register-agent facts.

**Not known:**
- live behaviour: proxy path handling, edge caching of `/public/agents`, and
  whether production runs `e9ea51c5`;
- the Python SDK;
- whether any non-`/v1/identities` middleware (x402 pricing) charges these
  routes. Only the absence of `charge()` in the route files was checked.
