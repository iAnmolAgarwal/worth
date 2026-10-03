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
/** An amount in its own currency, such as €45.00 or ¥4,500, from hundredths of that currency. */
export const currencyAmount = (hundredths: number, currency: string) => {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(hundredths / 100)
  } catch {
    return `${currency} ${(hundredths / 100).toFixed(2)}`
  }
}
