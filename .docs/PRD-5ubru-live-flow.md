# PRD: Custom-quote launch, live prices and trading

## Problem
The SDK receives mainnet trades for 5ubruMYpgKqw9ip5J1qrXbVGmMdn2VCsMg421B4bpump but produces no converted SOL/USD prices. Default PUMP funding discovery is rejected by RPC, and explicit-pool buy instructions exceed the v0 packet size without suitable lookup tables.

The user clarified that custom-quote launches must work too. Acceptance covers the whole supported Pump flow: launch with a SOL-funded creator buy, fresh converted prices, and subsequent SOL-funded buy/sell through the SDK. Existing launch APIs are not proof of working mainnet execution.

## Constraints
Use ChatGPT conversation 6ad289e5-cbbc-83ec-86ea-c4c600096f26 for implementation. Preserve the dirty working tree and existing trade guards. Do not use Codex sub-agents. No wallet secrets in attachments. Mainnet submission requires a concrete wallet, amount, successful simulation and transaction review.

## Acceptance
- [ ] Default discovery resolves verified base and funding markets without the rejected broad scan.
- [ ] Fresh matching events contain verified SOL/USD prices and supply-based capitalization.
- [ ] Public SDK creates a packet-size-valid protected buy through the caller's RPC path.
- [ ] Actual unsigned simulation passes, with size, minima, fees and logs observable.
- [ ] Funded transaction is reviewed and confirmed, with actual accounting verified.
- [ ] Deterministic tests and relevant checks pass; existing unrelated diagnostics are identified.
- [ ] Prepare and simulate a supported custom-quote Pump launch with a SOL-funded creator buy; creation and buy are atomic, with protected minima and actual quote mint/program/decimals.
- [ ] Verify protocol eligibility for listed quotes and eligible Pump quote coins, including unmigrated curves, migration gaps and prohibited mayhem/nested quotes; unsupported launches fail explicitly before submission.
- [ ] After an approved funded custom-quote launch, receive fresh converted SOL/USD prices and supply-based caps for the new token, then verify SDK buy/sell and confirmed accounting.
- [ ] Launch and trade transactions fit packet limits with validated lookup tables or a compact route; any on-chain ALT setup is separately reviewable.

## Implementation handoff
Winflow scans and mainnet observations are submitted to the selected chat. Require one complete inline unified diff. Codex reviews, integrates, tests and returns factual feedback under the session's semi-manual workflow. No publishing or schema rewrite is part of this task.
