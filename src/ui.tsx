import * as RadixDialog from '@radix-ui/react-dialog'
import { CircleAlert, LoaderCircle, Pencil, X } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useEffect, useId, useState, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { cx } from './format'

export function Wordmark({ onClick }: { onClick?: () => void }) {
  return (
    <a className="wordmark" href="#home" aria-label="Worth home" onClick={onClick}>
      Worth
      <i aria-hidden="true" />
    </a>
  )
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'quiet' | 'text' | 'danger'
  block?: boolean
  loading?: boolean
  icon?: LucideIcon
}
/** PayPal pill button. Loading swaps the icon for a spinner and keeps the label. */
export function Button({
  variant = 'primary',
  block,
  loading,
  icon: Icon,
  className,
  children,
  type = 'button',
  ...props
}: ButtonProps) {
  return (
    <button
      type={type}
      {...props}
      className={cx(
        'btn',
        variant === 'danger' ? 'btn-danger-text' : `btn-${variant}`,
        block && 'btn-block',
        className,
      )}
      disabled={props.disabled || loading}
      aria-busy={loading || undefined}
    >
      {loading ? (
        <LoaderCircle className="ico spin" aria-hidden="true" />
      ) : (
        Icon && <Icon className="ico" strokeWidth={2} aria-hidden="true" />
      )}
      {children}
    </button>
  )
}

export function IconButton({
  label,
  icon: Icon,
  quiet,
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; icon: LucideIcon; quiet?: boolean }) {
  return (
    <button
      type="button"
      {...props}
      className={cx('icon-btn', quiet && 'quiet', className)}
      aria-label={label}
    >
      <Icon className="ico" strokeWidth={1.75} aria-hidden="true" />
    </button>
  )
}

export type Tone = 'ok' | 'bad' | 'info' | 'sug' | 'warn'
export function Pill({ tone, children }: { tone: Tone; children: ReactNode }) {
  return <span className={`pill ${tone}`}>{children}</span>
}

export function Disc({
  icon: Icon,
  kind,
  badge,
}: {
  icon: LucideIcon
  kind?: 'income' | 'plan'
  badge?: LucideIcon
}) {
  const Badge = badge
  return (
    <span className={cx('disc', kind)} aria-hidden="true">
      <Icon className="ico" strokeWidth={2} />
      {Badge && (
        <span className="badge">
          <Badge size={12} strokeWidth={2.5} />
        </span>
      )}
    </span>
  )
}

export function Toggle({
  checked,
  onChange,
  label,
  disabled,
  busy,
  id,
  describedBy,
}: {
  checked: boolean
  onChange: (next: boolean) => void
  label: string
  disabled?: boolean
  /** Saving: the switch keeps focus and ignores clicks instead of being disabled. */
  busy?: boolean
  id?: string
  describedBy?: string
}) {
  return (
    <button
      id={id}
      type="button"
      role="switch"
      className="toggle"
      aria-checked={checked}
      aria-label={label}
      aria-describedby={describedBy}
      aria-busy={busy || undefined}
      aria-disabled={busy || undefined}
      disabled={disabled}
      onClick={() => !busy && onChange(!checked)}
    />
  )
}

/** "Read as Camera · $1,199.00 · today [Edit]" (C-12). The warning variant asks; it never guesses. */
export function ReadAsChip({
  label = 'Read as',
  value,
  action = 'Edit',
  onAction,
  ask,
  disabled,
}: {
  label?: string
  value: string
  action?: string
  onAction?: () => void
  ask?: boolean
  disabled?: boolean
}) {
  return (
    <span
      className={cx('readas', ask && 'ask')}
      role="group"
      aria-label="How Worth read your question"
    >
      {ask && <CircleAlert className="ico" size={16} aria-hidden="true" />}
      <span className="lbl">{label}</span>
      <span className="val">{value}</span>
      {onAction && (
        <button className="edit" type="button" onClick={onAction} disabled={disabled}>
          {action === 'Edit' && <Pencil size={14} aria-hidden="true" />}
          {action}
        </button>
      )}
    </span>
  )
}

export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string
  hint?: string
  error?: string
  children: ReactNode
}) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint && !error && <small>{hint}</small>}
      {error && (
        <span className="field-error">
          <CircleAlert size={16} aria-hidden="true" style={{ marginTop: 2, flex: 'none' }} />
          {error}
        </span>
      )}
    </label>
  )
}

export function Alert({
  tone,
  icon: Icon,
  children,
  live,
}: {
  tone: 'bad' | 'ok' | 'info' | 'warn'
  icon: LucideIcon
  children: ReactNode
  live?: boolean
}) {
  return (
    <div className={`alert ${tone}`} role={live ? 'status' : undefined}>
      <Icon className="ico" strokeWidth={1.75} aria-hidden="true" />
      <div className="alert-body">{children}</div>
    </div>
  )
}

export function SkeletonRow() {
  return (
    <div className="row" aria-hidden="true">
      <span className="sk c" />
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 8, paddingTop: 4 }}>
        <span className="sk" style={{ width: '60%' }} />
        <span className="sk" style={{ width: '35%' }} />
      </div>
      <span className="sk" style={{ width: 64 }} />
    </div>
  )
}

export function EmptyState({
  icon: Icon,
  title,
  children,
  action,
}: {
  icon: LucideIcon
  title: string
  children: ReactNode
  action?: ReactNode
}) {
  return (
    <div className="tile empty">
      <span className="co-icon neutral" aria-hidden="true">
        <Icon className="ico" strokeWidth={1.75} />
      </span>
      <h3 className="h-section">{title}</h3>
      <p className="meta">{children}</p>
      {action}
    </div>
  )
}

