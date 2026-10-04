import { useEffect, useId, useRef, useState } from 'react'
import { ArrowLeft, ExternalLink, Store } from 'lucide-react'
import type { Alternative, Alternatives, SavedItem, UnverifiedAlternative } from '../shared/types'
import { api } from './api'
import type { AppState } from './contract'
import { cx, money } from './format'
import { Pill } from './ui'

/**
 * Which item to find similar ones for: a catalog product, a named item at its price, or a Channel3
 * product this server has already shown ("More like this").
 */
export type AlternativesRequest =
  | { productId: string }
  | { itemName: string; amountCents?: number; maxPriceCents?: number }
  | { similarTo: string }

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
/** One price check per saved item per page load; a failure counts as no news. */
const priceChecks = new Map<string, Promise<number | undefined>>()
/**
 * The lower price a saved Channel3 item has now, when it dropped since it was saved: one check per
 * item per page load, through the server's free product read. Anything else shows nothing.
 */
export function usePriceDrop(item: Pick<SavedItem, 'id' | 'channel3Id' | 'amountCents'>) {
  const [dropped, setDropped] = useState<number>()
  const { id, channel3Id, amountCents } = item
  useEffect(() => {
    if (!channel3Id) return
    let cancelled = false
    const key = `${id}|${channel3Id}|${amountCents}`
    let check = priceChecks.get(key)
    if (!check) {
      const query = new URLSearchParams({ id: channel3Id, savedPriceCents: String(amountCents) })
      check = api<PriceCheck>(`/alternatives/price?${query}`)
        .then((result) =>
          result.status === 'dropped' && result.current ? result.current.priceCents : undefined,
        )
        .catch(() => undefined)
      priceChecks.set(key, check)
    }
    void check.then((cents) => !cancelled && setDropped(cents))
    return () => {
      cancelled = true
    }
  }, [id, channel3Id, amountCents])
  return dropped
}
interface PriceCheck {
  status: 'dropped' | 'same' | 'higher' | 'unavailable'
  current?: { priceCents: number }
}
const stringValues = (request: AlternativesRequest) =>
  Object.fromEntries(
    Object.entries(request)
      .filter(([, value]) => value !== undefined)
      .map(([name, value]) => [name, String(value)]),
  )

/** Results worth showing: found live, or recorded examples, with at least one row. */
export const shownAlternatives = (result: Alternatives | undefined) =>
  result && result.status !== 'off' && (result.items.length || result.unverified?.length)
    ? result
    : undefined

/** A product photo, falling back to a store icon when the image is missing or fails to load. */
function Thumb({ src }: { src?: string }) {
  const [failed, setFailed] = useState(false)
  if (!src || failed)
    return (
      <span className="thumb alt-thumb" aria-hidden="true">
        <Store className="ico" />
      </span>
    )
  return (
    <img
      className="thumb alt-blur"
      src={src}
      alt=""
      width={48}
      height={48}
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
    />
  )
}

/**
 * The compact list of similar items. Each current row opens the retailer's page in a new tab;
 * Worth never sells these items or offers PayPal checkout for them. Example rows that could not be
 * re-checked are listed without a price or link.
 */
