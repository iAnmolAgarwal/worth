import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowLeft,
  Bookmark,
  CalendarClock,
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
import type { InstalmentPlanProposal, Product, SavedItem } from '../shared/types'
import { Activity } from './Activity'
import { AgentLauncher, nudgeLine, type AskOffer } from './AgentLauncher'
import { api } from './api'
import { Ask } from './Ask'
import { Check, handoffToken, reloadForNewToken } from './Check'
import { Checkout } from './Checkout'
import type { AppState, Purchase, SavePlan, SaveTarget } from './contract'
import { alternativeTarget, decisionRequestFrom, saveRequest } from './contract'
import { Decision, type DecisionRequest, type Explanation } from './Decision'
import { envLabel } from './engine'
import { dayLabel, fullDate, money, sampleDate } from './format'
import type { GuideExpression } from './Guide'
import { Home, HomeSkeleton } from './Home'
import { ImportDialog } from './Import'
import { ImportReview, type ChosenFile } from './Onboarding'
import { ConnectProgress, returnToCheck } from './ConnectPayPal'
import { PlanPage, PlanWizard } from './Plan'
import { ConfirmPlanDialog, RefundDialog } from './Reviews'
import { migratePlanned, Saved, Settings } from './Saved'
import { ASSESSMENT_ONLY, paypalModeLine, pinnedSample, replayToast, SAMPLE_WHO } from './copy'
import { usePayPalSdk } from './paypal'
import { Alert, Button, IconButton, Wordmark } from './ui'

type Screen =
  | 'home'
  | 'activity'
  | 'plan'
  | 'plan-edit'
  | 'saved'
  | 'settings'
  | 'decision'
  | 'check'
  | 'import'
const LEGACY: Record<string, Screen> = {
  overview: 'home',
  recurring: 'plan',
  wishlist: 'saved',
}
/** `ask` is not a screen: it opens the Ask Worth panel over the current one. */
const NAV: {
  screen: Screen | 'ask'
  label: string
  tabLabel?: string
  icon: LucideIcon
  tab: boolean
}[] = [
  { screen: 'home', label: 'Home', icon: House, tab: true },
  { screen: 'ask', label: 'Ask Worth', tabLabel: 'Ask', icon: Sparkles, tab: true },
  { screen: 'activity', label: 'Activity', icon: ReceiptText, tab: true },
  { screen: 'plan', label: 'Plan', icon: SlidersHorizontal, tab: true },
  { screen: 'saved', label: 'Saved', icon: Bookmark, tab: true },
]
const DETAIL: Screen[] = ['decision', 'plan-edit', 'settings', 'check', 'import']

/** `#ask` and the old `#assistant` open the Ask Worth panel; they are no longer screens. */
const isAskRoute = () => /^#(?:ask|assistant)(?:\?|$)/.test(window.location.hash)

