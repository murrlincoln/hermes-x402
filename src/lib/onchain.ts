import { createPublicClient, http, formatUnits } from 'viem'
import { base } from 'viem/chains'

const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as const
const USDC_ABI = [
  {
    inputs: [{ name: 'account', type: 'address' }],
    name: 'balanceOf',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const

function getClient() {
  return createPublicClient({
    chain: base,
    transport: http('https://mainnet.base.org'),
  })
}

export async function getUsdcBalance(address: string): Promise<number> {
  const client = getClient()
  const balance = await client.readContract({
    address: USDC_BASE,
    abi: USDC_ABI,
    functionName: 'balanceOf',
    args: [address as `0x${string}`],
  })
  return Number(formatUnits(balance as bigint, 6))
}

export function formatUsdc(amount: number): string {
  if (amount === 0) return '$0.00'
  if (amount < 0.01) return `$${amount.toFixed(6)}`
  return `$${amount.toFixed(2)}`
}
