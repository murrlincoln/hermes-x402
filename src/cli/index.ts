#!/usr/bin/env node
import { Command } from 'commander'
import chalk from 'chalk'
import ora from 'ora'
import qrcode from 'qrcode-terminal'
import { parse as parseYaml, stringify as stringifyYaml, parseDocument } from 'yaml'
import {
  readFileSync,
  writeFileSync,
  copyFileSync,
  existsSync,
  readdirSync,
  openSync,
  unlinkSync,
  mkdirSync,
} from 'node:fs'
import { join, basename } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'
import {
  generateWallet,
  saveWallet,
  loadWallet,
  walletExists,
} from '../lib/wallet.js'
import { getVeniceClient, fetchBalance } from '../lib/venice.js'
import {
  spendSince,
  spendByModel,
  paymentsSince,
  recentPayments,
} from '../lib/ledger.js'
import {
  WALLET_PATH,
  X402_HOME,
  HERMES_CONFIG,
  DEFAULT_BRIDGE_PORT,
} from '../lib/paths.js'

const PID_FILE = join(X402_HOME, 'bridge.pid')
const LOG_FILE = join(X402_HOME, 'bridge.log')

const PROJECT_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
const BUNDLES_DIR = join(PROJECT_ROOT, 'bundles')

const program = new Command()
program
  .name('x402')
  .description('hermes-x402 — wallet-funded onboarding for Hermes Agent')
  .version('0.0.1')

// ------------------------------------------------------------------------
// init
// ------------------------------------------------------------------------

program
  .command('init')
  .description('Generate a wallet and apply a bundle (default: starter)')
  .option('-b, --bundle <name>', 'Bundle to install', 'starter')
  .option('--no-patch', 'Skip patching ~/.hermes/config.yaml')
  .action(async (opts) => {
    if (walletExists()) {
      const w = loadWallet()
      console.log(chalk.yellow(`Wallet already exists at ${WALLET_PATH}`))
      console.log(`  ${chalk.bold('address:')} ${w.address}`)
    } else {
      const spin = ora('Generating wallet').start()
      const w = generateWallet()
      saveWallet(w)
      spin.succeed(`Wallet created at ${WALLET_PATH}`)
      console.log(`  ${chalk.bold('address:')} ${w.address}`)
      console.log(
        chalk.dim(`  (private key chmod 600, stored at ${WALLET_PATH})`),
      )
    }

    const bundle = loadBundle(opts.bundle)
    console.log(`\n${chalk.bold('Bundle:')} ${bundle.name}  ${chalk.dim(bundle.description?.trim().split('\n')[0] ?? '')}`)

    if (opts.patch !== false) {
      patchHermesConfig(bundle)
    } else {
      console.log(chalk.dim('  (--no-patch given, leaving Hermes config alone)'))
    }

    const w = loadWallet()
    console.log()
    console.log(chalk.bold.green('Next steps:'))
    console.log(`  1. Send ${chalk.bold('$5 USDC on Base')} to ${chalk.cyan(w.address)}`)
    console.log(`     ${chalk.dim('(USDC on Base contract: 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913)')}`)
    console.log(`  2. ${chalk.bold('x402 balance')} — confirm funds arrived`)
    console.log(`  3. ${chalk.bold('x402 start')} — launch the bridge`)
    console.log(`  4. In another terminal: ${chalk.bold('hermes')} — talk to your agent`)
  })

// ------------------------------------------------------------------------
// start (run bridge)
// ------------------------------------------------------------------------

program
  .command('start')
  .description('Start the bridge on localhost')
  .option('-p, --port <port>', 'Bridge port', String(DEFAULT_BRIDGE_PORT))
  .option('-d, --daemon', 'Run detached in the background; logs to ~/.hermes-x402/bridge.log')
  .action((opts) => {
    if (!walletExists()) {
      console.error(chalk.red(`No wallet at ${WALLET_PATH}. Run \`x402 init\` first.`))
      process.exit(1)
    }
    if (isBridgeAlive()) {
      console.log(chalk.yellow(`bridge already running (pid=${readPid()})`))
      return
    }
    const bridgePath = join(PROJECT_ROOT, 'src', 'bridge', 'server.ts')
    const env = { ...process.env, X402_BRIDGE_PORT: String(opts.port) }
    if (opts.daemon) {
      mkdirSync(X402_HOME, { recursive: true })
      const logFd = openSync(LOG_FILE, 'a')
      const child = spawn('npx', ['tsx', bridgePath], {
        stdio: ['ignore', logFd, logFd],
        detached: true,
        env,
      })
      child.unref()
      writeFileSync(PID_FILE, String(child.pid))
      console.log(`bridge started ${chalk.green('(daemon)')}  pid=${child.pid}  port=${opts.port}`)
      console.log(chalk.dim(`  log: ${LOG_FILE}`))
      console.log(chalk.dim(`  stop with: x402 stop`))
    } else {
      const child = spawn('npx', ['tsx', bridgePath], { stdio: 'inherit', env })
      child.on('exit', (code) => process.exit(code ?? 0))
    }
  })

