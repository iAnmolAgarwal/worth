import { paypalModeLine, SAMPLE_WHO } from './copy'
import type { AppState } from './contract'
import { envLabel } from './engine'

/**
 * Whose data this is, the assistant's state and the PayPal mode, with the way to bring your own
 * activity. It sat in a popover on the top bar's data chip; the chip is gone (the banner on top
 * names the sample) and this is kept for Settings to show.
 */
export function EnvDetails({
  state,
  onImport,
  onNavigate,
}: {
  state: AppState
  onImport: () => void
  onNavigate?: () => void
}) {
  const demo = state.profile.source === 'demo'
  return (
    <span className="env-details">
      <span className="env-about">
        {demo
          ? `This is ${SAMPLE_WHO}. No real money moves, and ${paypalModeLine(state.config.paypal)}.`
          : `This is the PayPal activity you imported. ${paypalModeLine(state.config.paypal)}.`}
      </span>
      {/* The sentence above already says it is sample data. */}
      {envLabel(state)
        .split(' · ')
        .filter((part) => !(demo && part === 'Sample data'))
        .map((part) => (
          <span key={part}>{part}</span>
        ))}
      {demo && (
        <button type="button" className="link" onClick={onImport}>
          Use your own PayPal activity
        </button>
      )}
      <a href="#settings" onClick={onNavigate}>
        About this demo
      </a>
    </span>
  )
}
