#!/usr/bin/env node
import { Command } from 'commander'
import chalk from 'chalk'
import ora from 'ora'
import qrcode from 'qrcode-terminal'
import { parse as parseYaml, parseDocument } from 'yaml'
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
  walletFromPrivateKey,
} from '../lib/wallet.js'
import { WALLET_PROVIDERS, type ProviderId } from '../lib/wallet-providers.js'
import { select, password, confirm, checkbox } from '@inquirer/prompts'
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
import {
  fetchCatalog,
  groupByCategory,
  searchServices,
  formatPrice,
  addSelectedService,
  removeSelectedService,
  loadSkillsConfig,
  getSelectedServiceIds,
  CATEGORIES,
  type MarketplaceService,
} from '../lib/marketplace.js'
import { getUsdcBalance, formatUsdc } from '../lib/onchain.js'
import {
  writeSkillFiles,
  cleanStaleSkillFiles,
  generateIndexSkill,
  getSkillsDir,
} from '../lib/skills-generator.js'

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
  .description('Full onboarding: wallet → skills marketplace → inference bundle → fund → auto-configure')
  .option('-b, --bundle <name>', 'Skip the bundle picker and install this one')
  .option('-y, --yes', 'Non-interactive: defaults (generate wallet, starter bundle, no marketplace)')
  .option('--no-patch', 'Skip patching ~/.hermes/config.yaml')
  .action(async (opts) => {
    const nonInteractive = opts.yes === true || !process.stdin.isTTY

    console.log()
    console.log(chalk.bold('  Welcome to hermes-x402.'))
    console.log(chalk.dim('  Wallet-funded agent setup — no API keys needed.'))
    console.log(chalk.dim('  Your agent gets a wallet, picks skills, and is ready to go.'))
    console.log()

    // ── Step 1 of 3: Wallet ────────────────────────────────────────────
    sectionHeader('Step 1 of 3', 'Wallet')

    if (walletExists()) {
      const w = loadWallet()
      console.log(`  ${chalk.green('✓')} wallet already configured`)
      console.log(`    ${chalk.bold('address:')} ${w.address}`)
      console.log(
        chalk.dim(`    (stored at ${WALLET_PATH}; chmod 600)`),
      )
    } else {
      const providerId: ProviderId = nonInteractive
        ? 'local-generate'
        : await pickWalletProvider()
      await setupWallet(providerId)
    }

    const wallet = loadWallet()
    const balSpin = ora('Checking on-chain USDC balance on Base').start()
    try {
      const onChainBalance = await getUsdcBalance(wallet.address)
      balSpin.stop()
      console.log(`  ${chalk.bold('USDC:')}     ${onChainBalance > 0 ? chalk.green(formatUsdc(onChainBalance)) : chalk.yellow('$0.00')} on Base`)
      if (onChainBalance === 0) {
        console.log(chalk.yellow('  No USDC detected. Send USDC on Base to this address to use paid services.'))
        console.log(chalk.dim(`  You can continue setup now and fund later.`))
      }
    } catch (err) {
      balSpin.fail(`Could not check balance: ${(err as Error).message}`)
    }

    // ── Step 2 of 3: Skills ────────────────────────────────────────────
    console.log()
    sectionHeader('Step 2 of 3', 'Skills')

    const bundleChoice: string = opts.bundle ?? (nonInteractive ? 'starter' : await pickBundleOrCustom())

    let bundle: Bundle | null = null
    if (bundleChoice === 'custom') {
      console.log(chalk.dim('  Build your own skill set from the x402 marketplace.'))
      console.log()
      await interactiveSkillBrowser()
    } else {
      bundle = loadBundle(bundleChoice)
      console.log(
        `  ${chalk.bold('bundle:')} ${chalk.cyan(bundle.name)}  ${chalk.dim(bundle.description?.trim().split('\n')[0] ?? '')}`,
      )

      if (bundle.x402_skills && bundle.x402_skills.length > 0) {
        const bundleSkillsSpin = ora('Adding skills from bundle').start()
        try {
          const catalog = await fetchCatalog()
          let added = 0
          for (const skillId of bundle.x402_skills) {
            const service = catalog.find((s) => s.id === skillId)
            if (service) {
              addSelectedService(service)
              added++
            }
          }
          bundleSkillsSpin.succeed(`Added ${added} skill${added !== 1 ? 's' : ''} from ${bundle.name} bundle`)
        } catch {
          bundleSkillsSpin.warn('Could not fetch marketplace catalog for bundle skills')
        }
      }
    }

    if (bundle && opts.patch !== false) {
      patchHermesConfig(bundle)
    }

    // ── Step 3 of 3: Configure ─────────────────────────────────────────
    console.log()
    sectionHeader('Step 3 of 3', 'Configure')

    const skillsConfig = loadSkillsConfig()
    if (skillsConfig.selectedServices.length > 0) {
      const skillSpin = ora('Generating x402 skill files for Hermes').start()
      const written = writeSkillFiles(skillsConfig.selectedServices)
      generateIndexSkill(skillsConfig.selectedServices)
      const currentIds = new Set(skillsConfig.selectedServices.map((s) => s.id))
      cleanStaleSkillFiles(currentIds)
      skillSpin.succeed(`Generated ${written.length} skill file${written.length !== 1 ? 's' : ''} at ${getSkillsDir()}`)
    } else {
      console.log(chalk.dim('  No marketplace skills selected. Agent will have x402_fetch for manual use.'))
    }

    // Auto-install MCP server
    if (existsSync(HERMES_CONFIG)) {
      const serverPath = join(PROJECT_ROOT, 'src', 'mcp', 'server.ts')
      if (existsSync(serverPath)) {
        const mcpSpin = ora('Registering x402 MCP server with Hermes').start()
        const backup = HERMES_CONFIG + '.bak.' + Date.now()
        copyFileSync(HERMES_CONFIG, backup)
        const result = upsertMcpServer(
          readFileSync(HERMES_CONFIG, 'utf-8'),
          'hermes-x402',
          'npx',
          ['tsx', serverPath],
        )
        writeFileSync(HERMES_CONFIG, result.text)
        mcpSpin.succeed(`${result.action} hermes-x402 MCP server`)
        console.log(chalk.dim(`    (backup: ${backup})`))
      }
    } else {
      console.log(chalk.dim('  Hermes config not found — run `hermes setup` first, then `x402 install-mcp`'))
    }

    // Final summary
    console.log()
    console.log(chalk.bold.green('  ✓ Setup complete!'))
    console.log()

    const sc = loadSkillsConfig()
    if (sc.selectedServices.length > 0) {
      console.log(chalk.bold('  Selected skills:'))
      for (const s of sc.selectedServices) {
        console.log(`    ${chalk.cyan('•')} ${s.name} (${s.endpoints.length} endpoint${s.endpoints.length !== 1 ? 's' : ''})`)
      }
      console.log()
    }

    console.log(chalk.bold('  Next steps:'))
    try {
      const bal = await getUsdcBalance(wallet.address)
      if (bal === 0) {
        console.log(`    ${chalk.bold('1.')} Send USDC on Base to ${chalk.cyan(wallet.address)}`)
        console.log(`    ${chalk.bold('2.')} ${chalk.bold('x402 topup 5')}      convert on-chain USDC → Venice balance`)
        console.log(`    ${chalk.bold('3.')} ${chalk.bold('x402 start --daemon')} run the bridge`)
        console.log(`    ${chalk.bold('4.')} ${chalk.bold('hermes')}             talk to your agent`)
      } else {
        console.log(`    ${chalk.bold('1.')} ${chalk.bold('x402 topup 5')}      convert on-chain USDC → Venice balance`)
        console.log(`    ${chalk.bold('2.')} ${chalk.bold('x402 start --daemon')} run the bridge`)
        console.log(`    ${chalk.bold('3.')} ${chalk.bold('hermes')}             talk to your agent`)
      }
    } catch {
      console.log(`    ${chalk.bold('x402 balance')}              check wallet funds`)
      console.log(`    ${chalk.bold('x402 start --daemon')}       run the bridge`)
      console.log(`    ${chalk.bold('hermes')}                    talk to your agent`)
    }
    console.log()
    console.log(chalk.dim('  Manage skills anytime: x402 marketplace'))
    console.log(chalk.dim('  Check spending:        x402 spend'))
    console.log()
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
    if (!existsSync(HERMES_CONFIG)) {
      console.error(chalk.red(`${HERMES_CONFIG} not found — install Hermes first`))
      process.exit(1)
    }
    const backup = HERMES_CONFIG + '.bak.' + Date.now()
    copyFileSync(HERMES_CONFIG, backup)
    const result = upsertMcpServer(
      readFileSync(HERMES_CONFIG, 'utf-8'),
      opts.name,
      'npx',
      ['tsx', serverPath],
    )
    writeFileSync(HERMES_CONFIG, result.text)
    console.log(`${result.action} ${chalk.cyan(opts.name)} in ${HERMES_CONFIG}`)
    console.log(chalk.dim(`  backup: ${backup}`))
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

// ------------------------------------------------------------------------
// marketplace
// ------------------------------------------------------------------------

const marketplace = program
  .command('marketplace')
  .description('Browse and manage x402 skills from agentic.market')

marketplace
  .command('browse')
  .description('Interactive skill browser — pick services to add to your agent')
  .action(async () => {
    await interactiveSkillBrowser()
  })

marketplace
  .command('search <query>')
  .description('Search the marketplace by name or description')
  .action(async (query: string) => {
    const spin = ora('Searching marketplace').start()
    try {
      const catalog = await fetchCatalog()
      spin.stop()
      const results = searchServices(catalog, query)
      if (results.length === 0) {
        console.log(chalk.dim(`  No services matching "${query}"`))
        return
      }
      const selectedIds = getSelectedServiceIds()
      console.log(chalk.bold(`  ${results.length} result${results.length !== 1 ? 's' : ''} for "${query}":\n`))
      for (const s of results.slice(0, 20)) {
        const installed = selectedIds.has(s.id) ? chalk.green(' ✓') : ''
        const price = formatPrice(s)
        console.log(`  ${chalk.bold(s.name.padEnd(24))} ${chalk.dim(price.padEnd(12))} ${s.description.slice(0, 60)}${installed}`)
      }
      if (results.length > 20) {
        console.log(chalk.dim(`\n  ...and ${results.length - 20} more. Refine your search.`))
      }
    } catch (err) {
      spin.fail((err as Error).message)
    }
  })

marketplace
  .command('add <serviceId>')
  .description('Add a service to your agent by ID')
  .action(async (serviceId: string) => {
    const spin = ora('Fetching service info').start()
    try {
      const catalog = await fetchCatalog()
      const service = catalog.find((s) => s.id === serviceId)
      if (!service) {
        spin.fail(`Service "${serviceId}" not found. Use \`x402 marketplace search\` to find services.`)
        return
      }
      addSelectedService(service)
      spin.succeed(`Added ${chalk.cyan(service.name)} (${service.endpoints.length} endpoints)`)
      regenerateSkillFiles()
    } catch (err) {
      spin.fail((err as Error).message)
    }
  })

marketplace
  .command('remove <serviceId>')
  .description('Remove a service from your agent')
  .action((serviceId: string) => {
    removeSelectedService(serviceId)
    regenerateSkillFiles()
    console.log(`Removed ${chalk.cyan(serviceId)}`)
  })

marketplace
  .command('list')
  .description('Show services currently added to your agent')
  .action(() => {
    const config = loadSkillsConfig()
    if (config.selectedServices.length === 0) {
      console.log(chalk.dim('  No services selected. Use `x402 marketplace browse` to add some.'))
      return
    }
    console.log(chalk.bold(`  ${config.selectedServices.length} selected service${config.selectedServices.length !== 1 ? 's' : ''}:\n`))
    for (const s of config.selectedServices) {
      console.log(`  ${chalk.cyan('•')} ${chalk.bold(s.name.padEnd(24))} ${s.endpoints.length} endpoint${s.endpoints.length !== 1 ? 's' : ''}  ${chalk.dim(s.category)}`)
    }
  })

marketplace
  .command('refresh')
  .description('Refresh the marketplace catalog cache')
  .action(async () => {
    const spin = ora('Refreshing marketplace catalog').start()
    try {
      const catalog = await fetchCatalog(true)
      spin.succeed(`Loaded ${catalog.length} services from agentic.market`)
    } catch (err) {
      spin.fail((err as Error).message)
    }
  })

// ------------------------------------------------------------------------
// info
// ------------------------------------------------------------------------

program
  .command('info')
  .description('Show config paths and current state')
  .action(async () => {
    console.log(`${chalk.bold('X402_HOME:')}      ${X402_HOME}`)
    console.log(`${chalk.bold('wallet:')}         ${WALLET_PATH}  ${existsSync(WALLET_PATH) ? chalk.green('(present)') : chalk.red('(missing)')}`)
    console.log(`${chalk.bold('hermes config:')}  ${HERMES_CONFIG}  ${existsSync(HERMES_CONFIG) ? chalk.green('(present)') : chalk.red('(missing)')}`)
    console.log(`${chalk.bold('bridge port:')}    ${DEFAULT_BRIDGE_PORT}`)
    console.log(`${chalk.bold('skills dir:')}     ${getSkillsDir()}`)
    const config = loadSkillsConfig()
    console.log(`${chalk.bold('skills:')}         ${config.selectedServices.length} selected`)
    if (walletExists()) {
      try {
        const w = loadWallet()
        const bal = await getUsdcBalance(w.address)
        console.log(`${chalk.bold('USDC balance:')}   ${formatUsdc(bal)} (on-chain, Base)`)
      } catch { /* ignore */ }
    }
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
  x402_skills?: string[]
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

function sectionHeader(step: string, title: string): void {
  const bar = '─'.repeat(56)
  console.log(`  ${chalk.dim(bar)}`)
  console.log(`  ${chalk.dim(step)}  ${chalk.bold(title)}`)
  console.log(`  ${chalk.dim(bar)}`)
}

async function pickWalletProvider(): Promise<ProviderId> {
  return await select<ProviderId>({
    message: 'How do you want to provide a wallet?',
    choices: WALLET_PROVIDERS.map((p) => ({
      name:
        p.label +
        (p.status === 'coming-soon'
          ? chalk.yellow('  (coming soon)')
          : p.recommended
            ? chalk.green('  (recommended)')
            : ''),
      value: p.id,
      description: p.description,
    })),
  })
}

async function setupWallet(providerId: ProviderId): Promise<void> {
  if (providerId === 'local-generate') {
    const spin = ora('Generating wallet').start()
    const w = generateWallet()
    saveWallet(w)
    spin.succeed(`Wallet created at ${WALLET_PATH}`)
    console.log(`    ${chalk.bold('address:')} ${w.address}`)
    console.log(chalk.dim(`    (private key chmod 600)`))
    return
  }
  if (providerId === 'local-import') {
    let pk: string
    try {
      pk = await password({
        message:
          'Paste private key (hidden — must start with 0x or be 64-char hex):',
        mask: '*',
      })
    } catch {
      console.log(chalk.red('  cancelled'))
      process.exit(1)
    }
    let wallet
    try {
      wallet = walletFromPrivateKey(pk)
    } catch (err) {
      console.error(chalk.red(`  Invalid private key: ${(err as Error).message}`))
      process.exit(1)
    }
    saveWallet(wallet)
    console.log(`  ${chalk.green('✓')} imported wallet`)
    console.log(`    ${chalk.bold('address:')} ${wallet.address}`)
    console.log(chalk.dim(`    (private key chmod 600)`))
    return
  }
  // coming-soon providers
  const provider = WALLET_PROVIDERS.find((p) => p.id === providerId)
  console.log()
  console.log(
    chalk.yellow(`  ${provider?.label} is not implemented yet.`),
  )
  console.log(
    chalk.dim('  Tracking in NEXTSTEPS.md (P0 — wallet provider abstraction).'),
  )
  const proceed = await confirm({
    message: 'Generate a local keypair for now instead?',
    default: true,
  }).catch(() => false)
  if (!proceed) {
    console.log(chalk.red('  Aborting init.'))
    process.exit(1)
  }
  await setupWallet('local-generate')
}

async function pickBundle(): Promise<string> {
  const files = readdirSync(BUNDLES_DIR).filter((f) => f.endsWith('.yaml'))
  if (files.length === 1) {
    const only = basename(files[0], '.yaml')
    console.log(chalk.dim(`  (only one bundle available: ${only})`))
    return only
  }
  return await select<string>({
    message: 'Which bundle do you want to start with?',
    choices: files.map((f) => {
      const b = loadBundle(basename(f, '.yaml'))
      return {
        name: b.name,
        value: b.name,
        description: b.description?.trim().split('\n')[0] ?? '',
      }
    }),
  })
}

async function pickBundleOrCustom(): Promise<string> {
  const files = readdirSync(BUNDLES_DIR).filter((f) => f.endsWith('.yaml'))
  const bundles = files.map((f) => {
    const b = loadBundle(basename(f, '.yaml'))
    const skillCount = b.x402_skills?.length ?? 0
    const skillLabel = skillCount > 0 ? chalk.dim(` (${skillCount} skills)`) : ''
    return {
      name: `${b.name}${skillLabel}`,
      value: b.name,
      description: b.description?.trim().split('\n')[0] ?? '',
    }
  })
  return await select<string>({
    message: 'Pick a skill set for your agent',
    choices: [
      ...bundles,
      {
        name: `custom ${chalk.dim('— pick individual skills from the marketplace')}`,
        value: 'custom',
        description: 'Browse 700+ paid API services and choose exactly what you want.',
      },
    ],
  })
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

  // Targeted line-level rewrites: preserves comments + layout instead of
  // round-tripping through a YAML AST (which strips comments).
  const patch = bundle.hermes_config_patch as Record<string, Record<string, unknown>>
  let text = readFileSync(HERMES_CONFIG, 'utf-8')
  const applied: Array<[string, string, unknown]> = []
  for (const [section, kv] of Object.entries(patch)) {
    for (const [key, value] of Object.entries(kv)) {
      const result = setYamlKeyInSection(text, section, key, value)
      if (result.changed) {
        text = result.text
        applied.push([section, key, value])
      } else {
        console.log(
          chalk.yellow(`    ⚠ could not find ${section}.${key} in config; left unchanged`),
        )
      }
    }
  }
  writeFileSync(HERMES_CONFIG, text)
  console.log(
    `  patched ${chalk.cyan(HERMES_CONFIG)} ${chalk.dim('(backup: ' + backup + ')')}`,
  )
  for (const [section, key, value] of applied) {
    console.log(
      `    ${chalk.dim(section + '.')}${chalk.bold(key)} = ${JSON.stringify(value)}`,
    )
  }
}

// Replace a key=value inside a top-level section, preserving comments + indentation.
// Returns the updated text + whether a change was made.
function setYamlKeyInSection(
  text: string,
  section: string,
  key: string,
  value: unknown,
): { text: string; changed: boolean } {
  const lines = text.split('\n')
  let inSection = false
  let sectionIndent = 0
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const trimmed = line.trimStart()
    const indent = line.length - trimmed.length

    if (!inSection) {
      if (trimmed.startsWith(`${section}:`)) {
        inSection = true
        sectionIndent = indent
      }
      continue
    }
    // We left the section when we see a line whose indent <= sectionIndent and is non-blank
    if (trimmed.length > 0 && !trimmed.startsWith('#') && indent <= sectionIndent) {
      // Section ended without finding the key
      return { text, changed: false }
    }
    // Match `<indent>key:` (allow optional comment after value)
    const keyMatch = new RegExp(`^(\\s+)${escapeRegex(key)}:\\s*.*$`)
    const m = line.match(keyMatch)
    if (m) {
      const formatted = formatYamlScalar(value)
      lines[i] = `${m[1]}${key}: ${formatted}`
      return { text: lines.join('\n'), changed: true }
    }
  }
  return { text, changed: false }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// Add or update an MCP server entry under `mcp_servers:` without rewriting the
// whole config (so comments survive). If `mcp_servers:` doesn't exist yet, we
// append a new top-level block.
function upsertMcpServer(
  text: string,
  name: string,
  command: string,
  args: string[],
): { text: string; action: string } {
  const block = [
    `  ${name}:`,
    `    command: ${command}`,
    `    args:`,
    ...args.map((a) => `    - ${a}`),
    `    enabled: true`,
  ].join('\n')

  const lines = text.split('\n')
  let mcpIdx = -1
  for (let i = 0; i < lines.length; i++) {
    if (/^mcp_servers:\s*(\{\s*\})?\s*$/.test(lines[i]) || /^mcp_servers:\s*$/.test(lines[i])) {
      mcpIdx = i
      break
    }
  }

  if (mcpIdx === -1) {
    // Append at end of file
    const sep = text.endsWith('\n') ? '' : '\n'
    return {
      text: text + sep + '\nmcp_servers:\n' + block + '\n',
      action: 'added',
    }
  }

  // Find the existing block for this name within mcp_servers (indent 2)
  // If present, replace it; else insert after `mcp_servers:` line.
  let entryStart = -1
  let entryEnd = -1
  for (let i = mcpIdx + 1; i < lines.length; i++) {
    const line = lines[i]
    const trimmed = line.trimStart()
    const indent = line.length - trimmed.length
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue
    if (indent === 0) {
      // left mcp_servers section
      if (entryStart !== -1) entryEnd = i
      break
    }
    if (indent === 2 && trimmed.startsWith(`${name}:`)) {
      entryStart = i
      continue
    }
    if (entryStart !== -1 && indent <= 2) {
      // we left the entry — next sibling or end
      entryEnd = i
      break
    }
  }
  if (entryStart !== -1) {
    if (entryEnd === -1) entryEnd = lines.length
    const newLines = [...lines.slice(0, entryStart), ...block.split('\n'), ...lines.slice(entryEnd)]
    return { text: newLines.join('\n'), action: 'updated' }
  }
  // Need to convert "mcp_servers: {}" or "mcp_servers:" into a block
  if (/^mcp_servers:\s*\{\s*\}\s*$/.test(lines[mcpIdx])) {
    lines[mcpIdx] = 'mcp_servers:'
  }
  const newLines = [...lines.slice(0, mcpIdx + 1), ...block.split('\n'), ...lines.slice(mcpIdx + 1)]
  return { text: newLines.join('\n'), action: 'added' }
}

function formatYamlScalar(v: unknown): string {
  if (typeof v === 'string') {
    return `"${v.replace(/"/g, '\\"')}"`
  }
  if (typeof v === 'number' || typeof v === 'boolean' || v === null) {
    return String(v)
  }
  return JSON.stringify(v)
}

function regenerateSkillFiles(): void {
  const config = loadSkillsConfig()
  writeSkillFiles(config.selectedServices)
  generateIndexSkill(config.selectedServices)
  const currentIds = new Set(config.selectedServices.map((s) => s.id))
  cleanStaleSkillFiles(currentIds)
}

async function interactiveSkillBrowser(): Promise<void> {
  const spin = ora('Loading marketplace catalog from agentic.market').start()
  let catalog: MarketplaceService[]
  try {
    catalog = await fetchCatalog()
    spin.succeed(`Loaded ${catalog.length} services`)
  } catch (err) {
    spin.fail(`Could not load marketplace: ${(err as Error).message}`)
    return
  }

  const grouped = groupByCategory(catalog)
  let browsing = true

  while (browsing) {
    console.log()
    const selectedIds = getSelectedServiceIds()
    const selectedCount = selectedIds.size

    const action = await select<string>({
      message: `Skills marketplace${selectedCount > 0 ? chalk.green(` (${selectedCount} selected)`) : ''}`,
      choices: [
        ...CATEGORIES
          .filter((cat) => grouped.has(cat.id))
          .map((cat) => {
            const services = grouped.get(cat.id)!
            const installedInCat = services.filter((s) => selectedIds.has(s.id)).length
            const suffix = installedInCat > 0 ? chalk.green(` (${installedInCat} selected)`) : ''
            return {
              name: `${cat.emoji}  ${cat.label}  ${chalk.dim(`(${services.length})`)}${suffix}`,
              value: `cat:${cat.id}`,
            }
          }),
        { name: chalk.dim('─'.repeat(40)), value: 'sep', disabled: true },
        { name: `🔍  Search by name`, value: 'search' },
        {
          name: selectedCount > 0
            ? `${chalk.green('✓')}  Done (${selectedCount} selected)`
            : `✓  Done`,
          value: 'done',
        },
      ],
    }).catch(() => 'done')

    if (action === 'done' || action === 'sep') {
      browsing = false
      continue
    }

    if (action === 'search') {
      const { input } = await import('@inquirer/prompts')
      const query = await input({ message: 'Search:' }).catch(() => '')
      if (!query) continue
      const results = searchServices(catalog, query)
      if (results.length === 0) {
        console.log(chalk.dim(`  No results for "${query}"`))
        continue
      }
      await pickServicesFromList(results, `Results for "${query}"`)
      continue
    }

    if (action.startsWith('cat:')) {
      const catId = action.slice(4)
      const catInfo = CATEGORIES.find((c) => c.id === catId)
      const services = grouped.get(catId) ?? []
      await pickServicesFromList(services, catInfo?.label ?? catId)
    }
  }

  const finalConfig = loadSkillsConfig()
  if (finalConfig.selectedServices.length > 0) {
    console.log()
    console.log(chalk.bold(`  ${finalConfig.selectedServices.length} skill${finalConfig.selectedServices.length !== 1 ? 's' : ''} selected:`))
    for (const s of finalConfig.selectedServices) {
      console.log(`    ${chalk.cyan('•')} ${s.name}`)
    }
  }
}

async function pickServicesFromList(services: MarketplaceService[], title: string): Promise<void> {
  const selectedIds = getSelectedServiceIds()

  const maxServices = 30
  const displayServices = services.slice(0, maxServices)

  const chosen = await checkbox<string>({
    message: `${title} — toggle services (space to select, enter to confirm)`,
    choices: displayServices.map((s) => ({
      name: `${s.name.padEnd(24)} ${chalk.dim(formatPrice(s).padEnd(10))} ${s.description.slice(0, 50)}`,
      value: s.id,
      checked: selectedIds.has(s.id),
    })),
  }).catch(() => [] as string[])

  const chosenSet = new Set(chosen)

  for (const s of displayServices) {
    if (chosenSet.has(s.id) && !selectedIds.has(s.id)) {
      addSelectedService(s)
    } else if (!chosenSet.has(s.id) && selectedIds.has(s.id)) {
      removeSelectedService(s.id)
    }
  }

  if (services.length > maxServices) {
    console.log(chalk.dim(`  Showing first ${maxServices} of ${services.length}. Use \`x402 marketplace search\` for more.`))
  }
}
