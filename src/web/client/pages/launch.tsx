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

function BuyPlanTable() {
  const wallets = state.overview?.wallets ?? [];
  const groups = state.overview?.groups ?? [];
  return (
    <div className="launch-panel span-12 buy-plan-panel">
      <div className="section-head">
        <div>
          <div className="section-kicker">Parallel followers</div>
          <h2>Follower buy plan</h2>
          <p className="muted">
            Each card is one wallet lane. Mix amount rules, sender, strategy,
            fees and retry rhythm in the same launch.
          </p>
        </div>
        <div className="plan-toolbar">
          <select id="buy-plan-group-select" className="group-picker">
            <option value="">Load wallets from group…</option>
            {groups.map((group: AnyRow) => (
              <option value={group.name}>{group.name}</option>
            ))}
          </select>
          <button
            type="button"
            className="secondary"
            onClick={() => {
              const select = document.getElementById(
                "buy-plan-group-select",
              ) as HTMLSelectElement | null;
              if (select?.value) populateBuyPlanFromGroup(select.value);
            }}
          >
            Load group
          </button>
          <button
            type="button"
            onClick={() => {
              state.buyPlanRows = [
                ...state.buyPlanRows,
                newBuyPlanRow({
                  label: `buyer-${state.buyPlanRows.length + 1}`,
                }),
              ];
              update();
            }}
          >
            Add wallet
          </button>
        </div>
      </div>

      <div className="plan-summary">
        <span>
          <b>{state.buyPlanRows.length}</b> wallet lanes
        </span>
        <span>
          <b>
            {
              state.buyPlanRows.filter((row) => row.sender === "helius-fast")
                .length
            }
          </b>{" "}
          Helius fast
        </span>
        <span>
          <b>
            {
              state.buyPlanRows.filter((row) => row.strategy.includes("spam"))
                .length
            }
          </b>{" "}
          spam lanes
        </span>
        <span>Rows override the fallback buyer group settings.</span>
      </div>

      <div className="plan-list">
        {state.buyPlanRows.map((row, index) => (
          <div className="plan-card" data-sender={row.sender}>
            <div className="plan-card-top">
              <div className="lane-badge">#{index + 1}</div>
              <label className="field label-field">
                <span>Label</span>
                <input
                  placeholder="buyer-1"
                  value={row.label}
                  onInput={(event: any) =>
                    updateBuyPlanRow(row.id, {
                      label: event.currentTarget.value,
                    })
                  }
                />
              </label>
              <label className="field wallet-field">
                <span>Wallet</span>
                <select
                  value={row.wallet}
                  onInput={(event: any) =>
                    updateBuyPlanRow(row.id, {
                      wallet: event.currentTarget.value,
                    })
                  }
                >
                  <option value="">Select wallet…</option>
                  {wallets.map((wallet: AnyRow) => (
                    <option value={wallet.address}>
                      {walletLabel(wallet)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field sender-field">
                <span>Sender</span>
                <select
                  value={row.sender}
                  onInput={(event: any) =>
                    updateBuyPlanRow(row.id, {
                      sender: event.currentTarget.value,
                    })
                  }
                >
                  <option value="helius-fast">Helius fast</option>
                  <option value="helius-rpc">Helius RPC</option>
                </select>
              </label>
              <label className="field strategy-field">
                <span>Strategy</span>
                <select
                  value={row.strategy}
                  onInput={(event: any) =>
                    updateBuyPlanRow(row.id, {
                      strategy: event.currentTarget.value,
                    })
                  }
                >
                  <option value="fast-spam">Fast spam</option>
                  <option value="spam-after-market-ready">
                    Market-ready spam
                  </option>
                  <option value="after-deploy-processed">
                    After processed
                  </option>
                  <option value="after-deploy-confirmed">
                    After confirmed
                  </option>
                </select>
              </label>
              <button
                type="button"
                className="danger compact"
                onClick={() => removeBuyPlanRow(row.id)}
              >
                Remove
              </button>
            </div>

            <div className="plan-card-body">
              <div className="plan-block amount-block">
                <div className="block-title">Amount</div>
                <div className="inline-fields">
                  <label className="field wide">
                    <span>Mode</span>
                    <select
                      value={row.amountMode}
                      onInput={(event: any) =>
                        updateBuyPlanRow(row.id, {
                          amountMode: event.currentTarget.value,
                        })
                      }
                    >
                      <option value="range-bps">Balance % range</option>
                      <option value="exact-sol">Exact SOL</option>
                      <option value="exact-lamports">Exact lamports</option>
                    </select>
                  </label>
                  {row.amountMode === "range-bps" ? (
                    <>
                      <label className="field">
                        <span>Min %</span>
                        <input
                          value={String(Number(row.minBps || "0") / 100)}
                          onInput={(event: any) =>
                            updateBuyPlanRow(row.id, {
                              minBps: String(
                                Math.round(
                                  Number(event.currentTarget.value || "0") *
                                    100,
                                ),
                              ),
                            })
                          }
                        />
                      </label>
                      <label className="field">
                        <span>Max %</span>
                        <input
                          value={String(Number(row.maxBps || "0") / 100)}
                          onInput={(event: any) =>
                            updateBuyPlanRow(row.id, {
                              maxBps: String(
                                Math.round(
                                  Number(event.currentTarget.value || "0") *
                                    100,
                                ),
                              ),
                            })
                          }
                        />
                      </label>
                      <label className="field">
                        <span>Reserve SOL</span>
                        <input
                          value={row.reserveSol}
                          onInput={(event: any) =>
                            updateBuyPlanRow(row.id, {
                              reserveSol: event.currentTarget.value,
                            })
                          }
                        />
                      </label>
                    </>
                  ) : null}
                  {row.amountMode === "exact-sol" ? (
                    <label className="field">
                      <span>Exact SOL</span>
                      <input
                        placeholder="0.25"
                        value={row.exactSol}
                        onInput={(event: any) =>
                          updateBuyPlanRow(row.id, {
                            exactSol: event.currentTarget.value,
                          })
                        }
                      />
                    </label>
                  ) : null}
                  {row.amountMode === "exact-lamports" ? (
                    <label className="field">
                      <span>Lamports</span>
                      <input
                        placeholder="250000000"
                        value={row.exactLamports}
                        onInput={(event: any) =>
                          updateBuyPlanRow(row.id, {
                            exactLamports: event.currentTarget.value,
                          })
                        }
                      />
                    </label>
                  ) : null}
                </div>
              </div>

              <div className="plan-block fee-block">
                <div className="block-title">Fees & slippage</div>
                <div className="inline-fields">
                  <label className="field">
                    <span>Tip SOL</span>
                    <input
                      value={row.tipSol}
                      disabled={row.sender !== "helius-fast"}
                      onInput={(event: any) =>
                        updateBuyPlanRow(row.id, {
                          tipSol: event.currentTarget.value,
                        })
                      }
                    />
                  </label>
                  <label className="field">
                    <span>Priority µ-lamports</span>
                    <input
                      value={row.priorityMicroLamports}
                      onInput={(event: any) =>
                        updateBuyPlanRow(row.id, {
                          priorityMicroLamports: event.currentTarget.value,
                        })
                      }
                    />
                  </label>
                  <label className="field">
                    <span>Slippage bps</span>
                    <input
                      value={row.slippageBps}
                      onInput={(event: any) =>
                        updateBuyPlanRow(row.id, {
                          slippageBps: event.currentTarget.value,
                        })
                      }
                    />
                  </label>
                </div>
              </div>

              <div className="plan-block retry-block">
                <div className="block-title">Retry</div>
                <div className="inline-fields">
                  <label className="field">
                    <span>Retry ms</span>
                    <input
                      value={row.retryIntervalMs}
                      onInput={(event: any) =>
                        updateBuyPlanRow(row.id, {
                          retryIntervalMs: event.currentTarget.value,
                        })
                      }
                    />
                  </label>
                  <label className="field">
                    <span>Recompile ms</span>
                    <input
                      value={row.recompileIntervalMs}
                      onInput={(event: any) =>
                        updateBuyPlanRow(row.id, {
                          recompileIntervalMs: event.currentTarget.value,
                        })
                      }
                    />
                  </label>
                  <label className="field">
                    <span>Fresh quote delay</span>
                    <input
                      value={row.freshQuoteDelayMs}
                      onInput={(event: any) =>
                        updateBuyPlanRow(row.id, {
                          freshQuoteDelayMs: event.currentTarget.value,
                        })
                      }
                    />
                  </label>
                  <label className="field">
                    <span>Max failed</span>
                    <input
                      value={row.maxFailedAttempts}
                      onInput={(event: any) =>
                        updateBuyPlanRow(row.id, {
                          maxFailedAttempts: event.currentTarget.value,
                        })
                      }
                    />
                  </label>
                </div>
              </div>
            </div>
          </div>
        ))}
        {state.buyPlanRows.length === 0 ? (
          <div className="empty-plan">
            <b>No custom follower rows.</b>
            <span>
              Load a group or add wallets manually. Without rows, the fallback
              buyer-group settings are used.
            </span>
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function LaunchPage() {
  return (
    <form
      className="launch-grid"
      onSubmit={(event) => {
        event.preventDefault();
        const body = formData(event.currentTarget);
        body.live = event.currentTarget.querySelector<HTMLInputElement>(
          "[name=live]",
        )?.checked
          ? "true"
          : "false";
        body.skipSimulation =
          event.currentTarget.querySelector<HTMLInputElement>(
            "[name=skipSimulation]",
          )?.checked
            ? "true"
            : "false";
        const explicitBuyPlan = buyPlanPayload();
        if (explicitBuyPlan.length > 0) body.buyPlan = explicitBuyPlan;
        void runAction(async () => {
          const started = await api<{ id: string }>("/api/launch/pump", {
            method: "POST",
            body: JSON.stringify(body),
          });
          state.selectedJobId = started.id;
          await refreshJobs();
        });
      }}
    >
      <div className="launch-hero span-12">
        <div>
          <div className="section-kicker">Pump launch builder</div>
          <h2>Build a token launch + parallel follower plan</h2>
          <p className="muted">
            Configure metadata, creator buy, per-wallet follower lanes, and
            sender strategy in one place before starting the job.
          </p>
        </div>
        <div className="launch-actions">
          <label className="toggle-card">
            <span>Live</span>
            <input type="checkbox" name="live" />
          </label>
          <label className="toggle-card">
            <span>Skip sim</span>
            <input type="checkbox" name="skipSimulation" defaultChecked />
          </label>
          <button type="submit" className="primary-large">
            Start launch job
          </button>
        </div>
      </div>

      <div className="span-12">
        <LaunchRunSummary job={latestJob()} />
      </div>

      <div className="launch-panel span-7">
        <div className="section-head compact-head">
          <div>
            <div className="section-kicker">01</div>
            <h3>Token metadata</h3>
          </div>
        </div>
        <div className="clean-form token-form">
          <label className="field full">
            <span>Metadata JSON path</span>
            <input name="metadataPath" placeholder="./metadata/mind.json" />
          </label>
          <label className="field">
            <span>Alias</span>
            <input name="alias" placeholder="mind" />
          </label>
          <label className="field">
            <span>Name</span>
            <input name="name" placeholder="Mind Token" />
          </label>
          <label className="field">
            <span>Symbol</span>
            <input name="symbol" placeholder="MIND" />
          </label>
          <label className="field">
            <span>Metadata URI</span>
            <input name="uri" placeholder="ipfs:// or https://" />
          </label>
          <label className="field full">
            <span>Server image path</span>
            <input name="imagePath" placeholder="./metadata/mind.png" />
          </label>
          <label className="field full">
            <span>Description</span>
            <textarea
              name="description"
              placeholder="Optional; auto-filled if empty."
            />
          </label>
        </div>
      </div>

      <div className="launch-panel span-5">
        <div className="section-head compact-head">
          <div>
            <div className="section-kicker">02</div>
            <h3>Launch defaults</h3>
          </div>
        </div>
        <div className="clean-form defaults-form">
          <label className="field full">
            <span>Creator wallet</span>
            <input name="creator" required placeholder="name or address" />
          </label>
          <label className="field">
            <span>Creator buy SOL</span>
            <input name="creatorBuySol" placeholder="0" />
          </label>
          <label className="field">
            <span>Buyer group fallback</span>
            <input name="buyerGroup" placeholder="mind-buyers" />
          </label>
          <label className="field">
            <span>Buyer min %</span>
            <input name="buyerMinBps" defaultValue="5000" />
          </label>
          <label className="field">
            <span>Buyer max %</span>
            <input name="buyerMaxBps" defaultValue="8000" />
          </label>
          <label className="field">
            <span>Reserve SOL</span>
            <input name="buyerReserveSol" defaultValue="0.02" />
          </label>
          <label className="field">
            <span>Deploy sender</span>
            <select name="deploymentSender">
              <option value="helius-rpc">Helius RPC</option>
              <option value="helius-fast">Helius fast</option>
            </select>
          </label>
          <label className="field">
            <span>Buyer sender</span>
            <select name="buyerSender">
              <option value="helius-fast">Helius fast</option>
              <option value="helius-rpc">Helius RPC</option>
            </select>
          </label>
          <label className="field full">
            <span>Submit mode</span>
            <select name="submitMode">
              <option value="fast-spam">Fast spam</option>
              <option value="spam-after-market-ready">Market-ready spam</option>
              <option value="after-deploy-processed">After processed</option>
              <option value="after-deploy-confirmed">After confirmed</option>
            </select>
          </label>
        </div>
      </div>

      <BuyPlanTable />

      <div className="launch-panel span-12 global-strip">
        <div>
          <div className="section-kicker">03</div>
          <h3>Global execution defaults</h3>
          <p className="muted small">
            Used when a follower row does not override the value.
          </p>
        </div>
        <div className="global-fields">
          <label className="field">
            <span>Sender TPS</span>
            <input name="senderTps" defaultValue="40" />
          </label>
          <label className="field">
            <span>Helius tip SOL</span>
            <input name="heliusTipSol" defaultValue="0.001" />
          </label>
          <label className="field">
            <span>Buyer priority</span>
            <input name="buyerPriorityMicroLamports" defaultValue="1500000" />
          </label>
          <label className="field">
            <span>Slippage bps</span>
            <input name="slippageBps" defaultValue="9999" />
          </label>
          <label className="field">
            <span>Fresh quote delay</span>
            <input name="freshQuoteDelayMs" defaultValue="-1" />
          </label>
          <button type="submit" className="primary-large bottom-submit">
            Start launch job
          </button>
        </div>
      </div>
    </form>
  );
}

export default function mount() {
  return mountPage("launch", LaunchPage);
}
