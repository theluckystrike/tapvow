# TapVow

TapVow puts one signed spending limit in front of every AI agent you run, enforces it on each paid call, and keeps a tamper-evident receipt of every cent. It is a small local gateway. Your agents get virtual keys, the gateway holds the real ones, and a call that would break the limit is refused before it reaches the provider. The same budget covers LLM calls and x402 payments. It never holds funds. MIT, Node 22.13 or newer, no native dependencies.

## Quick start

For a local demo without an install or build, download the [portable judge kit](https://github.com/theluckystrike/tapvow/releases/tag/nebius-judge-20261030), verify its published checksum, extract it, and run `bash judge.sh` then `bash check-acceptance.sh`. It requires Bash and Node 22.13 or newer. It uses a local fake provider and simulated accounting, with no model call or spend. The kit contains an older compiled gateway whose budget cards need a reload; the dashboard source in this repository includes the later refresh repair.

The npm package is not published yet. Build the source with Node 22.13 or newer. These commands start a demo with no provider key and no paid call.

```sh
git clone https://github.com/theluckystrike/tapvow.git
cd tapvow
npm ci
npm run build --workspace tapvow
node packages/spendmandate/dist/cli.js init --budget 10
node packages/spendmandate/dist/cli.js start --fake-upstream
```

Run the CLI commands below from the clone root. To use your provider account, stop the demo gateway and start it with your own key.

```sh
ANTHROPIC_API_KEY=sk-ant-... node packages/spendmandate/dist/cli.js start
```

Agent calls through this gateway use your provider account. The real key stays in the gateway process.

Then, in the shell where your agent runs, paste one line.

| Agent | Line to paste | What it sets |
|---|---|---|
| Claude Code (API key billing) | `source ~/.tapvow/clients/claude-code.env` | `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_MODEL`, `ANTHROPIC_SMALL_FAST_MODEL`, `CLAUDE_CODE_MAX_OUTPUT_TOKENS` |
| OpenCode | `source ~/.tapvow/clients/opencode.env` | `OPENCODE_CONFIG`, a config with the `anthropic` and `tapvow-openai` providers |
| OpenAI SDK, LangChain, your own agents | `source ~/.tapvow/clients/openai.env` | `OPENAI_BASE_URL`, `OPENAI_API_KEY` |
| Codex | not supported yet | Codex now calls only the OpenAI Responses API, which the gateway does not speak |

`node packages/spendmandate/dist/cli.js init --apply` writes the Claude Code lines into `~/.claude/settings.json` instead, after a backup. To try it with no key and no spend, run `node packages/spendmandate/dist/cli.js start --fake-upstream` from the clone root.

Your agent now gets a virtual key. The gateway holds the real key, reserves the worst-case cost of each call before it goes out, and refuses a call that would break the cap with HTTP 402. Claude Code shows the reason, for example `API Error: 402 amount exceeds per-call cap ... Lower max_tokens to 4726 or less`. Each reply carries `X-Mandate-Charged-Micros` and `X-Mandate-Remaining-Micros` headers, and every charge and refusal is a signed ledger entry. `start` prints a dashboard link.

On 23 Oct 2026 this ran from an empty folder with a fresh HOME, from the packed tarball, with the fake provider: install, init, start, one Claude Code 2.x call, one OpenCode 1.19 call and one chat completions call took 6.2 seconds of machine time. That run used a local tarball, not a registry download.

Claude Code on a Pro or Max subscription does not use an API key, so there is nothing to cap there. The gateway caps API-key traffic.

## Nebius and NVIDIA Nemotron

TapVow can cap spend on [Nebius Token Factory](https://tokenfactory.nebius.com), which serves NVIDIA Nemotron and other open models behind an OpenAI-compatible API. A Nemotron call gets the same worst-case reservation, cap check and signed ledger entry as any other call. The gateway asks Nebius for streamed usage (`stream_options.include_usage`), so a streamed call settles at its real token count, not at the hold.

Setup in 4 steps.

1. Create an API key at [tokenfactory.nebius.com](https://tokenfactory.nebius.com).
2. From the clone root, run `node packages/spendmandate/dist/cli.js init --provider nebius --budget 0.05`. The signed mandate allows Nebius only, with 0.05 USD a day. It writes `~/.tapvow/clients/nebius.env` and an OpenCode config with a `tapvow-nebius` provider. Use `--provider nebius,anthropic` or `--provider all` to allow more than one provider.
3. Run `NEBIUS_API_KEY=<your key> node packages/spendmandate/dist/cli.js start` in its own terminal. This step needs a real Nebius key; the steps above make no provider calls. Only this process holds the real key.
4. In the shell where your agent runs, run `source ~/.tapvow/clients/nebius.env`. It sets `OPENAI_BASE_URL`, `OPENAI_API_KEY` (a virtual key) and `TAPVOW_MODEL=nvidia/nemotron-3-super-120b-a12b`, so the OpenAI SDK and LangChain work unchanged. For OpenCode, run `source ~/.tapvow/clients/opencode.env` and pick a `tapvow-nebius/*` model.

A call that would break the daily budget gets HTTP 402 with the reason, for example `budget exceeded. This call reserves up to 0.020410 USD (input bound 55744 tokens and max_tokens 4096 on nvidia/nemotron-3-super-120b-a12b). The budget is 0.050000 USD per day (UTC), 0.033022 USD is already spent or held, so 0.016978 USD is left.` The call never reaches Nebius.

Prices in USD per 1M tokens, read on 23 Oct 2026 from the public Token Factory catalog at `https://tokenfactory.nebius.com/api/public/models_info` (base flavor).

| Model id | Input | Cached input | Output |
|---|---|---|---|
| `nvidia/nemotron-3-super-120b-a12b` (default) | 0.30 | 0.06 | 0.90 |
| `nvidia/Nemotron-3-Ultra-550b-a55b` | 1.00 | 0.12 | 3.00 |
| `nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B` | 0.06 | not listed | 0.24 |
| `nvidia/Nemotron-3_5-Lightning` | 0.06 | not listed | 0.24 |
| `moonshotai/Kimi-K2.7-Code` | 0.95 | 0.15 | 4.00 |
| `deepseek-ai/DeepSeek-V4-Flash-0731` | 0.14 | 0.01 | 0.28 |
| `openai/gpt-oss-120b` | 0.15 | not listed | 0.60 |

Where no cached price is listed, cached input bills at the input price. Nebius publishes no output limit per model, so the gateway clamps `max_tokens` at 32,768 for these models. The gateway speaks chat completions only, not the Responses API that Nebius also offers.

To see it work, run `examples/nebius-demo/run.sh`. A small coding agent on Nemotron writes and tests a module through the gateway until the daily budget stops it, and then the receipt ledger is exported and verified. It needs `NEBIUS_API_KEY` (or `NEBIUS_API_KEY_FILE` pointing at a 0600 file) and refuses to start without one. `examples/nebius-demo/run.sh --fake` runs the same flow against a local stand-in for Nebius, with no key and no spend, and CI runs it on every push. The demo has also run against the live Nebius API. On 26 Oct 2026, 6 calls on Nemotron 3 Super settled for 0.014891 USD under a 0.02 USD daily budget. On 27 Oct 2026, 2 calls settled for 0.003072 USD under a 0.005 USD daily budget. Both times the next call got HTTP 402 before it reached Nebius, and the signed ledger verified. In those two runs the agent read code from only 1 of 8 replies, because Nemotron often answers with plain `// file:` sections and no Markdown fences, and the old parser read only fences. The fixed agent reads both forms and turns Nemotron's reasoning off by default. In a later run on 27 Oct 2026, all 4 replies gave code. The code passed its own tests from call 2 on, and after call 4 it had 17 passing tests. The 4 calls settled for 0.004403 USD under a 0.010 USD daily budget. Then the next call got HTTP 402 and the ledger verified. The module from that historical run rejects `1h30m` written without a space, and its own tests do not check that case.

The current agent also runs fixed acceptance checks for the initial task, including `1h30m`, before it saves a candidate or advances the feature backlog. Both complete generated files and both test suites must pass. After two failed repair attempts it stops; a later failed candidate cannot replace the last accepted files. A budget refusal before any accepted result is a failed run. Run `node --test examples/nebius-demo/agent.acceptance.test.mjs` for five local regression cases with no provider key or spend. These local checks do not change the historical model results above. Later backlog features still depend on the generated tests.

## What it does not do yet

- So far only my own agents run through it. It started on 18 Oct 2026, and you would be one of the first outside users.
- x402 payments have settled on the Base Sepolia testnet only, 59 of them at 0.01 USDC. Nothing has been paid on mainnet.
- The Stripe rail has run only against a fake Stripe API. The passkey approval page has not been tried on a real phone, and no process polls the Telegram bot yet.
- The gateway speaks OpenAI chat completions and Anthropic messages, not the OpenAI Responses API. Prices come from a static table of list prices, and unknown models are refused, not priced at zero.
- Anyone with full access to the gateway machine can cut the tail of the ledger or copy the database and fork the budget. The details are in the Limits section and in `docs/THREAT-MODEL.md`.

## Status

Status on 20 Oct 2026. The signed ledger, the LLM rail, the x402 rail, the passkey approval page with Telegram as an optional channel, the payee guard, passkey-signed mandates, the `tapvow` command and the live ledger dashboard work and are tested. The x402 rail has settled 59 live payments of 0.01 USDC on the Base Sepolia testnet and none on mainnet (see Limits). The Stripe rail is built and tested against a fake Stripe API, and its end-to-end test waits for a Stripe sandbox key. A dogfood run on real DeepSeek calls (a 24 hour window, with real calls in its first 3 h 52 min) through the owner's model lock ended on 19 Oct (step 10 below). Nothing here holds funds.

TapVow was first called SpendMandate and was renamed on 19 Oct 2026. Tests named `tm1 spendmandate-*` in logs dated 18 and 19 Oct 2026 are now named `tm1 tapvow-*`.

## Install from source

The `tapvow` package source is in `packages/spendmandate`. npm publication is pending. Use the source build in Quick start.

To make an optional local package file, run this command from the clone root.

```sh
npm pack --workspace tapvow
```

This creates `tapvow-0.1.0.tgz`. It can be installed in a separate project. It is a local package file; it has not been downloaded from the npm registry.

Run `node packages/spendmandate/dist/cli.js <command>` from the clone root.

`init` makes an owner key, a ledger key, a signed mandate (5.00 USD a day by default, and a per-call cap of 2.00 USD or the budget when that is lower) and one virtual key each for Claude Code, OpenCode and any OpenAI-compatible client. It writes the base URL and the virtual key for each client into `~/.tapvow/clients`, and prints the line to paste for each agent, not the keys. It never reads your real provider keys and never overwrites a file. With `--apply` it also adds five entries to the `env` block of `~/.claude/settings.json`, after a backup. It leaves that file alone when it already sets an Anthropic key, a base URL, a model or an `apiKeyHelper`. It does not touch the Codex config, because current Codex refuses to load a config with a `wire_api = "chat"` provider.

The per-call cap default is 2.00 USD because Claude Code asks for up to 128,000 output tokens. The Claude Code file sets `CLAUDE_CODE_MAX_OUTPUT_TOKENS=32000`, so a fresh Claude Code call on Sonnet 5.5 reserves about 0.52 USD. The reservation grows with the conversation, because the input bound is the request size in bytes.

The gateway lets through the `anthropic-beta` values that Claude Code and OpenCode send on every call (the list is `DEFAULT_ANTHROPIC_BETAS` in `packages/spendmandate/src/server.ts`). None of them changes the per-token price. Any other beta, such as a 1M context or fast mode beta, gets HTTP 400. Set `allowed_anthropic_betas` in `~/.tapvow/config.json` to change the list.

`start` runs the gateway on 127.0.0.1, port 47821 by default. Without `--fake-upstream` it reads the real keys from `OPENAI_API_KEY` and `ANTHROPIC_API_KEY` in its own environment, so they stay in the gateway process. It prints a dashboard link with a random token.

`node packages/spendmandate/dist/cli.js export --out pack.json --pdf pack.pdf` writes the signed receipt pack, and `node packages/spendmandate/dist/cli.js verify pack.json` checks it. Verify pins the keys from `~/.tapvow/public-keys.json` or from `--keys`. A good pack with pinned keys prints PASS and exits 0. A reader who only has the pack can run it with `--trust-pack-keys`. That proves the pack is consistent but not who made it, so the output says CONSISTENT instead of PASS and the exit code is 3. Verify also refuses unknown fields and a file whose bytes differ from the form `export` writes, which catches duplicate JSON keys.

The plan said Next.js for the dashboard. Disk on the build machine is tight, so the dashboard is one static page served by the gateway, fed by Server-Sent Events. It needs no build step and no extra dependency.

## What is in the repo

`packages/core` holds the mandate format and the ledger.

- A mandate is a JSON document in the shape of a Google AP2 IntentMandate. It carries a budget, a per-call cap, the allowed payees, a rate limit, an approval threshold, an expiry and the rails it covers. The schema is in `packages/core/schema/mandate.schema.json`.
- The owner signs a mandate with Ed25519. The gateway accepts it only when it verifies against the owner key the operator configured. A key found only inside the document is never trusted.
- The ledger is an append-only SQLite table. Each entry stores the SHA-256 hash of the entry before it and an Ed25519 signature. Verify walks the whole chain with keys supplied by the caller, never keys read from the database.
- Every denial and every human approval decision on the LLM rail is a signed ledger entry (`llm.denied`, `llm.approval`), like the x402 rail's `x402.blocked`. An agent can add at most `rate_limit.max_calls` denial entries per rate window and 1,000 per UTC day. When a cap starts, one `llm.denials_capped` entry records it, so a reader knows denials went on. The caps live in the gateway process and reset when it restarts.
- Each database has a random store id. A mandate can name it in a signed `store_id` field, and the gateway then refuses that mandate on any other database. `tapvow init` always binds the mandate, and the command refuses an unbound one.

`packages/spendmandate` holds the `tapvow` command (init, start, export, verify) and is the package intended for public release. It is not in the npm registry yet (404 on 28 Oct 2026), so install it from this repo as above. It bundles the internal `@mandate/*` packages into one file with no runtime dependencies.

- The dashboard at `/dashboard` shows the mandate, the budget, the amount spent and the ledger. It polls the ledger head every 200 ms and pushes new entries over Server-Sent Events, so entries written by a second gateway process on the same file show up too. Every dashboard route needs the token.
- A receipt pack holds the signed mandate, the raw ledger rows, the head, the totals and a head signature by the ledger key. Verify checks the keys, the mandate signature, the whole chain up to the head, the head signature, the registered mandate version, the store id and the totals. The PDF is a readable summary that names the SHA-256 of the JSON pack, and the JSON pack is the record.

`packages/llm-rail` is the first rail. It is a gateway that speaks the OpenAI chat completions API and the Anthropic messages API.

- Each agent gets its own virtual key. The gateway stores only a SHA-256 hash of it and holds the real provider keys itself, so an agent never sees them.
- Before a call goes upstream, the gateway reserves the worst-case cost of that call inside one SQLite `BEGIN IMMEDIATE` transaction. Input is bounded by the request size in bytes, output by `max_tokens` (or `max_completion_tokens`, whichever is larger), and both are priced from a table of public list prices. If the reservation would cross the budget, the call is refused with HTTP 402.
- The output bound never goes past what the model can write. A `max_tokens` above the model's output limit is lowered to that limit, in the reservation and in the request sent upstream, so asking for 1,000,000 tokens no longer trips the per-call cap by itself. A request with no `max_tokens` gets the model's default from the table below. Each reply names the bound it reserved in `X-Mandate-Max-Tokens`.
- A call refused by the per-call cap gets HTTP 402 with the largest `max_tokens` that would fit, in the message and as `suggested_max_tokens`. When even the prompt alone is over the cap, the message says to shorten the prompt.

| Model | Output limit | Default when `max_tokens` is missing |
|---|---|---|
| gpt-4o | 16,384 | 4,096 |
| gpt-4o-mini | 16,384 | 16,384 |
| gpt-4.1 | 32,768 | 4,096 |
| gpt-4.1-mini | 32,768 | 16,384 |
| claude-sonnet-4-5 | 64,000 | 2,048 |
| claude-haiku-4-5 | 64,000 | 8,192 |
| claude-opus-4-1 | 32,000 | 1,024 |
| claude-opus-5-5 | 128,000 | 2,048 |
| claude-opus-5 | 128,000 | 1,024 |
| claude-sonnet-5-5 | 128,000 | 4,096 |
| claude-sonnet-5 | 128,000 | 4,096 |
| claude-haiku-5-5 | 128,000 | 65,536 |
| deepseek/deepseek-v4.1-flash-1017 | 32,000 | 32,000 |

The default is the largest power of two, or the model limit, whose output costs at most 0.05 USD at the list price, and never less than 1,024. The `defaultMaxTokens` gateway option replaces it for every model and is still capped at the model limit.

- After the response, the gateway reads the real token usage, books the true cost and releases the rest. The ledger entry for that settlement commits in the same transaction as the budget update, so the two cannot disagree.
- When the cost is unknown, it charges high. A cut stream, a client that hangs up, a provider that goes silent for 10 minutes (HTTP 504, the idle timeout of the OpenAI and Anthropic SDKs) or a missing usage block books the full reservation. An error answer from the provider releases it. Every reservation is closed when its call ends, also when the gateway itself hits an error, so a finished call never keeps budget held. Requests that could cost more than the bound are refused, for example server-side tools, audio, priority tiers and unlisted beta headers.

`packages/x402-rail` pays [x402](https://www.x402.org) resources for agents through the same gateway, mandate and ledger.

- An agent calls `POST /v1/x402/fetch` with its virtual key and a URL. It never holds a wallet. The gateway fetches the URL with `@x402/fetch`.
- When the resource answers 402, the gateway checks the one requirement it is about to sign, reserves that exact amount in the shared budget, signs the EIP-3009 authorization, and books the settlement with its transaction hash in the signed ledger.
- LLM calls and x402 payments draw from one budget, so spending it on one rail blocks the other.
- If a payment was signed but the settlement is not confirmed, the full amount stays booked, because the payee could still settle it until the authorization expires. Authorization windows over 300 seconds are refused.
- Redirects are refused, so the URL that was checked is the URL that is paid. Loopback, private and link-local hosts are refused by default.

`packages/payee-guard` blocks prompt-injected payments before anything is signed.

- The `payTo` address must be in the signed mandate, or listed in a `/.well-known/spendmandate-payees.json` binding signed with an Ed25519 key that the mandate pins for that exact origin.
- The amount must be within 3 times the signed quote for that path, or 3 times the 30-day median of past payments to that payee. A payee with no history gets at most 0.05 USD. Payments priced against the median are left out of the median, so a payee cannot ratchet its price up.
- The asset must be the canonical USDC contract of the network.

`packages/approval` asks the owner on Telegram when a call is above the mandate's approval threshold.

- The message has inline Approve and Deny buttons. No answer within 60 seconds is a deny.
- Only the configured user ids in the configured chat can decide. Each button carries a random nonce bound to one message, and the first valid press wins.
- The budget and caps are checked before the owner is asked and again after Approve. An agent can hold at most 2 open prompts.

`packages/stripe-rail` pays with Stripe Shared Payment Tokens (API version `2026-09-30.preview`) through the same mandate, budget and ledger.

- It runs only in Stripe test mode. It refuses a live key and an account that is not in test mode.
- Unknown payees and charges above the cap are blocked with signed ledger entries.
- Webhooks are accepted only with a valid `Stripe-Signature`.
- The tests use a fake Stripe API. The end-to-end test against a real Stripe sandbox has not run yet.

### Passkey approval page

The passkey approver serves a small page instead of a Telegram message. The page shows the agent, the rail, the payee, the amount, the summary and the seconds left. It has Approve and Deny buttons. The link goes out over the same `notify` channel, so Telegram can still deliver it. Both buttons need a WebAuthn assertion from a trusted passkey. The challenge is bound to the request, the decision and the amount, so an assertion for one request or one decision cannot be reused for another. No answer within the timeout is a deny. The page and the decision endpoint answer 409 once the request is decided or expired.

WebAuthn needs a secure context. Use https, or http://localhost on the same machine. A phone cannot use localhost on the gateway machine. Put the gateway behind https on a hostname that matches the rpID, for example `approve.example`, or use a tunnel that gives an https hostname. This page has not been tested with a real phone yet. The tests use the software authenticator.

`packages/passkey` lets the owner sign a mandate with a passkey (WebAuthn, through SimpleWebAuthn), and makes every edit of that mandate need a passkey assertion.

- The WebAuthn challenge is the SHA-256 of the exact mandate, the hash of the version it replaces, a one-time nonce, the gateway's audience id and an expiry of at most 15 minutes. A signature over one mandate or one gateway cannot be reused for another.
- The gateway checks origin, RP ID, user verification and the signature counter. It accepts only credentials the operator configured, and only for the issuer that owns the mandate.
- Once a mandate is passkey-protected, the signed ledger records it. An Ed25519 signature alone can no longer change it, even if someone deletes the protection row from the database.
- Adding a second passkey needs an assertion from an existing one.
- Tests use a software authenticator, because there is no browser in CI. A real passkey run is still to do.

## Results

These are dated development results. References to internal logs below identify the original build records, which are outside this source snapshot. The complete test source is included and can be run with `npm test`.

These numbers come from the test output saved in the private development record dated 2026-10-18.

- A 100-entry chain verifies. Changing 1 byte in any column makes verify fail. An exhaustive run tried 26,971 single-character changes to one entry and none went undetected.
- Ten agents ran at the same time against a 5.00 USD mandate until the gateway refused them. In 3 of 3 runs the provider bill stayed at or under 5.00 USD.
- The same agents without the gateway, each checking a shared counter before the call and booking the cost after it, went over 5.00 USD in 3 of 3 runs.
- Two gateway processes sharing one database file also stayed under the cap and kept a single valid chain.
- A separate AI review agent, which did not write the code, found 8 issues on 18 Oct 2026. Seven are fixed with regression tests in `packages/llm-rail/test/review-fixes.test.ts`. The open one is listed under limits below.

Steps 3 to 5, from the same log.

- 12 x402 payments of 0.01 USDC went through the gateway on an anvil fork of Base Sepolia, against the real USDC contract at 0x036CbD53842c5426634e7929541eC2318f3dCF7e. All 12 transactions have a successful receipt and a USDC transfer to the payee. The ledger holds the 12 hashes and verifies.
- The same 12 payments also pass against a local x402 facilitator built from the real `@x402/evm` verification code. A captured payment signature sent twice is refused, and no money moves.
- A README with a hidden instruction to pay 50 USDC to an unknown address is blocked with the reason "payTo ... is not in the mandate allowlist, and origin ... has no pinned payee binding". The same 50 USDC asked by an allowed payee is blocked as more than 3 times the 30-day median. A normal 0.01 payment passes. Both blocks are written to the signed ledger.
- Approve lets the agent continue, and Deny and the 60 second timeout block it, on both the LLM rail and the x402 rail. The tests run against a mock Telegram Bot API server.
- Three separate AI review agents on 18 Oct 2026 covered signing, payee checks, replay and approval. Their high and medium findings are fixed with regression tests in the `review-fixes.test.ts` files. Not every finding is fixed, and the open ones are in `docs/THREAT-MODEL.md`.

On start, the gateway checks the unsigned budget tables against the signed ledger and refuses to run if they disagree.

The provider in these tests is a local fake upstream that returns real response shapes and token counts. No real API key and no paid API was used.

Steps 8 and 9 and the two threat-model fixes, from the private development record dated 2026-10-19.

- From a clean temporary HOME, installing the packed tarball, running `init`, starting the gateway against the fake upstream and making the first governed call through the generated OpenAI client file took 1,203 ms. The plan's limit is 5 minutes. The install was from a local tarball, not the npm registry.
- The same run made governed calls with the Claude Code and Codex keys, and a call over the per-call cap got HTTP 402 and a signed `llm.denied` entry.
- A script with no browser read the dashboard event stream while making 5 calls. The worst delay from the end of a call to its ledger entry on the stream was 181.9 ms, against a limit of 2 seconds.
- Verify passed on the real pack and failed on 5 tampered copies (a changed charge, a changed denial code, a dropped middle entry, a dropped last entry, changed totals). With keys taken from the pack it printed CONSISTENT and exited 3.
- Stand-in provider keys set in the environment during `init` appeared in no file, no output, no pack and no PDF.

A separate AI review agent looked at steps 8 and 9 on 19 Oct 2026 and found 12 issues (2 high). An agent could fill the disk with denied calls carrying a huge model name, and that name reached the dashboard as HTML. Both are fixed. The ledger now keeps only a model name that looks like a model id, denial entries are capped per agent per window and per day with one marker entry when a cap starts, and the dashboard builds every cell as text under a strict Content-Security-Policy. The other fixes cover symlinked and existing Claude Code settings, Codex configs that cannot be safely appended to, the default port (8787 is also the default of `wrangler dev`), a failed `init` that left a half-built home, unknown pack fields, and export overwriting files. Their tests are in `packages/llm-rail/test/review-fixes-2.test.ts` and `packages/spendmandate/test/review-fixes.test.ts`.

Step 10, first part, from the private development record dated 2026-10-19 lines 455 to 543. It was the first run on real model calls.

- A gateway built from the same packages (`scripts/dogfood/gateway.ts`) runs on 127.0.0.1 in front of the owner's local model lock proxy, which forwards to DeepSeek V4.1 Flash 1017 on Nous. Its mandate is signed with a passkey through the passkey registry and the software authenticator, with 3.00 USD a day, 0.10 USD per call and an approval threshold of 0.05 USD. No Telegram bot exists yet, so approval goes to an approver that always denies.
- OpenCode ran 4 small tasks through it on 18 Oct 2026 between 20:40 and 20:44 UTC. The gateway settled 16 calls and booked 0.006979 USD. Every settled call matched one call in the model lock ledger by token counts (16 of 16), and the ledger of 21 entries verifies with the pinned key.
- A passkey-signed edit set the per-call cap to 0.005 USD. The next OpenCode task stopped at once with `amount exceeds per-call cap`, the denial is a signed `llm.denied` entry, and the model lock shows no upstream call in that window. A call above the approval threshold got HTTP 403 `approval_denied` and a signed `llm.approval` entry. A second edit restored the caps, and the next task ran normally.
- The gateway's price for DeepSeek comes from a static table. The model lock books the cost the upstream reports when it is higher, so it recorded 0.010375 USD for the same 16 calls. The gateway undercounted by about a third on calls with little cached input.
- The first edit attempt kept the old `created_at`, and the gateway refused it as not newer than the registered version, which is the rollback guard working.

Step 10, final check after the 24 hour window, from the private development record dated 2026-10-20.

- The window ran from 18 Oct 2026 20:40 UTC to 19 Oct 20:40 UTC. The ledger verifies on 90 signed entries with the pinned key.
- 84 real calls settled for 0.087854 USD booked. The model lock billed 0.082750 USD for the same 84 calls, and 81 of 84 match by token counts. The 3 that do not match booked reasoning tokens twice, which is now fixed.
- The mandate stopped 3 calls. Two were planned tests, and one was a real OpenCode call above the 0.05 USD approval threshold.
- No outage was caused by the gateway. It was restarted 3 times on purpose, for 17 seconds in total.
- Real calls ran only in the first 3 h 52 min of the window, so this is not yet 24 hours of steady use.

## Run it

You need Node 22.13 or newer. There are no native dependencies. SQLite comes from `node:sqlite`.

```sh
npm install
npm test
npx tsc -p tsconfig.json --noEmit
./scripts/done-tests-8-9.sh
```

## Limits I know about

- The input bound assumes every token covers at least one byte of the request, which holds for byte-level BPE tokenizers.
- The gateway trusts the token counts the provider reports. It books the larger figure only when a stream breaks or usage is missing.
- Prices are list prices recorded on 18 Oct 2026 from the OpenAI and Anthropic pricing pages. Unknown models are refused, not priced at zero.
Two limits come from where the ledger lives.

- Deleting entries from the end of the ledger is caught by a signed head that the gateway writes to two files after every commit, and start refuses a ledger shorter than that head. Both files sit on the gateway machine next to the key, so someone with full access to that machine can still cut the tail.
- The store binding stops a signed mandate from being used on a second database. A byte copy of the database file is the same store, so whoever can copy the file can still fork the budget. Run one copy.

Two more come from how it was tested.

- `init --apply` was tested against temporary config files. The client files were tested on 23 Oct 2026 with live Claude Code 2.x and OpenCode 1.19 sessions against the fake provider, not against a real provider.
- The dogfood gateway prices DeepSeek V4.1 Flash 1017 from a static table at the model lock rates. The upstream sometimes bills more, so the ledger can book less than the real bill (see step 10 above). Booking the upstream-reported cost is still to do. Codex is not supported. Codex 0.163 refuses `wire_api = "chat"`, and the gateway does not speak the Responses API yet.

Open items for the x402 rail and approval.

- The x402 rail has paid on the live Base Sepolia testnet (37 of 37 through the CDP facilitator, 21 of 24 through the shared x402.org facilitator). It has not paid on mainnet, which needs a separate wallet funded by the owner. The required funding and credentials are supplied by the operator.
- Without an on-chain check, the transaction hash in the ledger is the one the resource server reported, and the ledger entry says so (`settlement_verified` false). The `verifySettlement` option checks it on chain.
- The default fetch resolves DNS once, refuses private addresses, and connects only to the address it checked, so DNS rebinding is blocked.
- A signed payee binding is accepted until it expires (at most 400 days). An older binding is refused after a newer one was seen (`binding_rolled_back`).
- A dedicated Telegram approval bot exists, but no process polls it yet. Only one process may poll that bot. The passkey approval page has not been tried on a real phone.

## Protocol identifiers

Some strings keep the older spendmandate name on purpose. They are part of signed data, so changing them would break every signed ledger, mandate and payee binding that exists today. The list is the signed head format `spendmandate-head-v1`, the passkey mandate challenge prefix `spendmandate/passkey-mandate/v1`, the passkey credential challenge prefix `spendmandate/passkey-add-credential/v1`, the approval challenge prefix `spendmandate/approval/v1`, the payee binding path `/.well-known/spendmandate-payees.json` and its signing prefix `spendmandate-payee-binding/v1`, the receipt pack format `spendmandate-receipt-pack/v1` and its signing prefix `spendmandate-pack/v1`, and the anchored heads marker `spendmandate-heads/v1`. The package folder `packages/spendmandate`, the internal workspace names under `@mandate/`, and the second command name `spendmandate` also stay.

## License

Built by Michael Lip, github.com/theluckystrike.

MIT, for the core and every package in this repo, including the `tapvow` command. Copyright 2026 Michael Lip, Warsaw, Poland. https://github.com/theluckystrike
