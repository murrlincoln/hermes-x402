import { homedir } from 'node:os'
import { join } from 'node:path'

export const X402_HOME = process.env.X402_HOME ?? join(homedir(), '.hermes-x402')
export const WALLET_PATH = join(X402_HOME, 'wallet.json')
export const LEDGER_PATH = join(X402_HOME, 'ledger.sqlite')
export const STATE_PATH = join(X402_HOME, 'state.json')

export const HERMES_HOME = join(homedir(), '.hermes')
export const HERMES_CONFIG = join(HERMES_HOME, 'config.yaml')
export const HERMES_ENV = join(HERMES_HOME, '.env')

export const DEFAULT_BRIDGE_PORT = Number(process.env.X402_BRIDGE_PORT ?? 8402)
export const DEFAULT_VENICE_API_URL = process.env.VENICE_API_URL ?? 'https://api.venice.ai'
