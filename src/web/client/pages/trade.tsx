import {
  state,
  update,
  runAction,
  api,
  formData,
  mountPage,
  refreshOverview,
  refreshJobs,
  refreshPortfolio,
  refreshSignals,
  refreshPumpLive,
  refreshWatchGroups,
  startPumpFeed,
  stopPumpFeed,
  navigatePage,
  short,
  solFromLamports,
  formatSol,
  tokenUrl,
  tokenImage,
  TokenBadges,
  passesBadgeFilters,
  formatMcap,
  latestMcap,
  mcapChange,
  mcapChangePct,
  formatSignedMcap,
  formatPct,
  sortFeedRows,
  sortWatchRows,
  age,
  selectedWatchGroup,
  statusClass,
  isRetryExecution,
  friendlyExecutionKind,
  jobHeadline,
  jobStatusPill,
  latestJob,
  LaunchRunSummary,
  walletGroupBadges,
  walletHoldingsChips,
  walletBalanceForAddress,
  newBuyPlanRow,
  updateBuyPlanRow,
  removeBuyPlanRow,
  walletLabel,
  populateBuyPlanFromGroup,
  buyPlanPayload,
  addWatchedToken,
  removeWatchedToken,
  starPumpFeedRow,
  quickBuyPumpFeedRow,
  signalAction,
} from "../runtime";
import type {
  AnyRow,
  BuyPlanRow,
  PumpFeedRow,
  TokenWatchToken,
} from "../runtime";

export function TradePage() {
  return (
    <div className="grid">
      <form
        className="card span-6"
        onSubmit={(event) => {
          event.preventDefault();
          const body = formData(event.currentTarget);
          body.live = event.currentTarget.querySelector<HTMLInputElement>(
            "[name=live]",
          )?.checked
            ? "true"
            : "false";
          void runAction(() =>
            api("/api/trade/buy", {
              method: "POST",
              body: JSON.stringify(body),
            }),
          );
        }}
      >
        <h2>Buy</h2>
        <div className="form-grid">
          <label>
            Wallet
            <input name="wallet" required />
          </label>
          <label>
            Token
            <input name="token" required />
          </label>
          <label>
            SOL
            <input name="amountSol" defaultValue="0.01" />
          </label>
          <label>
            Slippage bps
            <input name="slippageBps" defaultValue="1500" />
          </label>
          <label>
            Sender
            <input name="sender" defaultValue="rpc" />
          </label>
          <label>
            <span>Live</span>
            <input type="checkbox" name="live" />
          </label>
          <button className="full">Buy</button>
        </div>
      </form>
      <form
        className="card span-6"
        onSubmit={(event) => {
          event.preventDefault();
          const body = formData(event.currentTarget);
          body.live = event.currentTarget.querySelector<HTMLInputElement>(
            "[name=live]",
          )?.checked
            ? "true"
            : "false";
          void runAction(() =>
            api("/api/trade/sell", {
              method: "POST",
              body: JSON.stringify(body),
            }),
          );
        }}
      >
        <h2>Sell</h2>
        <div className="form-grid">
          <label>
            Wallet
            <input name="wallet" required />
          </label>
          <label>
            Token
            <input name="token" required />
          </label>
          <label>
            Sell bps
            <input name="bps" defaultValue="10000" />
          </label>
          <label>
            Slippage bps
            <input name="slippageBps" defaultValue="1500" />
          </label>
          <label>
            Sender
            <input name="sender" defaultValue="rpc" />
          </label>
          <label>
            <span>Live</span>
            <input type="checkbox" name="live" />
          </label>
          <button className="full danger">Sell</button>
        </div>
      </form>
    </div>
  );
}

export default function mount() {
  return mountPage("trade", TradePage);
}
