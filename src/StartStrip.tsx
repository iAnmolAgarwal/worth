import { useState } from 'react'
import { ArrowRight, CircleAlert, FileText } from 'lucide-react'
import type { AppState } from './contract'
import { isActive } from './contract'
import { cx } from './format'
import {
  ChooseFile,
  FileError,
  HowTo,
  loadSampleExport,
  PRIVACY_LINE,
  realToday,
  useCsvFile,
  useDrop,
  type ChosenFile,
} from './Onboarding'
import { Alert, Button } from './ui'

/** "Choose your CSV": the user's own PayPal activity export. */
export function CsvAction({ read, disabled }: { read: (file?: File) => void; disabled?: boolean }) {
  return (
    <ChooseFile read={read} disabled={disabled}>
      Use my CSV
    </ChooseFile>
  )
}

/** The bundled, fictional PayPal export, run through the same import. */
export function SampleExportAction({
  state,
  onFile,
  onError,
  disabled,
}: {
  state: AppState
  onFile: (file: ChosenFile) => void
  onError: (message: string) => void
  disabled?: boolean
}) {
  const [loading, setLoading] = useState(false)
  async function sample() {
    onError('')
    setLoading(true)
    try {
      onFile(await loadSampleExport(realToday(state)))
    } catch {
      onError('The sample export could not load. Try again.')
    } finally {
      setLoading(false)
    }
  }
  return (
    <Button
      variant="quiet"
      icon={FileText}
      loading={loading}
      disabled={disabled || loading}
      onClick={() => void sample()}
    >
      Try a sample export
    </Button>
  )
}

/** PayPal's download steps, the privacy line and entering bills by hand, behind one disclosure. */
export function StripMore({ onEnterYourself }: { onEnterYourself: () => void }) {
  return (
    <details className="quiet-details start-more">
      <summary>More</summary>
      <div className="stack tight start-pop">
        <p className="t">How to get the file from PayPal</p>
        <HowTo />
        <p className="caption">
          {PRIVACY_LINE} English-language export in USD, up to 1 MB. A few minutes.
        </p>
        <button type="button" className="link" onClick={onEnterYourself}>
          Enter your bills yourself
        </button>
      </div>
    </details>
  )
}

/**
 * The slim row under the hero on the sample plan: one sentence and the ways to bring your own
 * PayPal activity. Each action is its own element, so another way in is one more line here. A CSV
 * dropped anywhere on the row is read like a chosen one.
 */
export function StartStrip({
  state,
  onFile,
  onImport,
  onEnterYourself,
}: {
  state: AppState
  /** Without it (no import handler), the row only names the sample. */
  onFile?: (file: ChosenFile) => void
  onImport?: () => void
  onEnterYourself: () => void
}) {
  const busy = state.purchases.some(isActive)
  const { read, error, setError, reading } = useCsvFile(onFile ?? (() => undefined))
  const { over, handlers } = useDrop((file) => void read(file), busy || !onFile)
  const name = state.profile.name.trim()
  return (
    <section
      className={cx('start-strip', over && 'over')}
      aria-label="Start with your PayPal activity"
      {...handlers}
    >
      <p className="start-strip-text">
        This is {name ? `${name}’s` : 'the'} sample plan.{' '}
        <span className="soft">Bring your own PayPal activity.</span>
      </p>
      <div className="start-strip-actions">
        {onFile ? (
          <>
            <SampleExportAction state={state} onFile={onFile} onError={setError} disabled={busy} />
            <CsvAction read={(file) => void read(file)} disabled={busy || reading} />
            <StripMore onEnterYourself={onEnterYourself} />
          </>
        ) : (
          onImport && (
            <button type="button" className="link inline" onClick={onImport}>
              Use your own PayPal activity
              <ArrowRight size={16} strokeWidth={2} aria-hidden="true" />
            </button>
          )
        )}
      </div>
      {busy && onFile && (
        <Alert tone="warn" icon={CircleAlert}>
          Finish or cancel your active checkout before importing PayPal activity.
        </Alert>
      )}
      {error && <FileError>{error}</FileError>}
    </section>
  )
}
