// Structural interfaces shared by the x402 rail and the packages the other
// workers are building (payee-guard, approval). The x402 rail never imports
// those packages; it accepts anything that matches these shapes.

/** The payment an x402 resource is asking for, in the terms the guard understands. */
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

/** Verifies the payee against the mandate allowlist (or a signed binding) and bounds the amount. */
export type PaymentGuard = (ask: PaymentAsk) => Promise<GuardResult>;

/** Telegram-style step-up approval. Called only when the store says approval_required. */
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
