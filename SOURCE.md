# Source provenance

This product source snapshot comes from commit `a37bab68e086e96cf952109a98fce71f7c09f8ee` on the Solana rail branch of the TapVow development repository. The tracked tree hash was `b50287a144562a7edaa03f83704a4e605dd6c5fa` with 247 tracked files. The snapshot was made with `git archive` from that exact ref, so it holds no untracked files and no development history.

The branch shares an older base with the current public main branch and is not a descendant of it. The two branches diverged: the Solana rail work is here, and later main-branch work is not. Do not merge this snapshot into current main without review. The source audit records the differences separately. This branch omits the newer Nebius integration and adds shared budget-store settlement and replay logic. Publication as a separate experiment does not mean those changes are production approved.

Product source, tests, assets, build files, public documentation and licenses are retained, including the whole `packages/svm-rail` package. Private operator material is excluded: the task notes, the development logs, the plan state file, the launch script and the former operator blockers record. A separate preservation audit records retained blobs, documentation changes and exclusions.

`BLOCKERS.md` is a new product-prerequisites document. It does not contain the private operator record formerly at that path. Date references to the private development record in the documentation are dated observations, not newly reproduced results.

Built by Michael Lip, github.com/theluckystrike, with AI coding assistance. Copyright and MIT license notices are retained in the source and package license files.

## Verification status, 28 Oct 2026

No install, build, test or demo was run while this snapshot was prepared. Disk space was below the sprint floor of 20 GB and the brief allowed no build or test.

The development branch has a saved report of 79 `svm-rail` tests passing and a pinned-compiler typecheck. That report is not a current install proof. A future check must run `npm ci`, the workspace build, targeted rail and shared-store tests, typecheck and one isolated fake-upstream call with `--home` under a scratch folder.

## What a reader should not conclude

- These source files do not establish an npm package, stable tag or release.
- Saved evidence does not establish a live Solana devnet or mainnet settlement.
- The Stripe rail has not passed a live sandbox end-to-end run.

## Conservative settlement maintenance

This experimental candidate adds a small maintenance patch after the source snapshot. Reconcile no longer releases an unknown signed payment from a wall-clock deadline alone. Its exact signed blockhash expiry is not proven, so the booking stays charged in full until chain evidence or an explicit audited operator release. The code diff and regressions are visible in this branch's commit. The original clean snapshot remains separate for comparison.
