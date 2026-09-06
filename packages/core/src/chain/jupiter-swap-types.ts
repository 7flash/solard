export type JupiterSwapOrder = {
  transaction?: string | null;
  requestId?: string;
  inAmount?: string;
  outAmount?: string;
  router?: string;
  mode?: string;
  feeBps?: number;
  feeMint?: string;
  errorCode?: number;
  errorMessage?: string;
};

export type JupiterSwapQuote = {
  inputMint: string;
  outputMint: string;
  amountRaw: bigint;
  outAmountRaw: bigint;
  router: string | null;
  feeBps: number | null;
  feeMint: string | null;
};

export type JupiterSwapExecuteResult = {
  status: "Success" | "Failed";
  signature?: string;
  code: number;
  totalInputAmount?: string;
  totalOutputAmount?: string;
  inputAmountResult?: string;
  outputAmountResult?: string;
  error?: string;
};
