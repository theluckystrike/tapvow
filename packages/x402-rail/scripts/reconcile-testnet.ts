// Reports what reconcileX402 would do for one or more old x402 ledger
// databases, reading them READ ONLY against live Base Sepolia. It never writes
// to a ledger and never reads the signing key; the report is advisory.
//
// Usage: npm run reconcile-testnet -- <ledger.db> [more.db ...]
import { createPublicClient, http } from "viem";
import { reconcileReport, redactError, viemAuthorizationChain } from "../src/reconcile.js";

const RPC_URL = "https://sepolia.base.org";
const USER_AGENT = "tapvow-reconcile-testnet";

async function main(): Promise<number> {
  const paths = process.argv.slice(2);
  if (paths.length === 0) {
    console.error("usage: reconcile-testnet <ledger.db> [more.db ...]");
    return 2;
  }

  const publicClient = createPublicClient({
    transport: http(RPC_URL, { fetchOptions: { headers: { "User-Agent": USER_AGENT } } }),
  });
  const chain = viemAuthorizationChain(publicClient, { rpcUrl: RPC_URL });

  let releasedMicros = 0;
  let confirmedMicros = 0;
  let bookings = 0;
  for (const dbPath of paths) {
    console.log(`# ${dbPath}`);
    try {
      const report = await reconcileReport(dbPath, chain);
      for (const r of report.results) {
        const tx = r.txHash ? ` ${r.txHash}` : "";
        const reason = r.reason ? ` (${r.reason})` : "";
        console.log(`${r.reservationId} ${r.result}${tx}${reason}`);
        bookings += 1;
      }
      releasedMicros += report.releasedMicros;
      confirmedMicros += report.confirmedMicros;
    } catch (err) {
      console.error(`${dbPath}: ${redactError(err)}`);
      return 1;
    }
  }
  console.log(
    `totals: ${bookings} bookings, released ${releasedMicros} micros, confirmed ${confirmedMicros} micros`,
  );
  return 0;
}

main().then((code) => process.exit(code));
