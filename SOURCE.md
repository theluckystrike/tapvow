# Source provenance

This product source snapshot comes from commit `a37bab68e086e96cf952109a98fce71f7c09f8ee` on the Solana rail branch of the TapVow development repository. The tracked tree hash was `b50287a144562a7edaa03f83704a4e605dd6c5fa` with 247 tracked files. The snapshot was made with `git archive` from that exact ref, so it holds no untracked files and no development history.

The branch shares an older base with the current public main branch and is not a descendant of it. The two branches diverged: the Solana rail work is here, and later main-branch work is not. Do not merge this snapshot into current main without review. The source audit records the differences separately. This branch omits the newer Nebius integration and adds shared budget-store settlement and replay logic. Publication as a separate experiment does not mean those changes are production approved.

Product source, tests, assets, build files, public documentation and licenses are retained, including the whole `packages/svm-rail` package. Private operator material is excluded: the task notes, the development logs, the plan state file, the launch script and the former operator blockers record. A separate preservation audit records retained blobs, documentation changes and exclusions.

`BLOCKERS.md` is a new product-prerequisites document. It does not contain the private operator record formerly at that path. Date references to the private development record in the documentation are dated observations, not newly reproduced results.

Built by Michael Lip, github.com/theluckystrike, with AI coding assistance. Copyright and MIT license notices are retained in the source and package license files.

## Verification status, 28 Oct 2026

The initial clean snapshot was prepared without installs or tests while disk space was below the task floor. After disk recovery, a fresh isolated clone of expiry-retention commit `892da04bfe2e4a1ef6b9fc009eab60eeff209054` passed dependency installation, 80 SVM tests, 22 focused shared-store tests, 66 payee tests, the pinned TypeScript 5.6.3 typecheck and CLI build. Four new domain regressions failed against the original `9b9d04c` runtime before passing on the fix.

The source-build smoke used Node 22.23.4, an isolated TapVow home and a fake upstream. A governed call returned HTTP 200, and exported receipts passed pinned-key verification. No real provider or Solana call was made. The harness failed only while compiling its final summary because a Node reporter used a new output prefix. Counts were recovered from saved test logs without repeating the passed checks.

A separate commit, `48553efeb3c13affa2f2555f1ca8935ac0c67cdb`, adds the demo genesis guard. Its four mocked preflight tests and SVM package typecheck passed. The base dependency installation and 168 checks were not repeated, since this guard changes no dependency, CLI or shared money logic. This documentation update changes no runtime source.

The later conservative replay and failed-response maintenance at `fe48ed94228c913ddd451bfed5e878ced3272cc8` passed 87 SVM tests, 22 focused shared-store tests, 66 payee tests and the pinned TypeScript 5.6.3 typecheck. Three native accounting regressions failed when the runtime was reverted to `36dd8d4`, then passed with the fix. An independent two-case fake-state fixture also failed the old runtime and passed the fix. It held the full simulated budget and refused the extra request. These are local accounting checks, not real transfer or cryptographic chain proof.

The successful isolated dependency installation was reused because this maintenance changes no lockfile or dependency. The earlier `892da04` source-build and fake-call smoke remains dated evidence for that exact commit; it is not relabelled as a new live run or a repeated full source smoke on `fe48ed9`.

These are local and mocked checks. Saved evidence does not establish a live Solana settlement. A genuine devnet payment still needs funded test wallets, canonical devnet USDC and an end-to-end verification and resource-delivery run.

## What a reader should not conclude

- These source files do not establish an npm package, stable tag or release.
- Saved evidence does not establish a live Solana devnet or mainnet settlement.
- The Stripe rail has not passed a live sandbox end-to-end run.

## Conservative settlement maintenance

This experimental candidate includes conservative maintenance after the source snapshot. A local deadline, historical signature mention, atomic duplicate claim or unbound failed transaction ID never automatically frees the budget of a signed request. Such bookings remain `charged_full` until their outcome is established or an operator makes an explicit audited release. Matching verified transfers can settle bookings. Genuine failed or duplicate payments can therefore over-hold budget. Exact payer-signature authorization binding is not implemented. The original clean snapshot remains separate for comparison.

## Demo setup safety

The demo reads the RPC genesis before resolving payee and fee-payer actors. Only the official Solana devnet genesis permits the next stage. Read errors and unknown networks fail closed without exposing RPC authentication details. Keep the three test key files explicit, outside the repository, and use a separate demo directory. The guard was tested with mocks only; the real demo was not invoked.
