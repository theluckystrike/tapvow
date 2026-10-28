# Stripe rail status

The Stripe Shared Payment Token rail is built. This source snapshot includes its implementation, fake-API tests and test-mode verification script. No successful live Stripe end-to-end run is claimed for this release.

## What the rail does

Agents do not hold a Stripe key. The gateway checks a granted Shared Payment Token against the signed mandate, reserves the amount atomically and records the PaymentIntent in the same signed ledger used by the LLM and x402 rails.

When a charge cannot be confirmed, the rail keeps the full reserved amount committed against the budget and marks it unconfirmed. A later Stripe reconciliation path is not built yet. The limits are also described in `packages/stripe-rail/README.md`.

## Tests and live verification

The existing test suite uses a fake Stripe API. Run it from the clone root.

```sh
npm test --workspace @mandate/stripe-rail
```

The optional verification script is `packages/stripe-rail/scripts/step7-e2e.ts`. It targets the API version declared in the implementation. It needs suitable Stripe test credentials and provider access. It is separate from the fake-API test suite. Read its setup and credential checks before running it.

Keep real credentials outside the repository. The script accepts the `STRIPE_KEY_FILE` and `TAPVOW_SECRETS_DIR` settings. No credential file is included in this source snapshot.

A future live test must verify the PaymentIntent, revocation webhook and signed ledger together. Update claims only after that run has recorded proof. Until then, the Stripe rail remains tested with the fake API only.
