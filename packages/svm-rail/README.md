# @mandate/svm-rail

The Solana x402 rail for TapVow. It pays SPL USDC through x402 on Solana devnet and books every payment in the same signed mandate and ledger as the other TapVow rails.

This is an experimental library package. No successful live Solana payment is claimed. It exposes `pay` and `handler`; it is not wired into a public gateway route or the CLI. Tests use a fake chain and facilitator. The package version remains local `0.1.0`; no package or stable tag is published.

## What it does

An embedding application supplies the payer signer and must keep it out of the agent process. The embedding gateway must authenticate the caller and pass verified agent and mandate IDs. The library checks the 402 quote against the signed mandate, holds the worst-case cost, signs a partially signed SPL transfer, lets the facilitator add the fee-payer signature and submit it, then reads the transaction signature and settles a matching transfer or retains the uncertain booking. This package does not provide a public gateway route or CLI integration.

The package matches `@x402/core` 2.28.0 and `@x402/svm` 2.28.0. It uses `@solana/kit` 5.x as `@x402/svm` requires.

## Setup

Install from the repository root.

```
npm ci
```

Build is not needed. Packages run from TypeScript source through tsx and vitest.

The main entry points are below.

- `createSvmRail` in `src/rail.ts`
- `createSvmPaymentGuard` in `src/guard.ts`
- `rpcSolanaChain` in `src/chain.ts`
- `reconcileSvm` in `src/reconcile.ts`

## How it works

1. The rail fetches the resource with the shared pinned fetch. A 402 response carries the payment requirements.
2. The rail accepts only the `exact` scheme on an enabled Solana network. The requirement must name a valid fee payer.
3. The guard checks the payee allowlist, the USDC mint, the request URL and the amount bounds. Solana addresses stay case sensitive.
4. The budget store reserves the full quoted amount. This is the worst-case cost. The same call checks the budget, the per-call cap, the rate limit and the approval threshold.
5. A call above the approval line gets a hold first. The approver decides. A timeout or a denial releases the hold.
6. A cheap RPC preflight runs before any signature. If the RPC does not answer, the call stops and the hold is released.
7. The rail decodes the signed transaction and proves it moves the exact mint, amount and payee to the payee token account. It allows only that transfer, Compute Budget limit and price instructions under a price cap, and one optional Memo. Any other program, a second token instruction, a payer writable signer outside the transfer, or the payer as fee payer is refused. A mismatch stops the call and releases the hold.
8. The facilitator settles. The rail reads the returned transaction signature on chain and waits up to 30 s for a finalized matching transfer. A finalized transfer settles the hold. A reported failed transfer remains charged in full because its ID is not bound to this exact signed authorization. A transfer that is still pending at the deadline, an unreadable result, a facilitator error, or a redirect after signing books the full amount as unconfirmed for reconcile. Money that may have moved is never released on a timeout or an error.
9. The ledger entry records the signature, the payer signature, the mint, the payee, the fee payer and the settlement source.

## Fail closed rule

The rail fails closed. If the rail cannot prove that no money moved, it books the full amount as unconfirmed and keeps the booking for reconcile.

These cases are not proof that no money moved.

- A payer history scan that hit its signature cap.
- A payer history scan that hit its deadline.
- A facilitator error after the payer signed.
- A redirect after the payer signed.
- An RPC error after the payer signed.

Unknown signed payments stay charged in full. This implementation does not persist and prove the exact signed blockhash lifetime, so a wall-clock deadline never causes automatic release. The current adapter does not bind a reported transaction ID to this exact signed authorization. Replay reports and failed IDs therefore keep the booking charged in full too. Only an explicit audited operator override releases an uncertain signed booking. Pre-sign refusals remain separate.

Every settle path uses one atomic claim function. The live path and the reconcile path both claim the on chain signature in the same database transaction as the settle. A second claim loses and its signed booking stays charged in full. A signature-only claim is not authorization identity.

## Failure cases and what is booked

| Case | What the rail proves | What is booked | What the buyer sees |
|---|---|---|---|
| Blocked payee, cap hit or budget hit | No signature exists | Nothing, no hold | 402 or 403 |
| Approval timeout | No signature exists | Nothing, no hold | 403 |
| Signed transaction mismatch | The fee payer has not signed, so the transfer cannot land | Hold released | 403 |
| RPC timeout before signing | No signature exists | Nothing, no hold | 503 |
| Facilitator error after signing | No settlement proof. The payer history scan may find a transfer, may finish with no match, may hit its cap or deadline, or may fail | A found transfer settles. Any other result books the full amount as unconfirmed; its deadline metadata is not proof of chain expiry | 502 `mandate_unconfirmed` |
| Redirect after signing | Same as a facilitator error | Same as a facilitator error | 502 `mandate_unconfirmed` |
| Transfer still pending at the finalized deadline | No final settlement proof | Full amount as unconfirmed; no automatic time-based release | 502 `mandate_unconfirmed` |
| Reported failed transaction | The ID is not bound to this signed authorization | Full amount as unconfirmed | 502 `mandate_unconfirmed` |
| Replayed or historically mentioned signature | No proof this exact signed authorization is already counted | This booking stays charged in full | 403 `mandate_unconfirmed` |
| Wall-clock deadline passed, with no match or a pending result | No proof that the signed blockhash is invalid | Booking stays charged in full until chain evidence or explicit operator release | None, reconcile only |
| Expired booking, incomplete or unreadable scan | Nothing about the transfer | The booking stays charged full | None, reconcile only |

