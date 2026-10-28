// Structural interfaces shared by the SVM rail, the guard and the tests.

/** The payment a Solana x402 resource asks for. */
export interface PaymentAsk {
  resourceUrl: string;
  network: string;
  asset: string;
  payTo: string;
  amount: string;
}

export type GuardResult =
  | {
      ok: true;
      amountMicros: number;
      payeeBasis: "allowlist" | "binding";
      priceBasis: string;
      referenceMicros: number | null;
      bindingHash?: string;
    }
  | { ok: false; code: string; reason: string };

export type PaymentGuard = (ask: PaymentAsk) => Promise<GuardResult>;

/** Telegram-style step-up approval. */
export interface Approver {
  request(req: {
    mandateId: string;
    agentId: string;
    rail: "llm" | "x402";
    payee: string;
    amountMicros: number;
    summary: string;
  }): Promise<{ decision: "approved" | "denied" | "timeout"; requestId: string; decidedBy?: string }>;
}

/** What an on-chain read says about one signed transfer. */
export type ChainVerification =
  | { status: "success"; slot?: number }
  | { status: "failed"; reason: string }
  | { status: "pending"; reason: string }
  | { status: "missing"; reason: string }
  | { status: "mismatch"; reason: string }
  | { status: "error"; reason: string };

export interface TransferFacts {
  network: string;
  mint: string;
  payTo: string;
  amountAtomic: string;
  payer: string;
}

/**
 * The chain reads the SVM rail needs. The real adapter reads Solana RPC; a
 * fake is a small object for tests.
 */
export interface SolanaChain {
  /** A cheap reachability check before any signature is made. */
  preflight(): Promise<void>;
  /** The RPC genesis hash. When present, the rail checks it against its networks. */
  getGenesisHash?(): Promise<string>;
  /** Read one transaction signature and check the transfer against facts. */
  verifyTransfer(signature: string, facts: TransferFacts): Promise<ChainVerification>;
  /**
   * Find a transfer from payer after sinceMs. The result is three-state on
   * purpose. "none" means the whole window was read and held no match.
   * "incomplete" means the scan hit its cap or its deadline, so the rail did
   * not prove that no money moved and must fail closed.
   */
  findTransfer(
    facts: TransferFacts & { sinceMs: number; deadlineMs?: number },
  ): Promise<TransferSearch>;
}

/** The result of one payer history scan. */
export type TransferSearch =
  | { kind: "found"; signature: string }
  | { kind: "none" }
  | { kind: "incomplete"; capped: boolean; timedOut: boolean };
