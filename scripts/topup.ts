import { getVeniceClient, fetchBalance } from '../src/lib/venice.js'

const amount = Number(process.argv[2] ?? 3)
if (!Number.isFinite(amount) || amount <= 0) {
  console.error('Usage: tsx scripts/topup.ts <amount-usd>')
  process.exit(1)
}

const client = getVeniceClient()
console.log(`Topping up $${amount.toFixed(2)}…`)
try {
  await client.topUp(amount)
  const bal = await fetchBalance()
  console.log(`✓ top-up succeeded`)
  console.log(`  new balance: $${bal.balanceUsd.toFixed(4)}`)
  console.log(`  can consume: ${bal.canConsume}`)
} catch (err) {
  console.error(`✗ top-up failed: ${(err as Error).message}`)
  process.exit(1)
}
