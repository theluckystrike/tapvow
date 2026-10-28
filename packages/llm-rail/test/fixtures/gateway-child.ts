// Test fixture: one gateway process. Two of these share one database file in
// test/multiprocess.test.ts. Args: <config.json path>. Prints "PORT <n>".
import { readFileSync } from "node:fs";
import { createPrivateKey } from "node:crypto";
import { openGovernedRail } from "../../src/mandate.js";
import { createGateway } from "../../src/gateway.js";

const cfg = JSON.parse(readFileSync(process.argv[2]!, "utf8"));
const rail = openGovernedRail({
  dbPath: cfg.dbPath,
  signedMandate: cfg.signedMandate,
  trustedIssuerKey: cfg.trustedIssuerKey,
  ledgerSigner: { keyId: cfg.ledgerKeyId, privateKey: createPrivateKey(cfg.ledgerPrivatePem) },
});
const gw = createGateway({ store: rail.store, upstreams: { openai: { baseUrl: cfg.upstream, apiKey: cfg.upstreamKey }, anthropic: { baseUrl: cfg.upstream, apiKey: cfg.upstreamKey } } });
gw.listen(0, "127.0.0.1", () => {
  const a = gw.address();
  process.stdout.write(`PORT ${typeof a === "object" && a ? a.port : 0}\n`);
});
process.on("SIGTERM", () => gw.close(() => { rail.close(); process.exit(0); }));
