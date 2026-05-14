import { walletFromPrivateKey, saveWallet } from '../src/lib/wallet.js'

const w = walletFromPrivateKey('1f6af9fd915d29c93b5f25cfd7686d02b289ebbfc0ca035c896e52d418c87d00')
saveWallet(w)
console.log('Imported wallet:', w.address)
