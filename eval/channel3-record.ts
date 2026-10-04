// Records Channel3's example results: one live search per catalog item, saved to
// server/fixtures/channel3.json. The app serves these, labelled "Example results", whenever
// Channel3 cannot answer, and the adapter tests parse them. Each run spends one credit per item.
//
//   npm run channel3:record -- --env <path/to/.env> [--items camera,chair]
//
// The key is read from the env file and never printed. Only the fields the parser reads are kept.
import { config } from 'dotenv'
import { readFileSync, writeFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { CATALOG_QUERIES } from '../server/alternatives.ts'
import {
  CHANNEL3_API,
  parseProducts,
  priceBucket,
  priceFloor,
  requestBody,
} from '../server/channel3.ts'
import type { Channel3Fixtures, FixtureSearch, RawSearch } from '../server/channel3.ts'

/** The price ceiling recorded per item: just under its price, or the persona's room for a camera. */
const CEILINGS: Record<string, number> = {
  camera: 42500,
  chair: 42500,
  headphones: 32500,
  backpack: 10000,
}

const { values } = parseArgs({
  options: { env: { type: 'string' }, items: { type: 'string' } },
})
if (values.env) config({ path: values.env, quiet: true })
const key = process.env.CHANNEL3_API_KEY
if (!key) throw new Error('CHANNEL3_API_KEY is not set.')
const path = new URL('../server/fixtures/channel3.json', import.meta.url)
let existing: Channel3Fixtures = { recordedAt: '', searches: [] }
try {
  existing = JSON.parse(readFileSync(path, 'utf8')) as Channel3Fixtures
} catch {
  /* First recording. */
}

function trim(raw: RawSearch): RawSearch {
  return {
    products: (raw.products ?? []).map((p) => ({
      id: p.id,
      title: p.title,
      brands: (p.brands ?? []).slice(0, 1).map((b) => ({ name: b.name })),
      images: (p.images ?? []).slice(0, 3).map((i) => ({
        url: i.url,
        cleaned_url: i.cleaned_url,
        is_main_image: i.is_main_image,
      })),
      offers: (p.offers ?? []).map((o) => ({
        url: o.url,
        domain: o.domain,
        price: o.price,
        availability: o.availability,
        condition: o.condition,
      })),
    })),
  }
}

const items = values.items ? values.items.split(',') : Object.keys(CATALOG_QUERIES)
const searches: FixtureSearch[] = existing.searches.filter(
  (s) => !(s.kind === 'search' && items.some((id) => CATALOG_QUERIES[id] === s.query)),
)
for (const id of items) {
  const query = CATALOG_QUERIES[id]
  if (!query) throw new Error(`Unknown catalog item ${id}`)
  const maxPriceCents = priceBucket(CEILINGS[id]!)
  const band = { minPriceCents: priceFloor(maxPriceCents), maxPriceCents }
  const response = await fetch(`${CHANNEL3_API}/v1/search`, {
    method: 'POST',
    headers: { 'x-api-key': key, 'content-type': 'application/json' },
    body: JSON.stringify(requestBody('search', query, band)),
    signal: AbortSignal.timeout(15_000),
  })
  if (!response.ok) throw new Error(`Channel3 answered ${response.status} for ${id}`)
  const raw = trim((await response.json()) as RawSearch)
  console.log(`${id}: ${parseProducts(raw, band).length} usable of ${raw.products?.length ?? 0}`)
  searches.push({ kind: 'search', query, ...band, response: raw })
}
const fixtures: Channel3Fixtures = { recordedAt: new Date().toISOString(), searches }
writeFileSync(path, JSON.stringify(fixtures, null, 1) + '\n')
console.log(`recorded ${searches.length} searches`)
