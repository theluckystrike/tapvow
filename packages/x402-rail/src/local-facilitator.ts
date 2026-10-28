// A local x402 facilitator for tests and offline demos.
//
// It wraps the real @x402/core facilitator and the real @x402/evm exact
// facilitator scheme, so every payment is checked by the production
// verification code (signature, amount, payTo, asset, validity window, nonce
// reuse). The signer is backed by an in-memory USDC token instead of a chain.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { x402Facilitator } from "@x402/core/facilitator";
import type { Network } from "@x402/core/types";
import { ExactEvmScheme } from "@x402/evm/exact/facilitator";
import { authorizationTypes, eip3009ABI, type FacilitatorEvmSigner } from "@x402/evm";
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionData,
  encodeFunctionResult,
  getAddress,
  keccak256,
  verifyTypedData,
} from "viem";

/** Real Base Sepolia USDC, so requirements look exactly like production. */
export const BASE_SEPOLIA_USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";

export interface LocalFacilitatorToken {
  balanceOf(a: string): bigint;
  usedNonces: Set<string>;
  transfers: Array<{ from: string; to: string; value: bigint; nonce: string; txHash: string }>;
}

export interface LocalFacilitator {
  url: string;
  token: LocalFacilitatorToken;
  close(): Promise<void>;
}

export interface StartLocalFacilitatorOptions {
  networks: string[];
  balances: Record<string, bigint>;
  tokenName?: string;
  tokenVersion?: string;
}

const TRANSFER_EVENT_ABI = [
  {
    type: "event",
    name: "Transfer",
    inputs: [
      { name: "from", type: "address", indexed: true },
      { name: "to", type: "address", indexed: true },
      { name: "value", type: "uint256", indexed: false },
    ],
  },
] as const;

const MAX_BODY_BYTES = 256 * 1024;

function lc(a: string): string {
  return a.toLowerCase();
}

function nonceKey(authorizer: string, nonce: string): string {
  return `${lc(authorizer)}:${lc(nonce)}`;
}

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

/**
 * Starts an in-memory USDC token plus an HTTP facilitator on 127.0.0.1.
 * The token moves balances on settle, rejects a reused nonce or an expired
 * authorization, and records every transfer.
 */
