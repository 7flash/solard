export type AirdropRecipient = {
  owner: string;
  amountUi: string;
  amountRaw: string;
  sourceBalanceUi?: number;
  sourceSharePct?: number;
};

export type AirdropPlan = {
  schema: "solard.airdrop-plan";
  version: 2;
  planId: string;
  name: string;
  bankWallet: string;
  sourceMint: string;
  payoutMint: string;
  payoutDecimals: number;
  mode: "fixed" | "equal-total" | "pro-rata";
  memo: string | null;
  recipients: AirdropRecipient[];
  recipientCount: number;
  totalAmountUi: string;
  totalAmountRaw: string;
  requestedAt: string;
};

export type AirdropRecipientRun = AirdropRecipient & {
  status: "queued" | "sending" | "sent" | "failed";
  signature?: string;
  error?: string;
};

export type AirdropJobStatus =
  "queued" | "running" | "completed" | "partial" | "failed";

export type AirdropJobLog = {
  atMs: number;
  level: "info" | "warn" | "error";
  message: string;
};

export type AirdropJob = {
  id: string;
  planId: string;
  status: AirdropJobStatus;
  createdAtMs: number;
  updatedAtMs: number;
  startedAtMs: number | null;
  finishedAtMs: number | null;
  plan: AirdropPlan;
  progress: {
    total: number;
    attempted: number;
    sent: number;
    failed: number;
    batchesTotal: number;
    batchesComplete: number;
  };
  signatures: string[];
  recipients: AirdropRecipientRun[];
  logs: AirdropJobLog[];
  error: string | null;
};
