import { dateInTimezone } from '../shared/finance'
import type { Purchase } from '../shared/types'

/** Money always shows cents (brief §7); chart ticks are the only exception. */
export const money = (cents: number, decimals = true) =>
  new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: decimals ? 2 : 0,
    minimumFractionDigits: decimals ? 2 : 0,
  }).format(cents / 100)
/** A signed amount with a true minus sign: −$950.00 or +$1,450.00. */
export const signed = (cents: number, plus = false) =>
  cents < 0 ? `−${money(-cents)}` : `${plus ? '+' : ''}${money(cents)}`
const at = (date: string) => new Date(`${date.slice(0, 10)}T12:00:00`)
export const shortDate = (date: string, options: Intl.DateTimeFormatOptions = {}) =>
  at(date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...options })
/** "Mon, Oct 12": every date a person reads carries its weekday (brief §7). */
export const dayLabel = (date: string) => shortDate(date, { weekday: 'short' })
export const fullDate = (date: string) => shortDate(date, { weekday: 'long', year: 'numeric' })
/** "Fri, Nov 13, 2026": a pinned sample day, short enough for one line. */
export const sampleDate = (date: string) => shortDate(date, { weekday: 'short', year: 'numeric' })
export const monthLabel = (date: string) =>
  at(date).toLocaleDateString('en-US', { month: 'short', year: 'numeric' })
export const daysFrom = (from: string, to: string) =>
  Math.round((at(to).getTime() - at(from).getTime()) / 86_400_000)
/** "today", "tomorrow" or "Fri, Oct 30". */
export const relativeDay = (date: string, today: string) =>
  date === today ? 'today' : daysFrom(today, date) === 1 ? 'tomorrow' : dayLabel(date)
export const fromMoney = (input: string) => Math.round(Number(input.replace(/[$,\s]/g, '')) * 100)
export const cx = (...classes: (string | false | undefined | null)[]) =>
  classes.filter(Boolean).join(' ')
/** An amount in its own currency, such as €45.00 or ¥4,500, from hundredths of that currency. */
export const currencyAmount = (hundredths: number, currency: string) => {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(hundredths / 100)
  } catch {
    return `${currency} ${(hundredths / 100).toFixed(2)}`
  }
}
export const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1)
/** Names imported in capitals ("NORTHWIND LOGISTICS PAYROLL") read as "Northwind Logistics Payroll". */
export const displayName = (name: string) =>
  /[A-Z]{3}/.test(name) && name === name.toUpperCase()
    ? name.toLowerCase().replace(/\b\p{L}/gu, (letter) => letter.toUpperCase())
    : name

/** The day a purchase completed, as the plan counts days (the demo clock's day under a replay). */
export function boughtOn(
  purchase: Pick<Purchase, 'completedOn' | 'completedAt' | 'assessmentDate'>,
  timezone: string,
) {
  return (
    purchase.completedOn ??
    (purchase.completedAt
      ? dateInTimezone(purchase.completedAt, timezone)
      : purchase.assessmentDate)
  )
}
