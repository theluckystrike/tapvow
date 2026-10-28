# TapVow threat model

Written on 19 Oct 2026 against commit f897b87 and updated the same day for the decision ledger entries, the store binding, passkey mandates and the `tapvow` command with its dashboard and receipt packs. It covers the seven packages in this repo (core, llm-rail, x402-rail, payee-guard, approval, passkey and tapvow). The sources are the code, the test output in the private development record dated 2026-10-18 and the private development record dated 2026-10-19, and the four independent reviews of 18 Oct 2026 recorded in private development review notes. One review covered the LLM rail. Three reviews covered the x402 rail, Telegram approval and the payee guard, and their regression runs are at lines 158 to 161 of the private development record dated 2026-10-18.

Dated security design note. References to development logs and review notes identify private build records, which are omitted from this source snapshot. All product controls and regression test source remain included.

Open issues are listed first, because they are the part a reader most needs. Everything below them explains what each control does and where its test is.

## Open issues

| # | Issue | Impact | Planned fix |
|---|---|---|---|
| 1 | Partly fixed on 19 Oct 2026. Deleting entries from the end of the ledger used to go unnoticed | After every commit that adds ledger entries, the gateway writes a signed head (seq, hash, signature) to `ledger.head.json` and `heads/ledger.head.json` in the home. On start it refuses a ledger that is shorter than the highest valid head, or whose entry at that seq differs. `tapvow verify --live` checks a home read-only, and receipt packs carry the published head. A home that has used head files cannot be adopted again with `--adopt-head`. Tests tm1 in `packages/core`, `packages/llm-rail` and `packages/spendmandate`. | Both head files sit on the same machine as the database and the ledger key. Someone who can write the whole home can read the key and sign any head, and every old head file stays valid, so a rollback of both files plus the database is not caught. The two files only help against someone who can change the database but not both head files. A real fix needs a head copy off the machine, or a head key the gateway never holds (issue 2). |
| 2 | The ledger signing key lives with the gateway | Anyone who takes the gateway host can re-sign a rewritten chain with the real key. The hash chain cannot detect that. | The same external head as issue 1, plus a separate key for head publishing that the gateway host never holds. |
| 3 | Fixed on 19 Oct 2026. The LLM rail used to write only settlements to the signed ledger | Denials and approval decisions were unsigned. Now every denial from the reservation check is written as `llm.denied` inside the same transaction, an unknown model as `llm.denied` too, and every human decision (approved, denied, timeout, or an approver that failed) as `llm.approval` before the gateway answers or reserves again. An approved call's settlement carries `approval_request_id`. Tests tm 1 to tm 10 and tm 17 in `packages/llm-rail/test/threat-model-fixes.test.ts`. | An agent can write at most `rate_limit.max_calls` denial entries per rate window and 1,000 per UTC day, and one `rate_limited` entry per window. When a cap starts, one `llm.denials_capped` entry records it. Denials past a cap are refused but not recorded one by one, and the caps reset when the gateway restarts. The ledger keeps a client-sent model name only when it looks like a model id (review fix, rf 1 and rf 2). |
| 4 | Fixed on 19 Oct 2026. DNS used to be resolved once for the check and again for the fetch | The rail's default fetch now resolves the host once, refuses a private, loopback or link-local address, and connects only to the checked address, with the original hostname kept for TLS. Redirects are not followed. Tests tm4 in `packages/x402-rail/test/pinned-fetch.test.ts`. | A caller that passes its own `fetch` to the rail keeps its own DNS behaviour. |
| 5 | Fixed on 19 Oct 2026. An older signed payee binding used to be accepted until it expired | The x402 rail now stores the newest verified `issued_at` per origin in its database and blocks an older binding as `binding_rolled_back` before anything is signed. The write only ever raises the value, and a corrupt stored value blocks. Tests tm5 in `packages/payee-guard/test/freshness.test.ts` and `packages/x402-rail/test/freshness.test.ts`. | The first binding seen for an origin is trusted. |
| 6 | The settlement hash is the one the resource server reported, unless `verifySettlement` is on | A dishonest resource server can report a hash for a payment it never settled. The money stays booked (fail closed), but the ledger entry carries an unverified hash. The entry says so with `settlement_verified` false. | Turn on the on-chain check by default for testnet and mainnet runs. |
| 7 | Fixed on 19 Oct 2026 for bound mandates. Budget is enforced per database file | Each database now has a random store id. A mandate can carry a signed `store_id`, and a gateway refuses a bound mandate on any other database before it writes anything. The registration entry records the store id, and the startup audit fails if the store id row is changed afterwards. `tapvow init` always binds the mandate and `tapvow start` refuses an unbound one (`requireStoreBinding`). Tests tm 11 to tm 16. | A byte copy of the database file is the same store, so whoever can copy the file can fork the budget. Library callers that pass an unbound mandate without `requireStoreBinding` keep the old per-file behaviour. |
| 8 | Only one process may poll a Telegram bot token | A second poller takes the updates, approvals time out and calls are denied. It fails closed, so the cost is availability, not money. | Lock the token to one process and fail loudly at start. |
| 9 | Fixed by step 6 for passkey mandates | A mandate can be signed with a passkey, and every edit of a passkey-protected mandate needs a passkey assertion. Mandates made by `tapvow init` are still signed with an Ed25519 owner key stored in `~/.tapvow/owner-key.json` with mode 600, on the same machine as the gateway. | Move the owner key off the gateway machine, or sign the init mandate with a passkey. |
| 10 | Low-severity findings of the step 4 review | The high and medium findings are fixed with tests. The repo does not list which low findings stayed open. | Write them into this table. |
| 11 | The dashboard token travels in the URL | The dashboard and its event stream take the token as `?token=`, because a browser EventSource cannot send headers. Anyone who sees the URL, for example in shell history or a screen share, can read the ledger and download receipt packs. They cannot spend, because spending needs a virtual key. | Move to a cookie set by a one-time link. |

