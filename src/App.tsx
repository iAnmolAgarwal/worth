import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowDownLeft,
  ArrowRight,
  ArrowUpRight,
  CalendarDays,
  Check,
  ChevronRight,
  Heart,
  LayoutGrid,
  Leaf,
  Menu,
  Plus,
  Repeat2,
  Settings2,
  ShieldCheck,
  Sparkles,
  Wallet,
  X,
} from 'lucide-react'
import type { AppState, Product, ScheduledFlow } from '../shared/types'
import { assessPurchase, getUpcomingFlows } from '../shared/finance'
import { api } from './api'
import { cx, fullDate, money, shortDate } from './format'
import { ArrowLink, Button, Footnote, IconButton, Logo, SectionTitle, Tag } from './ui'
import { ForecastChart } from './ForecastChart'
import { Assistant } from './Assistant'
import { PlanDialog, ImportDialog } from './PlanDialogs'
import { PurchaseDialog } from './PurchaseDialog'
import { Activity } from './Activity'

type Page = 'overview' | 'assistant' | 'activity' | 'recurring' | 'wishlist'
const navigation = [
  { id: 'overview', label: 'Overview', icon: LayoutGrid },
  { id: 'assistant', label: 'Ask Worth', icon: Sparkles },
  { id: 'activity', label: 'Activity', icon: ArrowDownLeft },
  { id: 'recurring', label: 'Recurring', icon: Repeat2 },
  { id: 'wishlist', label: 'Wishlist', icon: Heart },
] as const
function getPage(): Page {
  const hash = window.location.hash.slice(1)
  return navigation.some((n) => n.id === hash) ? (hash as Page) : 'overview'
}

