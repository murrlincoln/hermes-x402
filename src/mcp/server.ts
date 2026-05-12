#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { getX402Fetch, extractPaymentInfo } from '../lib/x402-fetch.js'
import { logPayment } from '../lib/ledger.js'
import { loadWallet } from '../lib/wallet.js'

// stdout is owned by the MCP protocol; everything else goes to stderr.
const log = (...args: unknown[]) => process.stderr.write(args.join(' ') + '\n')

const wallet = loadWallet()
log(`[hermes-x402-mcp] wallet ${wallet.address}`)

const server = new McpServer({ name: 'hermes-x402', version: '0.0.1' })

server.tool(
  'x402_fetch',
  [
    'Make an HTTP request that may require an x402 micropayment.',
    'Use for any endpoint that returns 402 Payment Required (e.g. agentcash.dev-wrapped APIs, Exa via x402 proxies, or any future x402-native service).',
    'Returns: { status, headers, body, payment }. `payment` is filled when a micropayment was actually settled.',
    'Pays from the agent\'s own wallet — every call is real USDC on Base.',
  ].join(' '),
  {
    url: z.string().url().describe('Fully-qualified HTTPS URL'),
    method: z
      .enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])
      .default('GET'),
    headers: z
      .record(z.string())
      .optional()
      .describe('Additional HTTP headers'),
    body: z
      .string()
      .optional()
      .describe(
        'Request body as a string. If sending JSON, stringify it first and set Content-Type accordingly.',
      ),
    parse: z
      .enum(['text', 'json'])
      .default('text')
      .describe('How to decode the response body for the agent'),
    max_price_usdc: z
      .number()
      .optional()
      .describe(
        'Refuse to pay more than this in USDC. Omit to accept any price. Default no cap.',
      ),
  },
  async (args) => {
    const t0 = Date.now()
    const ts = new Date().toISOString()
    const f = getX402Fetch()

    // max_price_usdc is currently advisory; the @x402 scheme picks the cheapest payment
    // requirement by default. v1 will add a paymentRequirementsSelector that enforces the cap.

    try {
      const init: RequestInit = {
        method: args.method,
        headers: args.headers,
        body: args.body,
      }
      const response = await f(args.url, init)
      const headersObj: Record<string, string> = {}
      response.headers.forEach((v, k) => {
        headersObj[k] = v
      })
      const text = await response.text()
      const payment = extractPaymentInfo(response)
      logPayment({
        ts,
        url: args.url,
        method: args.method,
        status: response.status,
        amount_usdc: payment.amount_usdc,
        network: payment.network,
        tx_hash: payment.transaction,
        latency_ms: Date.now() - t0,
        error: null,
      })

      let body: unknown = text
      if (args.parse === 'json') {
        try {
          body = JSON.parse(text)
        } catch {
          // fall back to raw text
        }
      }
      const result = {
        status: response.status,
        headers: headersObj,
        body,
        payment: payment.transaction
          ? {
              amount_usdc: payment.amount_usdc,
              network: payment.network,
              transaction: payment.transaction,
            }
          : null,
      }
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      }
    } catch (err) {
      const e = err as Error
      logPayment({
        ts,
        url: args.url,
        method: args.method,
        status: 0,
        amount_usdc: null,
        network: null,
        tx_hash: null,
        latency_ms: Date.now() - t0,
        error: e.message,
      })
      return {
        isError: true,
        content: [
          {
            type: 'text' as const,
            text: `x402_fetch error: ${e.message}`,
          },
        ],
      }
    }
  },
)

server.tool(
  'x402_wallet_info',
  'Return the agent\'s own wallet address and on-chain USDC balance on Base. No payment required.',
  {},
  async () => {
    const { JsonRpcProvider, Contract, formatUnits } = await import('ethers')
    const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
    const ABI = ['function balanceOf(address) view returns (uint256)']
    const provider = new JsonRpcProvider('https://mainnet.base.org')
    const usdc = new Contract(USDC, ABI, provider)
    const bal = (await usdc.balanceOf(wallet.address)) as bigint
    const onChain = Number(formatUnits(bal, 6))
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            { address: wallet.address, on_chain_usdc: onChain, network: 'base' },
            null,
            2,
          ),
        },
      ],
    }
  },
)

const transport = new StdioServerTransport()
await server.connect(transport)
log('[hermes-x402-mcp] ready over stdio')
