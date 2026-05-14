/**
 * Fetch and manage the agentic.market service catalog.
 * Services are x402-compatible API endpoints agents can pay-per-call.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { X402_HOME } from './paths.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EndpointParameter {
  name: string
  type: string
  description?: string
  example?: unknown
  required?: boolean
  group?: string
}

export interface MarketplaceEndpoint {
  url: string
  method: string
  description: string
  pricing?: { amount: string; currency: string }
  parameters?: EndpointParameter[]
}

export interface MarketplaceService {
  id: string
  name: string
  description: string
  category: string
  networks: string[]
  endpoints: MarketplaceEndpoint[]
  /** computed — cheapest endpoint price in USDC */
  minPriceUsdc: number | null
}

export interface SelectedService {
  id: string
  name: string
  category: string
  endpoints: MarketplaceEndpoint[]
  addedAt: string
}

export interface SkillsConfig {
  version: number
  selectedServices: SelectedService[]
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CATALOG_API = 'https://api.agentic.market/v1/services'
const CACHE_FILE = join(X402_HOME, 'marketplace-cache.json')
const SKILLS_CONFIG_FILE = join(X402_HOME, 'skills.json')
const CACHE_TTL_MS = 4 * 60 * 60 * 1000 // 4 hours

// Category display order + labels
export const CATEGORIES = [
  { id: 'inference', label: 'AI Inference', emoji: '🧠' },
  { id: 'search', label: 'Search & Web', emoji: '🔍' },
  { id: 'data', label: 'Data & Research', emoji: '📊' },
  { id: 'media', label: 'Media (Audio/Image/Video)', emoji: '🎨' },
  { id: 'social', label: 'Social & Communication', emoji: '💬' },
  { id: 'infrastructure', label: 'Infrastructure', emoji: '⚙️' },
  { id: 'trading', label: 'Trading', emoji: '📈' },
  { id: 'other', label: 'Other', emoji: '📦' },
] as const

// Featured / curated services that should appear first
const FEATURED_IDS = new Set([
  'exa', 'perplexity', 'firecrawl', 'deepgram', 'fal',
  'coingecko', 'nansen', 'wolfram', 'e2b', 'stablesocial',
  'stableemail', 'stablephone', 'hyperbrowser',
])

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

interface CacheEntry {
  fetchedAt: number
  services: MarketplaceService[]
}

function readCache(): CacheEntry | null {
  if (!existsSync(CACHE_FILE)) return null
  try {
    const data = JSON.parse(readFileSync(CACHE_FILE, 'utf-8')) as CacheEntry
    if (Date.now() - data.fetchedAt < CACHE_TTL_MS) return data
    return null // expired
  } catch {
    return null
  }
}

function writeCache(services: MarketplaceService[]): void {
  mkdirSync(X402_HOME, { recursive: true })
  const entry: CacheEntry = { fetchedAt: Date.now(), services }
  writeFileSync(CACHE_FILE, JSON.stringify(entry))
}

// ---------------------------------------------------------------------------
// Fetch catalog
// ---------------------------------------------------------------------------

function parseMinPrice(endpoints: MarketplaceEndpoint[]): number | null {
  let min: number | null = null
  for (const ep of endpoints) {
    if (ep.pricing?.amount) {
      const val = parseFloat(ep.pricing.amount)
      if (Number.isFinite(val) && (min === null || val < min)) min = val
    }
  }
  return min
}

function normalizeCategory(raw: string): string {
  const lower = raw.toLowerCase().trim()
  const map: Record<string, string> = {
    inference: 'inference',
    'ai inference': 'inference',
    search: 'search',
    'search & web': 'search',
    data: 'data',
    'data & research': 'data',
    media: 'media',
    social: 'social',
    communication: 'social',
    infrastructure: 'infrastructure',
    infra: 'infrastructure',
    trading: 'trading',
  }
  return map[lower] ?? 'other'
}

export async function fetchCatalog(forceRefresh = false): Promise<MarketplaceService[]> {
  if (!forceRefresh) {
    const cached = readCache()
    if (cached) return cached.services
  }

  const response = await fetch(CATALOG_API)
  if (!response.ok) {
    throw new Error(`Failed to fetch marketplace catalog: ${response.status} ${response.statusText}`)
  }

  const body = (await response.json()) as { services?: unknown[] } | unknown[]
  const raw = (Array.isArray(body) ? body : (body as { services: unknown[] }).services ?? []) as Array<{
    id?: string
    name?: string
    description?: string
    category?: string
    networks?: string[]
    endpoints?: Array<{
      url?: string
      method?: string
      description?: string
      pricing?: { amount?: string; currency?: string }
      parameters?: Array<{
        name?: string
        type?: string
        description?: string
        example?: unknown
        required?: boolean
        group?: string
      }>
    }>
  }>

  const services: MarketplaceService[] = raw
    .filter((s) => s.id && s.name)
    .map((s) => {
      const endpoints: MarketplaceEndpoint[] = (s.endpoints ?? []).map((ep) => ({
        url: ep.url ?? '',
        method: ep.method ?? 'GET',
        description: ep.description ?? '',
        pricing: ep.pricing?.amount
          ? { amount: ep.pricing.amount, currency: ep.pricing.currency ?? 'USDC' }
          : undefined,
        parameters: (ep.parameters ?? [])
          .filter((p) => p.name)
          .map((p) => ({
            name: p.name!,
            type: p.type ?? 'string',
            description: p.description,
            example: p.example,
            required: p.required,
            group: p.group,
          })),
      }))
      return {
        id: s.id!,
        name: s.name!,
        description: s.description ?? '',
        category: normalizeCategory(s.category ?? 'other'),
        networks: s.networks ?? ['base'],
        endpoints,
        minPriceUsdc: parseMinPrice(endpoints),
      }
    })

  writeCache(services)
  return services
}

// ---------------------------------------------------------------------------
// Service selection / grouping
// ---------------------------------------------------------------------------

export function groupByCategory(services: MarketplaceService[]): Map<string, MarketplaceService[]> {
  const map = new Map<string, MarketplaceService[]>()
  for (const s of services) {
    const cat = s.category
    if (!map.has(cat)) map.set(cat, [])
    map.get(cat)!.push(s)
  }
  // Sort each category: featured first, then alphabetical
  for (const [, list] of map) {
    list.sort((a, b) => {
      const aFeat = FEATURED_IDS.has(a.id) ? 0 : 1
      const bFeat = FEATURED_IDS.has(b.id) ? 0 : 1
      if (aFeat !== bFeat) return aFeat - bFeat
      return a.name.localeCompare(b.name)
    })
  }
  return map
}

export function searchServices(services: MarketplaceService[], query: string): MarketplaceService[] {
  const lower = query.toLowerCase()
  return services.filter(
    (s) =>
      s.name.toLowerCase().includes(lower) ||
      s.id.toLowerCase().includes(lower) ||
      s.description.toLowerCase().includes(lower),
  )
}

export function formatPrice(service: MarketplaceService): string {
  if (service.minPriceUsdc === null) return '—'
  if (service.minPriceUsdc < 0.001) return `$${service.minPriceUsdc.toFixed(6)}`
  if (service.minPriceUsdc < 0.01) return `$${service.minPriceUsdc.toFixed(4)}`
  return `$${service.minPriceUsdc.toFixed(2)}`
}

// ---------------------------------------------------------------------------
// Skills config persistence
// ---------------------------------------------------------------------------

export function loadSkillsConfig(): SkillsConfig {
  if (!existsSync(SKILLS_CONFIG_FILE)) {
    return { version: 1, selectedServices: [] }
  }
  try {
    return JSON.parse(readFileSync(SKILLS_CONFIG_FILE, 'utf-8')) as SkillsConfig
  } catch {
    return { version: 1, selectedServices: [] }
  }
}

export function saveSkillsConfig(config: SkillsConfig): void {
  mkdirSync(X402_HOME, { recursive: true })
  writeFileSync(SKILLS_CONFIG_FILE, JSON.stringify(config, null, 2))
}

export function addSelectedService(service: MarketplaceService): void {
  const config = loadSkillsConfig()
  // Don't add duplicates
  if (config.selectedServices.some((s) => s.id === service.id)) return
  config.selectedServices.push({
    id: service.id,
    name: service.name,
    category: service.category,
    endpoints: service.endpoints,
    addedAt: new Date().toISOString(),
  })
  saveSkillsConfig(config)
}

export function removeSelectedService(serviceId: string): void {
  const config = loadSkillsConfig()
  config.selectedServices = config.selectedServices.filter((s) => s.id !== serviceId)
  saveSkillsConfig(config)
}

export function getSelectedServiceIds(): Set<string> {
  const config = loadSkillsConfig()
  return new Set(config.selectedServices.map((s) => s.id))
}
