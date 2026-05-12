# hermes-x402 — Next steps

Working roadmap. **P0** is what blocks broader use. **P1** is quality / completeness.
**P2+** is scope / scaling. Bridgeless directions live in [README.md → Future: bridgeless](README.md).

---

## P0 — Onboarding & wallet provider abstraction

Today `x402 init` always generates a fresh local keypair. Fine for solo dev,
wrong as the default once anyone else uses this. **This is the gating P0** —
without a real onboarding flow nobody who isn't us can use this.

### Goal
At first run, the user:
1. Picks how they want to provide a wallet,
2. Picks which x402-compatible skills/bundles to enable,
3. Is funded in one flow.

### Wallet provider abstraction

Replace the hardcoded `loadWallet()` with a `WalletProvider` interface so we
can plug in:

| Provider | When to pick | Status |
|---|---|---|
| **Local keypair** (current) | Solo dev, "I'll move funds myself" | done |
| **Coinbase AWAL (Agentic Wallet)** | Production. Smart wallet, gasless via paymaster, prod-ready. | **P0 next** |
| **WalletConnect** | Bring an existing wallet (mobile, hardware) | P0 next |
| **MetaMask** | Browser-native variant only | future |
| **Custodial / API-key wallets** | If user wants a managed service | future |

Each provider supplies:
- `address`
- `signTypedData(...)`, `signMessage(...)` — for x402 SIWE/EIP-712 auth
- `signEip3009(...)` — USDC `transferWithAuthorization`
- `getBalance(network, asset)`

Refactor `src/lib/wallet.ts` into `src/lib/wallet/{local,coinbase-awal,wc}.ts`.
`getX402Fetch()` accepts any provider that satisfies a `viem.LocalAccount`-ish
interface so `@x402/evm` can use it unchanged.

### Onboarding flow (target UX)

```
$ x402 init

  Welcome to hermes-x402.

  ? How do you want to provide a wallet?
    ❯ Local keypair (generate or import) — simplest, hot key on this machine
      Coinbase AWAL — smart wallet, gasless via paymaster
      WalletConnect — bring an existing wallet
      I'll configure later

  ? Pick bundles to install (space to select):
    ◉ starter        Venice inference (chat, embeddings)
    ◉ research       + Exa search ($0.007/call)
    ◯ multimedia     + image / audio / video generation
    ◯ compute        + Conway sandboxes (agent self-hosting)
    ◯ all-of-the-above

  Generated wallet 0xABC… (local)
  Send $5+ USDC on Base to fund. [QR]
  …
```

### Richer bundle schema

Today a bundle is just config patches. Make it self-documenting so the agent
doesn't have to discover schemas through trial-and-error (the Exa
body-shape bug would have been solved by this):

```yaml
name: research
endpoints:
  - id: exa-search
    url: https://api.exa.ai/search
    method: POST
    pricing: $0.007/call (up to 10 results)
    docs: https://exa.ai/docs/reference/x402-guide
    sample_body: { query: string, numResults: 1-10 }
    capped_results: 10
skills:
  - name: web-research
    source: skills/web-research.md
mcp_tools_exposed:
  - x402_fetch
```

`x402 bundle install <name>` would:
1. Patch Hermes config (existing).
2. Drop skill markdown into `~/.hermes/skills/` so the agent has documented
   schemas at hand.
3. Optionally pre-seed Hermes memory with the bundle's "how to use" notes.

---

## P0 — Curated x402 bundles (you curate)

I'll wait on your list, but as a strawman to react to:

| Bundle | Endpoints | Use case |
|---|---|---|
| `starter` | Venice (chat, embeddings) | baseline — done |
| `research` | + Exa, + Parallel.AI, + Tavily | agent-driven web research |
| `multimedia` | + Venice images/audio/video | content generation |
| `finance` | + market data, + Polygon, + Dune | trading research |
| `compute` | + Conway, + e2b, + Daytona (if x402) | agent self-hosting (see below) |
| `identity` | + Worldcoin, + ENS, + Lens, + Farcaster | onchain identity |
| `dev` | + Replicate, + GitHub Copilot via x402 (if any) | engineering |
| `all` | every above | max capability |

