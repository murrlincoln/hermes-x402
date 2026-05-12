export type ProviderId = 'local-generate' | 'local-import' | 'coinbase-awal' | 'walletconnect'

export interface WalletProviderInfo {
  id: ProviderId
  label: string
  description: string
  status: 'ready' | 'coming-soon'
  recommended?: boolean
}

export const WALLET_PROVIDERS: WalletProviderInfo[] = [
  {
    id: 'local-generate',
    label: 'Local keypair — generate a new wallet',
    description: 'Simplest. Hot key stored at ~/.hermes-x402/wallet.json (chmod 600). Recommended for hacking, dev, and the metabolic experiment.',
    status: 'ready',
    recommended: true,
  },
  {
    id: 'local-import',
    label: 'Local keypair — import an existing private key',
    description: 'Bring a key you already have. Stored hot in the same file. Use if you want a wallet that already holds USDC or has on-chain history.',
    status: 'ready',
  },
  {
    id: 'coinbase-awal',
    label: 'Coinbase AWAL (Agentic Wallet)',
    description: 'Smart wallet + paymaster (gasless for users). Production-grade. Coming soon — track NEXTSTEPS.md.',
    status: 'coming-soon',
  },
  {
    id: 'walletconnect',
    label: 'WalletConnect — bring an existing wallet',
    description: 'Connect a mobile or hardware wallet via QR. Coming soon.',
    status: 'coming-soon',
  },
]
