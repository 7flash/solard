export type AirdropDistributionMode = "fixed" | "equal-total" | "pro-rata";

export type AirdropRules = {
  name: string;
  bankWallet: string;
  sourceMint: string;
  payoutMint: string;
  holderLimit: number;
  minBalanceUi: string;
  minSharePct: string;
  excludedOwners: string[];
  mode: AirdropDistributionMode;
  fixedAmountUi: string;
  totalAmountUi: string;
  memo: string | null;
  priorityMicroLamports: number;
};

export type AirdropRecipient = {
  owner: string;
  rank: number;
  sourceAmountRaw: string;
  sourceBalanceUi: string;
  sourceSharePct: string;
  amountUi: string;
  amountRaw: string;
};

export type AirdropPlan = {
  schema: "solard.airdrop-plan";
  version: 3;
  planId: string;
  name: string;
  bankWallet: string;
  sourceMint: string;
  sourceDecimals: number;
  sourceSupplyRaw: string;
  payoutMint: string;
  payoutDecimals: number;
  payoutTokenProgram: "spl-token" | "token-2022";
  mode: AirdropDistributionMode;
  memo: string | null;
  priorityMicroLamports: number;
  holderSnapshotAtMs: number;
  recipientCount: number;
  totalAmountUi: string;
  totalAmountRaw: string;
  recipients: AirdropRecipient[];
  rules: AirdropRules;
  requestedAt: string;
};

export type AirdropRecipientStatus =
  "queued" | "sending" | "submitted" | "sent" | "failed" | "cancelled";

export type AirdropRecipientRun = AirdropRecipient & {
  status: AirdropRecipientStatus;
  signature?: string;
  error?: string;
};

export type AirdropJobStatus =
  | "queued"
  | "running"
  | "completed"
  | "partial"
  | "failed"
  | "attention"
  | "cancelled";

export type AirdropJobLog = {
  atMs: number;
  level: "info" | "warn" | "error";
  message: string;
};

export type AirdropJob = {
  id: string;
  planId: string;
  attempt: number;
  status: AirdropJobStatus;
  cancelRequested: boolean;
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
    cancelled: number;
    batchesTotal: number;
    batchesComplete: number;
  };
  signatures: string[];
  recipients: AirdropRecipientRun[];
  logs: AirdropJobLog[];
  error: string | null;
};
