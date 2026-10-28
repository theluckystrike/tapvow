// A local x402 facilitator backed by a real chain.
//
// Same routes as startLocalFacilitator, but built from the real @x402/core
// facilitator class and the real @x402/evm exact facilitator scheme, with a
// FacilitatorEvmSigner made from a viem wallet + public client on rpcUrl. It
// submits real transferWithAuthorization transactions to whatever chain rpcUrl
// serves (an anvil fork in the tests), so verification, simulation and
// settlement all run the production code against real USDC.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { x402Facilitator } from "@x402/core/facilitator";
import type { Network } from "@x402/core/types";
import { ExactEvmScheme } from "@x402/evm/exact/facilitator";
import { toFacilitatorEvmSigner, type FacilitatorEvmSigner } from "@x402/evm";
import { createPublicClient, createWalletClient, defineChain, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";

export interface ChainFacilitatorOptions {
  rpcUrl: string;
  privateKey: `0x${string}`;
  /** CAIP-2 network id, e.g. "eip155:84532". */
  network: string;
}

export interface ChainFacilitator {
  url: string;
  address: string;
  close(): Promise<void>;
}

const MAX_BODY_BYTES = 256 * 1024;

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let length = 0;
    let done = false;
    req.on("data", (chunk: Buffer) => {
      if (done) return;
      length += chunk.length;
      if (length > MAX_BODY_BYTES) {
        done = true;
        reject(new Error("body too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (done) return;
      done = true;
      const text = Buffer.concat(chunks).toString("utf8");
      if (!text) return resolve(undefined);
      try {
        resolve(JSON.parse(text));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", (err) => {
      if (!done) {
        done = true;
        reject(err);
      }
    });
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = Buffer.from(JSON.stringify(body), "utf8");
  res.writeHead(status, { "content-type": "application/json", "content-length": String(payload.length) });
  res.end(payload);
}

function chainFromNetwork(network: string, rpcUrl: string) {
  const match = /^eip155:(\d+)$/.exec(network);
  if (!match) throw new Error(`unsupported network ${network} (expected eip155:CHAIN_ID)`);
  const id = Number(match[1]);
  return defineChain({
    id,
    name: `anvil-fork-${id}`,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
}

/**
 * Starts an HTTP facilitator on 127.0.0.1 that verifies and settles real
 * EIP-3009 authorizations by broadcasting to rpcUrl with privateKey.
 */
export function startChainFacilitator(opts: ChainFacilitatorOptions): Promise<ChainFacilitator> {
  const account = privateKeyToAccount(opts.privateKey);
  const chain = chainFromNetwork(opts.network, opts.rpcUrl);
  const transport = http(opts.rpcUrl);
  const publicClient = createPublicClient({ chain, transport });
  const walletClient = createWalletClient({ account, chain, transport });

  const signer = toFacilitatorEvmSigner({
    address: account.address,
    readContract: (args) => publicClient.readContract(args as never),
    verifyTypedData: (args) => publicClient.verifyTypedData(args as never),
    writeContract: (args) => walletClient.writeContract(args as never),
    sendTransaction: (args) => walletClient.sendTransaction(args as never),
    waitForTransactionReceipt: (args) => publicClient.waitForTransactionReceipt(args as never),
    getCode: (args) => publicClient.getCode(args as never),
  }) as FacilitatorEvmSigner;

  const facilitator = new x402Facilitator();
  facilitator.register(opts.network as Network, new ExactEvmScheme(signer));

  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = req.url ?? "/";
      const method = req.method ?? "GET";
      try {
        if (method === "GET" && (url === "/supported" || url === "/supported/")) {
          sendJson(res, 200, facilitator.getSupported());
          return;
        }
        if (method === "POST" && (url === "/verify" || url === "/verify/")) {
          const body = (await readJson(req)) as { paymentPayload: never; paymentRequirements: never };
          sendJson(res, 200, await facilitator.verify(body.paymentPayload, body.paymentRequirements));
          return;
        }
        if (method === "POST" && (url === "/settle" || url === "/settle/")) {
          const body = (await readJson(req)) as { paymentPayload: never; paymentRequirements: never };
          sendJson(res, 200, await facilitator.settle(body.paymentPayload, body.paymentRequirements));
          return;
        }
        sendJson(res, 404, { error: "not found" });
      } catch (err) {
        sendJson(res, 400, {
          isValid: false,
          invalidReason: "facilitator_error",
          invalidMessage: err instanceof Error ? err.message : String(err),
        });
      }
    })();
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        url: `http://127.0.0.1:${port}`,
        address: account.address,
        close(): Promise<void> {
          return new Promise((done) => {
            server.closeAllConnections();
            server.close(() => done());
          });
        },
      });
    });
  });
}
