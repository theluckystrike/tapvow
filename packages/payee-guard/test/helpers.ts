import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { generateSigner } from "@mandate/core";
import { USDC, type PayeeBinding } from "../src/index.js";

export const NETWORK = "eip155:84532";
export const ASSET = USDC[NETWORK]!;
export const PAY_TO = "0x" + "b".repeat(40);

export interface TestServer {
  origin: string;
  close: () => Promise<void>;
}

export function newKey(): { signer: ReturnType<typeof generateSigner>["signer"]; publicKey: string } {
  return generateSigner("test-key");
}

export async function startServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<TestServer> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

export function makeBinding(
  origin: string,
  overrides?: Partial<PayeeBinding>,
): PayeeBinding {
  return {
    version: 1,
    origin,
    payees: [
      {
        network: NETWORK,
        asset: ASSET,
        pay_to: PAY_TO,
        quotes: [{ path: "/report", amount: "10000" }],
      },
    ],
    issued_at: "2026-10-17T00:00:00Z",
    expires_at: "2026-11-17T00:00:00Z",
    ...overrides,
  };
}