function parseRoute(): { screen: Screen; params: URLSearchParams } {
  const [path = '', query = ''] = window.location.hash.slice(1).split('?')
  // A store's hand-off lands on /check (specs/handoff-contract.md); hash routes still work there.
  if (window.location.pathname === '/check' && (path === '' || path.startsWith('q=')))
    return { screen: 'check', params: new URLSearchParams() }
  const screen: Screen =
    path === 'plan/edit'
      ? 'plan-edit'
      : (LEGACY[path] ??
        ((
          ['home', 'activity', 'plan', 'saved', 'settings', 'decision', 'import'] as string[]
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
  // Read first, so the store's token leaves the address bar before anything else runs.
  const [checkToken] = useState(handoffToken)
  const [state, setState] = useState<AppState>()
  const [error, setError] = useState('')
  const [route, setRoute] = useState(parseRoute)
  /** The Ask Worth panel; a first load on `#ask` opens it over Home. */
  const [panelOpen, setPanelOpen] = useState(isAskRoute)
  const [mood, setMood] = useState<GuideExpression>('neutral')
  /** The item Decision or /check offers the panel while it is on screen. */
  const [offer, setOffer] = useState<AskOffer>()
  const launcher = useRef<HTMLButtonElement>(null)
  /** The address of the screen behind the panel, restored when `#ask` opens it. */
  const behind = useRef(isAskRoute() ? '' : window.location.hash)
  const [menu, setMenu] = useState(false)
  /** The data chip's details: whose data this is, assistant state and PayPal mode. */
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
  /** The PayPal export chosen on Home's first-run card, reviewed at #import (P3a). Memory only. */
  const [chosenFile, setChosenFile] = useState<ChosenFile>()
  const [prompt, setPrompt] = useState<{ text: string; id: number }>()
  const [epoch, setEpoch] = useState(0)
  const [explanations, setExplanations] = useState<Record<string, Explanation>>({})
  /** The pasted-link item this tab last confirmed at Channel3's price (C5). */
  const [confirmedLink, setConfirmedLink] = useState<DecisionRequest>()
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
  /**
   * The state request in flight. Overlapping loads share it: on a first visit, two parallel
   * requests (React's development double mount, or a focus refresh) would each start a session,
   * and the cookie could end up on a different session than the state shown, so the first
   * question was refused as a session change and the conversation cleared.
   */
  const loading = useRef<Promise<AppState> | undefined>(undefined)
  const load = useCallback(async () => {
    const started = revision.current
    try {
      loading.current ??= (api<AppState>('/state') as Promise<AppState>).finally(() => {
        loading.current = undefined
      })
      const next = await loading.current
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
      if (reloadForNewToken()) return
      // An old `#ask` link opens the panel over the screen already showing.
      if (isAskRoute()) {
        history.replaceState(
          null,
          '',
          window.location.pathname + window.location.search + behind.current,
        )
        setPanelOpen(true)
        return
      }
      behind.current = window.location.hash
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
  // Once per load: move the browser's old wait dates to the server (G5-6), and pin a sample day
  // when a link asks for one (?replay=demo, demo-dec15 or video).
  useEffect(() => {
    if (!state) return
    void migratePlanned(replaceState)
    const params = new URLSearchParams(window.location.search)
    const preset = params.get('replay')
    if (preset === 'video' || preset === 'demo' || preset === 'demo-dec15') {
      params.delete('replay')
      const query = params.toString()
      history.replaceState(
        null,
        '',
        window.location.pathname + (query ? `?${query}` : '') + window.location.hash,
      )
      void startReplay(preset)
    }
    // Runs once, when the first state arrives.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [Boolean(state)])
  // A store told Worth about a payment after its own PayPal checkout (C4): say so once, naming
  // every new report, then clear exactly those. This tab never repeats one while that is on its way.
  const noticed = useRef(new Set<string>())
  useEffect(() => {
    const fresh = (state?.purchases ?? []).filter(
      (p) => p.reportNotice && p.reportedBy && !noticed.current.has(p.id),
    )
    if (!fresh.length) return
    for (const purchase of fresh) noticed.current.add(purchase.id)
    const stores = new Set(fresh.map((p) => p.reportedBy))
    const who = stores.size === 1 ? fresh[0]!.reportedBy : `${stores.size} stores`
    // oxlint-disable-next-line react/set-state-in-effect
    setToast(
      fresh.length === 1
        ? `${who} told Worth about your ${money(fresh[0]!.amountCents)} payment.`
        : `${who} told Worth about ${fresh.length} payments. They’re in your Activity.`,
    )
    // The server takes at most 20 per call, so every report this notice named is cleared in batches.
    for (let start = 0; start < fresh.length; start += 20)
      void api('/handoff/notices/seen', {
        purchaseIds: fresh.slice(start, start + 20).map((p) => p.id),
      }).catch(() => {})
  }, [state])
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
  // A first load on `#ask` drops it from the address bar; Home shows behind the panel.
  useEffect(() => {
    if (isAskRoute())
      history.replaceState(null, '', window.location.pathname + window.location.search)
  }, [])
  /** Opens the Ask Worth panel over the current screen, asking `text` when given. */
  const ask = useCallback((text?: string) => {
    if (text) setPrompt({ text, id: Date.now() })
    setPanelOpen(true)
  }, [])
  const openDecision = useCallback(
    (request: DecisionRequest, explanation?: Explanation, from = 'ask') => {
      const params = new URLSearchParams()
      if (request.productId) params.set('product', request.productId)
      else {
        params.set('amount', String(request.amountCents))
        params.set('item', request.itemName ?? 'Your purchase')
        if (request.sourceUrl) params.set('link', request.sourceUrl)
        if (request.savedId) params.set('saved', request.savedId)
      }
      if (request.budgetCents !== undefined) params.set('budget', String(request.budgetCents))
      params.set('from', from)
      // Channel3's price counts as read only in this tab's memory, never from the URL (C5).
      setConfirmedLink(request.priceSource === 'channel3' ? request : undefined)
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
  /** Saves any assessed item, with the plan's option and date (C-17, A3). */
  async function saveItem(target: SaveTarget, plan: SavePlan = {}) {
    try {
      const result = await api<{ item: SavedItem; state: AppState }>(
        '/saved',
        saveRequest(target, plan),
      )
      replaceState(result.state)
      const custom = target.kind === 'custom' ? ` ${ASSESSMENT_ONLY}.` : ''
      setToast(
        plan.waitDate
          ? `Saved for ${dayLabel(plan.waitDate)}. Worth checks it again when you come back.${custom}`
          : `${result.item.name} is in Saved.${custom}`,
      )
      return result.item
    } catch (failure) {
      setToast((failure as Error).message)
      return undefined
    }
  }
  /** A ?replay= link: pins the sample persona to that preset's day (G5-3). */
  async function startReplay(preset: 'video' | 'demo' | 'demo-dec15') {
    try {
      const next = (await api<AppState>('/demo-clock', { preset })) as AppState
      clearConversation()
      replaceState(next)
      setEnvOpen(false)
      setToast(replayToast(next))
      navigate('home')
    } catch (failure) {
      setToast((failure as Error).message)
    }
  }
  async function endReplay() {
    try {
      const next = (await api<AppState>('/demo-clock', { preset: 'today' })) as AppState
      clearConversation()
      replaceState(next)
      setToast(
        next.demoClock
          ? `${next.profile.name}’s sample is back on ${sampleDate(next.today)}.`
          : `${next.profile.name}’s sample plan is back on today’s date.`,
      )
    } catch (failure) {
      setToast((failure as Error).message)
    }
  }

  const { screen, params } = route
  const decisionRequest = useMemo<DecisionRequest | undefined>(() => {
    if (screen !== 'decision') return undefined
    return decisionRequestFrom(params, confirmedLink)
  }, [screen, params, confirmedLink])

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
      ? params.get('from') === 'saved'
        ? 'saved'
        : 'home'
      : screen === 'plan-edit'
        ? 'plan'
        : screen
  const demo = state.profile.source === 'demo'
  // One label at every width: it names whose month this is (third-party feedback F1).
  const sample = demo ? `Sample: ${state.profile.name}` : 'Your data'
  const env = envLabel(state)
  const decisionProduct = decisionRequest?.productId
    ? state.products.find((p) => p.id === decisionRequest.productId)
    : undefined
  // Decisions opened from the panel, or from an old `from=ask` link, go back to Home.
  const backTo: Screen =
    screen === 'decision'
      ? params.get('from') === 'saved'
        ? 'saved'
        : 'home'
      : screen === 'plan-edit'
        ? 'plan'
        : 'home'
  const backLabel = `Back to ${NAV.find((n) => n.screen === backTo)?.label ?? 'Home'}`
  const mobileTitle =
    screen === 'decision'
      ? (decisionProduct?.name ?? decisionRequest?.itemName ?? 'Your options')
      : screen === 'plan-edit'
        ? 'Edit your plan'
        : screen === 'check'
          ? 'Analyse with Worth'
          : screen === 'import'
            ? 'Check what Worth found'
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
            {NAV.map((item) =>
              item.screen === 'ask' ? (
                <button
                  key="ask"
                  type="button"
                  className="nav-ask"
                  aria-expanded={panelOpen}
                  onClick={() => setPanelOpen(!panelOpen)}
                >
                  {item.label}
                </button>
              ) : (
                <a
                  key={item.screen}
                  href={`#${item.screen}`}
                  aria-current={current === item.screen ? 'page' : undefined}
                >
                  {item.label}
                </a>
              ),
            )}
          </nav>
          <div className="right">
            <span
              className="env-wrap"
              onBlur={(event) => {
                // Focus leaving the chip and its details, by Tab or otherwise, closes them.
                if (!event.currentTarget.contains(event.relatedTarget as Node)) setEnvOpen(false)
              }}
            >
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
              >
                {sample}
              </button>
              {envOpen && (
                <span className="env-pop" id="env-details">
                  <span className="env-about">
                    {demo
                      ? `This is ${SAMPLE_WHO}. No real money moves, and ${paypalModeLine(state.config.paypal)}.`
                      : `This is the PayPal activity you imported. ${paypalModeLine(state.config.paypal)}.`}
                  </span>
                  {/* The sentence above already says it is sample data. */}
                  {env
                    .split(' · ')
                    .filter((part) => !(demo && part === 'Sample data'))
                    .map((part) => (
                      <span key={part}>{part}</span>
                    ))}
                  {demo && (
                    <button
                      type="button"
                      className="link"
                      onClick={() => {
                        setEnvOpen(false)
                        setImporting(true)
                      }}
                    >
                      Use your own PayPal activity
                    </button>
                  )}
                  <a href="#settings" onClick={() => setEnvOpen(false)}>
                    About this demo
                  </a>
                </span>
              )}
            </span>
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
                {NAV.map((item) =>
                  item.screen === 'ask' ? (
                    <button
                      key="ask"
                      type="button"
                      role="menuitem"
                      className="show-t"
                      onClick={() => {
                        setMenu(false)
                        setPanelOpen(true)
                      }}
                    >
                      <item.icon className="ico" aria-hidden="true" />
                      {item.label}
                    </button>
                  ) : (
                    <a
                      key={item.screen}
                      role="menuitem"
                      className={item.tab ? 'show-t' : undefined}
                      href={`#${item.screen}`}
                    >
                      <item.icon className="ico" aria-hidden="true" />
                      {item.label}
                    </a>
                  ),
                )}
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
        {state.demoClock && pinnedSample(state) && (
          <div className="wrap" style={{ paddingBottom: 0 }}>
            <Alert tone="info" icon={CalendarClock}>
              <b>{state.profile.name}’s sample month</b>, as of {sampleDate(state.today)} (not
              today’s date).
              {state.profile.userEdited && (
                <>
                  {' '}
                  <button
                    type="button"
                    className="link inline"
                    onClick={() => void startReplay(state.demoClock!.preset!)}
                  >
                    Start the sample again
                  </button>
                </>
              )}
            </Alert>
          </div>
        )}
        {state.demoClock && !pinnedSample(state) && (
          <div className="wrap" style={{ paddingBottom: 0 }}>
            <Alert tone="info" icon={CalendarClock}>
              <b>Demo clock:</b> {state.profile.name}’s sample plan is set to{' '}
              {fullDate(state.today)}
              {state.demoClock.preset === 'video' ? ', the day the video was recorded' : ''}. Your
              own data never uses it.{' '}
              <button type="button" className="link inline" onClick={() => void endReplay()}>
                {state.config.sample === 'alex' ? 'Back to the sample day' : 'Back to today'}
              </button>
            </Alert>
          </div>
        )}
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
            onOpenSaved={(item) =>
              openDecision(
                { amountCents: item.amountCents, itemName: item.name.slice(0, 150) },
                undefined,
                'home',
              )
            }
            onEditPlan={() => navigate('plan/edit')}
            onImport={() => setImporting(true)}
            onImportFile={(file) => {
              setChosenFile(file)
              navigate('import')
            }}
            onOpenCheckout={openCheckout}
            onConfirmPlan={(purchaseId) => setReview({ kind: 'plan', purchaseId })}
            onReviewRefund={(purchaseId, refundId) =>
              setReview({ kind: 'refund', purchaseId, refundId })
            }
            onUpdate={replaceState}
          />
        )}
        {screen === 'import' && route.params.get('connect') && !chosenFile && (
          <ConnectProgress
            result={route.params.get('connect')!}
            onFile={setChosenFile}
            onUseCsv={() => setRoute({ screen: 'import', params: new URLSearchParams() })}
          />
        )}
        {screen === 'import' && !(route.params.get('connect') && !chosenFile) && (
          <ImportReview
            state={state}
            file={chosenFile}
            onFile={setChosenFile}
            onEnterYourself={() => navigate('plan/edit')}
            onCancel={() => {
              setChosenFile(undefined)
              navigate('home')
            }}
            onImported={(next) => {
              clearConversation()
              replaceState(next)
            }}
            onDone={(next) => {
              clearConversation()
              replaceState(next)
              setChosenFile(undefined)
              // Connect PayPal began on /check: back to the store's item for its verdict.
              if (chosenFile?.connected && returnToCheck()) return window.location.assign('/check')
              setToast('Your month from PayPal is ready.')
              navigate('home')
            }}
          />
        )}
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
              onSave={(target, plan) => void saveItem(target, plan)}
              onSaveAlternative={(item) => void saveItem(alternativeTarget(item))}
              onEditPlan={() => navigate('plan/edit')}
              onViewActivity={() => navigate('activity')}
              onOffer={setOffer}
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
        {screen === 'check' && (
          <Check
            state={state}
            token={checkToken}
            instance={sdk.instance}
            onUpdate={replaceState}
            onToast={setToast}
            onOpenDecision={(request) => openDecision(request, undefined, 'home')}
            onNavigate={navigate}
            onOffer={setOffer}
          />
        )}
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
            checkId={params.get('check') ?? undefined}
            onOpenDecision={(request) => openDecision(request, undefined, 'saved')}
            onUpdate={replaceState}
            onToast={setToast}
            onOpenCheckout={openCheckout}
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
            onToast={setToast}
          />
        )}
      </main>
      <nav className="tabbar" aria-label="Tab bar">
        {NAV.filter((item) => item.tab).map((item) =>
          item.screen === 'ask' ? (
            <button
              key="ask"
              type="button"
              aria-expanded={panelOpen}
              onClick={() => setPanelOpen(!panelOpen)}
            >
              <item.icon className="ico" strokeWidth={2} aria-hidden="true" />
              {item.tabLabel ?? item.label}
            </button>
          ) : (
            <a
              key={item.screen}
              href={`#${item.screen}`}
              aria-current={current === item.screen ? 'page' : undefined}
            >
              <item.icon className="ico" strokeWidth={2} aria-hidden="true" />
              {item.tabLabel ?? item.label}
            </a>
          ),
        )}
      </nav>
      <AgentLauncher
        open={panelOpen}
        onOpenChange={setPanelOpen}
        mood={mood}
        launcher={launcher}
        nudge={nudgeLine(state)}
        // Wizards and dialogs own the screen; the conversation stays mounted underneath.
        hidden={
          screen === 'import' || screen === 'plan-edit' || Boolean(checkout || review || importing)
        }
        lifted={detail}
      >
        <Ask
          key={epoch}
          layout="panel"
          state={state}
          initialPrompt={prompt}
          visible={panelOpen}
          offer={screen === 'decision' || screen === 'check' ? offer : undefined}
          onMood={setMood}
          onUpdate={replaceState}
          onSessionChange={() => void load()}
          onOpenDecision={(request, explanation) => {
            setPanelOpen(false)
            openDecision(request, explanation, screen === 'saved' ? 'saved' : 'home')
          }}
          onSave={saveItem}
          onOpenCheckout={(purchaseId) => {
            const purchase = state.purchases.find((p) => p.id === purchaseId)
            if (purchase) openCheckout(purchase)
            else void load()
          }}
          onNavigate={(hash) => {
            setPanelOpen(false)
            navigate(hash)
          }}
        />
      </AgentLauncher>
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
