Solard position controller V31 - resilient measured cycles

Based directly on the V30 no-dashboard position-controller.ts.

What changed
- Normal measure-fn streaming stays enabled; no terminal dashboard and no custom JSON logger.
- Transient snapshot / quote / RPC failures no longer kill a --loop controller.
- Failed non-execution cycles retry from a completely fresh snapshot with exponential backoff.
- New flags:
    --error-retry-ms 3000
    --error-retry-max-ms 30000
- New measure events:
    trade.submission.begin
    cycle.retry
    cycle.fail-stop.execution-ambiguous
- No stale decision is queued across a retry. The next attempt re-snapshots and re-decides.
- Execution ambiguity is deliberately NOT retried. Once a swap call begins, an error before
  its signature is durably written as pendingSettlement stops the agent, because the tx may
  have reached the network and an automatic retry could duplicate the trade.
- Once pendingSettlement is durably written, ordinary RPC/indexing errors are safe to retry;
  the existing V29/V30 settlement barrier reconciles the same signature first.
- V30 transaction-local economics and execution-price anchors are preserved unchanged.

Typical command does not need new flags. Defaults are 3s -> 6s -> 12s -> 24s -> 30s max.

This patch intentionally changes runtime resilience only, not value-band thresholds,
price guards, sizing, routing, or capital policy.
