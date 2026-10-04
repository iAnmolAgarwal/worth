import { useEffect, useId, useState } from 'react'
import { Bookmark, ExternalLink, Store } from 'lucide-react'
import type { Alternative, Alternatives } from '../shared/types'
import { api } from './api'
import type { AppState } from './contract'
import { cx, money } from './format'
import { IconButton, Pill } from './ui'

/** Which item to find similar ones for: a catalog product, or a named item at its price. */
export type AlternativesRequest =
  { productId: string } | { itemName: string; amountCents?: number; maxPriceCents?: number }

/**
 * Presentation mode for screen capture (`?capture=1`, before or inside the hash): product images,
 * titles and store names are blurred, so third-party trademarks stay out of a recording.
 */
export function captureMode() {
  if (typeof window === 'undefined') return false
  const hashQuery = window.location.hash.split('?')[1] ?? ''
  return (
    new URLSearchParams(window.location.search).get('capture') === '1' ||
    new URLSearchParams(hashQuery).get('capture') === '1'
  )
}

/** Similar items for a request, fetched once per request and plan version. Hidden on failure. */
export function useAlternatives(request: AlternativesRequest | null, version: number) {
  const key = request ? new URLSearchParams(stringValues(request)).toString() : ''
  const [result, setResult] = useState<{ key: string; data?: Alternatives }>({ key: '' })
  useEffect(() => {
    if (!key) return
    let cancelled = false
    api<Alternatives>(`/alternatives?${key}`)
      .then((data) => !cancelled && setResult({ key: `${key}|${version}`, data }))
      // No error is ever shown: without results the panel simply stays hidden.
      .catch(() => !cancelled && setResult({ key: `${key}|${version}` }))
    return () => {
      cancelled = true
    }
  }, [key, version])
  const current = result.key === `${key}|${version}`
  return { data: current ? result.data : undefined, loading: Boolean(key) && !current }
}
const stringValues = (request: AlternativesRequest) =>
  Object.fromEntries(
    Object.entries(request)
      .filter(([, value]) => value !== undefined)
      .map(([name, value]) => [name, String(value)]),
  )

/** Results worth showing: found live or from the recorded examples. */
export const shownAlternatives = (result: Alternatives | undefined) =>
  result && result.status !== 'off' && result.items.length ? result : undefined

/**
 * The compact list of similar items. Each row opens the retailer's page in a new tab; Worth never
 * sells these items or offers PayPal checkout for them.
 */
export function AlternativesList({
  result,
  headingLevel = 2,
  onSave,
}: {
  result: Alternatives
  headingLevel?: 2 | 3
  /** Saves an item for later as a custom Saved item (wired by the Saved phase). */
  onSave?: (item: Alternative) => void
}) {
  const id = useId()
  const blur = captureMode()
  const Heading = headingLevel === 2 ? 'h2' : 'h3'
  const example = result.status === 'fixture'
  return (
    <section
      className={cx('tile alternatives', blur && 'capture')}
      aria-labelledby={id}
      data-testid="alternatives"
    >
      <div className="sec-head">
        <div>
          <Heading className="h-section" id={id}>
            Similar items that fit today
          </Heading>
          <div className="meta">Under {money(result.maxPriceCents)} · from other stores</div>
        </div>
        {example && <Pill tone="info">Example results</Pill>}
      </div>
      <ul className="rows alt-list">
        {result.items.map((item) => (
          <li key={item.id} className="alt-item">
            <a
              className="row plain small"
              href={item.url}
              target="_blank"
              rel="noopener noreferrer"
              referrerPolicy="no-referrer"
            >
              {item.imageUrl ? (
                <img
                  className="thumb alt-blur"
                  src={item.imageUrl}
                  alt=""
                  width={48}
                  height={48}
                  loading="lazy"
                  referrerPolicy="no-referrer"
                />
              ) : (
                <span className="thumb alt-thumb" aria-hidden="true">
                  <Store className="ico" />
                </span>
              )}
              <span className="body">
                <span className="t alt-blur">{item.title}</span>
                <span className="s">
                  <span className="soft alt-blur">{item.retailer}</span>
                </span>
              </span>
              <span className="amt num">{money(item.priceCents)}</span>
              <ExternalLink className="ico alt-out" aria-hidden="true" />
              <span className="sr">
                {' '}
                at {item.retailer}, {money(item.priceCents)}. Opens the store’s page in a new tab.
              </span>
            </a>
            {onSave && (
              <IconButton
                quiet
                icon={Bookmark}
                label={`Save ${item.title} for later`}
                onClick={() => onSave(item)}
              />
            )}
          </li>
        ))}
      </ul>
      <p className="caption" style={{ marginTop: 'var(--s-3)' }}>
        From other stores · via Channel3 · prices may change
        {example ? ' · example results recorded earlier, while Channel3 is unavailable' : ''}
      </p>
      <p className="caption">
        Worth doesn’t sell these items and can’t check them out. Worth shares only the kind of item
        and a price limit with Channel3.
      </p>
    </section>
  )
}

/**
 * "Similar items that fit today" under the Spend less option. It asks the server, which sets the
 * price limit from the plan; when Channel3 is off or finds nothing, nothing is shown.
 */
export function AlternativesPanel({
  state,
  request,
  onSave,
}: {
  state: AppState
  request: AlternativesRequest
  onSave?: (item: Alternative) => void
}) {
  const enabled = state.config.alternatives !== undefined && state.config.alternatives !== 'off'
  const { data, loading } = useAlternatives(enabled ? request : null, state.profile.version)
  if (!enabled) return null
  if (loading)
    return (
      <div className="tile" aria-hidden="true" data-testid="alternatives-loading">
        <div className="stack tight">
          <span className="sk" style={{ width: '45%', height: 18 }} />
          {[0, 1, 2].map((row) => (
            <span key={row} className="sk" style={{ width: `${80 - row * 12}%` }} />
          ))}
        </div>
      </div>
    )
  const shown = shownAlternatives(data)
  return shown ? <AlternativesList result={shown} onSave={onSave} /> : null
}
