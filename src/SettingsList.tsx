import { useId } from 'react'
import type { ReactNode } from 'react'
import { ChevronRight, type LucideIcon } from 'lucide-react'
import { cx } from './format'
import './settings.css'

/**
 * The parts of a settings screen people already know from phone and account settings: a named
 * group of rows, each an icon, a plain label, at most one grey line, and its control on the right.
 */
export function SettingsGroup({
  title,
  danger,
  children,
}: {
  title: string
  danger?: boolean
  children: ReactNode
}) {
  const id = useId()
  return (
    <section className="set-group" aria-labelledby={id}>
      <h2 className="set-group-title" id={id}>
        {title}
      </h2>
      <div className={cx('set-list', danger && 'danger')}>{children}</div>
    </section>
  )
}

function RowText({
  label,
  sub,
  labelId,
  subId,
}: {
  label: ReactNode
  sub?: ReactNode
  labelId?: string
  subId?: string
}) {
  return (
    <span className="set-text">
      <span className="set-label" id={labelId}>
        {label}
      </span>
      {sub && (
        <span className="set-sub" id={subId}>
          {sub}
        </span>
      )}
    </span>
  )
}

/** A row with its control (a switch, a value, a button) on the right. */
export function SettingsRow({
  icon: Icon,
  label,
  sub,
  control,
  labelId,
}: {
  icon: LucideIcon
  label: ReactNode
  sub?: ReactNode
  control?: ReactNode
  labelId?: string
}) {
  return (
    <div className="set-row">
      <span className="set-ic" aria-hidden="true">
        <Icon size={18} strokeWidth={2} />
      </span>
      <RowText label={label} sub={sub} labelId={labelId} />
      {control !== undefined && <span className="set-ctl">{control}</span>}
    </div>
  )
}

/** A whole-row button with a chevron, such as "Import PayPal activity". */
export function SettingsAction({
  icon: Icon,
  label,
  sub,
  onClick,
  disabled,
  danger,
}: {
  icon: LucideIcon
  label: string
  sub?: ReactNode
  onClick: () => void
  disabled?: boolean
  danger?: boolean
}) {
  const id = useId()
  // The label names the button; its grey line describes it.
  return (
    <button
      type="button"
      className={cx('set-row', 'set-action', danger && 'danger')}
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      aria-describedby={sub ? id : undefined}
    >
      <span className="set-ic" aria-hidden="true">
        <Icon size={18} strokeWidth={2} />
      </span>
      <RowText label={label} sub={sub} subId={id} />
      <ChevronRight className="set-chev" size={20} aria-hidden="true" />
    </button>
  )
}

/** A row that opens in place for the details: what is shared, set-up steps, the demo clock. */
export function SettingsMore({
  icon: Icon,
  label,
  sub,
  region,
  children,
}: {
  icon: LucideIcon
  label: string
  sub?: ReactNode
  /** The opened detail's name for assistive technology, when it differs from the label. */
  region?: string
  children: ReactNode
}) {
  const id = useId()
  return (
    <details className="set-row set-more">
      <summary>
        <span className="set-ic" aria-hidden="true">
          <Icon size={18} strokeWidth={2} />
        </span>
        <RowText label={label} sub={sub} labelId={id} />
        <ChevronRight className="set-chev" size={20} aria-hidden="true" />
      </summary>
      <div
        className="set-body"
        role="region"
        {...(region ? { 'aria-label': region } : { 'aria-labelledby': id })}
      >
        {children}
      </div>
    </details>
  )
}