program
  .command('stop')
  .description('Stop the daemon bridge')
  .action(() => {
    if (!existsSync(PID_FILE)) {
      console.log('bridge not running (no pid file)')
      return
    }
    const pid = readPid()
    try {
      process.kill(pid, 'SIGTERM')
      unlinkSync(PID_FILE)
      console.log(`stopped bridge (pid=${pid})`)
    } catch {
      unlinkSync(PID_FILE)
      console.log(chalk.dim(`pid ${pid} not alive; cleared stale pid file`))
    }
  })

program
  .command('status')
  .description('Show bridge daemon status')
  .action(async () => {
    if (!existsSync(PID_FILE)) {
      console.log(chalk.dim('bridge not running'))
      return
    }
    const pid = readPid()
    if (!isAlive(pid)) {
      console.log(chalk.yellow(`stale pid file: ${pid} not running`))
      return
    }
    console.log(`bridge running ${chalk.green('(pid=' + pid + ')')}  port=${DEFAULT_BRIDGE_PORT}`)
    try {
      const r = await fetch(`http://127.0.0.1:${DEFAULT_BRIDGE_PORT}/x402/info`)
      const info = (await r.json()) as Record<string, unknown>
      console.log(`  address:     ${info.address}`)
      console.log(`  balance:     $${Number(info.balance_usd ?? 0).toFixed(4)}`)
      console.log(`  can consume: ${info.can_consume ? chalk.green('yes') : chalk.red('no')}`)
    } catch (err) {
      console.log(chalk.yellow(`  /x402/info unreachable: ${(err as Error).message}`))
    }
  })

program
  .command('topup <amount>')
  .description('Convert on-chain USDC into Venice spendable balance (min $5)')
  .action(async (amountStr: string) => {
    const amount = Number(amountStr)
    if (!Number.isFinite(amount) || amount <= 0) {
      console.error(chalk.red(`Bad amount: ${amountStr}`))
      process.exit(1)
    }
    const client = getVeniceClient()
    const spin = ora(`Topping up $${amount.toFixed(2)}`).start()
    try {
      await client.topUp(amount)
      const bal = await fetchBalance()
      spin.succeed(`balance: ${chalk.green('$' + bal.balanceUsd.toFixed(4))}  can_consume=${bal.canConsume}`)
    } catch (err) {
      spin.fail((err as Error).message)
      process.exit(1)
    }
  })

// ------------------------------------------------------------------------
// balance
// ------------------------------------------------------------------------

program
  .command('balance')
  .description('Show wallet address and Venice spendable balance')
  .action(async () => {
    if (!walletExists()) {
      console.error(chalk.red(`No wallet at ${WALLET_PATH}. Run \`x402 init\` first.`))
      process.exit(1)
    }
    const w = loadWallet()
    const spin = ora('Fetching balance').start()
    try {
      const bal = await fetchBalance()
      spin.stop()
      const fmt = (n: number | undefined | null): string =>
        n == null ? chalk.dim('—') : '$' + Number(n).toFixed(4)
      console.log(`${chalk.bold('address:')}        ${w.address}`)
      console.log(`${chalk.bold('balance:')}        ${chalk.green(fmt(bal.balanceUsd))}`)
      console.log(`${chalk.bold('diem balance:')}   ${fmt(bal.diemBalanceUsd)}`)
      console.log(`${chalk.bold('can consume:')}    ${bal.canConsume ? chalk.green('yes') : chalk.red('no')}`)
      if (!bal.canConsume) {
        console.log(chalk.yellow(`  minimum top-up: ${fmt(bal.minimumTopUpUsd)}`))
        console.log(chalk.yellow(`  suggested:      ${fmt(bal.suggestedTopUpUsd)}`))
      }
    } catch (err) {
      spin.fail((err as Error).message)
      process.exit(1)
    }
  })

// ------------------------------------------------------------------------
// spend
// ------------------------------------------------------------------------

