export const money = (cents: number, decimals = false) =>
  new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: decimals ? 2 : 0,
    minimumFractionDigits: decimals ? 2 : 0,
  }).format(cents / 100)
export const shortDate = (date: string, options: Intl.DateTimeFormatOptions = {}) =>
  new Date(`${date.slice(0, 10)}T12:00:00`).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    ...options,
  })
export const fullDate = (date: string) => shortDate(date, { weekday: 'long', year: 'numeric' })
export const fromMoney = (input: string) => Math.round(Number(input.replace(/[$,]/g, '')) * 100)
export const cx = (...classes: (string | false | undefined | null)[]) =>
  classes.filter(Boolean).join(' ')
