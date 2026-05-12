import { wrapFetchWithPaymentFromConfig, decodePaymentResponseHeader } from '@x402/fetch'
import { ExactEvmScheme } from '@x402/evm/exact/client'
import { privateKeyToAccount } from 'viem/accounts'
import { loadWallet } from './wallet.js'

export interface X402PaymentInfo {
  amount_usdc: number | null
  network: string | null
  transaction: string | null
}

let _fetchWithPayment: typeof fetch | null = null

export function getX402Fetch(): typeof fetch {
  if (_fetchWithPayment) return _fetchWithPayment
  const wallet = loadWallet()
  const account = privateKeyToAccount(wallet.privateKey as `0x${string}`)
  _fetchWithPayment = wrapFetchWithPaymentFromConfig(fetch, {
    schemes: [
      {
        network: 'eip155:*',
        client: new ExactEvmScheme(account),
      },
    ],
  })
  return _fetchWithPayment
}

export function extractPaymentInfo(response: Response): X402PaymentInfo {
  const header = response.headers.get('PAYMENT-RESPONSE')
  if (!header) return { amount_usdc: null, network: null, transaction: null }
  try {
    const decoded = decodePaymentResponseHeader(header) as Record<string, unknown>
    const amountStr = decoded.amount as string | undefined
    return {
      amount_usdc: amountStr ? Number(amountStr) / 1e6 : null,
      network: (decoded.network as string) ?? null,
      transaction: (decoded.transaction as string) ?? null,
    }
  } catch {
    return { amount_usdc: null, network: null, transaction: null }
  }
}
