# tapvow

TapVow puts one signed spending limit in front of every AI agent. The
`tapvow` command sets up a small local gateway that sits between your
coding agents and the model providers, enforces the budget and the per-call
cap, and writes every settlement to a tamper-evident receipt ledger.
Source, threat model and tests are at https://github.com/theluckystrike/tapvow.

npm publication is pending. Build the source and run the CLI with `node`.
Run all CLI commands below from the clone root.

## Quick start

Build the CLI and start a demo with no provider key or paid call.

```
git clone https://github.com/theluckystrike/tapvow.git
cd tapvow
npm ci
npm run build --workspace tapvow
node packages/spendmandate/dist/cli.js init --budget 10
node packages/spendmandate/dist/cli.js start --fake-upstream
```

To use your provider account, stop the demo gateway and start it with your
own key in its own terminal.

```
ANTHROPIC_API_KEY=sk-ant-... node packages/spendmandate/dist/cli.js start
```

Use your own key in place of the placeholder. Agent calls through this
gateway use your provider account.

Run `start` in its own terminal and leave it running. Then paste one line in
the shell where your agent runs.

```
source ~/.tapvow/clients/claude-code.env   # Claude Code with an API key
source ~/.tapvow/clients/opencode.env      # OpenCode
source ~/.tapvow/clients/openai.env        # OpenAI SDK clients and your own agents
```

Codex is not supported yet, because it now calls only the OpenAI Responses API.
The package has no runtime dependencies. Node 22.13 or newer is required.

## Initialize

```
node packages/spendmandate/dist/cli.js init
```

This creates a home directory at `~/.tapvow` with an owner key, a ledger
signing key, a signed mandate, a SQLite ledger and ready-to-use client files
for the OpenAI client, Claude Code and OpenCode. The default budget is 5.00 USD
a day with a per-call cap of 2.00 USD (or the budget, when it is lower). Nothing
is ever overwritten and a second run stops with exit code 2.

Add `--apply` to also merge the Claude Code environment variables into
`~/.claude/settings.json`. The file is backed up first.

## Start

```
node packages/spendmandate/dist/cli.js start --fake-upstream
```

With `--fake-upstream` the gateway uses a local fake provider. It needs no
provider key and makes no paid call. Without that option, the gateway reads
`ANTHROPIC_API_KEY` and `OPENAI_API_KEY` from its own environment and forwards
agent calls to the provider.

The gateway listens on port 47821 on 127.0.0.1 by default. Point a client at it
by sourcing one of the generated files.

```
source ~/.tapvow/clients/openai.env
```

## Dashboard

Open the dashboard URL that `start` prints. It shows the mandate, the budget,
the amount spent and the live receipt ledger, and it offers the receipt pack as
JSON and as a PDF.

## Verify

```
node packages/spendmandate/dist/cli.js export --out pack.json
node packages/spendmandate/dist/cli.js verify pack.json
```

`verify` checks the signed mandate, the whole hash chain, the head signature,
the registration entry and the totals. With keys pinned from `--keys` or
`~/.tapvow/public-keys.json` it prints `PASS (keys pinned from <path>)`
and exits 0; with `--trust-pack-keys` it can only show the pack is internally
consistent and exits 3, because the pack supplies its own keys. A failure prints
`FAIL` with a reason and exits 1.

## Limits

TapVow is new and so far runs only the author's own agents. x402 payments have
settled on the Base Sepolia testnet only, the Stripe rail has run only against a
fake Stripe API, and the gateway speaks OpenAI chat completions and Anthropic
messages, not the Responses API. Anyone with full access to the gateway machine
can cut the tail of the ledger or copy the database. The full list is in the
repo README and in docs/THREAT-MODEL.md.

## License

MIT, Copyright 2026 Michael Lip