export function startLocalFacilitator(opts: StartLocalFacilitatorOptions): Promise<LocalFacilitator> {
  if (!opts.networks || opts.networks.length === 0) {
    throw new Error("startLocalFacilitator requires at least one network");
  }
  const chainId = parseChainId(opts.networks[0]!);
  const tokenName = opts.tokenName ?? "USDC";
  const tokenVersion = opts.tokenVersion ?? "2";
  const tokenAddress = getAddress(BASE_SEPOLIA_USDC);

  const balances = new Map<string, bigint>();
  for (const [addr, value] of Object.entries(opts.balances)) balances.set(lc(addr), value);
  const usedNonces = new Set<string>();
  const transfers: LocalFacilitatorToken["transfers"] = [];
  const receipts = new Map<string, { status: string; logs: readonly unknown[] }>();

  function balanceOf(a: string): bigint {
    return balances.get(lc(a)) ?? 0n;
  }

  function authorizationMessage(auth: {
    from: string;
    to: string;
    value: bigint;
    validAfter: bigint;
    validBefore: bigint;
    nonce: string;
  }) {
    return {
      from: getAddress(auth.from),
      to: getAddress(auth.to),
      value: auth.value,
      validAfter: auth.validAfter,
      validBefore: auth.validBefore,
      nonce: auth.nonce as `0x${string}`,
    };
  }

  function domain() {
    return { name: tokenName, version: tokenVersion, chainId, verifyingContract: tokenAddress };
  }

  function signatureFor(args: readonly unknown[]): `0x${string}` {
    // ECDSA form: [..., v, r, s]; bytes form: [..., signature]
    if (args.length >= 9) {
      const v = BigInt(args[6] as bigint | number);
      const r = args[7] as `0x${string}`;
      const s = args[8] as `0x${string}`;
      const yParity = v === 27n || v === 28n ? v - 27n : v;
      const vHex = (yParity === 0n ? "1b" : "1c") as string;
      return `0x${(r as string).slice(2)}${(s as string).slice(2)}${vHex}` as `0x${string}`;
    }
    return args[args.length - 1] as `0x${string}`;
  }

  function takeAuthorization(input: {
    from: string;
    to: string;
    value: bigint;
    validAfter: bigint;
    validBefore: bigint;
    nonce: string;
    signature?: `0x${string}`;
  }): { txHash: `0x${string}` } {
    const key = nonceKey(input.from, input.nonce);
    if (usedNonces.has(key)) throw new Error("ERC20: authorization is already used (nonce used)");
    const now = BigInt(Math.floor(Date.now() / 1000));
    if (input.validBefore < now) throw new Error("ERC20: authorization expired (valid before)");
    if (input.validAfter > now) throw new Error("ERC20: authorization is not yet valid");
    const from = lc(input.from);
    const to = lc(input.to);
    if (balanceOf(from) < input.value) throw new Error("ERC20: transfer amount exceeds balance (insufficient balance)");
    balances.set(from, balanceOf(from) - input.value);
    balances.set(to, balanceOf(to) + input.value);
    usedNonces.add(key);

    const args: unknown[] =
      input.signature !== undefined
        ? [getAddress(input.from), getAddress(input.to), input.value, input.validAfter, input.validBefore, input.nonce, input.signature]
        : [
            getAddress(input.from),
            getAddress(input.to),
            input.value,
            input.validAfter,
            input.validBefore,
            input.nonce,
          ];
    const data = encodeFunctionData({ abi: eip3009ABI, functionName: "transferWithAuthorization", args: args as never });
    const txHash = keccak256(data);
    const topics = encodeEventTopics({
      abi: TRANSFER_EVENT_ABI,
      eventName: "Transfer",
      args: { from: getAddress(input.from), to: getAddress(input.to) },
    });
    const log = {
      address: tokenAddress,
      topics: topics as unknown as readonly `0x${string}`[],
      data: encodeAbiParameters([{ type: "uint256" }], [input.value]),
      blockNumber: 1n,
      transactionHash: txHash,
      transactionIndex: 0,
      logIndex: transfers.length,
      removed: false,
    };
    receipts.set(txHash, { status: "success", logs: [log] });
    transfers.push({ from: getAddress(input.from), to: getAddress(input.to), value: input.value, nonce: input.nonce, txHash });
    return { txHash };
  }

  function simulateTransfer(auth: {
    from: string;
    to: string;
    value: bigint;
    validAfter: bigint;
    validBefore: bigint;
    nonce: string;
  }): void {
    const key = nonceKey(auth.from, auth.nonce);
    if (usedNonces.has(key)) throw new Error("ERC20: authorization is already used (nonce used)");
    const now = BigInt(Math.floor(Date.now() / 1000));
    if (auth.validBefore < now) throw new Error("ERC20: authorization expired (valid before)");
    if (auth.validAfter > now) throw new Error("ERC20: authorization is not yet valid");
    if (balanceOf(auth.from) < auth.value) throw new Error("ERC20: transfer amount exceeds balance (insufficient balance)");
  }

  function multicall(calls: Array<{ target: string; callData: string }>): Array<{ success: boolean; returnData: string }> {
    return calls.map((call) => {
      try {
        const decoded = decodeFunctionData({ abi: eip3009ABI, data: call.callData as `0x${string}` }) as {
          functionName: string;
          args?: readonly unknown[];
        };
        const args = (decoded.args ?? []) as readonly unknown[];
        let result: unknown;
        switch (decoded.functionName) {
          case "balanceOf":
            result = balanceOf(args[0] as string);
            break;
          case "name":
            result = tokenName;
            break;
          case "version":
            result = tokenVersion;
            break;
          case "authorizationState":
            result = usedNonces.has(nonceKey(args[0] as string, args[1] as string));
            break;
          case "transferWithAuthorization": {
            const auth = {
              from: args[0] as string,
              to: args[1] as string,
              value: BigInt(args[2] as bigint),
              validAfter: BigInt(args[3] as bigint),
              validBefore: BigInt(args[4] as bigint),
              nonce: args[5] as string,
            };
            simulateTransfer(auth);
            result = undefined;
            break;
          }
          default:
            throw new Error(`unsupported function ${decoded.functionName}`);
        }
        const returnData =
          decoded.functionName === "transferWithAuthorization"
            ? "0x"
            : (encodeFunctionResult({
                abi: eip3009ABI,
                functionName: decoded.functionName,
                result,
              } as never) as string);
        return { success: true, returnData };
      } catch {
        return { success: false, returnData: "0x" };
      }
    });
  }

  const signer: FacilitatorEvmSigner = {
    getAddresses: () => ["0x0000000000000000000000000000000000000001"],
    readContract: async (args) => {
      switch (args.functionName) {
        case "balanceOf":
          return balanceOf(args.args?.[0] as string);
        case "name":
          return tokenName;
        case "version":
          return tokenVersion;
        case "authorizationState":
          return usedNonces.has(nonceKey(args.args?.[0] as string, args.args?.[1] as string));
        case "transferWithAuthorization": {
          const a = args.args ?? [];
          simulateTransfer({
            from: a[0] as string,
            to: a[1] as string,
            value: BigInt(a[2] as bigint),
            validAfter: BigInt(a[3] as bigint),
            validBefore: BigInt(a[4] as bigint),
            nonce: a[5] as string,
          });
          return undefined;
        }
        case "tryAggregate":
          return multicall((args.args?.[1] ?? []) as Array<{ target: string; callData: string }>);
        case "isValidSignature":
          return "0xffffffff";
        default:
          throw new Error(`unsupported readContract: ${args.functionName}`);
      }
    },
    verifyTypedData: async (args) => {
      return verifyTypedData({
        address: args.address,
        domain: args.domain,
        types: args.types,
        primaryType: args.primaryType,
        message: args.message,
        signature: args.signature,
      } as never);
    },
    writeContract: async (args) => {
      if (args.functionName !== "transferWithAuthorization") {
        throw new Error(`unsupported writeContract: ${args.functionName}`);
      }
      const a = args.args;
      const auth = {
        from: a[0] as string,
        to: a[1] as string,
        value: BigInt(a[2] as bigint),
        validAfter: BigInt(a[3] as bigint),
        validBefore: BigInt(a[4] as bigint),
        nonce: a[5] as string,
      };
      const signature = signatureFor(a);
      const ok = await verifyTypedData({
        address: getAddress(auth.from),
        domain: domain(),
        types: authorizationTypes,
        primaryType: "TransferWithAuthorization",
        message: authorizationMessage(auth),
        signature,
      } as never);
      if (!ok) throw new Error("ERC20: invalid signature (invalid signature)");
      return takeAuthorization({ ...auth, signature }).txHash;
    },
    sendTransaction: async () => {
      throw new Error("sendTransaction is not supported by the local facilitator");
    },
    waitForTransactionReceipt: async (args) => {
      const receipt = receipts.get(args.hash);
      if (!receipt) throw new Error(`unknown transaction ${args.hash}`);
      return receipt as unknown as { status: string; logs?: readonly import("viem").Log[] };
    },
    getCode: async (args) => (lc(args.address) === lc(tokenAddress) ? "0x60016000" : "0x"),
  };

  const facilitator = new x402Facilitator();
  facilitator.register(opts.networks as Network[], new ExactEvmScheme(signer));

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
        token: { balanceOf, usedNonces, transfers },
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

function parseChainId(network: string): number {
  const match = /^eip155:(\d+)$/.exec(network);
  if (!match) throw new Error(`unsupported network ${network} (expected eip155:CHAIN_ID)`);
  return Number(match[1]);
}