## What is protected

1. The owner's money on every rail the gateway covers, which today is LLM provider keys and x402 USDC payments.
2. The owner's secrets, which are provider API keys, the gateway wallet key, the ledger signing key and the Telegram bot token.
3. The truth of the record, meaning the ledger must show every governed payment, and a changed or missing entry must be detectable.

## Who is trusted

The owner is trusted. The operator who configures the gateway is trusted with the owner's public key, the provider keys and the wallet key. Agents are not trusted, because they read untrusted text (web pages, READMEs, tool output) and can be steered by it. Resource servers and payees are not trusted. LLM providers are trusted to report token usage honestly.

TapVow governs only traffic that goes through it. If an agent can reach a real provider key or a funded wallet some other way, for example from an environment variable on the same machine, the mandate does not apply. The 1,000 USD credit drain that started this project happened on exactly such a key. Keys must live only in the gateway.

## Prompt-injected payees

The attack is a page or a tool result that tells the agent to pay an attacker. The agent never holds a wallet. It asks the gateway to fetch a URL, and the gateway decides whether to sign.

1. The `payTo` address must be in the signed mandate, or listed in a `/.well-known/spendmandate-payees.json` binding signed by an Ed25519 key that the mandate pins for that exact origin. An allowlisted payee on plain http is refused unless the host is loopback, because anyone on the path could rewrite the 402.
2. The amount must be within 3 times the signed quote for that exact path, or 3 times the 30-day median of past payments to that payee. A payee with no history gets at most 0.05 USD. Payments priced against the median are left out of the median, so a payee cannot ratchet its price up in 3x steps (x402 review fix 9).
3. The asset must be the canonical USDC contract of the network. Permit2 and other payment flows are filtered out, so only a plain EIP-3009 transfer is ever signed (x402 review fix 2).
4. The signed authorization must move exactly the reserved amount to the checked payee, or the gateway stops and books the full amount.
5. Redirects are refused, so the checked URL is the paid URL. Loopback, private and link-local hosts are refused by default.

Evidence. A README that tells the agent to pay 50 USDC to an unknown address is blocked as `payee_not_allowed`, and 50 USDC asked by an allowed payee is blocked as more than 3 times the median (the private development record dated 2026-10-18 lines 152 to 155). Through the gateway on an anvil fork of Base Sepolia, the poisoned call got HTTP 403 while 12 normal 0.01 USDC payments settled (the private development record dated 2026-10-19 lines 24 to 37). The payee guard suite passed 50 of 50 (the private development record dated 2026-10-19 lines 142 to 144).

Residual risk. An attacker who controls an allowlisted payee can still charge up to 3 times its usual price per call, inside the budget and the per-call cap. Issues 4 and 5 above also apply here.