Framework + 2–3 bundles is enough for the first cut. Iterate after that.

---

## P0 — Agent self-hosting via x402

The capability that defines the experiment phase: **the agent pays for its
own compute and persistence**. Once that loop is closed, the metabolic
experiment becomes "does it earn faster than it burns on hosting + inference."

### Conway sandboxes (likely first)

[docs.conway.tech/cloud/sandboxes](https://docs.conway.tech/cloud/sandboxes) — if
Conway's sandbox API accepts x402 payment (TBD; check), it's the cleanest path
because:
- We can pay per-second of compute
- Sandboxes can host long-running Hermes processes
- It's the same primitive as "agent spawns a child agent in a separate machine"

Sketch — new MCP tool wrapping `x402_fetch`:

```ts
server.tool('x402_provision_sandbox',
  'Pay to spin up a fresh sandbox the agent can deploy itself into.',
  {
    template: z.enum(['hermes-x402', 'bare', 'gpu']),
    ttl_hours: z.number().default(24),
    max_cost_usdc: z.number().default(1.00),
  },
  async (args) => {
    // POST https://api.conway.tech/sandboxes via x402-fetch
    // returns { id, url, expires_at }
  }
)
```

### Alternatives to investigate
- **Modal** (already a Hermes terminal backend) — supports serverless persistence; x402 support TBD
- **Daytona** (Hermes-supported) — serverless dev environments
- **e2b** — code-exec sandboxes
- **Fly.io** — long-running VMs

Selection criterion: which providers natively accept x402 payment headers
today. Where they don't, build a thin proxy (similar to our Venice bridge)
that converts API-key access into wallet-paid access. Each such proxy is its
own potential product.

### The bigger pattern

Self-hosting is one instance of a general capability — **the agent should be
able to pay for anything an autonomous business would need**:
- Compute (sandboxes, GPUs)
- Storage (S3-x402 if/when it exists)
- Domains + DNS
- Identity (ENS registration)
- Payment rails for receiving payments

Each of these is a separate `x402_*` tool or a bundle.

---

## P1 — Quality / completeness gaps

### Per-call cost tracking
`inference_calls.cost_usdc` is always `NULL` today. Fix: record `balance_before`
in addition to `balance_after`, derive cost = before − after. Update
`x402 spend` to show per-model `$/call` averages. Same fix on the x402_payments
table (right now we read amount from the `PAYMENT-RESPONSE` header but the
decoder doesn't surface it correctly — see next item).

### `PAYMENT-RESPONSE` decoder
`extractPaymentInfo()` returned `$0.000000` for a real Exa payment that
actually settled. The tx hash works; the amount field doesn't. Inspect
`decodePaymentResponseHeader`'s real return shape (probably nested under
`payload` or similar) and fix the amount extraction.

### Spending limits & auto-top-up policy
- `~/.hermes-x402/policy.yaml` with `daily_cap_usdc`, `per_call_max_usdc`,
  `auto_top_up: { threshold_usdc, amount_usdc }`
- Bridge + MCP server enforce caps before signing
- `x402_fetch.max_price_usdc` already exists at the tool level — wire it
  through to a real `paymentRequirementsSelector` instead of being advisory

### Streaming usage tracking
Streaming chat completions don't populate `prompt_tokens`/`completion_tokens`
in the ledger today. Inject `stream_options: { include_usage: true }` when
forwarding `stream:true` requests to Venice and parse the final SSE chunk to
fill those columns.

### Hermes config patch resilience
The `parseDocument`-based patch in `init` strips YAML comments. Switch to a
fenced-section approach: own a clearly delimited block in the config (e.g.
`# ─── hermes-x402 BEGIN ───` … `# ─── hermes-x402 END ───`) and only modify
inside it. Easier to diff, easier to uninstall.

### MCP server error robustness
When `logPayment` blew up on the SQL reserved-word bug, every tool call
errored, and Hermes marked the server unreachable after 3 strikes. Defenses:
- Wrap every ledger write in try/catch so logging failures never crash the tool
- Forward better error messages to the agent (vs. raw stacks)
- Add a `x402 doctor` command that verifies wallet, bridge, MCP, Hermes config
  in one shot

### MCP install non-interactive
`hermes mcp add` prompts for "save anyway" when test fails; our `install-mcp`
wrapper has to pipe `y`. Find the proper non-interactive flag or fix at the
Hermes layer. Also: get the install to succeed cleanly now that the `mcp`
Python package gotcha is fixed (file upstream PR to Nous so future installs
include `mcp`).

---

## P1 — Trajectory logger (groundwork for the experiment phase)

The metabolic-agent / Project-Vend-on-steroids experiment needs:

- `experiments` table: `id, started_at, prompt, model, budget_usdc, status, ended_at, end_reason`
- `trajectory_events` table: `experiment_id, ts, event_type, payload_json`
- `x402 run-experiment <prompt-file>` CLI that spawns a sandboxed Hermes with a
  capped wallet and a deadline
- Hermes hooks (cron, before/after each turn) emit trajectory events
- `x402 analyze <experiment_id>` produces a markdown summary: lifespan, calls,
  spend by model, skills authored, final state

This is also where Hermes's `batch_runner.py` integration lands — wrap it so we
can run 100 trajectories and produce a distribution.

---

## P2 — UX & scaling

### `x402 install-service`
launchd plist drop into `~/Library/LaunchAgents/dev.x402.hermes.plist` so the
bridge stays up across reboots without ceremony. Linux variant: systemd user
service.

### Local web dashboard
Tiny app at `localhost:8403`:
- Live wallet balance + recent receipts
- Spend timeline (calls/hr, $/hr by model)
- Bundle browser + one-click install
- Replay any tool call to debug

### Multi-wallet support (child agents)
Pre-req for `spawn_child_agent`:
- `x402 wallet new <name>` creates a sub-wallet
- `x402 wallet fund <name> <amount>` transfers from parent
- Bridge / MCP server route by header (`X-Wallet: <name>`)
- Each wallet has its own ledger view; parent can see aggregate

### Skill / bundle marketplace
Public index at `bundles.x402.dev` (or similar). Each bundle ships its YAML,
skill markdown, cost estimate, sample usage. `x402 bundle install <name>` pulls
from the index instead of the local `bundles/` dir.

### One-line install
`curl -fsSL https://x402.dev/install | bash` — same vibe as Hermes's installer.
Probably wraps: Hermes install, `hermes-x402` clone + npm install, wallet
provider picker, bundle picker.

---

## P3+ — Architecture / research

### Bridgeless variants
See [README.md → Future: bridgeless](README.md#future-bridgeless). Four sketched
paths in order of effort: Hermes-native provider, OpenAI SDK shim,
`X-402-Wallet-Signature` header standard, browser-native.

### Constitutional / democracy layer
Originally captured as a P1 brainstorm. Concept: a shared constitutional
layer all agents in the system can read, human-nominated candidate agents
with visible system prompts, existing agents vote on which becomes canonical
and shapes the next generation. Worth doing once we have a population of
agents (post-spawn_child_agent).

### `spawn_child_agent` tool
The recursive-labor primitive. Each child gets a sub-wallet, an isolated
Hermes session, a budget, and a parent who can observe its trajectory. Does
Coasean firm theory hold for agents? Open empirical question.

### Batch trajectory studies
Run 100 metabolic-agent trajectories per model tier (Hermes 4B → 70B → 405B,
or equivalent). Produce taxonomy of emergent strategies. The research output
isn't "did it make money" — it's the **vocabulary of self-authored skills**
and **distribution of survival strategies**.

---

## Priority summary

If we work strictly in order:

1. **P0 onboarding flow + wallet provider abstraction** (Coinbase AWAL,
   WalletConnect, local) — gates broader use
2. **P0 curated bundle expansion** (your list)
3. **P0 agent self-hosting via x402** (Conway sandboxes first)
4. **P1 quality** (cost tracking, payment-response decoder, error robustness,
   spending limits)
5. **P1 trajectory logger** (groundwork for experiments)
6. **P2 polish** (launchd, dashboard, multi-wallet, marketplace, one-line install)
7. **P3 architecture** (bridgeless, democracy, spawn_child_agent, batch studies)