program
  .command('spend')
  .description('Show recent inference spend (from local ledger)')
  .option('-l, --last <duration>', 'Window: 1h, 24h, 7d, 30d', '24h')
  .action((opts) => {
    const since = parseSince(opts.last)
    const roll = spendSince(since)
    const byModel = spendByModel(since)
    console.log(`${chalk.bold('window:')}  since ${since.toISOString()}`)
    console.log(`${chalk.bold('calls:')}   ${roll.count}`)
    console.log(
      `${chalk.bold('cost:')}    ${
        roll.total_cost_usdc != null
          ? '$' + roll.total_cost_usdc.toFixed(6)
          : chalk.dim('(per-call cost not tracked yet)')
      }`,
    )
    console.log(
      `${chalk.bold('tokens:')}  in=${roll.total_prompt_tokens ?? 0}  out=${roll.total_completion_tokens ?? 0}`,
    )
    if (byModel.length > 0) {
      console.log(`\n${chalk.bold('by model:')}`)
      for (const row of byModel) {
        console.log(
          `  ${row.model.padEnd(28)} ${String(row.calls).padStart(5)} calls   ${
            row.cost != null ? '$' + row.cost.toFixed(6) : chalk.dim('—')
          }`,
        )
      }
    }
  })

// ------------------------------------------------------------------------
// fund
// ------------------------------------------------------------------------

program
  .command('fund')
  .description('Show wallet address + USDC-on-Base funding instructions')
  .option('--qr', 'Print a QR code for the address')
  .action((opts) => {
    if (!walletExists()) {
      console.error(chalk.red(`No wallet at ${WALLET_PATH}. Run \`x402 init\` first.`))
      process.exit(1)
    }
    const w = loadWallet()
    console.log(`${chalk.bold('Send USDC on Base to:')}`)
    console.log(`  ${chalk.cyan.bold(w.address)}`)
    console.log()
    console.log(`${chalk.dim('Network:')}  Base mainnet`)
    console.log(`${chalk.dim('Asset:')}    USDC  (0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913)`)
    console.log(`${chalk.dim('Suggested:')} $5 for v0 testing`)
    if (opts.qr) {
      console.log()
      qrcode.generate(w.address, { small: true })
    }
  })

// ------------------------------------------------------------------------
// bundles
// ------------------------------------------------------------------------

program
  .command('bundles')
  .description('List available bundles')
  .action(() => {
    const files = readdirSync(BUNDLES_DIR).filter((f) => f.endsWith('.yaml'))
    for (const f of files) {
      const b = loadBundle(basename(f, '.yaml'))
      const desc = b.description?.trim().split('\n')[0] ?? ''
      console.log(`  ${chalk.bold(b.name.padEnd(14))} ${chalk.dim(desc)}`)
    }
  })

// ------------------------------------------------------------------------
// info
// ------------------------------------------------------------------------

program
  .command('fetch <url>')
  .description('Hit a URL with x402 payment support (your wallet pays if needed)')
  .option('-X, --method <method>', 'HTTP method', 'GET')
  .option('-H, --header <h...>', 'HTTP headers like "X-Foo: bar"')
  .option('-d, --data <body>', 'Request body (string)')
  .option('-j, --json', 'Pretty-print response body as JSON')
  .action(async (url: string, opts) => {
    const { getX402Fetch, extractPaymentInfo } = await import('../lib/x402-fetch.js')
    const { logPayment } = await import('../lib/ledger.js')
    const t0 = Date.now()
    const headers: Record<string, string> = {}
    for (const h of (opts.header as string[] | undefined) ?? []) {
      const i = h.indexOf(':')
      if (i < 0) continue
      headers[h.slice(0, i).trim()] = h.slice(i + 1).trim()
    }
    const f = getX402Fetch()
    const spin = ora(`${opts.method} ${url}`).start()
    try {
      const r = await f(url, {
        method: opts.method,
        headers: Object.keys(headers).length ? headers : undefined,
        body: opts.data,
      })
      const text = await r.text()
      const payment = extractPaymentInfo(r)
      logPayment({
        ts: new Date().toISOString(),
        url,
        method: opts.method,
        status: r.status,
        amount_usdc: payment.amount_usdc,
        network: payment.network,
        tx_hash: payment.transaction,
        latency_ms: Date.now() - t0,
        error: null,
      })
      spin.stop()
      console.log(`${chalk.bold('status:')}  ${r.status}  ${chalk.dim(`(${Date.now() - t0}ms)`)}`)
      if (payment.transaction) {
        console.log(`${chalk.bold('paid:')}    ${chalk.green('$' + (payment.amount_usdc ?? 0).toFixed(6))}  on ${payment.network}`)
        console.log(`${chalk.bold('tx:')}      ${chalk.dim(payment.transaction)}`)
      }
      console.log()
      if (opts.json) {
        try {
          console.log(JSON.stringify(JSON.parse(text), null, 2))
        } catch {
          console.log(text)
        }
      } else {
        console.log(text.length > 4000 ? text.slice(0, 4000) + chalk.dim(`\n[…${text.length - 4000} more bytes]`) : text)
      }
    } catch (err) {
      spin.fail((err as Error).message)
      process.exit(1)
    }
  })