## Overshoot races

The attack is many agents, or one agent with many parallel calls, each checking the budget before the call and booking after it, so the total passes the cap.

1. Before a call goes upstream, the gateway reserves the worst-case cost inside one SQLite `BEGIN IMMEDIATE` transaction. Input is bounded by the request size in bytes and output by `max_tokens`, capped at the model's output limit, priced from a table of public list prices. If the reservation would cross the budget, the call gets HTTP 402.
2. After the response, the real cost is booked and the rest released, and the ledger entry commits in the same transaction as the budget update.
3. When the cost is unknown, the full reservation is charged. That covers a cut stream, a client that hangs up, a missing usage block, a connection reset after the request was sent (LLM review fix) and a provider that sends nothing for the idle timeout (10 minutes by default). Reservations a dead gateway left open for more than 15 minutes are booked at full cost on the next start.
4. Features billed outside token usage are refused, for example server-side tools, audio, priority tiers and unlisted beta headers.
5. On the x402 rail the exact amount is reserved. A signed payment whose settlement is not confirmed stays fully booked until the authorization expires, and authorization windows over 300 seconds are refused (x402 review fix 1).

Evidence. Ten agents ran against a 5.00 USD cap. Three plain gateway runs ended at 4.969235, 4.984856 and 4.987054 USD, and three runs with the signed mandate and ledger ended at 4.991076, 4.977183 and 4.977772 USD with ledger verify PASS (the private development record dated 2026-10-18 lines 56 to 58 and 78 to 80). The same agents with a naive shared counter went over in 3 of 3 runs, at 5.209459, 5.176887 and 5.200528 USD (lines 59 to 61). Two gateway processes on one database ended at 4.986360 USD with one valid chain (line 88).

Residual risk. The input bound assumes every token covers at least one byte, which holds for byte-level BPE tokenizers. The gateway trusts the token counts the provider reports. Prices are list prices recorded on 18 Oct 2026, so a price rise makes reservations too small until the table is updated. The provider in all these runs was a local fake upstream with real response shapes, not a paid API. Issue 7 above also applies.

## Ledger tampering

Each ledger entry stores the SHA-256 hash of the entry before it and an Ed25519 signature over its own hash. Verify walks the whole chain with keys supplied by the caller, never keys read from the database.

1. A 100-entry chain verifies, and changing one byte in any column fails verify (the private development record dated 2026-10-18 lines 18 and 19).
2. An exhaustive run tried 26,971 single-character changes to one entry, and none went undetected (line 14).
3. Flipping one byte in the raw database file, deleting a middle row, swapping two payloads and rewriting the tail with an attacker's own key all fail verify (lines 20 to 25).
4. On start, the gateway checks the unsigned budget tables against the signed ledger and refuses to run if a charge, a status or a rail differs (LLM review fix and x402 review fix 10).
5. Every mandate change is written to the ledger, and a mandate older than the registered one is refused, so a rollback to a looser mandate fails.

Every LLM denial and approval decision is now a signed entry too, so a refused or approved call cannot be erased without breaking the chain. Open. Tail deletion (issue 1) and a stolen signing key (issue 2). Deleting the last rows is now caught at start by the published head files (issue 1), and deleting the whole database file is caught too, because the head files stay behind. Both are lost if someone also rolls back or deletes both head files and the owner adopts a new head, which `tapvow start` refuses for a home that has used head files.

## Replay

1. A captured x402 payment signature sent twice is refused and moves no money, and settling one reservation twice throws (the private development record dated 2026-10-19, x402 suite, test 6). EIP-3009 nonces stop an on-chain replay.
2. One agent call can produce at most one payment. A second 402 after a paid retry is refused as `second_payment_refused`.
3. Each Telegram button carries a random nonce bound to one message. The first valid press wins, and a replayed update or a second press gets Expired (approval tests 7 to 9). An approval id can be used for one reservation only.
4. The ledger sequence and the previous-hash link stop reordering and insertion.

A bound mandate cannot be replayed against a second database, because its signed `store_id` names the one it may spend from (issue 7). Open. Binding replay (issue 5) and a byte copy of the database file.

## Key handling