export function AlternativesList({
  result,
  title = 'Similar items that fit today',
  subtitle,
  headerAction,
  headingRef,
  onMoreLike,
  onSave,
}: {
  result: Alternatives
  title?: string
  subtitle?: string
  headerAction?: React.ReactNode
  headingRef?: React.Ref<HTMLHeadingElement>
  /** Shows "More like this" on each current row: similar products from Channel3. */
  onMoreLike?: (item: Alternative) => void
  /** Saves an item for later as a custom Saved item (wired by the Saved phase). */
  onSave?: (item: Alternative) => void
}) {
  const id = useId()
  const blur = captureMode()
  const example = result.status === 'fixture'
  const unverified: UnverifiedAlternative[] = result.unverified ?? []
  return (
    <section
      className={cx('tile alternatives', blur && 'capture')}
      aria-labelledby={id}
      data-testid="alternatives"
    >
      <div className="sec-head">
        <div>
          <h2 className="h-section" id={id} ref={headingRef} tabIndex={-1}>
            {title}
          </h2>
          <div className="meta">
            {subtitle ?? `Under ${money(result.maxPriceCents)} · from other stores`}
          </div>
        </div>
        {headerAction ?? (example && <Pill tone="info">Example results</Pill>)}
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
              <Thumb src={item.imageUrl} />
              <span className="body">
                <span className="t alt-blur">{item.title}</span>
                <span className="s">
                  <span className="soft alt-blur">{item.retailer}</span>
                </span>
              </span>
              <span className="amt num">{money(item.priceCents)}</span>
              <ExternalLink className="ico alt-out" aria-hidden="true" />
              <span className="sr">, opens in a new tab</span>
            </a>
            {(onMoreLike || onSave) && (
              <div className="alt-actions">
                {onMoreLike && (
                  <button
                    type="button"
                    className="link"
                    aria-label={`More like ${item.title}`}
                    onClick={() => onMoreLike(item)}
                  >
                    More like this
                  </button>
                )}
                {onSave && (
                  <button
                    type="button"
                    className="link"
                    aria-label={`Save ${item.title} for later`}
                    onClick={() => onSave(item)}
                  >
                    Save for later
                  </button>
                )}
              </div>
            )}
          </li>
        ))}
        {unverified.map((item) => (
          <li key={item.id} className="alt-item">
            <div className="row plain small">
              <Thumb src={item.imageUrl} />
              <span className="body">
                <span className="t alt-blur">{item.title}</span>
                <span className="s">
                  <span className="soft alt-blur">{item.retailer}</span>
                </span>
              </span>
              <span className="amt">
                <small>Price not checked</small>
              </span>
            </div>
          </li>
        ))}
      </ul>
      <p className="caption" style={{ marginTop: 'var(--s-3)' }}>
        From other stores · via Channel3 · prices may change
        {example ? ' · example results from an earlier search' : ''}
        {example && result.items.length ? ', prices checked just now' : ''}
      </p>
      {unverified.length > 0 && (
        <p className="caption">
          Channel3 couldn’t confirm some prices and links just now, so they aren’t shown.
        </p>
      )}
      <p className="caption">
        Worth doesn’t sell these items and can’t check them out. Worth shares only a generic kind of
        item and a price limit with Channel3.
      </p>
    </section>
  )
}

function Loading() {
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
}

/**
 * Similar items with "More like this": choosing a row asks Channel3 for products like it, under
 * the same limit, and "Back" returns to the first list. Used under Spend less and in Ask.
 */
export function SimilarItems({
  state,
  result,
  onSave,
}: {
  state: AppState
  result: Alternatives
  onSave?: (item: Alternative) => void
}) {
  const [focus, setFocus] = useState<Alternative>()
  const { data, loading } = useAlternatives(
    focus ? { similarTo: focus.id } : null,
    state.profile.version,
  )
  const heading = useRef<HTMLHeadingElement>(null)
  const moved = useRef(false)
  useEffect(() => {
    if (moved.current && !loading) heading.current?.focus({ preventScroll: true })
  }, [focus, loading])
  const pick = (item?: Alternative) => {
    moved.current = true
    setFocus(item)
  }
  if (!focus)
    return (
      <AlternativesList
        result={result}
        headingRef={heading}
        onMoreLike={(item) => pick(item)}
        onSave={onSave}
      />
    )
  if (loading) return <Loading />
  const back = (
    <button type="button" className="link" onClick={() => pick(undefined)}>
      <ArrowLeft size={16} aria-hidden="true" />
      Back
    </button>
  )
  const more = shownAlternatives(data)
  if (!more)
    return (
      <section className="tile alternatives" aria-labelledby="alt-more-none">
        <div className="sec-head">
          <h2 className="h-section" id="alt-more-none" ref={heading} tabIndex={-1}>
            More like this
          </h2>
          {back}
        </div>
        <p className="meta">
          Channel3 found nothing else like it under {money(result.maxPriceCents)} just now.
        </p>
      </section>
    )
  return (
    <AlternativesList
      result={more}
      title="More like this"
      subtitle={`Like the ${focus.title} · under ${money(more.maxPriceCents)}`}
      headerAction={back}
      headingRef={heading}
      onSave={onSave}
    />
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
  if (loading) return <Loading />
  const shown = shownAlternatives(data)
  return shown ? <SimilarItems state={state} result={shown} onSave={onSave} /> : null
}