program
  .command('install-mcp')
  .description('Register the hermes-x402 MCP server with Hermes Agent')
  .option('--name <name>', 'MCP server name', 'hermes-x402')
  .action((opts) => {
    const serverPath = join(PROJECT_ROOT, 'src', 'mcp', 'server.ts')
    if (!existsSync(serverPath)) {
      console.error(chalk.red(`MCP server file missing: ${serverPath}`))
      process.exit(1)
    }
    console.log(chalk.dim(`Running: hermes mcp add ${opts.name} --command npx --args tsx ${serverPath}`))
    const r = spawnSync(
      'hermes',
      ['mcp', 'add', opts.name, '--command', 'npx', '--args', 'tsx', serverPath],
      { stdio: 'inherit' },
    )
    if (r.status !== 0) {
      console.error(chalk.red(`hermes mcp add exited with ${r.status}`))
      process.exit(r.status ?? 1)
    }
    console.log()
    console.log(chalk.green('Registered. The agent now has these tools:'))
    console.log(`  ${chalk.bold('x402_fetch')}       pay any x402 endpoint with your wallet`)
    console.log(`  ${chalk.bold('x402_wallet_info')} show wallet address + on-chain USDC`)
    console.log(chalk.dim('  (restart hermes to pick up the new tools)'))
  })

program
  .command('payments')
  .description('Show recent x402 payments made by the MCP tool')
  .option('-l, --last <duration>', 'Window: 1h, 24h, 7d', '24h')
  .action((opts) => {
    const since = parseSince(opts.last)
    const roll = paymentsSince(since)
    console.log(`${chalk.bold('window:')}  since ${since.toISOString()}`)
    console.log(`${chalk.bold('count:')}   ${roll.count}`)
    console.log(`${chalk.bold('total:')}   ${roll.total_usdc != null ? '$' + roll.total_usdc.toFixed(6) : chalk.dim('—')}`)
    const rows = recentPayments(since, 20)
    if (rows.length > 0) {
      console.log(`\n${chalk.bold('recent:')}`)
      for (const r of rows) {
        const cost = r.amount_usdc != null ? '$' + r.amount_usdc.toFixed(6) : chalk.dim('—')
        const tx = r.tx_hash ? chalk.dim(r.tx_hash.slice(0, 12) + '…') : ''
        console.log(`  ${r.ts}  ${String(r.status).padStart(3)}  ${cost.padEnd(12)}  ${r.method.padEnd(6)} ${r.url}  ${tx}`)
      }
    }
  })

program
  .command('models')
  .description("List models available on Venice (queries the bridge if running, else Venice directly)")
  .option('-f, --filter <kw>', 'Filter by substring (case-insensitive)')
  .option('-a, --all', 'Print every model, not just curated picks')
  .action(async (opts) => {
    const client = getVeniceClient()
    const spin = ora('Fetching model catalog').start()
    let models: Array<{ id: string }>
    try {
      const r = await client.models()
      models = r.data ?? []
      spin.stop()
    } catch (err) {
      spin.fail((err as Error).message)
      process.exit(1)
    }
    const filter = (opts.filter as string | undefined)?.toLowerCase()
    let list = filter ? models.filter((m) => m.id.toLowerCase().includes(filter)) : models
    if (!opts.all && !filter) {
      const curated = [
        'llama-3.2-3b',
        'llama-3.3-70b',
        'hermes-3-llama-3.1-405b',
        'qwen3-235b-a22b-instruct-2507',
        'qwen3-235b-a22b-thinking-2507',
        'mistral-small-3-2-24b-instruct',
        'zai-org-glm-4.7',
        'zai-org-glm-5',
      ]
      list = curated
        .map((id) => models.find((m) => m.id === id))
        .filter((m): m is { id: string } => m !== undefined)
      console.log(chalk.dim(`(curated picks — use --all or --filter to see all ${models.length} models)`))
    }
    for (const m of list) {
      const current = getCurrentHermesModel() === m.id ? chalk.green(' ← current') : ''
      console.log(`  ${chalk.bold(m.id)}${current}`)
    }
    if (!filter && !opts.all) {
      console.log()
      console.log(chalk.dim(`Switch model:  x402 use <model-id>`))
    }
  })

