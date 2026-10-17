# Tasks: 0.2.34

## Live check, 2026-10-17

- [ ] Expanded scope: verify custom-quote Pump launches with atomic SOL-funded creator buys, then live SOL/USD prices and SDK buy/sell on the launched token. Reuse verified quote discovery/conversion and preserve all guard/accounting requirements. Launch requirements and current launch source submitted to the selected session with R3 feedback; receipt confirmed.
- [x] Submit full-flow implementation request with reviewed Winflow source attachments to ChatGPT session `6ad289e5-cbbc-83ec-86ea-c4c600096f26`; receipt confirmed, round `20261017-r1`.
- [ ] Review the session's complete inline patch, integrate it, and verify fresh priced events plus actual unsigned buy simulation. State/cursor: `.docs/chatgpt-session/6ad289e5-cbbc-83ec-86ea-c4c600096f26/`.
- [x] Review first reply: diagnosis only, no code. Sent correction clarifying that ChatGPT authors the patch against source snapshots and Codex runs local validation. Correction submission confirmed; implementation remains pending.
- [x] Review candidate patch: not applied. Public mainnet proves canonical-only discovery misses the real noncanonical PUMP/SOL pool; captured patch also has malformed hunks. Sent exact findings and additional helper-source scan; complete corrected replacement pending (round r2).
- [x] Review R2 reply: attachment-only, no inline diff. Requested that exact generated R2 patch inline, without new changes. Attachment was not retrieved or applied; inline correction submission confirmed.
- [x] Integrate complete inline R2 after capture-format normalization; restore missing `curve` reference locally. Focused checks: 50 pass. Full npm test: 342 pass. No new core/SDK type diagnostics vs baseline.
- [ ] Complete live acceptance: tested providers hit 429/403 during history/account discovery; no fresh converted event or passing unsigned buy simulation yet. Return findings/current integrated source to the selected session for focused correction.
- [x] Recover R2 feedback: observed submitted user turn and R3 reply in selected chat; composer clear. Integrated R3, with 344 passing tests and no new baseline type diagnostics. Mainnet account reads remain blocked by configured RPC quota.
- [x] Send R3 results and current trade/launch source for incremental R4 work, including expanded launch acceptance; confirmed submitted. No signatures or funded transaction sent.
- [x] Check 5ubru mainnet market and SDK listener: 368 events, converted prices unavailable; diagnostic explicit-pool instructions construct.
- [ ] Repair funding-token discovery rejected by RPC, PUMP live conversion, and missing lookup tables before claiming this token trades through the default SDK path. See `docs/live-check-5ubru-2026-10-17.md`.

- [x] Inspect registry core public history-recorder export.
- [x] Synchronize package versions and internal pins to 0.2.34.
- [x] Add isolated npm archive runtime/readiness release gate.
- [x] Complete transport/custom-quote listener and execution repairs; exact SEEDCAT response/replay and read-only executable construction verified.
- [x] Run matching archive validation: runtime imports, seven SDK tests and 299 core tests pass.
- [ ] Publish matching packages and verify registry archives: npm/Bun upload rejected; npm access reports invalid authentication. No 0.2.34 package published.
- [ ] Funded mainnet acceptance (not performed).
- [ ] Verify a fresh live SEEDCAT tick; historical exact-signature replay passed but 45-second observation received none.
