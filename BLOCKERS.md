# Product prerequisites and current limits

## Build from source

Use Node 22.13 or newer. npm publication is pending. Build and run the local CLI as README.md describes. The fake upstream needs no provider key and makes no paid call.

## Live provider calls

Use your own provider account and keep its key outside the repository. The gateway limits only traffic sent through it. Calls made directly to a provider are outside that limit.

## Testnet demonstrations

A public-chain demonstration needs testnet funds and working RPC and facilitator services. The Base Sepolia scripts can exit with code 3 when required testnet funds or setup are absent. Do not describe a local fork as a public-chain payment. No mainnet payment is claimed for this source release.

## Step 7 Stripe sandbox

The Stripe Shared Payment Token rail has fake-API tests. A live test-mode demonstration requires suitable Stripe test credentials, provider access and the Stripe CLI used by the verification script.

Keep the key file outside the repository with mode 600. Set `STRIPE_KEY_FILE` to that file, or configure `TAPVOW_SECRETS_DIR`. Read `packages/stripe-rail/scripts/step7-e2e.ts` before running the optional verification. It checks test mode before proceeding. A missing key file produces exit code 3.

A successful demonstration must check the PaymentIntent, token revocation webhook and signed ledger. No successful live Stripe end-to-end run is claimed here. See docs/STRIPE-RAIL.md and packages/stripe-rail/README.md for the implementation status and limits.

## Approvals and ledger trust

The passkey and Telegram flows require the operator's own setup. A real-phone passkey run and a live Telegram polling process are not established by the fake-API tests. Host compromise can defeat a local ledger trust boundary. Read docs/THREAT-MODEL.md before production use.
