# hermes-x402

> Wallet-funded onboarding for [Hermes Agent](https://github.com/NousResearch/hermes-agent). No API keys.

`hermes-x402` is a companion to Hermes that swaps "sign up for 6 services and paste API keys" for "fund a wallet, pick skills." Inference and other paid actions flow through a local bridge that pays via [x402](https://github.com/coinbase/x402) micropayments (USDC on Base) using your wallet.

## What it does

1. **Wallet setup** — generates or imports a local keypair for USDC payments
2. **On-chain balance** — checks your USDC balance on Base in real-time
3. **Skills marketplace** — browse 700+ paid API services from [agentic.market](https://agentic.market) and add them to your agent
4. **Inference bundles** — curated model + skill sets (Starter, Research, Builder)
5. **Auto-configuration** — patches Hermes config, registers MCP server, generates skill files

## Architecture

```
hermes → localhost:8402 → venice-x402-client → Venice API
                              │
                              └── SQLite ledger (every call costed)

hermes → MCP (stdio) → x402_fetch tool → any x402 endpoint (Exa, Perplexity, etc.)
                                              │
                                              └── pays USDC on Base automatically
```

- **Bridge** (`src/bridge`): Express service exposing OpenAI-compatible `/v1/chat/completions`, `/v1/embeddings`, `/v1/models`. Wraps `venice-x402-client`.
- **MCP Server** (`src/mcp`): Gives Hermes `x402_fetch` (pay any x402 endpoint) and `x402_wallet_info` (check balance) tools.
- **Wallet** (`src/lib/wallet.ts`): Generates/loads a keypair at `~/.hermes-x402/wallet.json`.
- **Marketplace** (`src/lib/marketplace.ts`): Fetches the agentic.market catalog, caches locally, enables skill browsing and selection.
- **Skill Generator** (`src/lib/skills-generator.ts`): Generates Hermes-compatible skill markdown files for selected x402 services.
- **Ledger** (`src/lib/ledger.ts`): Every call logged to SQLite.
- **Bundles** (`bundles/`): YAML definitions of curated model + skill sets.

## Quick start

```bash
npm install
npm run cli -- init             # 5-step setup: wallet → balance → marketplace → bundle → auto-config
npm run cli -- fund             # print address + USDC-on-Base instructions
# (send $5 USDC on Base to the address)
npm run cli -- balance          # verify funds arrived
npm run cli -- topup 5          # convert on-chain USDC → Venice balance
npm run cli -- start --daemon   # start the bridge
hermes                          # talk to your agent
```

## Skills marketplace

Browse and manage x402-compatible API services your agent can pay for:

```bash
x402 marketplace browse         # interactive skill browser (categories, search)
x402 marketplace search exa     # search by name/description
x402 marketplace add exa-ai     # add a service by ID
x402 marketplace remove exa-ai  # remove a service
x402 marketplace list           # show selected services
x402 marketplace refresh        # refresh catalog cache
```

Selected skills are persisted at `~/.hermes-x402/skills.json` and auto-generate Hermes skill files at `~/.hermes/skills/x402/`.

## Bundles

| Bundle | Skills included | Est. cost/hr |
|--------|----------------|-------------|
| `starter` | (inference only) | ~$0.05 |
| `research` | Exa, Firecrawl, Perplexity, Wolfram\|Alpha | ~$0.15 |
| `builder` | Exa, Firecrawl, E2B, StableEmail, Deepgram, Perplexity | ~$0.25 |

## CLI commands

| Command | Description |
|---------|-------------|
| `x402 init` | Full onboarding (wallet → marketplace → bundle → auto-config) |
| `x402 start` | Start the inference bridge |
| `x402 stop` | Stop the bridge daemon |
| `x402 status` | Bridge status |
| `x402 balance` | Wallet address + Venice balance |
| `x402 info` | Config paths, skills count, on-chain USDC |
| `x402 topup <amount>` | Convert on-chain USDC → Venice balance |
| `x402 spend` | Show recent inference spend |
| `x402 payments` | Show recent x402 payments |
| `x402 fetch <url>` | Make an x402-paid HTTP request |
| `x402 models` | List available Venice models |
| `x402 use <model>` | Switch the default model |
| `x402 install-mcp` | Register MCP server with Hermes |
| `x402 marketplace *` | Browse/manage x402 skills |

## Roadmap

- **v0** — bridge + Starter bundle (Venice inference only)
- **v1** ← *we are here* — marketplace, 3 bundles, on-chain balance, auto-config
- **v2** — Coinbase AWAL wallet provider, `spawn_child_agent` tool
- **v3** — bridgeless variants (see below)
- **v4+** — browser-native, upstream Hermes contribution

## Future: bridgeless

The localhost daemon is the right architecture for now (zero invasion of Hermes, reusable across any OpenAI-compatible client) but the wrong long-term answer. The per-machine bridge wants to disappear:

1. **Hermes-native x402 provider** — `provider: "x402"` directly in Hermes's provider list
2. **Drop-in OpenAI SDK shim** — `pip install openai-x402` / `npm install openai-x402`
3. **Header-level standard** — `X-402-Wallet-Signature` convention across inference gateways
4. **Browser-native** — WASM build + MetaMask/WalletConnect
