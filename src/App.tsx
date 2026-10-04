import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowLeft,
  Bookmark,
  CircleAlert,
  FileUp,
  House,
  ReceiptText,
  Settings as SettingsIcon,
  SlidersHorizontal,
  Sparkles,
  User,
  X,
  type LucideIcon,
} from 'lucide-react'
import type { InstalmentPlanProposal, Product } from '../shared/types'
import { Activity } from './Activity'
import { api } from './api'
import { Ask } from './Ask'
import { Checkout } from './Checkout'
import type { AppState, Purchase } from './contract'
import { Decision, type DecisionRequest, type Explanation } from './Decision'
import { envLabel } from './engine'
import { dayLabel } from './format'
import { Home, HomeSkeleton } from './Home'
import { ImportDialog } from './Import'
import { PlanPage, PlanWizard } from './Plan'
import { ConfirmPlanDialog, RefundDialog } from './Reviews'
import { readPlanned, Saved, Settings, writePlanned } from './Saved'
import { usePayPalSdk } from './paypal'
import { Alert, Button, IconButton, Wordmark } from './ui'

type Screen = 'home' | 'ask' | 'activity' | 'plan' | 'plan-edit' | 'saved' | 'settings' | 'decision'
const LEGACY: Record<string, Screen> = {
  overview: 'home',
  assistant: 'ask',
  recurring: 'plan',
  wishlist: 'saved',
}
const NAV: { screen: Screen; label: string; tabLabel?: string; icon: LucideIcon; tab: boolean }[] =
  [
    { screen: 'home', label: 'Home', icon: House, tab: true },
    { screen: 'ask', label: 'Ask Worth', tabLabel: 'Ask', icon: Sparkles, tab: true },
    { screen: 'activity', label: 'Activity', icon: ReceiptText, tab: true },
    { screen: 'plan', label: 'Plan', icon: SlidersHorizontal, tab: true },
    { screen: 'saved', label: 'Saved', icon: Bookmark, tab: false },
  ]
const DETAIL: Screen[] = ['decision', 'plan-edit', 'settings']

function parseRoute(): { screen: Screen; params: URLSearchParams } {
  const [path = '', query = ''] = window.location.hash.slice(1).split('?')
  const screen: Screen =
    path === 'plan/edit'
      ? 'plan-edit'
      : (LEGACY[path] ??
        ((
          ['home', 'ask', 'activity', 'plan', 'saved', 'settings', 'decision'] as string[]
        ).includes(path)
          ? (path as Screen)
          : 'home'))
  return { screen, params: new URLSearchParams(query) }
}

type CheckoutState = {
  productId: string
  purchaseId?: string
  approved?: boolean
  cancelled?: boolean
  acknowledge?: boolean
}
type ReviewState =
  { kind: 'plan'; purchaseId: string } | { kind: 'refund'; purchaseId: string; refundId: string }

