// Guards the devnet demo before any actor key is created. The demo must only
// ever run against Solana devnet, so the genesis hash is read once with a timeout
// signal. A failed or unexpected read leaks no RPC endpoint or auth details.
import { SOLANA_DEVNET_GENESIS_HASH } from "./chain.js";

export interface DemoPreflightRpc {
  getGenesisHash(): { send(options?: { abortSignal?: AbortSignal }): Promise<unknown> };
}

const GENESIS_READ_TIMEOUT_MS = 15_000;
const PREFLIGHT_ERROR = "the devnet demo could not verify Solana devnet; no actors were created";

/**
 * Read the RPC genesis hash and require exact Solana devnet. Only then run the
 * actor resolver. The resolver must not create or fund keys on its own before
 * this check, so no actor work happens on a wrong, unknown or unreadable chain.
 */
export async function prepareDevnetDemoActors<T>(
  rpc: DemoPreflightRpc,
  resolveActors: () => T | Promise<T>,
): Promise<T> {
  let genesisHash: unknown;
  try {
    genesisHash = await rpc.getGenesisHash().send({
      abortSignal: AbortSignal.timeout(GENESIS_READ_TIMEOUT_MS),
    });
  } catch {
    throw new Error(PREFLIGHT_ERROR);
  }
  if (genesisHash !== SOLANA_DEVNET_GENESIS_HASH) throw new Error(PREFLIGHT_ERROR);
  return await resolveActors();
}
