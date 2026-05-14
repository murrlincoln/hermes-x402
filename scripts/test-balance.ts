import { getUsdcBalance, formatUsdc } from '../src/lib/onchain.js'

async function main() {
  const address = '0xe726c98caBD11c7b0117075Becb299D51980a81E'
  console.log(`Checking USDC balance for ${address}...`)
  const bal = await getUsdcBalance(address)
  console.log(`Balance: ${formatUsdc(bal)}`)
  console.log(`Raw: ${bal}`)
}
main().catch(console.error)
