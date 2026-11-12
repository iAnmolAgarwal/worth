import { useEffect, useRef, useSyncExternalStore } from 'react'

/**
 * The guide's hold on the balance chart: Ask Worth sends a command, the mounted chart applies it
 * through its own state setters, and the chart publishes what it shows. View state only: a
 * command can press pills, pick the range and pin a day, never navigate, save, buy or edit.
 */
export type ChartOptionId = 'buyToday' | 'wait' | 'spendLess' | 'payIn4'
export type ChartRange = 'payday' | '30' | '60'
export const CHART_OPTION_IDS: readonly ChartOptionId[] = [
  'buyToday',
  'wait',
  'spendLess',
  'payIn4',
]
export const CHART_RANGES: readonly ChartRange[] = ['payday', '30', '60']

export interface ChartCommand {
  /** The pills to press; only those the chart offers for this item are applied. */
  options?: ChartOptionId[]
  range?: ChartRange
  /** ISO date; ignored outside the chart's window. */
  focusDay?: string
}

/** What the chart shows right now. */
export interface ChartSnapshot {
  available: ChartOptionId[]
  pressed: ChartOptionId[]
  range: ChartRange
  focusDay: string | null
  /** The window's dates, first and last. */
  window: { start: string; end: string }
  item: { name: string; amountCents: number; productId?: string }
}

type Receiver = (command: ChartCommand) => void
let receiver: Receiver | undefined
let snapshot: ChartSnapshot | null = null

/** Sends a command to the mounted chart; false when none is mounted. */
export function sendChartCommand(command: ChartCommand) {
  if (!receiver) return false
  receiver(command)
  return true
}

const watchers = new Set<() => void>()
const changed = () => watchers.forEach((watch) => watch())

/** What the mounted chart shows, or null. */
export const chartSnapshot = () => snapshot

/** True while a chart with an item is on screen, re-rendering when that changes. */
export function useChartMounted() {
  return useSyncExternalStore(
    (watch) => {
      watchers.add(watch)
      return () => watchers.delete(watch)
    },
    () => snapshot !== null,
    () => false,
  )
}

/** For the chart: receive commands while mounted. The latest handler always runs. */
export function useChartCommands(handler: Receiver) {
  const latest = useRef(handler)
  useEffect(() => {
    latest.current = handler
  })
  useEffect(() => {
    const own: Receiver = (command) => latest.current(command)
    receiver = own
    return () => {
      if (receiver === own) receiver = undefined
    }
  }, [])
}

/** For the chart: publish what it shows, cleared when it unmounts. */
export function usePublishChart(next: ChartSnapshot | null) {
  const key = JSON.stringify(next)
  useEffect(() => {
    snapshot = key === 'null' ? null : (JSON.parse(key) as ChartSnapshot)
    changed()
    return () => {
      snapshot = null
      changed()
    }
  }, [key])
}

/** True when a reply's chart directive is for the item the mounted chart shows. */
export function sameItem(
  target: { amountCents: number; itemName?: string; productId?: string },
  shown: ChartSnapshot | null,
) {
  if (!shown) return false
  if (target.productId || shown.item.productId) return target.productId === shown.item.productId
  return target.amountCents === shown.item.amountCents && target.itemName === shown.item.name
}
