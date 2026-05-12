import { Wallet } from 'ethers'
import { readFileSync, writeFileSync, existsSync, chmodSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { WALLET_PATH } from './paths.js'

export interface WalletFile {
  address: string
  privateKey: string
  createdAt: string
}

export function generateWallet(): WalletFile {
  const w = Wallet.createRandom()
  return {
    address: w.address,
    privateKey: w.privateKey,
    createdAt: new Date().toISOString(),
  }
}

export function walletFromPrivateKey(privateKey: string): WalletFile {
  const key = privateKey.trim().startsWith('0x')
    ? privateKey.trim()
    : '0x' + privateKey.trim()
  // Wallet constructor throws if invalid
  const w = new Wallet(key)
  return {
    address: w.address,
    privateKey: w.privateKey,
    createdAt: new Date().toISOString(),
  }
}

export function saveWallet(file: WalletFile, path = WALLET_PATH): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(file, null, 2))
  chmodSync(path, 0o600)
}

export function loadWallet(path = WALLET_PATH): WalletFile {
  if (!existsSync(path)) {
    throw new Error(`No wallet found at ${path}. Run \`x402 init\` first.`)
  }
  return JSON.parse(readFileSync(path, 'utf-8')) as WalletFile
}

export function walletExists(path = WALLET_PATH): boolean {
  return existsSync(path)
}
