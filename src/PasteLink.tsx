import { useEffect, useId, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { CircleAlert, ExternalLink, Link2 } from 'lucide-react'
import { checkProductLink, LINK_TITLE_MAX, productTitle, storeDomain } from '../shared/link'
import type { ProductLookup } from '../shared/types'
import { api, ApiError } from './api'
import type { DecisionRequest } from './Decision'
import { fromMoney, money } from './format'
import { Button, Field } from './ui'

/**
 * Paste-a-link (C5): Channel3 reads a store's product page and the shopper confirms the price
 * before anything is checked. The title is untrusted, so it is shown as plain text for the
 * shopper to keep or edit; only the confirmed name and price go on to the decision.
 */

type Read =
  | { step: 'reading' }
  | { step: 'confirm'; product: ProductLookup & { priceCents: number } }
  | { step: 'manual'; why: 'unread' | 'currency' | 'invalid' | 'limit'; product?: ProductLookup }

/** What the card says when it asks for the price itself. */
const MANUAL_HEADING = 'We couldn’t read that page. What’s the price?'
const MANUAL_NOTE: Record<Extract<Read, { step: 'manual' }>['why'], string> = {
  unread: 'Enter the item and its total price from the store page.',
  currency: '',
  invalid: 'Worth reads only https links to public store pages.',
  limit: 'Worth has read a lot of links lately. Enter the price from the store page.',
}

/** Reads a pasted link once: the confirm card when there is a USD price, the manual card otherwise. */
function useLinkRead(url: string): Read {
  const valid = checkProductLink(url).ok
  const [read, setRead] = useState<Read>(
    valid ? { step: 'reading' } : { step: 'manual', why: 'invalid' },
  )
  useEffect(() => {
    if (!valid) return
    let cancelled = false
    api<ProductLookup>('/lookup', { url })
      .then((product) => {
        if (cancelled) return
        if (product.priceCents && product.currency === 'USD')
          setRead({ step: 'confirm', product: { ...product, priceCents: product.priceCents } })
        else
          setRead({
            step: 'manual',
            why: product.priceCents ? 'currency' : 'unread',
            product,
          })
      })
      .catch((failure: unknown) => {
        if (cancelled) return
        const code = failure instanceof ApiError ? failure.code : undefined
        setRead({
          step: 'manual',
          why: code === 'INVALID_URL' ? 'invalid' : code === 'RATE_LIMITED' ? 'limit' : 'unread',
        })
      })
    return () => {
      cancelled = true
    }
  }, [url, valid])
  return read
}

export function LinkCheck({
  url,
  onConfirm,
  onCancel,
}: {
  url: string
  onConfirm: (request: DecisionRequest & { amountCents: number; itemName: string }) => void
  onCancel: () => void
}) {
  const read = useLinkRead(url)
  const heading = useRef<HTMLHeadingElement>(null)
  const titleId = useId()
  const link = checkProductLink(url)
  const store =
    read.step !== 'reading' && read.product
      ? read.product.merchantName
      : link.ok
        ? storeDomain(link.host)
        : undefined
  // Focus moves to the card once there is something to confirm, so keyboard users land on it.
  useEffect(() => {
    if (read.step !== 'reading') heading.current?.focus()
  }, [read.step])
  const escape = (event: KeyboardEvent) => {
    if (event.key !== 'Escape') return
    event.preventDefault()
    onCancel()
  }
  if (read.step === 'reading')
    return (
      <div className="tile link-check" role="status" style={{ width: '100%' }}>
        <div className="stack tight" aria-hidden="true">
          <span className="sk" style={{ width: '55%', height: 18 }} />
          <span className="sk" style={{ width: '35%' }} />
        </div>
        <p className="caption">Reading the product page with Channel3…</p>
      </div>
    )
  const product = read.product
  const title =
    read.step === 'confirm'
      ? `Is ${money(read.product.priceCents)} right?`
      : read.why === 'currency' && product?.currency
        ? `That page shows a price in ${product.currency}. What’s the price in US dollars?`
        : MANUAL_HEADING
  return (
    <section
      className="tile link-check"
      aria-labelledby={titleId}
      onKeyDown={escape}
      style={{ width: '100%' }}
    >
      <div className="co-head">
        <span
          className={`co-icon ${read.step === 'confirm' ? 'neutral' : 'wait'}`}
          aria-hidden="true"
        >
          {read.step === 'confirm' ? <Link2 className="ico" /> : <CircleAlert className="ico" />}
        </span>
        <div>
          <h2 className="h-section" id={titleId} ref={heading} tabIndex={-1}>
            {title}
          </h2>
          {read.step === 'manual' && MANUAL_NOTE[read.why] && (
            <p className="meta">{MANUAL_NOTE[read.why]}</p>
          )}
        </div>
      </div>
      {product && (
        <div className="product">
          {product.imageUrl && <img src={product.imageUrl} alt="" />}
          <div>
            {/* Plain text from the store page; React escapes it, and it is never sent to Claude. */}
            <div className="pt">{product.name}</div>
            <div className="meta">
              At {product.merchantName} · read by Channel3
              {product.status === 'fixture' ? ' · recorded example' : ''}
            </div>
          </div>
        </div>
      )}
      {!product && store && <p className="meta">At {store}</p>}
      <ConfirmForm
        key={read.step}
        name={product?.name ?? ''}
        priceCents={read.step === 'confirm' ? read.product.priceCents : undefined}
        submitLabel={read.step === 'confirm' ? 'Yes, check it' : 'Check it'}
        onCancel={onCancel}
        onSubmit={({ itemName, amountCents }) =>
          onConfirm({
            itemName,
            amountCents,
            ...(link.ok
              ? {
                  sourceUrl: link.url,
                  priceSource:
                    read.step === 'confirm' && amountCents === read.product.priceCents
                      ? 'channel3'
                      : 'user',
                }
              : {}),
          })
        }
      />
      {link.ok && (
        <a className="caption" href={link.url} target="_blank" rel="noopener noreferrer">
          Open the store page <ExternalLink size={14} aria-hidden="true" />
          <span className="sr"> (opens in a new tab)</span>
        </a>
      )}
    </section>
  )
}

function ConfirmForm({
  name,
  priceCents,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  name: string
  priceCents?: number
  submitLabel: string
  onSubmit: (next: { itemName: string; amountCents: number }) => void
  onCancel: () => void
}) {
  const [item, setItem] = useState(name)
  const [amount, setAmount] = useState(priceCents ? (priceCents / 100).toFixed(2) : '')
  const [error, setError] = useState<{ item?: string; amount?: string }>({})
  return (
    <form
      className="readas-edit"
      noValidate
      onSubmit={(event) => {
        event.preventDefault()
        const itemName = productTitle(item)
        const cents = fromMoney(amount)
        const next = {
          item: itemName ? undefined : 'Name the item you want to check.',
          amount:
            Number.isSafeInteger(cents) && cents > 0
              ? undefined
              : 'Enter the total price in US dollars.',
        }
        setError(next)
        if (next.item || next.amount) return
        onSubmit({ itemName: itemName!, amountCents: cents })
      }}
    >
      <Field label="Item" error={error.item}>
        <input
          className="input"
          value={item}
          maxLength={LINK_TITLE_MAX}
          aria-invalid={Boolean(error.item)}
          onChange={(e) => setItem(e.target.value)}
        />
      </Field>
      <Field
        label="Total price, USD"
        hint="Check it on the store page: size, tax and shipping can change it."
        error={error.amount}
      >
        <span className="money-input">
          <span aria-hidden="true">$</span>
          <input
            className="input num"
            inputMode="decimal"
            value={amount}
            aria-invalid={Boolean(error.amount)}
            onChange={(e) => setAmount(e.target.value)}
          />
        </span>
      </Field>
      <div className="actions">
        <Button type="submit">{submitLabel}</Button>
        <Button variant="text" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  )
}
