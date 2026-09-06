SOLARD RAYDIUM + LAUNCHLAB PATCH

What this adds
- Native Raydium exact-in swaps through the Raydium Trade API transaction builder.
- `slrd swap ... --venue raydium` while keeping Jupiter as the default path.
- Raydium LaunchLab config discovery, token launch, buy, and sell.
- Raydium CPMM pool creation for arbitrary existing SPL/SPL pairs, including tokenized-stock quote/base mints.
- Preview/simulation by default. Live writes require BOTH `--live` and `SOLARD_ENABLE_LIVE_TRADES=1`.
- Preserves the existing `slrd meteora lp-5m` CLI integration from the previous patch.

Install dependencies after copying the files:
  bun install

Examples

Quote / swap:
  slrd raydium quote --from SOL --to <MINT> --amount 1
  slrd swap --from SOL --to <MINT> --amount 1 --wallet phantom --venue raydium

LaunchLab configs:
  slrd raydium launchlab configs
  slrd raydium launchlab configs --quote <QUOTE_MINT>

Launch a token (preview first):
  slrd raydium launchlab launch --wallet phantom --name "My Coin" --symbol MYC --uri <METADATA_URI> --quote SOL

Launch live using the exact mint keypair produced by preview:
  $env:SOLARD_ENABLE_LIVE_TRADES="1"
  slrd raydium launchlab launch --wallet phantom --name "My Coin" --symbol MYC --uri <METADATA_URI> --quote SOL --mint-keypair <PATH_FROM_PREVIEW> --live

LaunchLab buy / sell:
  slrd raydium launchlab buy <MINT> --wallet phantom --quote SOL --amount 1
  slrd raydium launchlab sell <MINT> --wallet phantom --quote SOL --amount 100000

Arbitrary SPL/SPL pair (for example token + tokenized-stock mint):
  slrd raydium cpmm create --wallet phantom --mint-a <TOKEN_MINT> --mint-b <STOCK_TOKEN_MINT> --amount-a 1000000 --amount-b 10

Important LaunchLab constraint
LaunchLab can only launch against quote mints that have an on-chain LaunchLab config. The command checks this before generating a mint keypair. If the requested stock/token quote has no LaunchLab config, use `slrd raydium cpmm create` to create the arbitrary SPL/SPL pair instead.