program
  .command('use <model>')
  .description('Set the default model Hermes uses (patches ~/.hermes/config.yaml)')
  .action((model: string) => {
    if (!existsSync(HERMES_CONFIG)) {
      console.error(chalk.red(`${HERMES_CONFIG} not found`))
      process.exit(1)
    }
    const backup = HERMES_CONFIG + '.bak.' + Date.now()
    copyFileSync(HERMES_CONFIG, backup)
    const doc = parseDocument(readFileSync(HERMES_CONFIG, 'utf-8'))
    doc.setIn(['model', 'default'], model)
    writeFileSync(HERMES_CONFIG, doc.toString())
    console.log(`set ${chalk.bold('model.default')} = ${chalk.cyan(model)}`)
    console.log(chalk.dim(`backup: ${backup}`))
    console.log(chalk.dim('reload Hermes (Ctrl-C and rerun `hermes`) to pick it up'))
  })

program
  .command('info')
  .description('Show config paths and current state')
  .action(() => {
    console.log(`${chalk.bold('X402_HOME:')}      ${X402_HOME}`)
    console.log(`${chalk.bold('wallet:')}         ${WALLET_PATH}  ${existsSync(WALLET_PATH) ? chalk.green('(present)') : chalk.red('(missing)')}`)
    console.log(`${chalk.bold('hermes config:')}  ${HERMES_CONFIG}  ${existsSync(HERMES_CONFIG) ? chalk.green('(present)') : chalk.red('(missing)')}`)
    console.log(`${chalk.bold('bridge port:')}    ${DEFAULT_BRIDGE_PORT}`)
  })

program.parseAsync().catch((err) => {
  console.error(chalk.red((err as Error).message))
  process.exit(1)
})

// ------------------------------------------------------------------------
// helpers
// ------------------------------------------------------------------------

interface Bundle {
  name: string
  version?: string
  description?: string
  hermes_config_patch?: Record<string, unknown>
}

function loadBundle(name: string): Bundle {
  const path = join(BUNDLES_DIR, `${name}.yaml`)
  if (!existsSync(path)) {
    throw new Error(`Bundle not found: ${name} (looked at ${path})`)
  }
  return parseYaml(readFileSync(path, 'utf-8')) as Bundle
}

function parseSince(spec: string): Date {
  const m = spec.match(/^(\d+)([hdm])$/i)
  if (!m) throw new Error(`Bad duration: ${spec} (use 1h, 24h, 7d, 30m)`)
  const n = Number(m[1])
  const unit = m[2].toLowerCase()
  const ms = unit === 'h' ? n * 3600e3 : unit === 'd' ? n * 86400e3 : n * 60e3
  return new Date(Date.now() - ms)
}

function getCurrentHermesModel(): string | null {
  if (!existsSync(HERMES_CONFIG)) return null
  try {
    const doc = parseDocument(readFileSync(HERMES_CONFIG, 'utf-8'))
    return doc.getIn(['model', 'default']) as string | null
  } catch {
    return null
  }
}

function readPid(): number {
  return Number(readFileSync(PID_FILE, 'utf-8').trim())
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function isBridgeAlive(): boolean {
  return existsSync(PID_FILE) && isAlive(readPid())
}

function patchHermesConfig(bundle: Bundle): void {
  if (!bundle.hermes_config_patch) {
    console.log(chalk.dim('  bundle has no hermes_config_patch — skipping'))
    return
  }
  if (!existsSync(HERMES_CONFIG)) {
    console.log(
      chalk.red(`  ${HERMES_CONFIG} not found — install Hermes first (hermes setup)`),
    )
    return
  }
  const backup = HERMES_CONFIG + '.bak.' + Date.now()
  copyFileSync(HERMES_CONFIG, backup)

  // Use parseDocument to preserve as much structure as possible.
  const raw = readFileSync(HERMES_CONFIG, 'utf-8')
  const doc = parseDocument(raw)
  const patch = bundle.hermes_config_patch as Record<string, Record<string, unknown>>
  for (const [section, kv] of Object.entries(patch)) {
    for (const [key, value] of Object.entries(kv)) {
      doc.setIn([section, key], value)
    }
  }
  writeFileSync(HERMES_CONFIG, doc.toString())
  console.log(
    `  patched ${chalk.cyan(HERMES_CONFIG)} ${chalk.dim('(backup: ' + backup + ')')}`,
  )
  for (const [section, kv] of Object.entries(patch)) {
    for (const [key, value] of Object.entries(kv)) {
      console.log(
        `    ${chalk.dim(section + '.')}${chalk.bold(key)} = ${JSON.stringify(value)}`,
      )
    }
  }
}