export default function App() {
  const [state, setState] = useState<AppState>()
  const sessionKey = useRef<string | undefined>(undefined)
  const stateRevision = useRef(0)
  const [error, setError] = useState('')
  const [page, setPage] = useState<Page>(getPage)
  const [menu, setMenu] = useState(false)
  const sidebar = useRef<HTMLElement>(null)
  const [dialog, setDialog] = useState<'plan' | 'import' | null>(null)
  const [product, setProduct] = useState<Product | null>(null)
  const [checkoutId, setCheckoutId] = useState<string | null>(
    new URLSearchParams(location.search).get('checkout'),
  )
  const [prompt, setPrompt] = useState<{ text: string; id: number }>()
  const [conversationEpoch, setConversationEpoch] = useState(0)
  const [toast, setToast] = useState('')
  function replaceState(next: AppState) {
    stateRevision.current += 1
    if (sessionKey.current && next.sessionKey && next.sessionKey !== sessionKey.current)
      clearConversation()
    sessionKey.current = next.sessionKey
    setState(next)
  }
  async function load() {
    const revision = stateRevision.current
    try {
      const next = await api<AppState>('/state')
      // A slower refresh must not overwrite a completed edit or checkout.
      if (revision !== stateRevision.current) return
      replaceState(next)
      setError('')
    } catch (e) {
      setError((e as Error).message)
    }
  }
  useEffect(() => {
    // Synchronize the initial state with the server; subsequent updates are async.
    // oxlint-disable-next-line react/set-state-in-effect
    void load()
    const onHash = () => {
      const next = window.location.hash.slice(1)
      if (navigation.some((item) => item.id === next)) setPage(next as Page)
    }
    const refresh = () => {
      if (!document.hidden) void load()
    }
    window.addEventListener('hashchange', onHash)
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', refresh)
    const timer = setInterval(refresh, 60000)
    return () => {
      window.removeEventListener('hashchange', onHash)
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', refresh)
      clearInterval(timer)
    }
  }, [])
  useEffect(() => {
    if (!toast) return
    const timer = setTimeout(() => setToast(''), 5000)
    return () => clearTimeout(timer)
  }, [toast])
  useEffect(() => {
    if (!menu) return
    const previous = document.activeElement as HTMLElement | null
    const controls = () =>
      Array.from(
        sidebar.current?.querySelectorAll<HTMLElement>('a[href],button:not(:disabled)') ?? [],
      )
    controls()[0]?.focus()
    const keys = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenu(false)
      if (event.key === 'Tab') {
        const items = controls(),
          first = items[0],
          last = items.at(-1)
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault()
          last?.focus()
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault()
          first?.focus()
        }
      }
    }
    document.addEventListener('keydown', keys)
    return () => {
      document.removeEventListener('keydown', keys)
      previous?.focus()
    }
  }, [menu])
  const baseline = useMemo(
    () =>
      state
        ? assessPurchase(state.profile, state.purchases, {
            amountCents: 0,
            today: state.today,
            findEarliest: false,
          })
        : null,
    [state],
  )
  function navigate(next: Page) {
    setPage(next)
    location.hash = next
    setMenu(false)
    window.scrollTo({ top: 0, behavior: 'instant' })
  }
  function ask(text: string) {
    setPrompt({ text, id: Date.now() })
    navigate('assistant')
  }
  function clearConversation() {
    setConversationEpoch((value) => value + 1)
    setPrompt(undefined)
  }
  async function save(id: string) {
    try {
      replaceState(await api<AppState>('/wishlist', { productId: id }))
    } catch (e) {
      setToast((e as Error).message)
    }
  }
  function closePurchase() {
    setProduct(null)
    setCheckoutId(null)
    if (location.search) history.replaceState(null, '', location.pathname + location.hash)
  }
  const active = state?.purchases.find((p) => ['created', 'pending', 'unknown'].includes(p.status))
  const returned = state?.purchases.find((p) => p.id === checkoutId)

  if (!state)
    return (
      <div className="boot-screen">
        <Logo />
        <div className="boot-orbit">
          <Leaf size={28} />
        </div>
        <h1>{error ? 'Let’s reconnect.' : 'Making room for what matters.'}</h1>
        <p>{error || 'Getting your financial picture ready…'}</p>
        {error && <Button onClick={load}>Try again</Button>}
      </div>
    )
  const upcoming = getUpcomingFlows(state.profile, state.today, 30)
  const expenses = upcoming.filter((e) => e.flow.kind !== 'income')
  const incoming = upcoming.filter((e) => e.flow.kind === 'income')
  const totalBills = expenses.reduce((s, e) => s + e.flow.amountCents, 0)
  const subscriptions = expenses.filter((e) => e.flow.kind === 'subscription')
  const navLabel = navigation.find((n) => n.id === page)!.label
  return (
    <div className="app-shell">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      {menu && (
        <button
          className="nav-scrim"
          aria-label="Close navigation"
          onClick={() => setMenu(false)}
        />
      )}
      <aside ref={sidebar} className={cx('sidebar', menu && 'open')} aria-label="Main sidebar">
        <a
          className="brand-link"
          href="#overview"
          aria-label="Worth overview"
          onClick={() => navigate('overview')}
        >
          <Logo />
        </a>
        <nav aria-label="Main navigation">
          {navigation.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => navigate(id)}
              className={cx('nav-item', page === id && 'active')}
              aria-current={page === id ? 'page' : undefined}
            >
              <Icon size={19} strokeWidth={1.7} />
              <span>{label}</span>
              {id === 'assistant' && <span className="nav-new">AI</span>}
              {id === 'wishlist' && <span className="nav-count">{state.wishlist.length}</span>}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <button
            className="nav-item"
            aria-label="Import PayPal activity"
            onClick={() => setDialog('import')}
          >
            <ArrowDownLeft size={18} />
            <span>Import activity</span>
          </button>
          <button className="nav-item" onClick={() => setDialog('plan')}>
            <Settings2 size={18} />
            <span>Your plan</span>
          </button>
          <div className="account">
            <span className="avatar">{state.profile.name.slice(0, 1).toUpperCase()}</span>
            <div>
              <strong>{state.profile.name}</strong>
              <small>
                {state.profile.source === 'demo' ? 'Demo profile' : 'Your personal plan'}
              </small>
            </div>
            <ShieldCheck size={16} />
          </div>
        </div>
      </aside>
      <div className="main-shell" inert={menu || undefined}>
        <header className="topbar">
          <div className="topbar-left">
            <IconButton
              label="Open navigation"
              className="mobile-menu"
              onClick={() => setMenu(true)}
            >
              <Menu size={21} />
            </IconButton>
            <span className="breadcrumb">
              Worth <ChevronRight size={13} />
              <strong>{navLabel}</strong>
            </span>
          </div>
          <div className="topbar-right">
            <span className="today-label">
              {shortDate(state.today, { weekday: 'short', year: 'numeric' })}
            </span>
            <Tag dot tone={state.profile.source === 'demo' ? 'amber' : 'green'}>
              {state.profile.source === 'demo' ? 'Demo data' : 'Imported history'}
            </Tag>
            <button
              className="profile-button"
              onClick={() => setDialog('plan')}
              aria-label="Edit your financial plan"
            >
              {state.profile.name.slice(0, 1).toUpperCase()}
            </button>
          </div>
        </header>
        <main id="main" className="main-content" tabIndex={-1}>
          {error && (
            <div className="notice notice-warning review-banner" role="alert">
              <div>
                <strong>Your plan couldn’t refresh.</strong>
                <span>{error} Showing your last loaded picture.</span>
              </div>
              <Button variant="secondary" onClick={load}>
                Try again
              </Button>
            </div>
          )}
          {checkoutId && !returned && (
            <div className="notice notice-warning review-banner">
              <div>
                <strong>This checkout isn’t available in this session.</strong>
                <span>
                  It may have expired or belong to another session. Its payment status cannot be
                  confirmed here.
                </span>
              </div>
              <Button variant="secondary" onClick={closePurchase}>
                Back to your plan
              </Button>
            </div>
          )}
          {!state.profile.confirmed && (
            <div className="notice notice-warning review-banner">
              <div>
                <strong>Your picture needs a few details.</strong>
                <span>
                  Confirm your available funds, income and bills before making a decision.
                </span>
              </div>
              <Button variant="secondary" onClick={() => setDialog('plan')}>
                Review your plan <ArrowRight size={15} />
              </Button>
            </div>
          )}
          {active && !product && !checkoutId && (
            <div className="notice review-banner">
              <div>
                <strong>There’s a checkout to finish.</strong>
                <span>
                  {active.name} · {money(active.amountCents, true)} remains allocated until it’s
                  resolved.
                </span>
              </div>
              <Button variant="secondary" onClick={() => setCheckoutId(active.id)}>
                Review checkout
              </Button>
            </div>
          )}
          {page === 'overview' && baseline && (
            <div className="page-enter">
              <div className="page-heading">
                <div>
                  <h1>
                    Make room for <span className="serif-accent">what matters.</span>
                  </h1>
                </div>
                <Button
                  variant="secondary"
                  className="heading-action"
                  onClick={() => setDialog('plan')}
                >
                  <Settings2 size={16} /> Your plan
                </Button>
              </div>
              <div className="hero-grid">
                <section className="ask-hero">
                  <div className="hero-grain" />
                  <span className="hero-label">
                    <span className="ai-spark">
                      <Sparkles size={16} />
                    </span>{' '}
                    ASK WORTH
                  </span>
                  <h2>Can I afford it?</h2>
                  <p>Your bills, spending and cushion. Already considered.</p>
                  <QuestionBox onAsk={ask} placeholder="Can I afford a $1,199 camera?" light />
                  <div className="hero-prompt-links">
                    <button onClick={() => ask('How much can I afford to spend today?')}>
                      What can I spend? <ArrowUpRight size={12} />
                    </button>
                    <button onClick={() => ask('What subscriptions are coming up?')}>
                      What’s coming up? <ArrowUpRight size={12} />
                    </button>
                  </div>
                  <span className="hero-loop" aria-hidden="true" />
                </section>
                <section className="possibility-card">
                  <div
                    className="possibility-photo"
                    style={{
                      backgroundImage: `url(${state.products[0]?.image})`,
                    }}
                  />
                  <div className="possibility-content">
                    <Tag>ON YOUR RADAR</Tag>
                    <h3>
                      A little less noise.
                      <br />A little more you.
                    </h3>
                    <button
                      className="round-link"
                      onClick={() => setProduct(state.products[0]!)}
                      aria-label="Check if studio headphones fit your plan"
                    >
                      <ArrowUpRight size={22} />
                    </button>
                    <span>
                      Studio headphones <b>{money(state.products[0]?.priceCents ?? 0)}</b>
                    </span>
                  </div>
                </section>
              </div>
              <div className="stat-grid">
                <Stat
                  label="Available funds"
                  value={money(state.profile.balanceCents)}
                  icon={<Wallet size={18} />}
                  note={
                    state.profile.confirmed
                      ? `Confirmed snapshot · ${shortDate(state.profile.snapshotDate)}`
                      : 'Confirm your current balance'
                  }
                  onClick={() => setDialog('plan')}
                />
                <Stat
                  label="Upcoming commitments"
                  value={money(totalBills, true)}
                  icon={<CalendarDays size={18} />}
                  note={`${expenses.length} bills & subscriptions · next 30 days`}
                  onClick={() => navigate('recurring')}
                />
                <Stat
                  label="Room for a purchase"
                  value={
                    baseline.outcome === 'incomplete'
                      ? 'Needs review'
                      : money(baseline.maxAffordableCents, true)
                  }
                  icon={<Leaf size={18} />}
                  note={
                    baseline.outcome === 'incomplete'
                      ? 'Complete your picture first'
                      : baseline.outcome === 'tight'
                        ? 'Your baseline already crosses the cushion'
                        : `Preserving your ${money(baseline.cushionCents)} cushion`
                  }
                  green={baseline.outcome === 'fits'}
                  onClick={() => ask('How much can I afford to spend today?')}
                />
              </div>
              <div className="insights-grid">
                <section className="panel cashflow-panel">
                  <SectionTitle title="Your next 30 days">
                    <Tag tone={baseline.outcome === 'fits' ? 'green' : 'amber'} dot>
                      {baseline.outcome === 'fits'
                        ? 'Cushion protected'
                        : baseline.outcome === 'incomplete'
                          ? 'Review needed'
                          : 'Cushion under pressure'}
                    </Tag>
                  </SectionTitle>
                  <div className="chart-summary">
                    <strong>{money(baseline.baselineLowestCents, true)}</strong>
                    <span>
                      projected low point <b>on {shortDate(baseline.lowestDate)}</b>
                    </span>
                    <span className="chart-key">
                      <i /> Your plan
                    </span>
                  </div>
                  <ForecastChart assessment={baseline} showPurchase={false} />
                  <div className="chart-footer">
                    <span>
                      <ShieldCheck size={14} />
                      {money(state.profile.cushionCents)} protected cushion
                    </span>
                    <ArrowLink onClick={() => setDialog('plan')}>Check assumptions</ArrowLink>
                  </div>
                </section>
                <section className="panel upcoming-panel">
                  <SectionTitle title="Coming up">
                    <ArrowLink onClick={() => navigate('recurring')}>View all</ArrowLink>
                  </SectionTitle>
                  <div className="flow-list">
                    {expenses.slice(0, 4).map(({ flow, date }) => (
                      <FlowRow key={`${flow.id}-${date}`} flow={flow} date={date} />
                    ))}
                  </div>
                  {!expenses.length && (
                    <p className="muted">
                      No bills recorded. Add anything paid outside PayPal too.
                    </p>
                  )}
                  <div className="payday-note">
                    <span className="payday-icon">
                      <ArrowDownLeft size={19} />
                    </span>
                    <div>
                      <strong>{incoming[0] ? 'Next income' : 'Add expected income'}</strong>
                      <p>
                        {incoming[0]
                          ? `${money(incoming[0].flow.amountCents)} expected ${shortDate(incoming[0].date)}`
                          : 'Add your next expected income.'}
                      </p>
                    </div>
                  </div>
                </section>
              </div>
              <section className="recent-section">
                <SectionTitle title="Recent activity">
                  <ArrowLink onClick={() => navigate('activity')}>All activity</ArrowLink>
                </SectionTitle>
                <div className="recent-grid">
                  {state.transactions.slice(0, 3).map((t) => (
                    <div className="recent-card" key={t.id}>
                      <MerchantMark name={t.name} color={t.color} />
                      <div>
                        <strong>{t.name}</strong>
                        <small>
                          {t.category} · {shortDate(t.date)}
                        </small>
                      </div>
                      <b>
                        {t.amountCents < 0 ? '−' : '+'}
                        {money(Math.abs(t.amountCents), true)}
                      </b>
                    </div>
                  ))}
                </div>
              </section>
            </div>
          )}
          <div hidden={page !== 'assistant'}>
            <Assistant
              key={conversationEpoch}
              state={state}
              initialPrompt={prompt}
              onPlan={() => setDialog('plan')}
              onProduct={setProduct}
              onSessionChange={() => void load()}
              onUpdate={replaceState}
              visible={page === 'assistant'}
            />
          </div>
          {page === 'activity' && (
            <Activity
              state={state}
              onUpdate={replaceState}
              onImport={() => setDialog('import')}
              onPlan={() => setDialog('plan')}
            />
          )}
          {page === 'recurring' && (
            <div className="page-enter">
              <PageHeading
                title="What’s coming up."
                text="Income, bills and renewals. All in view."
                action={
                  <Button onClick={() => setDialog('plan')}>
                    <Plus size={16} /> Manage your plan
                  </Button>
                }
              />
              <div className="recurring-summary">
                <div>
                  <span className="eyebrow">NEXT 30 DAYS</span>
                  <strong>{money(totalBills, true)}</strong>
                  <p>Bills & subscriptions</p>
                </div>
                <div>
                  <span className="eyebrow">YOUR SUBSCRIPTIONS</span>
                  <strong>
                    {money(
                      subscriptions.reduce((s, e) => s + e.flow.amountCents, 0),
                      true,
                    )}
                  </strong>
                  <p>{subscriptions.length} upcoming renewals</p>
                </div>
                <span className="recurring-art" aria-hidden="true">
                  <Repeat2 size={65} strokeWidth={1} />
                </span>
              </div>
              <div className="recurring-grid">
                {upcoming.map(({ flow, date }) => (
                  <button
                    className="panel recurring-card"
                    key={`${flow.id}-${date}`}
                    onClick={() => setDialog('plan')}
                  >
                    <div className="recurring-card-top">
                      <MerchantMark name={flow.name} color={flow.color} />
                      <Tag
                        tone={
                          flow.kind === 'income' ? 'green' : flow.confirmed ? 'neutral' : 'amber'
                        }
                      >
                        {flow.kind === 'income'
                          ? 'Income'
                          : flow.confirmed
                            ? flow.cadence
                            : 'Needs review'}
                      </Tag>
                    </div>
                    <h3>{flow.name}</h3>
                    <strong className={flow.kind === 'income' ? 'positive' : ''}>
                      {flow.kind === 'income' ? '+' : ''}
                      {money(flow.amountCents, true)}
                    </strong>
                    <div className="recurring-card-bottom">
                      <span>{fullDate(date)}</span>
                      <ArrowUpRight size={16} />
                    </div>
                  </button>
                ))}
              </div>
              <Footnote>
                Changes here update your forecast. Manage actual subscriptions with the provider.
              </Footnote>
            </div>
          )}
          {page === 'wishlist' && (
            <div className="page-enter">
              <PageHeading
                title="Worth planning for."
                text="Find the right moment for something you love."
                action={
                  <Button
                    variant="secondary"
                    onClick={() => ask('I want to check a custom purchase.')}
                  >
                    <Plus size={16} /> Check something else
                  </Button>
                }
              />
              <div className="wishlist-note">
                <Heart size={17} />
                <span>{state.wishlist.length} saved · Demo store · Total prices in USD</span>
              </div>
              <div className="product-grid">
                {state.products.map((p) => (
                  <ProductCard
                    key={p.id}
                    product={p}
                    saved={state.wishlist.includes(p.id)}
                    onSave={() => save(p.id)}
                    onOpen={() => setProduct(p)}
                  />
                ))}
              </div>
              <Footnote>Sandbox checkout only. No goods are sold or shipped.</Footnote>
            </div>
          )}
          <footer className="app-footer">
            <span>
              {state.profile.source === 'demo' ? 'Synthetic history' : 'Imported history'} ·{' '}
              {state.config.paypal === 'sandbox' ? 'PayPal sandbox' : 'Simulated checkout'}
              <i />
              Conditional estimates, based on your plan.
            </span>
          </footer>
        </main>
      </div>
      {dialog === 'plan' && (
        <PlanDialog
          state={state}
          onClose={() => setDialog(null)}
          onReset={clearConversation}
          onUpdate={(s) => {
            replaceState(s)
            setToast('Your plan is up to date.')
          }}
        />
      )}
      {dialog === 'import' && (
        <ImportDialog
          state={state}
          onClose={() => setDialog(null)}
          onUpdate={(s) => {
            clearConversation()
            replaceState(s)
          }}
          onReview={() => setDialog('plan')}
        />
      )}
      {(product || returned) && (
        <PurchaseDialog
          state={state}
          product={product ?? state.products.find((p) => p.id === returned?.productId)!}
          existingPurchase={returned}
          onClose={closePurchase}
          onUpdate={replaceState}
          onPlan={() => {
            closePurchase()
            setDialog('plan')
          }}
        />
      )}
      {toast && (
        <div className="toast" role="status">
          <Check size={17} />
          {toast}
          <IconButton label="Dismiss notification" onClick={() => setToast('')}>
            <X size={15} />
          </IconButton>
        </div>
      )}
    </div>
  )
}

