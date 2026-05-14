import { mkdirSync, writeFileSync, existsSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { HERMES_HOME } from './paths.js'
import type { SelectedService, MarketplaceEndpoint, EndpointParameter } from './marketplace.js'

const SKILLS_BASE = join(HERMES_HOME, 'skills')
const X402_CATEGORY = 'x402'
const SKILLS_DIR = join(SKILLS_BASE, X402_CATEGORY)

export function getSkillsDir(): string {
  return SKILLS_DIR
}

const ENDPOINT_HINTS: Record<string, { params?: EndpointParameter[]; exampleBody?: string; exampleUrl?: string; notes?: string }> = {
  'https://wolframalpha.x402.paysponge.com/v1/result': {
    exampleUrl: 'https://wolframalpha.x402.paysponge.com/v1/result?i=population+of+france',
    params: [{ name: 'i', type: 'string', example: 'population of france', required: true, group: 'query' }],
    notes: 'The query parameter is `i` (not `query`). URL-encode the question.',
  },
  'https://wolframalpha.x402.paysponge.com/v1/simple': {
    exampleUrl: 'https://wolframalpha.x402.paysponge.com/v1/simple?i=solve+x^2-4=0',
    params: [{ name: 'i', type: 'string', example: 'solve x^2-4=0', required: true, group: 'query' }],
  },
  'https://wolframalpha.x402.paysponge.com/v2/query': {
    exampleUrl: 'https://wolframalpha.x402.paysponge.com/v2/query?input=ISS+location&output=json',
    params: [
      { name: 'input', type: 'string', example: 'ISS location', required: true, group: 'query' },
      { name: 'output', type: 'string', example: 'json', group: 'query' },
    ],
  },
  'https://pplx.x402.paysponge.com/search': {
    exampleBody: '{"query": "latest news about AI agents"}',
    params: [{ name: 'query', type: 'string', example: 'latest news about AI agents', required: true }],
  },
  'https://pplx.x402.paysponge.com/v1/agent': {
    exampleBody: '{"query": "explain quantum computing simply"}',
    params: [{ name: 'query', type: 'string', example: 'explain quantum computing simply', required: true }],
  },
  'https://api.exa.ai/contents': {
    exampleBody: '{"urls": ["https://nousresearch.com"], "text": true}',
  },
  'https://stableenrich.dev/api/apollo/org-search': {
    exampleBody: '{"query": "Nous Research"}',
    params: [{ name: 'query', type: 'string', example: 'Nous Research', required: true }],
  },
  'https://stableenrich.dev/api/apollo/org-enrich': {
    exampleBody: '{"domain": "nousresearch.com"}',
    params: [{ name: 'domain', type: 'string', example: 'nousresearch.com', required: true }],
  },
  'https://stableenrich.dev/api/apollo/people-search': {
    exampleBody: '{"query": "CEO artificial intelligence"}',
    params: [{ name: 'query', type: 'string', example: 'CEO artificial intelligence', required: true }],
  },
  'https://stableenrich.dev/api/apollo/people-enrich': {
    exampleBody: '{"email": "user@example.com"}',
    params: [{ name: 'email', type: 'string', example: 'user@example.com', required: true }],
  },
  'https://pro-api.coingecko.com/api/v3/x402/onchain/search/pools': {
    exampleUrl: 'https://pro-api.coingecko.com/api/v3/x402/onchain/search/pools?query=ETH',
    params: [{ name: 'query', type: 'string', example: 'ETH', required: true, group: 'query' }],
  },
  'https://pro-api.coingecko.com/api/v3/x402/onchain/simple/networks/base/token_price/ethereum': {
    notes: 'Returns ETH price on Base. No parameters needed — just GET this URL.',
  },
}

function buildExampleBody(params: EndpointParameter[]): string {
  const bodyParams = params.filter((p) => !p.group || p.group === 'body')
  if (bodyParams.length === 0) return '{}'
  const obj: Record<string, unknown> = {}
  for (const p of bodyParams) {
    if (p.example !== undefined && p.example !== null && p.example !== '') {
      obj[p.name] = p.example
    } else {
      const defaults: Record<string, unknown> = { string: `<${p.name}>`, number: 10, boolean: true, array: [] }
      obj[p.name] = defaults[p.type] ?? `<${p.name}>`
    }
  }
  return JSON.stringify(obj, null, 2)
}

function buildQueryExample(params: EndpointParameter[]): string {
  const queryParams = params.filter((p) => p.group === 'query')
  if (queryParams.length === 0) return ''
  const parts = queryParams.map((p) => {
    const val = p.example !== undefined && p.example !== null ? String(p.example) : `<${p.name}>`
    return `${p.name}=${encodeURIComponent(val)}`
  })
  return '?' + parts.join('&')
}

function buildCallExample(ep: MarketplaceEndpoint): string {
  const hint = ENDPOINT_HINTS[ep.url]
  const params = hint?.params ?? ep.parameters ?? []

  if (hint?.exampleUrl) {
    return `x402_fetch(url="${hint.exampleUrl}", method="GET")`
  }
  if (hint?.exampleBody) {
    return `x402_fetch(url="${ep.url}", method="${ep.method}", body='${hint.exampleBody}', headers={"Content-Type": "application/json"})`
  }
  if (ep.method === 'GET') {
    const qs = buildQueryExample(params)
    return `x402_fetch(url="${ep.url}${qs}", method="GET")`
  }
  const body = buildExampleBody(params)
  return `x402_fetch(url="${ep.url}", method="${ep.method}", body='${body}', headers={"Content-Type": "application/json"})`
}

function categoryTag(cat: string): string {
  const map: Record<string, string> = {
    search: 'Search', data: 'Data', media: 'Media', social: 'Social',
    infrastructure: 'Infrastructure', trading: 'Trading', inference: 'AI',
  }
  return map[cat] ?? 'Tools'
}

function generateSkillMd(service: SelectedService): string {
  const maxEndpoints = 8
  const displayEndpoints = service.endpoints.slice(0, maxEndpoints)
  const tag = categoryTag(service.category)

  const frontmatter = [
    '---',
    `name: ${service.id}`,
    `description: "${service.name} — paid x402 API. Use x402_fetch to call. Payment is automatic from wallet."`,
    'version: 1.0.0',
    'author: hermes-x402',
    'platforms: [linux, macos, windows]',
    'metadata:',
    '  hermes:',
    `    tags: [x402, ${tag}, ${service.name}, Paid API, USDC]`,
    '---',
    '',
  ].join('\n')

  const lines: string[] = [
    `# ${service.name}`,
    '',
    `Use the \`x402_fetch\` tool to call ${service.name}. Payment is automatic — your wallet pays per call in USDC on Base.`,
    '',
    `When the user asks you to do something related to ${service.name}, call \`x402_fetch\` with the appropriate URL and parameters below. Do NOT ask the user for API keys, URLs, or technical details — everything is here.`,
    '',
  ]

  for (let i = 0; i < displayEndpoints.length; i++) {
    const ep = displayEndpoints[i]
    const hint = ENDPOINT_HINTS[ep.url]
    const params = hint?.params ?? ep.parameters ?? []
    const price = ep.pricing?.amount ? `$${ep.pricing.amount}` : 'variable'

    lines.push(`## ${ep.description || ep.url}`)
    lines.push('')

    if (hint?.notes) {
      lines.push(`> ${hint.notes}`)
      lines.push('')
    }

    lines.push(`| Field | Value |`)
    lines.push(`|-------|-------|`)
    lines.push(`| URL | \`${ep.url}\` |`)
    lines.push(`| Method | ${ep.method} |`)
    lines.push(`| Price | ${price} USDC |`)
    lines.push('')

    if (params.length > 0) {
      lines.push('**Parameters:**')
      for (const p of params) {
        const req = p.required ? ' *(required)*' : ''
        const ex = p.example !== undefined && p.example !== null ? ` (example: \`${JSON.stringify(p.example)}\`)` : ''
        lines.push(`- \`${p.name}\` (${p.type})${req}${ex}`)
      }
      lines.push('')
    }

    lines.push('**Example call:**')
    lines.push('```')
    lines.push(buildCallExample(ep))
    lines.push('```')
    lines.push('')
  }

  if (service.endpoints.length > maxEndpoints) {
    lines.push(`> ${service.endpoints.length - maxEndpoints} more endpoints available.`)
    lines.push('')
  }

  return frontmatter + lines.join('\n')
}

export function writeSkillFiles(services: SelectedService[]): string[] {
  const written: string[] = []

  for (const service of services) {
    const skillDir = join(SKILLS_DIR, service.id)
    mkdirSync(skillDir, { recursive: true })
    const filepath = join(skillDir, 'SKILL.md')
    writeFileSync(filepath, generateSkillMd(service))
    written.push(filepath)
  }

  return written
}

export function cleanStaleSkillFiles(currentServiceIds: Set<string>): string[] {
  if (!existsSync(SKILLS_DIR)) return []
  const removed: string[] = []
  const entries = readdirSync(SKILLS_DIR, { withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (!currentServiceIds.has(entry.name)) {
      rmSync(join(SKILLS_DIR, entry.name), { recursive: true, force: true })
      removed.push(entry.name)
    }
  }
  return removed
}

export function generateIndexSkill(services: SelectedService[]): void {
  const skillDir = join(SKILLS_DIR, '_x402-index')
  mkdirSync(skillDir, { recursive: true })

  const byCategory = new Map<string, SelectedService[]>()
  for (const s of services) {
    if (!byCategory.has(s.category)) byCategory.set(s.category, [])
    byCategory.get(s.category)!.push(s)
  }

  const frontmatter = [
    '---',
    'name: _x402-index',
    `description: "Index of ${services.length} x402 paid API services available via x402_fetch. Check wallet with x402_wallet_info."`,
    'version: 1.0.0',
    'author: hermes-x402',
    'platforms: [linux, macos, windows]',
    'metadata:',
    '  hermes:',
    '    tags: [x402, Index, Paid APIs, USDC, Wallet]',
    '---',
    '',
  ].join('\n')

  const lines = [
    '# x402 Paid API Services',
    '',
    'You have access to these paid API services. Use `x402_fetch` to call any endpoint — payment is automatic from your wallet.',
    '',
    'When the user asks you to do something that matches one of these services, use `x402_fetch` with the appropriate URL, method, and body. Do NOT ask the user for URLs or API details — you already have them. View any skill for full endpoint details.',
    '',
  ]

  for (const [category, svcs] of byCategory) {
    lines.push(`## ${category}`)
    lines.push('')
    for (const s of svcs) {
      const ep = s.endpoints[0]
      const quickRef = ep ? `— \`${ep.method} ${ep.url}\`` : ''
      lines.push(`- **${s.name}** (${s.endpoints.length} endpoints) ${quickRef}`)
    }
    lines.push('')
  }

  lines.push('## Quick reference')
  lines.push('')
  lines.push('- Check wallet: `x402_wallet_info()`')
  lines.push('')

  writeFileSync(join(skillDir, 'SKILL.md'), frontmatter + lines.join('\n'))
}
