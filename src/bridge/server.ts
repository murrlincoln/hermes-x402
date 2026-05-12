import express, { Request, Response } from 'express'
import { Readable } from 'node:stream'
import { getVeniceClient, fetchBalance } from '../lib/venice.js'
import { logCall } from '../lib/ledger.js'
import { loadWallet } from '../lib/wallet.js'
import { DEFAULT_BRIDGE_PORT } from '../lib/paths.js'

const app = express()
app.use(express.json({ limit: '25mb' }))

// ------------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------------

function nowIso(): string {
  return new Date().toISOString()
}

async function balanceAfter(): Promise<number | null> {
  try {
    const bal = await fetchBalance()
    return bal.balanceUsd
  } catch {
    return null
  }
}

function setBalanceHeader(res: Response, balance: number | null): void {
  if (balance !== null) {
    res.setHeader('X-Balance-Remaining', balance.toFixed(6))
  }
}

// ------------------------------------------------------------------------
// Health + info
// ------------------------------------------------------------------------

app.get('/health', (_req, res) => {
  res.json({ ok: true, ts: nowIso() })
})

app.get('/x402/info', async (_req, res) => {
  try {
    const wallet = loadWallet()
    const bal = await fetchBalance()
    res.json({
      address: wallet.address,
      balance_usd: bal.balanceUsd,
      can_consume: bal.canConsume,
      minimum_top_up_usd: bal.minimumTopUpUsd,
      suggested_top_up_usd: bal.suggestedTopUpUsd,
    })
  } catch (err) {
    res.status(500).json({ error: (err as Error).message })
  }
})

// ------------------------------------------------------------------------
// OpenAI-compatible: /v1/models
// ------------------------------------------------------------------------

app.get('/v1/models', async (_req, res) => {
  const t0 = Date.now()
  try {
    const client = getVeniceClient()
    const models = await client.models()
    const bal = await balanceAfter()
    setBalanceHeader(res, bal)
    logCall({
      ts: nowIso(),
      endpoint: '/v1/models',
      model: '-',
      prompt_tokens: null,
      completion_tokens: null,
      cost_usdc: null,
      balance_after_usdc: bal,
      latency_ms: Date.now() - t0,
      status: 200,
      error: null,
    })
    res.json(models)
  } catch (err) {
    const e = err as Error
    logCall({
      ts: nowIso(),
      endpoint: '/v1/models',
      model: '-',
      prompt_tokens: null,
      completion_tokens: null,
      cost_usdc: null,
      balance_after_usdc: null,
      latency_ms: Date.now() - t0,
      status: 500,
      error: e.message,
    })
    res.status(500).json({ error: { message: e.message } })
  }
})

// ------------------------------------------------------------------------
// OpenAI-compatible: /v1/chat/completions  (non-streaming for v0)
// ------------------------------------------------------------------------