export function PageHeading({
  eyebrow,
  title,
  text,
  action,
}: {
  eyebrow?: string
  title: string
  text: string
  action?: React.ReactNode
}) {
  return (
    <div className="page-heading">
      <div>
        {eyebrow && <span className="eyebrow">{eyebrow}</span>}
        <h1>{title}</h1>
        <p>{text}</p>
      </div>
      {action}
    </div>
  )
}
export function QuestionBox({
  onAsk,
  placeholder,
  light = false,
}: {
  onAsk: (text: string) => void
  placeholder: string
  light?: boolean
}) {
  const [value, setValue] = useState('')
  return (
    <form
      className={cx('question-box', light && 'light')}
      onSubmit={(e) => {
        e.preventDefault()
        onAsk(value.trim() || placeholder)
        setValue('')
      }}
    >
      <Sparkles size={18} />
      <input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={placeholder}
        aria-label="Ask Worth a purchase question"
        maxLength={2000}
      />
      <button aria-label="Ask Worth" type="submit">
        <ArrowUpRight size={20} />
      </button>
    </form>
  )
}
function Stat({
  label,
  value,
  note,
  icon,
  green,
  onClick,
}: {
  label: string
  value: string
  note: string
  icon: React.ReactNode
  green?: boolean
  onClick: () => void
}) {
  return (
    <button className={cx('stat-card', green && 'stat-green')} onClick={onClick}>
      <div>
        <span>{label}</span>
        <span className="stat-icon">{icon}</span>
      </div>
      <strong>{value}</strong>
      <small>
        {green && <span className="status-dot" />}
        {note}
      </small>
    </button>
  )
}
export function MerchantMark({ name, color }: { name: string; color?: string }) {
  return (
    <span className="merchant-mark" style={{ background: color ?? '#e7ebdf' }}>
      {name.slice(0, 1).toUpperCase()}
    </span>
  )
}
export function FlowRow({ flow, date }: { flow: ScheduledFlow; date: string }) {
  return (
    <div className="flow-row">
      <MerchantMark name={flow.name} color={flow.color} />
      <div>
        <strong>{flow.name}</strong>
        <small>
          {shortDate(date)} ·{' '}
          {flow.kind === 'subscription'
            ? 'Subscription'
            : flow.kind === 'income'
              ? 'Expected income'
              : 'Bill'}
        </small>
      </div>
      <b>
        {flow.kind === 'income' ? '+' : ''}
        {money(flow.amountCents, true)}
      </b>
    </div>
  )
}
function ProductCard({
  product: p,
  saved,
  onSave,
  onOpen,
}: {
  product: Product
  saved: boolean
  onSave: () => void
  onOpen: () => void
}) {
  return (
    <article className="product-card">
      <div className="product-photo" style={{ background: p.color }}>
        <button className="product-open" onClick={onOpen} aria-label={`Assess ${p.name}`}>
          <img
            src={p.image}
            alt={p.name}
            style={{ objectPosition: p.id === 'chair' ? '50% 70%' : undefined }}
          />
        </button>
        <IconButton
          label={saved ? `Remove ${p.name} from wishlist` : `Save ${p.name}`}
          className={cx('save-button', saved && 'saved')}
          onClick={onSave}
        >
          <Heart size={18} fill={saved ? 'currentColor' : 'none'} />
        </IconButton>
        <span className="product-category">{p.category}</span>
      </div>
      <div className="product-info">
        <div>
          <h3>{p.name}</h3>
          <strong>{money(p.priceCents)}</strong>
        </div>
        <p>{p.description}</p>
        <Button variant="secondary" onClick={onOpen}>
          Does it fit my plan? <ArrowUpRight size={16} />
        </Button>
      </div>
    </article>
  )
}
