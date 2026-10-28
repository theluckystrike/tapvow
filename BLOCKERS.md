# Product prerequisites and current limits

This is an experimental Solana rail source snapshot. Its source commit is `a37bab68e086e96cf952109a98fce71f7c09f8ee`, recorded in `SOURCE.md`. It is not the current public main branch and it is not an npm release.

## Build from source

Use Node 22.13 or newer. npm publication is pending, so no `tapvow` package is available from the registry. Every workspace package here is a local `0.1.0` version. Build and run the local CLI as README.md describes. The fake upstream needs no provider key and makes no paid call.

Keep the snapshot separate from any existing installation. Pass `--home <dir>` or set `TAPVOW_HOME` to a new empty folder. Do not point it at an existing `~/.tapvow`.

## Live provider calls

Use your own provider account and keep its key outside the repository. The gateway limits only traffic sent through it. Calls made directly to a provider are outside that limit.

## Testnet demonstrations

A public-chain demonstration needs testnet funds and working RPC and facilitator services. The Base Sepolia scripts can exit with code 3 when required testnet funds or setup are absent. Do not describe a local fork as a public-chain payment. No mainnet payment is claimed for this source release.

## Solana devnet demonstration

The Solana rail has passed its test suite against a fake facilitator. No devnet or mainnet payment is claimed. A devnet run needs three separate Solana key files with mode 600: a payer with devnet SOL and devnet USDC, a payee and a fee payer. Keep them outside the repository.

Set `SVM_KEY_FILE`, `SVM_PAYEE_KEY_FILE`, `SVM_FEE_PAYER_KEY_FILE`, `SVM_RPC_URL` and `SVM_DEMO_DIR`, then run `npm run devnet-demo --workspace @mandate/svm-rail`. The demo never requests a faucet itself. If a balance is low it prints `OWNER-NEEDED` and stops. Read `packages/svm-rail/README.md` before running it. Keep the explorer links from any run as proof before claiming a devnet payment.

The rail must also read the transaction signature back from the RPC endpoint and settle or release the hold from that state. A devnet claim needs that settle path, not just a submitted transaction.

## Step 7 Stripe sandbox

The Stripe Shared Payment Token rail has fake-API tests. A live test-mode demonstration requires suitable Stripe test credentials, provider access and the Stripe CLI used by the verification script.

Keep the key file outside the repository with mode 600. Set `STRIPE_KEY_FILE` to that file, or configure `TAPVOW_SECRETS_DIR`. Read `packages/stripe-rail/scripts/step7-e2e.ts` before running the optional verification. It checks test mode before proceeding. A missing key file produces exit code 3.

A successful demonstration must check the PaymentIntent, token revocation webhook and signed ledger. No successful live Stripe end-to-end run is claimed here. See docs/STRIPE-RAIL.md and packages/stripe-rail/README.md for the implementation status and limits.

## Approvals and ledger trust

The passkey and Telegram flows require the operator's own setup. A real-phone passkey run and a live Telegram polling process are not established by the fake-API tests. Host compromise can defeat a local ledger trust boundary. Read docs/THREAT-MODEL.md before production use.