app.post('/v1/chat/completions', async (req: Request, res: Response) => {
  const t0 = Date.now()
  const { model, messages, max_tokens, temperature, stream } = req.body ?? {}

  if (!model || !Array.isArray(messages)) {
    res.status(400).json({
      error: { message: 'Missing required fields: model, messages[]' },
    })
    return
  }

  if (stream) {
    // ── Streaming path: pipe Venice's SSE response straight through ──
    try {
      const client = getVeniceClient() as unknown as {
        requestRaw: (path: string, init: RequestInit) => Promise<globalThis.Response>
      }
      const upstream = await client.requestRaw('/api/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(req.body),
      })
      res.status(upstream.status)
      res.setHeader('Content-Type', upstream.headers.get('content-type') ?? 'text/event-stream')
      res.setHeader('Cache-Control', 'no-cache, no-transform')
      res.setHeader('Connection', 'keep-alive')
      const balHeader = upstream.headers.get('X-Balance-Remaining')
      if (balHeader) res.setHeader('X-Balance-Remaining', balHeader)
      res.flushHeaders()

      if (!upstream.body) {
        res.end()
        return
      }
      const nodeStream = Readable.fromWeb(upstream.body as never)
      nodeStream.on('end', async () => {
        const bal = balHeader ? parseFloat(balHeader) : await balanceAfter()
        logCall({
          ts: nowIso(),
          endpoint: '/v1/chat/completions',
          model,
          prompt_tokens: null,
          completion_tokens: null,
          cost_usdc: null,
          balance_after_usdc: Number.isFinite(bal) ? (bal as number) : null,
          latency_ms: Date.now() - t0,
          status: upstream.status,
          error: null,
        })
      })
      nodeStream.on('error', (err) => {
        logCall({
          ts: nowIso(),
          endpoint: '/v1/chat/completions',
          model,
          prompt_tokens: null,
          completion_tokens: null,
          cost_usdc: null,
          balance_after_usdc: null,
          latency_ms: Date.now() - t0,
          status: 500,
          error: err.message,
        })
      })
      nodeStream.pipe(res)
      return
    } catch (err) {
      const e = err as Error
      logCall({
        ts: nowIso(),
        endpoint: '/v1/chat/completions',
        model,
        prompt_tokens: null,
        completion_tokens: null,
        cost_usdc: null,
        balance_after_usdc: null,
        latency_ms: Date.now() - t0,
        status: 500,
        error: e.message,
      })
      if (!res.headersSent) {
        res.status(500).json({ error: { message: e.message } })
      } else {
        res.end()
      }
      return
    }
  }

  // ── Non-streaming path ──
  try {
    const client = getVeniceClient()
    const response = await client.chat({
      model,
      messages,
      max_tokens,
      temperature,
    })
    const bal = await balanceAfter()
    setBalanceHeader(res, bal)
    logCall({
      ts: nowIso(),
      endpoint: '/v1/chat/completions',
      model,
      prompt_tokens: response.usage?.prompt_tokens ?? null,
      completion_tokens: response.usage?.completion_tokens ?? null,
      cost_usdc: null,
      balance_after_usdc: bal,
      latency_ms: Date.now() - t0,
      status: 200,
      error: null,
    })
    res.json(response)
  } catch (err) {
    const e = err as Error
    logCall({
      ts: nowIso(),
      endpoint: '/v1/chat/completions',
      model,
      prompt_tokens: null,
      completion_tokens: null,
      cost_usdc: null,
      balance_after_usdc: null,
      latency_ms: Date.now() - t0,
      status: 500,
      error: e.message,
    })
    res.status(500).json({ error: { message: e.message } })
  }
})

// ------------------------------------------------------------------------
// OpenAI-compatible: /v1/embeddings
// ------------------------------------------------------------------------

app.post('/v1/embeddings', async (req: Request, res: Response) => {
  const t0 = Date.now()
  const { model, input } = req.body ?? {}
  if (!model || input === undefined) {
    res.status(400).json({ error: { message: 'Missing required fields: model, input' } })
    return
  }
  try {
    const client = getVeniceClient()
    const response = await client.embeddings({ model, input })
    const bal = await balanceAfter()
    setBalanceHeader(res, bal)
    logCall({
      ts: nowIso(),
      endpoint: '/v1/embeddings',
      model,
      prompt_tokens: response.usage?.prompt_tokens ?? null,
      completion_tokens: null,
      cost_usdc: null,
      balance_after_usdc: bal,
      latency_ms: Date.now() - t0,
      status: 200,
      error: null,
    })
    res.json(response)
  } catch (err) {
    const e = err as Error
    logCall({
      ts: nowIso(),
      endpoint: '/v1/embeddings',
      model,
      prompt_tokens: null,
      completion_tokens: null,
      cost_usdc: null,
      balance_after_usdc: null,
      latency_ms: Date.now() - t0,
      status: 500,
      error: e.message,
    })
    res.status(500).json({ error: { message: e.message } })
  }
})

// ------------------------------------------------------------------------
// Start
// ------------------------------------------------------------------------

const port = DEFAULT_BRIDGE_PORT
app.listen(port, '127.0.0.1', () => {
  const wallet = loadWallet()
  // eslint-disable-next-line no-console
  console.log(`hermes-x402 bridge listening on http://127.0.0.1:${port}`)
  // eslint-disable-next-line no-console
  console.log(`  wallet: ${wallet.address}`)
  // eslint-disable-next-line no-console
  console.log(`  routes: /v1/chat/completions /v1/embeddings /v1/models /x402/info /health`)
})
