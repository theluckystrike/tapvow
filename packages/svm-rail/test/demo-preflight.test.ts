import { describe, expect, test, vi } from "vitest";
import {
  prepareDevnetDemoActors,
  type DemoPreflightRpc,
} from "../src/demo-preflight.js";
import { SOLANA_DEVNET_GENESIS_HASH, SOLANA_MAINNET_GENESIS_HASH } from "../src/chain.js";

function rpcReturning(read: () => Promise<unknown>): DemoPreflightRpc {
  return { getGenesisHash: () => ({ send: read }) };
}

function rpcWithHash(hash: string): DemoPreflightRpc {
  return rpcReturning(async () => hash);
}

function actorPipeline() {
  const actor = vi.fn(async () => "actors");
  const setup = vi.fn();
  const send = vi.fn();
  const resolveActors = vi.fn(async () => {
    actor();
    setup();
    send();
    return "actors";
  });
  return { actor, setup, send, resolveActors };
}

describe("the devnet demo preflight", () => {
  test("refuses a valid non-devnet genesis before any actor stage runs", async () => {
    const { actor, setup, send, resolveActors } = actorPipeline();

    await expect(
      prepareDevnetDemoActors(rpcWithHash(SOLANA_MAINNET_GENESIS_HASH), resolveActors),
    ).rejects.toThrow(/could not verify Solana devnet/);
    expect(resolveActors).not.toHaveBeenCalled();
    expect(actor).not.toHaveBeenCalled();
    expect(setup).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  test("refuses an unknown genesis before any actor stage runs", async () => {
    const { actor, setup, send, resolveActors } = actorPipeline();

    await expect(
      prepareDevnetDemoActors(rpcWithHash("not-a-known-genesis-hash"), resolveActors),
    ).rejects.toThrow(/could not verify Solana devnet/);
    expect(resolveActors).not.toHaveBeenCalled();
    expect(actor).not.toHaveBeenCalled();
    expect(setup).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  test("refuses a failed genesis read without leaking the endpoint or auth", async () => {
    const { actor, setup, send, resolveActors } = actorPipeline();
    const rpc = rpcReturning(async () => {
      throw new Error("request to https://api.devnet.solana.com failed with api-key=secret");
    });

    await expect(prepareDevnetDemoActors(rpc, resolveActors)).rejects.toMatchObject({
      message: expect.not.stringMatching(/https?:\/\/|api-key|secret/i),
    });
    expect(resolveActors).not.toHaveBeenCalled();
    expect(actor).not.toHaveBeenCalled();
    expect(setup).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  test("awaits verified devnet before the next actor stage and makes no setup RPC", async () => {
    const calls: string[] = [];
    const read = vi.fn(async (options?: { abortSignal?: AbortSignal }) => {
      calls.push("genesis");
      expect(options?.abortSignal).toBeInstanceOf(AbortSignal);
      return SOLANA_DEVNET_GENESIS_HASH;
    });
    const rpc = {
      getGenesisHash: () => ({ send: read }),
      getBalance: vi.fn(),
      getLatestBlockhash: vi.fn(),
      sendTransaction: vi.fn(),
    };
    const actorStage = vi.fn(async () => {
      calls.push("actors");
      return { payeeAddress: "payee" };
    });

    const actors = await prepareDevnetDemoActors(rpc, actorStage);

    expect(actors.payeeAddress).toBe("payee");
    expect(calls).toEqual(["genesis", "actors"]);
    expect(actorStage).toHaveBeenCalledTimes(1);
    expect(rpc.getBalance).not.toHaveBeenCalled();
    expect(rpc.getLatestBlockhash).not.toHaveBeenCalled();
    expect(rpc.sendTransaction).not.toHaveBeenCalled();
  });
});
