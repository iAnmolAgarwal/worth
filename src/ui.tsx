import * as Dialog from '@radix-ui/react-dialog'
import {
  ArrowUpRight,
  Check,
  ChevronRight,
  CircleHelp,
  LoaderCircle,
  Sparkles,
  X,
} from 'lucide-react'
import { useId, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { cx } from './format'

export function Logo({ compact = false }: { compact?: boolean }) {
  return (
    <span className="brand">
      <span className="brand-mark" aria-hidden="true">
        <span />
        <span />
        <span />
      </span>
      {!compact && (
        <span>
          worth<span className="brand-dot">.</span>
        </span>
      )}
    </span>
  )
}
export function Button({
  children,
  variant = 'primary',
  loading = false,
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'lime'
  loading?: boolean
}) {
  return (
    <button
      {...props}
      className={cx('button', `button-${variant}`, className)}
      disabled={props.disabled || loading}
    >
      {loading && <LoaderCircle size={16} className="spin" />}
      {children}
    </button>
  )
}
export function IconButton({
  children,
  label,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button
      {...props}
      type="button"
      className={cx('icon-button', props.className)}
      aria-label={label}
      title={label}
    >
      {children}
    </button>
  )
}
export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  className,
}: {
  open: boolean
  onClose: () => void
  title: string
  description?: string
  children: ReactNode
  className?: string
}) {
  const descriptionId = useId()
  return (
    <Dialog.Root open={open} onOpenChange={(v) => !v && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="modal-overlay" />
        <Dialog.Content
          className={cx('modal', className)}
          aria-describedby={description ? descriptionId : undefined}
        >
          <div className="modal-heading">
            <div>
              <Dialog.Title>{title}</Dialog.Title>
              {description && (
                <Dialog.Description id={descriptionId}>{description}</Dialog.Description>
              )}
            </div>
            <Dialog.Close asChild>
              <IconButton label="Close dialog">
                <X size={20} />
              </IconButton>
            </Dialog.Close>
          </div>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
export function Tag({
  children,
  tone = 'neutral',
  dot = false,
}: {
  children: ReactNode
  tone?: 'neutral' | 'green' | 'amber' | 'purple'
  dot?: boolean
}) {
  return (
    <span className={`tag tag-${tone}`}>
      {dot && <span className="status-dot" />}
      {children}
    </span>
  )
}
export function SectionTitle({
  eyebrow,
  title,
  children,
}: {
  eyebrow?: string
  title: string
  children?: ReactNode
}) {
  return (
    <div className="section-heading">
      <div>
        {eyebrow && <span className="eyebrow">{eyebrow}</span>}
        <h2>{title}</h2>
      </div>
      {children}
    </div>
  )
}
export function EmptyState({
  title,
  children,
  action,
}: {
  title: string
  children: ReactNode
  action?: ReactNode
}) {
  return (
    <div className="empty-state">
      <span className="empty-icon">
        <Sparkles size={24} />
      </span>
      <h3>{title}</h3>
      <p>{children}</p>
      {action}
    </div>
  )
}
export function Field({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: ReactNode
}) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  )
}
export function Footnote({ children }: { children: ReactNode }) {
  return (
    <p className="footnote">
      <CircleHelp size={14} />
      <span>{children}</span>
    </p>
  )
}
export function ArrowLink({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return (
    <button className="text-link" onClick={onClick}>
      {children}
      <ArrowUpRight size={15} />
    </button>
  )
}
export function Step({ index, done, label }: { index: number; done: boolean; label: string }) {
  return (
    <div className={cx('step', done && 'done')}>
      <span>{done ? <Check size={13} /> : index}</span>
      {label}
      <ChevronRight size={14} />
    </div>
  )
}
