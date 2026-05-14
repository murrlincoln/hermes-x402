import { mkdirSync, writeFileSync, existsSync, readdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { HERMES_HOME } from './paths.js'
import type { SelectedService, MarketplaceEndpoint, EndpointParameter } from './marketplace.js'

const SKILLS_DIR = join(HERMES_HOME, 'skills', 'x402')

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
      const defaults: Record<string, unknown> = {
        string: `<${p.name}>`,
        number: 10,
        boolean: true,
        array: [],
      }
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

function endpointSection(ep: MarketplaceEndpoint, index: number): string {
  const lines: string[] = []
  const price = ep.pricing?.amount ? `$${ep.pricing.amount} USDC` : 'variable'
  const hint = ENDPOINT_HINTS[ep.url]
  const params = hint?.params ?? ep.parameters ?? []

  lines.push(`### ${index + 1}. ${ep.description || ep.url}`)
  lines.push('')
  lines.push(`- **URL**: \`${ep.url}\``)
  lines.push(`- **Method**: ${ep.method}`)
  lines.push(`- **Price**: ${price} per call`)

  if (hint?.notes) {
    lines.push(`- **Note**: ${hint.notes}`)
  }

  if (params.length > 0) {
    lines.push(`- **Parameters**:`)
    for (const p of params) {
      const req = p.required ? ' (required)' : ''
      const ex = p.example !== undefined && p.example !== null ? ` — example: \`${JSON.stringify(p.example)}\`` : ''
      lines.push(`  - \`${p.name}\` (${p.type})${req}${ex}`)
    }
  }

  lines.push('')
  lines.push('**Call this endpoint:**')
  if (hint?.exampleUrl) {
    lines.push('```')
    lines.push(`x402_fetch(url="${hint.exampleUrl}", method="GET")`)
    lines.push('```')
  } else if (hint?.exampleBody) {
    lines.push('```')
    lines.push(`x402_fetch(url="${ep.url}", method="${ep.method}", body='${hint.exampleBody}', headers={"Content-Type": "application/json"})`)
    lines.push('```')
  } else if (ep.method === 'GET') {
    const qs = buildQueryExample(params)
    lines.push('```')
    lines.push(`x402_fetch(url="${ep.url}${qs}", method="GET")`)
    lines.push('```')
  } else {
    const body = buildExampleBody(params)
    lines.push('```')
    lines.push(`x402_fetch(url="${ep.url}", method="${ep.method}", body='${body}', headers={"Content-Type": "application/json"})`)
    lines.push('```')
  }

  lines.push('')
  return lines.join('\n')
}

function generateSkillMarkdown(service: SelectedService): string {
  const maxEndpoints = 8
  const displayEndpoints = service.endpoints.slice(0, maxEndpoints)

  const lines: string[] = [
    `# ${service.name}`,
    '',
    `**${service.name}** is an x402-powered API. Payment is automatic — when you call \`x402_fetch\` with any URL below, your wallet pays the microtransaction.`,
    '',
    `**Category**: ${service.category}`,
    `**Endpoints**: ${service.endpoints.length}`,
    '',
    '---',
    '',
  ]

  for (let i = 0; i < displayEndpoints.length; i++) {
    lines.push(endpointSection(displayEndpoints[i], i))
  }

  if (service.endpoints.length > maxEndpoints) {
    lines.push(`> ${service.endpoints.length - maxEndpoints} more endpoints available. Check the marketplace for full list.`)
    lines.push('')
  }

  return lines.join('\n')
}

export function writeSkillFiles(services: SelectedService[]): string[] {
  mkdirSync(SKILLS_DIR, { recursive: true })
  const written: string[] = []

  for (const service of services) {
    const filename = `${service.id}.md`
    const filepath = join(SKILLS_DIR, filename)
    const content = generateSkillMarkdown(service)
    writeFileSync(filepath, content)
    written.push(filepath)
  }

  return written
}

export function cleanStaleSkillFiles(currentServiceIds: Set<string>): string[] {
  if (!existsSync(SKILLS_DIR)) return []
  const removed: string[] = []
  const files = readdirSync(SKILLS_DIR).filter((f) => f.endsWith('.md'))
  for (const file of files) {
    const id = file.replace('.md', '')
    if (id === '_index') continue
    if (!currentServiceIds.has(id)) {
      unlinkSync(join(SKILLS_DIR, file))
      removed.push(file)
    }
  }
  return removed
}

export function generateIndexSkill(services: SelectedService[]): void {
  mkdirSync(SKILLS_DIR, { recursive: true })
  const lines = [
    '# x402 Paid API Services',
    '',
    'You have access to these paid API services. Use `x402_fetch` to call any endpoint — payment is automatic from your wallet.',
    '',
    'When the user asks you to do something that matches one of these services, use `x402_fetch` with the appropriate URL, method, and body. Do NOT ask the user for URLs or API details — you already have them.',
    '',
  ]

  const byCategory = new Map<string, SelectedService[]>()
  for (const s of services) {
    if (!byCategory.has(s.category)) byCategory.set(s.category, [])
    byCategory.get(s.category)!.push(s)
  }

  for (const [category, svcs] of byCategory) {
    lines.push(`## ${category}`)
    lines.push('')
    for (const s of svcs) {
      const ep = s.endpoints[0]
      const quickRef = ep ? `\`${ep.method} ${ep.url}\`` : ''
      lines.push(`- **${s.name}** (${s.endpoints.length} endpoints) — ${quickRef}`)
    }
    lines.push('')
  }

  lines.push('## Quick reference')
  lines.push('')
  lines.push('- Check wallet: `x402_wallet_info()`')
  lines.push('- Web search: `x402_fetch(url="https://api.exa.ai/search", method="POST", body=\'{"query":"...","numResults":5}\', headers={"Content-Type":"application/json"})`')
  lines.push('')

  writeFileSync(join(SKILLS_DIR, '_index.md'), lines.join('\n'))
}
