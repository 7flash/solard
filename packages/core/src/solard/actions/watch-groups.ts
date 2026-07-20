import {
  addTokenToWatchGroup,
  createTokenWatchGroup,
  listTokenWatchGroups,
  removeTokenFromWatchGroup,
} from "../../pump/services/pump-live-store.ts";
import { measureSolard, summarizeForMeasure } from "../api-response.ts";

export type WatchGroupTokenInput = {
  mint: string;
  name?: string | null;
  symbol?: string | null;
  creator?: string | null;
  uri?: string | null;
  image?: string | null;
  signature?: string | null;
  marketCapSol?: number | string | null;
  isMayhemMode?: boolean | null;
  quoteAsset?: string | null;
  quoteMint?: string | null;
  source?: string | null;
};

function tokenFromInput(input: WatchGroupTokenInput) {
  const mint = input.mint?.trim();
  if (!mint) throw new Error("token mint is required");
  return {
    mint,
    name: input.name ?? null,
    symbol: input.symbol ?? null,
    creator: input.creator ?? null,
    uri: input.uri ?? null,
    image: input.image ?? null,
    signature: input.signature ?? null,
    marketCapSol:
      input.marketCapSol == null || input.marketCapSol === ""
        ? null
        : Number(input.marketCapSol),
    isMayhemMode:
      typeof input.isMayhemMode === "boolean" ? input.isMayhemMode : null,
    quoteAsset: input.quoteAsset ?? null,
    quoteMint: input.quoteMint ?? null,
    source: input.source ?? "solard-cli",
  };
}

export async function listWatchGroupsAction() {
  const measured = await measureSolard(
    "solard:action:watch-groups:list",
    "listWatchGroupsAction",
    () => listTokenWatchGroups(),
    {
      summarize: (value) => ({ count: value.length }),
      onError: (error) => {
        throw error;
      },
    },
  );
  return measured.value;
}

export async function createWatchGroupAction(input: { name: string }) {
  const name = input.name?.trim();
  if (!name) throw new Error("group name is required");
  const measured = await measureSolard(
    `solard:action:watch-groups:create:${name}`,
    "createWatchGroupAction",
    () => createTokenWatchGroup(name),
    {
      summarize: summarizeForMeasure,
      meta: { name },
      onError: (error) => {
        throw error;
      },
    },
  );
  return measured.value;
}

export async function addWatchGroupTokenAction(input: {
  groupId: string;
  token: WatchGroupTokenInput;
}) {
  const groupId = input.groupId?.trim() || "main";
  const token = tokenFromInput(input.token);
  const measured = await measureSolard(
    `solard:action:watch-groups:add-token:${groupId}`,
    "addWatchGroupTokenAction",
    () => addTokenToWatchGroup({ groupId, ...token }),
    {
      summarize: summarizeForMeasure,
      meta: { groupId, mint: token.mint },
      onError: (error) => {
        throw error;
      },
    },
  );
  return measured.value;
}

export async function removeWatchGroupTokenAction(input: {
  groupId: string;
  mint: string;
}) {
  const groupId = input.groupId?.trim();
  const mint = input.mint?.trim();
  if (!groupId) throw new Error("groupId is required");
  if (!mint) throw new Error("mint is required");
  const measured = await measureSolard(
    `solard:action:watch-groups:remove-token:${groupId}`,
    "removeWatchGroupTokenAction",
    () => removeTokenFromWatchGroup(groupId, mint),
    {
      summarize: summarizeForMeasure,
      meta: { groupId, mint },
      onError: (error) => {
        throw error;
      },
    },
  );
  return measured.value;
}