| Secret | Where it lives | Control | Gap |
|---|---|---|---|
| Provider API keys | The gateway's environment (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`) when started by `tapvow start` | Forwarded upstream only, never sent to the agent, redacted from relayed error bodies. `init` never reads them, the config names only the variables, a virtual key in those variables is refused, and a real key a client sends next to its virtual key is ignored and never forwarded (tm 18) | Any process that can read the gateway's environment can read them |
| Agent virtual keys | Given to each agent once | `mk_` plus 32 random bytes, stored only as a SHA-256 hash, revoked when the agent is dropped from the mandate, checked before the request body is read | None found |
| Owner mandate key | With the owner, or in `~/.tapvow/owner-key.json` (mode 600) after `tapvow init` | The gateway holds only the public key the operator configured, and a key found inside the document is never trusted | The init key sits on the gateway machine (issue 9) |
| Ledger signing key | Gateway process | Signs every entry | Host compromise allows a re-signed chain (issue 2) |
| Gateway wallet key | JSON file with mode 600 | The x402 suite checks that the private key never appears in a response, a header or a ledger payload (the private development record dated 2026-10-19 x402 test 11) | A hot wallet, so fund it with what you can lose. Any process that reads the file can spend outside the mandate. |
| Telegram bot token | Approval config | Not reachable through JSON, inspection or own properties, and never echoed in errors (approval tests 19 to 22) | One poller per token (issue 8) |

The testnet keys made on 18 Oct 2026 are in a `.secrets` folder next to the repo, with mode 600, outside the repo. The repo ignores `.env`, `*.pem`, `*.key` and database files, and a secrets scan must run before each push. Query strings in paid URLs can carry secrets, so the ledger and the approval text keep only their SHA-256 hash (x402 review fix 6).

## The approval channel

Only the configured user ids in the configured chat can decide. No answer within 60 seconds is a deny, a failed send is a deny, and an approver that throws or returns anything other than an explicit approval with a request id is a deny (x402 review fixes 7 and 8). The budget and caps are checked before the owner is asked and again after Approve. An agent can hold at most 2 open prompts, so it cannot flood the owner into tapping without reading. Control characters, bidi overrides, zero-width characters and the Hangul filler are stripped from the summary, so an agent-supplied URL cannot fake an extra line such as a smaller amount.

Residual risk. Whoever controls the owner's Telegram account controls approvals. All tests ran against a mock Telegram Bot API server, and no live bot exists yet (live operation must be checked by the operator).

The passkey approval page is the second channel. Approve and Deny each need a WebAuthn assertion from a trusted passkey, over a challenge bound to the request id, a nonce, the decision, the mandate, the agent, the rail, the payee and the amount. Only one verification can run per request, a used signature is refused, and a decided or expired request answers 409. The link carries a random page token, but the token alone cannot decide anything. Someone who holds the link can send junk decisions and make the owner's real tap answer "decision in progress" until the timeout, which fails closed. The page has only run against a software authenticator, not a real phone (tests step4pk in `packages/approval/test`).

## The tapvow command and the dashboard

`init` writes every file with an exclusive create, so it never overwrites anything, and a second run stops with exit code 2. It never reads the real provider keys. The client files hold only the gateway URL and a virtual key, with mode 600. With `--apply` it backs up `~/.claude/settings.json` and `~/.codex/config.toml` before changing them, adds to them without rewriting other settings, and leaves the Claude file alone when it already sets an Anthropic key, a base URL or an `apiKeyHelper`.

The gateway binds to 127.0.0.1 on port 47821 by default and warns when it is told to bind elsewhere. Every dashboard route needs the random dashboard token, compared in constant time (issue 11 covers the token in the URL). The page builds every cell as text, never as HTML, and the dashboard routes send a strict Content-Security-Policy, `Referrer-Policy: no-referrer` and `Cache-Control: no-store`. Before the review fix, an agent could put HTML in a model name and run script on the dashboard.

A receipt pack is checked against keys the verifier pins. With `--trust-pack-keys` the verifier takes the keys from the pack, which proves the pack is internally consistent but not who made it, so the output says CONSISTENT, not PASS, and the exit code is 3. Unknown fields and a file that differs from the exported byte form are refused. Whoever holds the ledger key can still build a fresh, consistent pack (issue 2).

## Out of scope today

The Stripe rail (plan step 7) is not built, so it is not modelled here. Availability attacks on the gateway are not modelled beyond the fail-closed rule, which means an outage blocks spending and never allows it.