export default function App() {
  const [state, setState] = useState<AppState>()
  const [error, setError] = useState('')
  const [route, setRoute] = useState(parseRoute)
  const [menu, setMenu] = useState(false)
  /** The "Sandbox demo" chip's details: data source, assistant state and PayPal mode. */
  const [envOpen, setEnvOpen] = useState(false)
  const envButton = useRef<HTMLButtonElement>(null)
  // Escape anywhere closes the chip's details and returns focus to it; so does a click outside.
  useEffect(() => {
    if (!envOpen) return
    const close = (event: Event) => {
      if (event instanceof KeyboardEvent) {
        if (event.key !== 'Escape') return
        setEnvOpen(false)
        envButton.current?.focus()
        return
      }
      if (!envButton.current?.parentElement?.contains(event.target as Node)) setEnvOpen(false)
    }
    document.addEventListener('keydown', close)
    document.addEventListener('mousedown', close)
    return () => {
      document.removeEventListener('keydown', close)
      document.removeEventListener('mousedown', close)
    }
  }, [envOpen])
  const [toast, setToast] = useState('')
  const [checkout, setCheckout] = useState<CheckoutState>()
  const [review, setReview] = useState<ReviewState>()
  const [importing, setImporting] = useState(false)
  /** Pay in 4 plans the last import detected, offered pre-filled in the wizard. */
  const [importedPlans, setImportedPlans] = useState<InstalmentPlanProposal[]>([])
  const [prompt, setPrompt] = useState<{ text: string; id: number }>()
  const [epoch, setEpoch] = useState(0)
  const [explanations, setExplanations] = useState<Record<string, Explanation>>({})
  const [returned] = useState(() => {
    const params = new URLSearchParams(window.location.search)
    const id = params.get('checkout')
    return id
      ? {
          id,
          approved: params.get('paypal') === 'approved',
          cancelled: params.get('paypal') === 'cancelled',
        }
      : undefined
  })
  const sessionKey = useRef<string | undefined>(undefined)
  const revision = useRef(0)
  const avatar = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const sdk = usePayPalSdk(
    state?.config.paypal === 'sandbox' ? state.config.paypalClientId : undefined,
  )

  const clearConversation = useCallback(() => {
    setEpoch((value) => value + 1)
    setPrompt(undefined)
    setExplanations({})
  }, [])
  const replaceState = useCallback(
    (next: AppState) => {
      revision.current += 1
      if (sessionKey.current && next.sessionKey && next.sessionKey !== sessionKey.current)
        clearConversation()
      sessionKey.current = next.sessionKey
      setState(next)
    },
    [clearConversation],
  )
  const load = useCallback(async () => {
    const started = revision.current
    try {
      const next = (await api<AppState>('/state')) as AppState
      // A slower refresh must not overwrite a completed edit or checkout.
      if (started !== revision.current) return
      replaceState(next)
      setError('')
    } catch (failure) {
      setError((failure as Error).message)
    }
  }, [replaceState])

  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect
    void load()
    const onHash = () => {
      setRoute(parseRoute())
      setMenu(false)
      setEnvOpen(false)
      // A dialog belongs to the screen it opened on; leaving the screen closes it.
      setCheckout(undefined)
      setReview(undefined)
      setImporting(false)
      window.scrollTo?.({ top: 0, behavior: 'instant' })
    }
    const refresh = () => {
      if (!document.hidden) void load()
    }
    window.addEventListener('hashchange', onHash)
    window.addEventListener('focus', refresh)
    window.addEventListener('online', refresh)
    document.addEventListener('visibilitychange', refresh)
    const timer = setInterval(refresh, 60_000)
    return () => {
      window.removeEventListener('hashchange', onHash)
      window.removeEventListener('focus', refresh)
      window.removeEventListener('online', refresh)
      document.removeEventListener('visibilitychange', refresh)
      clearInterval(timer)
    }
  }, [load])
  // Back from PayPal: reopen that checkout and strip ?checkout=…&paypal=… from the URL.
  useEffect(() => {
    if (!returned || !state) return
    history.replaceState(null, '', window.location.pathname + window.location.hash)
    const purchase = state.purchases.find((p) => p.id === returned.id)
    // oxlint-disable-next-line react/set-state-in-effect
    if (purchase)
      setCheckout({
        productId: purchase.productId,
        purchaseId: purchase.id,
        approved: returned.approved,
        cancelled: returned.cancelled,
      })
    else
      setToast('That checkout isn’t available in this session, so its status can’t be shown here.')
    // Runs once, when the first state arrives.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [Boolean(state)])
  useEffect(() => {
    if (!toast) return
    const timer = setTimeout(() => setToast(''), 6000)
    return () => clearTimeout(timer)
  }, [toast])
  useEffect(() => {
    if (!menu) return
    menuRef.current?.querySelector<HTMLElement>('a,button')?.focus()
    const close = (event: Event) => {
      if (event instanceof KeyboardEvent && event.key !== 'Escape') return
      if (event instanceof MouseEvent && menuRef.current?.contains(event.target as Node)) return
      if (event instanceof MouseEvent && avatar.current?.contains(event.target as Node)) return
      setMenu(false)
      avatar.current?.focus()
    }
    document.addEventListener('keydown', close)
    document.addEventListener('mousedown', close)
    return () => {
      document.removeEventListener('keydown', close)
      document.removeEventListener('mousedown', close)
    }
  }, [menu])

  const navigate = useCallback((hash: string) => {
    if (window.location.hash === `#${hash}`) setRoute(parseRoute())
    else window.location.hash = hash
    setMenu(false)
  }, [])
  const ask = useCallback(
    (text?: string) => {
      if (text) setPrompt({ text, id: Date.now() })
      navigate('ask')
    },
    [navigate],
  )
  const openDecision = useCallback(
    (request: DecisionRequest, explanation?: Explanation, from = 'ask') => {
      const params = new URLSearchParams()
      if (request.productId) params.set('product', request.productId)
      else {
        params.set('amount', String(request.amountCents))
        params.set('item', request.itemName ?? 'Your purchase')
      }
      params.set('from', from)
      if (explanation)
        setExplanations((all) => ({ ...all, [JSON.stringify(request)]: explanation }))
      navigate(`decision?${params}`)
    },
    [navigate],
  )
  const openProduct = (product: Product, from: string) =>
    openDecision({ productId: product.id }, undefined, from)
  const openCheckout = (purchase: Purchase) =>
    setCheckout({ productId: purchase.productId, purchaseId: purchase.id })
  async function saveForLater(product: Product, date?: string) {
    if (!state) return
    try {
      if (!state.wishlist.includes(product.id))
        replaceState((await api<AppState>('/wishlist', { productId: product.id })) as AppState)
      writePlanned(product.id, date)
      setToast(
        date
          ? `Saved for ${dayLabel(date)}. Check it again from Saved.`
          : `${product.name} is in Saved.`,
      )
    } catch (failure) {
      setToast((failure as Error).message)
    }
  }

  const { screen, params } = route
  const decisionRequest = useMemo<DecisionRequest | undefined>(() => {
    if (screen !== 'decision') return undefined
    const product = params.get('product')
    if (product) return { productId: product }
    const amount = Number(params.get('amount'))
    return Number.isSafeInteger(amount) && amount > 0
      ? { amountCents: amount, itemName: (params.get('item') ?? 'Your purchase').slice(0, 150) }
      : undefined
  }, [screen, params])

  if (!state)
    return (
      <div>
        <header className="topbar">
          <div className="in">
            <Wordmark />
          </div>
        </header>
        <main id="main">
          {error ? (
            <div className="page plain">
              <div className="wrap narrow">
                <div className="tile empty" role="alert">
                  <span className="co-icon bad" aria-hidden="true">
                    <CircleAlert className="ico" />
                  </span>
                  <h1 className="h-section">Worth couldn’t load your plan</h1>
                  <p className="meta">{error}</p>
                  <Button onClick={() => void load()}>Try again</Button>
                </div>
              </div>
            </div>
          ) : (
            <HomeSkeleton />
          )}
        </main>
      </div>
    )

  const detail = DETAIL.includes(screen)
  const current: Screen =
    screen === 'decision'
      ? ((params.get('from') as Screen) ?? 'ask')
      : screen === 'plan-edit'
        ? 'plan'
        : screen
  const sample = state.profile.source === 'demo' ? 'Sample data' : 'Your data'
  const env = envLabel(state)
  const decisionProduct = decisionRequest?.productId
    ? state.products.find((p) => p.id === decisionRequest.productId)
    : undefined
  const from = (params.get('from') ?? 'ask') as Screen
  const backTo: Screen =
    screen === 'decision'
      ? ['home', 'saved', 'ask'].includes(from)
        ? from
        : 'ask'
      : screen === 'plan-edit'
        ? 'plan'
        : 'home'
  const backLabel = `Back to ${NAV.find((n) => n.screen === backTo)?.label ?? 'Home'}`
  const mobileTitle =
    screen === 'decision'
      ? (decisionProduct?.name ?? decisionRequest?.itemName ?? 'Your options')
      : screen === 'plan-edit'
        ? 'Edit your plan'
        : 'Settings and privacy'
  const checkoutProduct = checkout && state.products.find((p) => p.id === checkout.productId)

  return (
    <div className={detail ? 'detail' : undefined}>
      <a
        className="skip"
        href="#main"
        onClick={(event) => {
          event.preventDefault()
          document.getElementById('main')?.focus()
        }}
      >
        Skip to content
      </a>
      <header className="topbar">
        <div className="in">
          <IconButton
            className="back"
            label={backLabel}
            icon={ArrowLeft}
            onClick={() => navigate(backTo)}
          />
          <p className="mtitle">{mobileTitle}</p>
          <Wordmark />
          <nav className="nav" aria-label="Main">
            {NAV.map((item) => (
              <a
                key={item.screen}
                href={`#${item.screen}`}
                aria-current={current === item.screen ? 'page' : undefined}
              >
                {item.label}
              </a>
            ))}
          </nav>
          <div className="right">
            <span className="env-wrap d">
              <button
                type="button"
                className="env env-btn"
                aria-expanded={envOpen}
                aria-controls="env-details"
                ref={envButton}
                onClick={() => setEnvOpen(!envOpen)}
                onKeyDown={(event) => {
                  if (event.key === 'Escape' && envOpen) {
                    event.stopPropagation()
                    setEnvOpen(false)
                  }
                }}
                onBlur={(event) => {
                  if (!event.currentTarget.parentElement?.contains(event.relatedTarget as Node))
                    setEnvOpen(false)
                }}
              >
                Sandbox demo
              </button>
              {envOpen && (
                <span className="env-pop" id="env-details" role="status">
                  {env.split(' · ').map((part) => (
                    <span key={part}>{part}</span>
                  ))}
                  <a href="#settings" onClick={() => setEnvOpen(false)}>
                    About this demo
                  </a>
                </span>
              )}
            </span>
            <span className="env show-m">{sample}</span>
            <a className="icon-btn hide-m" href="#settings" aria-label="Settings and privacy">
              <SettingsIcon className="ico" strokeWidth={1.75} aria-hidden="true" />
            </a>
            <button
              ref={avatar}
              type="button"
              className="avatar-btn"
              aria-label={`${state.profile.name} account menu`}
              aria-expanded={menu}
              aria-haspopup="true"
              onClick={() => setMenu(!menu)}
            >
              <span className="avatar" aria-hidden="true">
                {state.profile.name === 'Your plan' ? (
                  <User size={18} strokeWidth={2} />
                ) : (
                  state.profile.name.slice(0, 1).toUpperCase()
                )}
              </span>
            </button>
            {menu && (
              <div className="menu" ref={menuRef} role="menu" aria-label="Account">
                <div className="menu-head">
                  <div className="strong" style={{ fontWeight: 700 }}>
                    {state.profile.name}
                  </div>
                  <div className="caption">{env}</div>
                </div>
                {NAV.filter((item) => !item.tab || true).map((item) => (
                  <a
                    key={item.screen}
                    role="menuitem"
                    className={item.tab ? 'show-t' : undefined}
                    href={`#${item.screen}`}
                  >
                    <item.icon className="ico" aria-hidden="true" />
                    {item.label}
                  </a>
                ))}
                <a role="menuitem" href="#plan/edit">
                  <SlidersHorizontal className="ico" aria-hidden="true" />
                  Edit your plan
                </a>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMenu(false)
                    setImporting(true)
                  }}
                >
                  <FileUp className="ico" aria-hidden="true" />
                  Import PayPal activity
                </button>
                <a role="menuitem" href="#settings">
                  <SettingsIcon className="ico" aria-hidden="true" />
                  Settings and privacy
                </a>
              </div>
            )}
          </div>
        </div>
      </header>
      <main id="main" tabIndex={-1}>
        {error && (
          <div className="wrap" style={{ paddingBottom: 0 }}>
            <Alert tone="warn" icon={CircleAlert}>
              <b>Your plan couldn’t refresh.</b> {error} Showing what was last loaded.{' '}
              <button type="button" className="link" onClick={() => void load()}>
                Try again
              </button>
            </Alert>
          </div>
        )}
        {screen === 'home' && (
          <Home
            state={state}
            onAsk={ask}
            onNavigate={navigate}
            onOpenProduct={(product) => openProduct(product, 'home')}
            onEditPlan={() => navigate('plan/edit')}
            onOpenCheckout={openCheckout}
            onConfirmPlan={(purchaseId) => setReview({ kind: 'plan', purchaseId })}
            onReviewRefund={(purchaseId, refundId) =>
              setReview({ kind: 'refund', purchaseId, refundId })
            }
          />
        )}
        <div hidden={screen !== 'ask'}>
          <Ask
            key={epoch}
            state={state}
            initialPrompt={prompt}
            visible={screen === 'ask'}
            onUpdate={replaceState}
            onSessionChange={() => void load()}
            onOpenDecision={(request, explanation) => openDecision(request, explanation, 'ask')}
            onOpenCheckout={(purchaseId) => {
              const purchase = state.purchases.find((p) => p.id === purchaseId)
              if (purchase) openCheckout(purchase)
              else void load()
            }}
            onNavigate={navigate}
          />
        </div>
        {screen === 'decision' &&
          (decisionRequest ? (
            <Decision
              key={JSON.stringify(decisionRequest)}
              state={state}
              request={decisionRequest}
              explanation={explanations[JSON.stringify(decisionRequest)]}
              instance={sdk.instance}
              backLabel={backLabel}
              onBack={() => navigate(backTo)}
              onBuy={(product, acknowledge) => {
                const active = state.purchases.find(
                  (p) =>
                    p.productId === product.id &&
                    ['created', 'pending', 'unknown'].includes(p.status),
                )
                setCheckout({ productId: product.id, purchaseId: active?.id, acknowledge })
              }}
              onSave={(product, date) => void saveForLater(product, date)}
              onEditPlan={() => navigate('plan/edit')}
              onViewActivity={() => navigate('activity')}
            />
          ) : (
            <div className="page plain">
              <div className="wrap narrow">
                <Alert tone="warn" icon={CircleAlert}>
                  This comparison link is incomplete. <a href="#ask">Ask about a purchase</a>
                </Alert>
              </div>
            </div>
          ))}
        {screen === 'activity' && (
          <Activity
            state={state}
            onUpdate={replaceState}
            onAsk={() => ask()}
            onOpenCheckout={openCheckout}
            onConfirmPlan={(purchaseId) => setReview({ kind: 'plan', purchaseId })}
            onReviewRefund={(purchaseId, refundId) =>
              setReview({ kind: 'refund', purchaseId, refundId })
            }
            onImport={() => setImporting(true)}
          />
        )}
        {screen === 'plan' && (
          <PlanPage
            state={state}
            onEdit={(step) => navigate(`plan/edit?step=${step}`)}
            onImport={() => setImporting(true)}
          />
        )}
        {screen === 'plan-edit' && (
          <PlanWizard
            key={state.sessionKey}
            state={state}
            initialStep={Number(params.get('step') ?? 0)}
            suggestedPlans={importedPlans}
            onClose={() => navigate('plan')}
            onSaved={(next) => {
              replaceState(next)
              setToast('Your plan is up to date.')
              navigate('plan')
            }}
          />
        )}
        {screen === 'saved' && (
          <Saved
            state={state}
            onOpen={(product) => openProduct(product, 'saved')}
            onUpdate={replaceState}
            onToast={setToast}
            key={JSON.stringify(readPlanned())}
          />
        )}
        {screen === 'settings' && (
          <Settings
            state={state}
            onUpdate={replaceState}
            onReset={(next) => {
              clearConversation()
              replaceState(next)
              setToast('Your data was deleted. Worth is showing the sample profile again.')
              navigate('home')
            }}
            onEditPlan={(step) => navigate(`plan/edit?step=${step}`)}
            onImport={() => setImporting(true)}
          />
        )}
      </main>
      <nav className="tabbar" aria-label="Tab bar">
        {NAV.filter((item) => item.tab).map((item) => (
          <a
            key={item.screen}
            href={`#${item.screen}`}
            aria-current={current === item.screen ? 'page' : undefined}
          >
            <item.icon className="ico" strokeWidth={2} aria-hidden="true" />
            {item.tabLabel ?? item.label}
          </a>
        ))}
      </nav>
      {checkout && checkoutProduct && (
        <Checkout
          key={`${checkout.productId}-${checkout.purchaseId ?? 'new'}`}
          state={state}
          product={checkoutProduct}
          purchaseId={checkout.purchaseId}
          returnedApproved={checkout.approved}
          returnedCancelled={checkout.cancelled}
          acknowledge={checkout.acknowledge}
          instance={sdk.instance}
          sdkStatus={sdk.status}
          onClose={() => setCheckout(undefined)}
          onUpdate={replaceState}
          onViewActivity={() => {
            setCheckout(undefined)
            navigate('activity')
          }}
          onConfirmPlan={(purchaseId) => {
            setCheckout(undefined)
            setReview({ kind: 'plan', purchaseId })
          }}
          onEditPlan={() => {
            setCheckout(undefined)
            navigate('plan/edit')
          }}
        />
      )}
      {review?.kind === 'plan' && (
        <ConfirmPlanDialog
          state={state}
          purchaseId={review.purchaseId}
          onClose={() => setReview(undefined)}
          onUpdate={(next) => {
            replaceState(next)
            setToast('Your plan is up to date.')
          }}
        />
      )}
      {review?.kind === 'refund' && (
        <RefundDialog
          state={state}
          purchaseId={review.purchaseId}
          refundId={review.refundId}
          onClose={() => setReview(undefined)}
          onUpdate={replaceState}
        />
      )}
      {importing && (
        <ImportDialog
          state={state}
          onClose={() => setImporting(false)}
          onUpdate={(next) => {
            clearConversation()
            replaceState(next)
          }}
          onReview={(plans) => {
            setImportedPlans(plans)
            navigate('plan/edit')
          }}
        />
      )}
      {toast && (
        <div className="toast" role="status">
          {toast}
          <IconButton label="Dismiss" icon={X} onClick={() => setToast('')} />
        </div>
      )}
    </div>
  )
}