/** Pay in 4 progress ring (A7): a quarter per payment. */
export function Ring({ part, of = 4 }: { part: number; of?: number }) {
  const length = 2 * Math.PI * 16
  const filled = (Math.min(part, of) / of) * length
  return (
    <svg className="ring" viewBox="0 0 40 40" aria-hidden="true">
      <circle cx="20" cy="20" r="16" fill="none" stroke="#F0F2F9" strokeWidth="4" />
      <circle
        cx="20"
        cy="20"
        r="16"
        fill="none"
        stroke="#0070E0"
        strokeWidth="4"
        strokeLinecap="round"
        strokeDasharray={`${filled.toFixed(1)} ${length.toFixed(1)}`}
        transform="rotate(-90 20 20)"
      />
    </svg>
  )
}

/**
 * A 480 px centred dialog on desktop and a full-height sheet on mobile. Radix restores focus to
 * the trigger on close (UX-12).
 */
export function Dialog({
  title,
  onClose,
  children,
  footer,
  wide,
  closeLabel = 'Close',
  dismissible = true,
}: {
  title: string
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  wide?: boolean
  closeLabel?: string
  dismissible?: boolean
}) {
  const describedBy = useId()
  // The element that opened the dialog. Dialogs here mount on open and unmount on close, so focus
  // is returned explicitly (UX-12); when the trigger is gone, the page's main region takes it.
  const [trigger] = useState(() =>
    typeof document === 'undefined' ? null : (document.activeElement as HTMLElement | null),
  )
  useEffect(
    () => () => {
      const target =
        trigger && trigger !== document.body && trigger.isConnected
          ? trigger
          : document.getElementById('main')
      setTimeout(() => {
        if (!document.querySelector('[role=dialog]')) target?.focus({ preventScroll: true })
      }, 0)
    },
    [trigger],
  )
  return (
    <RadixDialog.Root open onOpenChange={(open) => !open && dismissible && onClose()}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="scrim" />
        <RadixDialog.Content
          className={cx('dialog', wide && 'wide')}
          aria-describedby={undefined}
          onOpenAutoFocus={(event) => {
            // Start on the status heading when a dialog marks one, not on the close button.
            const target = (event.currentTarget as HTMLElement | null)?.querySelector<HTMLElement>(
              '[data-autofocus]',
            )
            if (target) {
              event.preventDefault()
              target.focus()
            }
          }}
        >
          <div className="dialog-head">
            <RadixDialog.Title asChild>
              <h2>{title}</h2>
            </RadixDialog.Title>
            <RadixDialog.Close asChild>
              <IconButton label={closeLabel} icon={X} quiet disabled={!dismissible} />
            </RadixDialog.Close>
          </div>
          <div className="dialog-body" id={describedBy}>
            {children}
          </div>
          {footer && <div className="dialog-foot">{footer}</div>}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  )
}

const shiftDay = (date: string, days: number) => {
  const next = new Date(`${date}T12:00:00Z`)
  next.setUTCDate(next.getUTCDate() + days)
  return next.toISOString().slice(0, 10)
}
/**
 * The app's date control: the date as people read it ("Sun, Oct 18") with day and week steps,
 * instead of the browser's mm/dd/yyyy picker. Arrow keys on the value step a day; Page Up/Down a
 * week. It is a spin button, so screen readers announce the date and its range.
 */
export function DateStepper({
  label,
  value,
  onChange,
  min,
  max,
  disabled,
}: {
  label: string
  value: string
  onChange: (date: string) => void
  min?: string
  max?: string
  disabled?: boolean
}) {
  const id = useId()
  const clamp = (date: string) => (min && date < min ? min : max && date > max ? max : date)
  const step = (days: number) => onChange(clamp(shiftDay(value, days)))
  const text = new Date(`${value}T12:00:00`).toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  })
  return (
    <div className="field">
      <span id={id}>{label}</span>
      <div className="date-step">
        <button
          type="button"
          className="date-step-btn"
          aria-label={`${label}: a week earlier`}
          disabled={disabled || (min !== undefined && shiftDay(value, -1) < min)}
          onClick={() => step(-7)}
        >
          «
        </button>
        <button
          type="button"
          className="date-step-btn"
          aria-label={`${label}: a day earlier`}
          disabled={disabled || (min !== undefined && shiftDay(value, -1) < min)}
          onClick={() => step(-1)}
        >
          ‹
        </button>
        <span
          className="date-step-value num"
          role="spinbutton"
          tabIndex={disabled ? -1 : 0}
          aria-labelledby={id}
          aria-valuetext={text}
          aria-disabled={disabled || undefined}
          onKeyDown={(event) => {
            if (disabled) return
            const days =
              event.key === 'ArrowUp' || event.key === 'ArrowRight'
                ? 1
                : event.key === 'ArrowDown' || event.key === 'ArrowLeft'
                  ? -1
                  : event.key === 'PageUp'
                    ? 7
                    : event.key === 'PageDown'
                      ? -7
                      : 0
            if (!days) return
            event.preventDefault()
            step(days)
          }}
        >
          {text}
        </span>
        <button
          type="button"
          className="date-step-btn"
          aria-label={`${label}: a day later`}
          disabled={disabled || (max !== undefined && shiftDay(value, 1) > max)}
          onClick={() => step(1)}
        >
          ›
        </button>
        <button
          type="button"
          className="date-step-btn"
          aria-label={`${label}: a week later`}
          disabled={disabled || (max !== undefined && shiftDay(value, 1) > max)}
          onClick={() => step(7)}
        >
          »
        </button>
      </div>
    </div>
  )
}
