import { useEffect, useState, type RefObject } from 'react'
import { cx } from './format'

/**
 * Worth, the guide: a tear-off calendar page with wire spectacles whose binder rings read as ears.
 * Drawn inline from `src/assets/guide/*.svg` so it can blink and look around. At 32 px and below
 * it switches to a simplified drawing with thicker strokes, so the spectacles still read.
 */
export type GuideExpression = 'neutral' | 'thinking' | 'warning' | 'happy'

const NAVY = '#142c8e'
const INK = '#001435'
const BLUE = '#0070e0'
const CURL = '#b9effc'

/** Where each expression's pupils rest, before any look offset. */
const PUPILS: Record<GuideExpression, [number, number][]> = {
  neutral: [
    [37, 57],
    [59, 57],
  ],
  thinking: [
    [40.5, 52.5],
    [62.5, 52.5],
  ],
  warning: [
    [37, 58],
    [59, 58],
  ],
  happy: [],
}

export function Guide({
  expression = 'neutral',
  size = 56,
  look,
  blink = false,
  title,
  className,
}: {
  expression?: GuideExpression
  size?: number
  /** Pupil offset towards the pointer, each axis from −1 to 1. */
  look?: { x: number; y: number }
  /** Blinks now and then; the CSS turns it off under reduced motion. */
  blink?: boolean
  /** Read out when set; otherwise the drawing is decorative. */
  title?: string
  className?: string
}) {
  const small = size <= 32
  // Lines thicken as the drawing shrinks: 2.6 units is 1.5 px at 56 px, too thin to read.
  const lens = small ? 5 : size <= 64 ? 3.6 : 2.6
  const outline = small ? 3.5 : size <= 64 ? 2.6 : 2
  const face = small ? 4.5 : 3
  const pupil = small ? 4.6 : size <= 64 ? 3.9 : 3.4
  const dx = (look?.x ?? 0) * 1.6
  const dy = (look?.y ?? 0) * 1.2
  return (
    <svg
      className={cx('guide', blink && 'guide-blink', className)}
      viewBox={small ? '14 8 68 82' : '10 4 76 88'}
      width={size}
      height={size}
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      focusable="false"
      data-expression={expression}
    >
      {!small && <ellipse cx="48" cy="91" rx="24" ry="3" fill={INK} opacity=".12" />}
      {/* A white halo behind the feet and rings keeps them apart from any background. */}
      <g fill="#fff" stroke="#fff" strokeLinecap="round" strokeLinejoin="round">
        <rect x="29" y="79" width="11" height="10" rx="4" strokeWidth="4" />
        <rect x="56" y="79" width="11" height="10" rx="4" strokeWidth="4" />
        <path
          d="M30 31V15a3.5 3.5 0 0 1 7 0V25 M59 31V15a3.5 3.5 0 0 1 7 0V25"
          fill="none"
          strokeWidth="8"
        />
      </g>
      <rect x="29" y="79" width="11" height="10" rx="4" fill={NAVY} />
      <rect x="56" y="79" width="11" height="10" rx="4" fill={NAVY} />
      <rect x="17" y="22" width="62" height="62" rx="10" fill="#fff" />
      <path d="M17 42V32a10 10 0 0 1 10-10h42a10 10 0 0 1 10 10v10z" fill={BLUE} />
      {!small && (
        <path
          d={
            expression === 'thinking'
              ? 'M79 64Q62 66 60 84H69A10 10 0 0 0 79 74Z'
              : 'M79 71Q67 73 65 84H69A10 10 0 0 0 79 74Z'
          }
          fill={CURL}
        />
      )}
      <rect
        x="17"
        y="22"
        width="62"
        height="62"
        rx="10"
        fill="none"
        stroke={NAVY}
        strokeWidth={outline}
      />
      <circle cx="33.5" cy="31" r="3.6" fill="#fff" />
      <circle cx="62.5" cy="31" r="3.6" fill="#fff" />
      <path
        d="M30 31V15a3.5 3.5 0 0 1 7 0V25 M59 31V15a3.5 3.5 0 0 1 7 0V25"
        fill="none"
        stroke={NAVY}
        strokeWidth={small ? 5 : 4}
        strokeLinecap="round"
      />
      {/* The spectacles: two lenses, a bridge and, above 32 px, the side arms. */}
      <g fill="none" stroke={NAVY} strokeWidth={lens} strokeLinecap="round">
        <circle cx="37" cy="56" r={small ? 10 : 9.5} />
        <circle cx="59" cy="56" r={small ? 10 : 9.5} />
        <path d={small ? 'M46.5 54q1.5-2 3 0' : 'M46.5 54q1.5-2 3 0 M27.5 54h-6 M68.5 54h6'} />
      </g>
      <g className="guide-eyes">
        {expression === 'happy' ? (
          <path
            d="M32.5 58q4.5-5.5 9 0 M54.5 58q4.5-5.5 9 0"
            fill="none"
            stroke={INK}
            strokeWidth={face}
            strokeLinecap="round"
          />
        ) : (
          PUPILS[expression].map(([x, y]) => (
            <circle key={x} cx={x + dx} cy={y + dy} r={pupil} fill={INK} />
          ))
        )}
      </g>
      {expression === 'thinking' && (
        <path d="M52 44.5l9-2" stroke={INK} strokeWidth={face} strokeLinecap="round" />
      )}
      {expression === 'warning' && (
        <path
          d="M30 43.5l9 3 M66 43.5l-9 3"
          stroke={INK}
          strokeWidth={face}
          strokeLinecap="round"
        />
      )}
      {expression === 'happy' && !small && (
        <path
          d="M24 75l3.5 3.5 7-7"
          fill="none"
          stroke={BLUE}
          strokeWidth="3.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      )}
      <path
        d={
          expression === 'neutral'
            ? 'M43 72q5 3.5 10 0'
            : expression === 'thinking'
              ? 'M48 73h7'
              : expression === 'warning'
                ? 'M42 73h12'
                : 'M41 70q7 7 14 0'
        }
        fill="none"
        stroke={INK}
        strokeWidth={face}
        strokeLinecap="round"
      />
    </svg>
  )
}

/** True when the person asked for less motion; read once per render. */
export function reducedMotion() {
  return (
    typeof window !== 'undefined' &&
    window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
  )
}

/**
 * The pupils' offset towards the pointer, relative to `target`'s centre. It stays at rest under
 * reduced motion, and updates at most once a frame.
 */
export function useLook(target: RefObject<Element | null>, enabled: boolean) {
  const [look, setLook] = useState<{ x: number; y: number }>()
  useEffect(() => {
    if (!enabled || reducedMotion()) return
    let frame = 0
    const move = (event: PointerEvent) => {
      if (frame) return
      frame = requestAnimationFrame(() => {
        frame = 0
        const box = target.current?.getBoundingClientRect()
        if (!box) return
        const x = event.clientX - (box.left + box.width / 2)
        const y = event.clientY - (box.top + box.height / 2)
        const distance = Math.hypot(x, y) || 1
        // Full deflection from about 240 px away; nearer, the eyes turn proportionally less.
        const reach = Math.min(1, distance / 240)
        setLook({ x: (x / distance) * reach, y: (y / distance) * reach })
      })
    }
    window.addEventListener('pointermove', move)
    return () => {
      window.removeEventListener('pointermove', move)
      if (frame) cancelAnimationFrame(frame)
    }
  }, [target, enabled])
  return look
}