A chain read that does not finish is never proof that no money moved. Reconcile keeps such a booking in place and reports an error.

## Reconcile

`reconcileSvm` reads every `charged_full` Solana booking for the mandate. When the chain can read a genesis hash, the pass refuses a hash that does not match the candidate networks, before any write. It settles a matching finalized transfer, retains a reported failed transaction or a signature mentioned by another booking, leaves bookings with only a passed wall-clock deadline in place, and leaves pending, incomplete or unreadable bookings in place. The settle uses the same atomic signature claim as the live path. A losing claim retains its booking; it does not release a potentially distinct authorization. One throwing chain read reports an error for that booking only. The signed ledger is audited before any write.

## Operator release

An operator can release one named booking. The command audits the ledger, writes a signed ledger entry with reason `operator_release`, and records the operator id and an optional note.

```
SVM_HOME=~/.tapvow SVM_OPERATOR=ops@example.com \
  npm run operator-release --workspace @mandate/svm-rail -- <reservation-id> --reason "text"
```

The home must hold the same `config.json`, signed mandate and ledger key as the gateway. The booking must be `charged_full`. A booking that is already settled or released is refused.

## Tests

```
npm test --workspace @mandate/svm-rail
npm run typecheck --workspace @mandate/svm-rail
```

The tests use vitest. They run with a fake facilitator and a fake chain. The fake chain has a balance that moves only on a confirmed success, and it honours the search window. The suite covers success, blocked payee, cap hit, approval timeout, facilitator error, RPC timeout, replay on both settlement paths, a transfer outside the search window, a signed transaction mismatch, the mint and payee pins, and reconcile cases. The reconcile cases include delayed approval, a stalled cluster, empty scans after wall-clock deadlines, an incomplete scan, an unreadable result at expiry, a live settle race, a swept booking, an operator release, and the audit trail.

The payee guard tests are separate.

```
cd packages/payee-guard
node --no-warnings --import tsx --test --test-timeout=120000 test/*.test.ts
```

## Devnet demo

The demo needs three different Solana keys. Each key file must have mode 600. Keep the key files outside the repository.

- `SVM_KEY_FILE` is the payer.
- `SVM_PAYEE_KEY_FILE` is the payee. If absent the demo generates one.
- `SVM_FEE_PAYER_KEY_FILE` is the facilitator fee payer. If absent the demo generates one.

The script refuses a payer, a payee or a fee payer that share one address. It prints addresses, never key bytes.

```
SVM_KEY_FILE=$HOME/.config/solana/svm-devnet.json \
SVM_PAYEE_KEY_FILE=$HOME/.config/solana/svm-payee.json \
SVM_FEE_PAYER_KEY_FILE=$HOME/.config/solana/svm-fee-payer.json \
SVM_RPC_URL=https://api.devnet.solana.com \
npm run devnet-demo --workspace @mandate/svm-rail
```

Pin `SVM_RPC_URL` to `https://api.devnet.solana.com`, supply all three existing actor key files, and set `SVM_DEMO_DIR` to a new task-local folder. Omitting actor files generates keys. The demo verifies the actual RPC genesis against Solana devnet before resolving actors or making any balance, setup or send call. A wrong, unknown or unreadable genesis stops the demo with no actor creation.

The payer must hold devnet SOL and canonical Circle devnet USDC. The payer SOL creates the payee token account and tops up the fee payer when needed. If a balance is too low the script prints `OWNER-NEEDED` with the exact faucet steps and stops. It never requests a faucet itself.

A generated payee key is lost when the script exits. Set `SVM_PAYEE_KEY_FILE` to keep one payee across runs.

The demo starts a paid policy-check seller and an in-process facilitator. It shows an approval timeout, a blocked payee, five paid calls, a budget refusal and a ledger verify. Each paid call prints its explorer link and the first line of the resource the seller delivered.

The demo ledger goes to `~/.tapvow/svm-demo/<pid>/rail.db`. Set `SVM_DEMO_DIR` to use another folder. This three-key version has not been run on devnet yet. Run it and keep the explorer links before you show that claim.

## Limits

- Devnet only in the demo. Mainnet needs a funded key, a mainnet facilitator and a mainnet USDC mint.
- The exact scheme needs the payee token account to exist. The rail does not create token accounts.
- The rail does not follow redirects. A redirect after signing is not proof that no money moved, so the rail books the full amount as unconfirmed.
- The rail holds one payment per agent call.
- A late on-chain settlement after a booking is handled by reconcile, not by the request.
- One database can hold more than one mandate. Set `store_id` in the mandate to bind it to one database.
- The signature claim is per mandate. The unique key is `(mandate_id, tx_signature)`. A transfer that settles under one mandate is not detected under a different mandate in the same database. Use one database per mandate, or accept this boundary.
- The facilitator is trusted to submit. The rail checks the result on chain.

## Conservative accounting limit

Transaction verification matches payment facts but does not bind the returned ID to the exact decoded payer signature. After a signed request may have left the gateway, neither a local deadline, a historical signature mention, an atomic duplicate claim nor an unbound failed transaction ID automatically frees its budget. Such bookings remain `charged_full` until explicit audited operator review. This can over-hold the budget for genuinely failed or duplicate payments. It is a deliberate safe default, not proof that all retained amounts were spent. Exact authorization binding is future work.
