import { VeniceClient } from 'venice-x402-client'
import { loadWallet } from './wallet.js'
import { DEFAULT_VENICE_API_URL } from './paths.js'

let _client: VeniceClient | null = null

export function getVeniceClient(): VeniceClient {
  if (_client) return _client
  const wallet = loadWallet()
  const autoTopUpAmount = process.env.X402_AUTO_TOPUP_USDC
    ? Number(process.env.X402_AUTO_TOPUP_USDC)
    : undefined
  _client = new VeniceClient(wallet.privateKey, {
    apiUrl: DEFAULT_VENICE_API_URL,
    autoTopUp: autoTopUpAmount
      ? { enabled: true, amount: autoTopUpAmount }
      : undefined,
  })
  return _client
}

export interface BalanceSummary {
  balanceUsd: number
  diemBalanceUsd: number
  canConsume: boolean
  minimumTopUpUsd: number
  suggestedTopUpUsd: number
}

export async function fetchBalance(): Promise<BalanceSummary> {
  return getVeniceClient().getBalance()
}
