# Source provenance

This product source snapshot starts from commit `0c0e3e6912100fcb4631122418663deb86c6a7e5`. Product source, tests, build files, public documentation and licenses are retained. The README install instructions and Stripe status document were updated for a source release while npm publication is pending.

Private operator notes and the original development Git history are outside this snapshot. BLOCKERS.md is a new public product-prerequisites document; it does not contain the private operator record formerly at that path. Historical references to those records in the documentation are dated observations, not newly reproduced results. The current test source is included.

Built by Michael Lip, github.com/theluckystrike, with AI coding assistance. Copyright and MIT license notices are retained in the source and package license files.

## Source install check, 28 Oct 2026

A fresh clone on Node 22.23.4 completed `npm ci`, the CLI build, initialization, a fake upstream chat call, receipt export and pinned-key verification. The call returned HTTP 200 and receipt verification returned PASS. This check used no real provider key and took 10.38 seconds on the maintainer's machine.

The full automated suite was last logged as 554 passing tests on 27 Oct 2026 at development commit `0c0e3e6`. Product code and test files in this public source snapshot are byte-identical to that version. The install check is a separate, smaller check.
