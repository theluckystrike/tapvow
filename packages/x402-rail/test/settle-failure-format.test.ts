// The demo resource must never print a raw viem settle error: those messages
// can carry a signed EIP-3009 authorization and an RPC URL. formatSettleFailure
// renders one redacted, bounded line instead.
import { test } from "node:test";
import assert from "node:assert/strict";
import { formatSettleFailure } from "../src/demo-server.js";

function report(name: string, outcome: string): void {
  console.log(`# testnet-fix ${name}: ${outcome}`);
}

// The real viem message shape, shortened but keeping its structure.
const VIEM_MESSAGE = `Missing or invalid parameters.
Double check you have provided the correct parameters.

URL: https://sepolia.base.org
Request body: {"method":"eth_sendRawTransaction","params":["0x02f9019583014a34832e4bb5830f4240836acfc0"]}
 
Request Arguments:
  from:  0xd407e409E34E0b9afb99EcCeb609bDbcD5e7f1bf
  args: (0x5b12E70F36c80B2B59b94D710419845c2D5ceEb7, 10000, 0xdfe80e8dff1e02868aec882976ad1292606d5151c37c16d39854ff6ea5b0fbf6, 27)

Details: replacement transaction underpriced
Version: viem@2.48.11`;

test("details line: the viem message collapses to the reason and Details value", () => {
  const out = formatSettleFailure("invalid_exact_evm_transaction_failed", VIEM_MESSAGE);
  assert.equal(
    out,
    "demo resource: settle failed: invalid_exact_evm_transaction_failed (replacement transaction underpriced)",
  );
  assert.ok(out.includes("replacement transaction underpriced"));
  report("details-line", "exact match");
});

test("no details line: the first line is kept with hex and URLs redacted", () => {
  const message = "boom while sending to https://sepolia.base.org tx 0x02f9019583014a34832e4bb5830f4240836acfc0\nmore text";
  const out = formatSettleFailure("invalid_exact_evm_transaction_failed", message);
  assert.ok(out.includes("<url>"), out);
  assert.ok(out.includes("<hex>"), out);
  assert.ok(!out.includes("sepolia.base.org"), out);
  assert.ok(!out.includes("02f9019583014a34832e4bb5830f4240836acfc0"), out);
  assert.ok(!out.includes("\n"), out);
  report("first-line-redacted", out);
});

test("a 64-hex signature never appears in the output", () => {
  const signature = `0x${"ab".repeat(32)}`;
  const out = formatSettleFailure("invalid_exact_evm_transaction_failed", `signature ${signature} was rejected`);
  assert.ok(!out.includes(signature), out);
  assert.ok(!out.includes("ab".repeat(32)), out);
  assert.ok(out.includes("<hex>"), out);
  report("signature-redacted", out);
});

test("newlines and ANSI escapes in the reason are removed", () => {
  const out = formatSettleFailure("invalid\nreason\u001b[31mred\u001b[0m");
  assert.ok(!out.includes("\n"), out);
  assert.ok(!out.includes("\r"), out);
  assert.ok(!out.includes("\u001b"), out);
  report("reason-controls", out);
});

test("the output is one line and at most the length cap", () => {
  const out = formatSettleFailure("invalid_exact_evm_transaction_failed", "x".repeat(500));
  assert.ok(!out.includes("\n"), out);
  assert.ok(out.length <= 200, `length ${out.length}`);
  const detail = out.slice(out.indexOf(" (") + 2, out.endsWith(")") ? -1 : undefined);
  assert.ok(detail.length <= 200, `detail length ${detail.length}`);
  report("length-cap", `length ${out.length}`);
});
