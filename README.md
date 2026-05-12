# hermes-x402

> Wallet-funded onboarding for [Hermes Agent](https://github.com/NousResearch/hermes-agent). No API keys.

`hermes-x402` is a companion to Hermes that swaps "sign up for 6 services and paste API keys" for "fund a wallet, pick a bundle." Inference and other paid actions flow through a local bridge that pays via [x402](https://github.com/coinbase/x402) micropayments (USDC on Base) using your wallet — so the same wallet powers normal use AND the "metabolic agent" economic experiment, where inference cost is denominated in the same currency the agent could earn.

## Architecture

```
hermes → localhost:8402 → venice-x402-client → Venice API
                              │
                              └── SQLite ledger (every call costed)
```

- **Bridge** (`src/bridge`): Express service exposing OpenAI-compatible `/v1/chat/completions`, `/v1/embeddings`, `/v1/models`. Wraps `venice-x402-client`.
- **Wallet** (`src/lib/wallet.ts`): Generates/loads a fresh keypair at `~/.hermes-x402/wallet.json`. USDC-on-Base address.
- **Ledger** (`src/lib/ledger.ts`): Every call logged to SQLite — model, tokens, cost, balance after.
- **Bundles** (`bundles/`): YAML definitions of curated endpoint + skill sets.
- **CLI** (`src/cli`): `x402 init`, `start`, `balance`, `spend`, `fund`.

## Quick start

```bash
npm install
npm run cli -- init             # generate wallet, pick a bundle, patch Hermes config
npm run cli -- fund             # print address + USDC-on-Base instructions
# (send $5 USDC on Base to the address printed)
npm run cli -- balance          # verify funds arrived
npm run bridge                  # start the bridge on localhost:8402
hermes                          # in another terminal — talk to the agent
npm run cli -- spend --last 1h  # see what the agent spent on
```

## Roadmap

- **v0** ← *we are here* — bridge + Starter bundle (Venice inference only)
- **v1** — bundle system, 3 bundles (Starter / Builder / Multimedia)
- **v2** — `spawn_child_agent` tool + trajectory logger + batch runner
- **v3** — polish + potential upstream contribution to Hermes
- **v4+** — bridgeless variants (see below)

## Future: bridgeless

The localhost daemon is the right architecture for v0 (zero invasion of Hermes, reusable
across any OpenAI-compatible client) but the wrong long-term answer for broad scale. The
per-machine bridge is friction that ultimately wants to disappear. Worth prototyping:

1. **Hermes-native x402 provider.** Add `provider: "venice-x402"` (or generic `x402`)
   directly to Hermes's provider list — same pattern as the existing 20+ providers (OpenAI,
   Anthropic, OpenRouter, etc.). Wallet auth lives inside Hermes's Python HTTP client.
   No daemon, no port, no PID file. Likely a viable upstream contribution to Nous; would
   also serve as the reference implementation for #2 below.

2. **Drop-in OpenAI SDK shim.** `pip install openai-x402` / `npm install openai-x402`
   subclassing the official OpenAI client and overriding the auth header generator to
   sign SIWE/x402. Existing apps change one import line and inherit wallet-funded
   inference. Cross-framework — works for LangChain, LlamaIndex, Hermes, anything.

3. **Header-level standard.** Push for an `X-402-Wallet-Signature` (or similar) HTTP
   header convention that OpenAI-compatible servers and inference gateways recognize.
   Once adopted by Venice + OpenRouter + Vercel AI Gateway + LiteLLM, clients only need
   to know how to sign — no shim, no daemon. This is the durable systems answer.

4. **Browser-native.** WASM build of `venice-x402-client` + MetaMask / WalletConnect for
   the wallet. Inference from a browser tab with no Node process anywhere. Closes the
   loop for non-developer agents.

**Build-order intuition:** (1) is the fastest "I can use this myself" win; (2) is the
fastest "anyone can use this" win; (3) is the durable answer; (4) opens consumer surface.
v0's bridge stays the reference implementation while these mature — same wallet, same
ledger schema, just different transport.
