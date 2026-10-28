export interface ApprovalRequest {
  mandateId: string;
  agentId: string;
  rail: "llm" | "x402";
  payee: string;
  amountMicros: number;
  summary: string;
}

export type ApprovalDecision =
  | { decision: "approved"; requestId: string; decidedBy: string; decidedAt: string; latencyMs: number }
  | { decision: "denied"; requestId: string; decidedBy: string; decidedAt: string; latencyMs: number }
  | { decision: "timeout"; requestId: string; decidedAt: string; latencyMs: number };

export interface Approver {
  request(req: ApprovalRequest): Promise<ApprovalDecision>;
  close(): Promise<void>;
}
