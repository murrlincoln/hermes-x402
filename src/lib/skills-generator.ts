import { mkdirSync, writeFileSync, existsSync, readdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { HERMES_HOME } from './paths.js'
import type { SelectedService, MarketplaceEndpoint } from './marketplace.js'

const SKILLS_DIR = join(HERMES_HOME, 'skills', 'x402')

export function getSkillsDir(): string {
  return SKILLS_DIR
}

function endpointBlock(ep: MarketplaceEndpoint): string {
  const price = ep.pricing?.amount ? `$${ep.pricing.amount} USDC` : 'variable'
  return [
    `### ${ep.method} ${ep.url}`,
    ep.description ? `${ep.description}` : '',
    `- **Price**: ${price} per call`,
    '',
  ]
    .filter(Boolean)
    .join('\n')
}

function generateSkillMarkdown(service: SelectedService): string {
  const lines: string[] = [
    `# ${service.name}`,
    '',
    `> Category: ${service.category} | Payment: x402 (USDC on Base)`,
    '',
    '## How to use',
    '',
    'Use the `x402_fetch` tool to call these endpoints. Payment is automatic — your wallet pays per call.',
    '',
    '## Endpoints',
    '',
  ]

  for (const ep of service.endpoints) {
    lines.push(endpointBlock(ep))
  }

  lines.push('## Example')
  lines.push('')

  const firstEp = service.endpoints[0]
  if (firstEp) {
    if (firstEp.method === 'GET') {
      lines.push('```')
      lines.push(`x402_fetch(url="${firstEp.url}", method="GET")`)
      lines.push('```')
    } else {
      lines.push('```')
      lines.push(`x402_fetch(url="${firstEp.url}", method="${firstEp.method}", body="{...}", headers={"Content-Type": "application/json"})`)
      lines.push('```')
    }
  }

  lines.push('')
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
    '# x402 Services',
    '',
    'Your agent has access to these paid API services via x402 micropayments.',
    'Use the `x402_fetch` tool to call any endpoint. Payment happens automatically from your wallet.',
    '',
    '## Available Services',
    '',
  ]

  const byCategory = new Map<string, SelectedService[]>()
  for (const s of services) {
    if (!byCategory.has(s.category)) byCategory.set(s.category, [])
    byCategory.get(s.category)!.push(s)
  }

  for (const [category, svcs] of byCategory) {
    lines.push(`### ${category}`)
    lines.push('')
    for (const s of svcs) {
      const endpointCount = s.endpoints.length
      lines.push(`- **${s.name}** — ${endpointCount} endpoint${endpointCount !== 1 ? 's' : ''}`)
    }
    lines.push('')
  }

  lines.push('## Usage')
  lines.push('')
  lines.push('To use any service, call `x402_fetch` with the endpoint URL. Your wallet pays automatically.')
  lines.push('Check your balance anytime with `x402_wallet_info`.')
  lines.push('')

  writeFileSync(join(SKILLS_DIR, '_index.md'), lines.join('\n'))
}
