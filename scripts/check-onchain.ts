import { JsonRpcProvider, Contract, formatUnits } from 'ethers'
import { loadWallet } from '../src/lib/wallet.js'

const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const ABI = ['function balanceOf(address) view returns (uint256)']

const wallet = loadWallet()
const provider = new JsonRpcProvider('https://mainnet.base.org')
const usdc = new Contract(USDC, ABI, provider)
const bal = await usdc.balanceOf(wallet.address)
console.log(`address:        ${wallet.address}`)
console.log(`on-chain USDC:  $${formatUnits(bal, 6)}  (Base mainnet)`)
