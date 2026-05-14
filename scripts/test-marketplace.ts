import { fetchCatalog, groupByCategory, searchServices, formatPrice, CATEGORIES } from '../src/lib/marketplace.js'

async function main() {
  console.log('Fetching marketplace catalog...')
  const catalog = await fetchCatalog(true)
  console.log(`Loaded ${catalog.length} services\n`)

  const grouped = groupByCategory(catalog)
  for (const cat of CATEGORIES) {
    const services = grouped.get(cat.id)
    if (services) {
      console.log(`${cat.emoji}  ${cat.label}: ${services.length} services`)
      for (const s of services.slice(0, 3)) {
        console.log(`   - ${s.name} (${formatPrice(s)}) ${s.description.slice(0, 50)}`)
      }
      if (services.length > 3) console.log(`   ... and ${services.length - 3} more`)
    }
  }

  console.log('\nSearch test: "exa"')
  const results = searchServices(catalog, 'exa')
  for (const s of results) {
    console.log(`  ${s.name} (${s.id}) - ${formatPrice(s)}`)
  }
}
main().catch(console.error)
