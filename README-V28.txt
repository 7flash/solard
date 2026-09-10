Solard position-controller V28 — normal measure-fn output

This patch is deliberately logging-only.

Problem
-------
@solard/core initializes measure-fn silently when loaded as a library. `slrd run`
spawns examples/position-controller.ts in a separate Bun process, so the parent
CLI's configureSolardMeasure()/--measure-stream state does not exist in the child.
The controller had many createSolardMeasure spans, but never enabled their renderer.

Fix
---
- Import configureSolardMeasure from @solard/sdk.
- Call configureSolardMeasure({ silent: false }) before creating the value-band scope.
- Keep measure-fn's built-in renderer.
- No terminal dashboard.
- No custom logger.
- No JSONL audit stream.
- No strategy/trading changes.

Expected output resembles:
  [slrd:value-band-agent:a] → agent.start
  [slrd:value-band-agent:b] → cycle
  [slrd:value-band-agent:b-a] → snapshot
  [slrd:value-band-agent:b-a] ✓ ... → {...}
  [slrd:value-band-agent:b-b] → decision
  ...

Apply:
  .\apply-v28.ps1 -Repo C:\Code\solwal
