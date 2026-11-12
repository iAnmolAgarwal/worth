import { useEffect, useState } from 'react'
import { Check, Copy, KeyRound, Plus } from 'lucide-react'
import type { AgentToken, AppState } from '../shared/types'
import { api } from './api'
import { shortDate } from './format'
import { Alert, Button, Pill } from './ui'

interface TokensResponse {
  endpoint: string
  tokens: AgentToken[]
}
interface Created extends TokensResponse {
  token: string
  item: AgentToken
}

/**
 * The Claude Desktop entry for Worth's hosted MCP endpoint, through the mcp-remote bridge. The
 * bridge carries the token, so its version is pinned exactly.
 */
function desktopConfig(endpoint: string, token: string) {
  const args = ['-y', 'mcp-remote@0.14.3', endpoint, '--transport', 'http-only']
  if (endpoint.startsWith('http://')) args.push('--allow-http')
  args.push('--header', 'Authorization:${WORTH_AUTH}')
  return JSON.stringify(
    {
      mcpServers: {
        worth: { command: 'npx', args, env: { WORTH_AUTH: `Bearer ${token}` } },
      },
    },
    null,
    2,
  )
}

const dateTime = (iso: string) =>
  new Date(iso).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })

function CopyButton({
  text,
  label,
  onCopied,
}: {
  text: string
  label: string
  onCopied: () => void
}) {
  const [done, setDone] = useState(false)
  async function copy() {
    try {
      await navigator.clipboard.writeText(text)
      setDone(true)
      onCopied()
      setTimeout(() => setDone(false), 2000)
    } catch {
      setDone(false)
    }
  }
  return (
    <Button variant="secondary" icon={done ? Check : Copy} onClick={() => void copy()}>
      {done ? 'Copied' : label}
    </Button>
  )
}

/**
 * Settings → Connect an agent. A token lets an outside agent such as Claude Desktop ask Worth
 * before it pays, at any store: check affordability, list saved plans and link to Worth's own
 * comparison for an item, where the person decides. The token is shown once; Worth keeps only its hash.
 */
export function ConnectAgent({
  state,
  onToast,
}: {
  state: AppState
  onToast?: (text: string) => void
}) {
  const [tokens, setTokens] = useState<AgentToken[]>([])
  const [endpoint, setEndpoint] = useState('')
  const [created, setCreated] = useState<Created>()
  const [busy, setBusy] = useState<string>()
  const [error, setError] = useState('')
  useEffect(() => {
    let live = true
    // Settings works without the list: a failed or missing answer leaves it empty.
    Promise.resolve()
      .then(() => api<TokensResponse>('/agent-tokens'))
      .then((result) => {
        if (!live || !result) return
        setTokens(result.tokens ?? [])
        setEndpoint(result.endpoint ?? '')
      })
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [])
  async function create() {
    setBusy('create')
    setError('')
    try {
      const result = await api<Created>('/agent-tokens', {})
      setCreated(result)
      setTokens(result.tokens)
      setEndpoint(result.endpoint)
    } catch (failure) {
      setError((failure as Error).message)
    } finally {
      setBusy(undefined)
    }
  }
  async function revoke(token: AgentToken) {
    setBusy(token.id)
    setError('')
    try {
      const result = await api<TokensResponse>(`/agent-tokens/${token.id}/revoke`, {})
      setTokens(result.tokens)
      if (created?.item.id === token.id) setCreated(undefined)
      onToast?.(`Token ending ${token.hint} revoked. Agents using it are disconnected.`)
    } catch (failure) {
      setError((failure as Error).message)
    } finally {
      setBusy(undefined)
    }
  }
  const active = tokens.filter((token) => token.status === 'active')
  const keep30 = state.retention?.keep30 ?? false
  const copied = () => onToast?.('Copied')
  return (
    <>
      <p className="meta" style={{ marginBottom: 12 }}>
        Let a shopping agent you use, such as Claude Desktop, check with Worth before it pays. Your
        own AI subscription writes the reply; every figure in it comes from Worth.
      </p>
      <dl className="kvlist">
        <div>
          <dt>The agent can</dt>
          <dd>Check a purchase against your plan and read your saved items</dd>
        </div>
        <div>
          <dt>It can also</dt>
          <dd>Send you a link to Worth’s comparison for an item, where you decide</dd>
        </div>
        <div>
          <dt>Pay for you</dt>
          <dd>Never</dd>
        </div>
      </dl>
      {created && (
        <div className="agent-new" aria-live="polite">
          <Alert tone="warn" icon={KeyRound}>
            Copy this token now. Worth keeps only a fingerprint of it, so it can’t show it again.
          </Alert>
          <label className="field" style={{ marginTop: 12 }}>
            <span>Agent token</span>
            <input
              className="mono-input"
              readOnly
              value={created.token}
              onFocus={(event) => event.currentTarget.select()}
            />
          </label>
          <div className="actions" style={{ marginTop: 8 }}>
            <CopyButton text={created.token} label="Copy token" onCopied={copied} />
          </div>
          <h3 className="meta strong" style={{ margin: '16px 0 4px', fontWeight: 700 }}>
            Claude Desktop setup
          </h3>
          <ol className="agent-steps caption">
            <li>In Claude Desktop, open Settings → Developer → Edit Config.</li>
            <li>
              Merge the <code>worth</code> entry below into <code>mcpServers</code> (or use the
              whole snippet if the file is empty), then save and restart Claude Desktop. It needs
              Node.js 20 or later for <code>npx</code>.
            </li>
            <li>Ask: “Can I afford the $1,899 Halden X5?”</li>
          </ol>
          <pre className="code-block" tabIndex={0} aria-label="Claude Desktop configuration">
            <code>{desktopConfig(created.endpoint, created.token)}</code>
          </pre>
          <div className="actions" style={{ marginTop: 8 }}>
            <CopyButton
              text={desktopConfig(created.endpoint, created.token)}
              label="Copy config"
              onCopied={copied}
            />
          </div>
        </div>
      )}
      <div className="actions" style={{ marginTop: 12 }}>
        <Button
          variant={created ? 'secondary' : 'primary'}
          icon={Plus}
          loading={busy === 'create'}
          disabled={Boolean(busy) || active.length >= 3}
          onClick={() => void create()}
        >
          Create agent token
        </Button>
      </div>
      {active.length >= 3 && (
        <p className="caption" style={{ marginTop: 8 }}>
          You have 3 active tokens. Revoke one to create another.
        </p>
      )}
      {error && (
        <p className="co-error" role="alert">
          {error}
        </p>
      )}
      {tokens.length > 0 && (
        <>
          <h3 className="meta strong" style={{ margin: '16px 0 0', fontWeight: 700 }}>
            Your agent tokens
          </h3>
          <ul className="agent-tokens">
            {tokens.map((token) => (
              <li key={token.id}>
                <div>
                  <span className="strong">Token ending {token.hint}</span>{' '}
                  <Pill tone={token.status === 'active' ? 'ok' : 'info'}>
                    {token.status === 'active'
                      ? 'Active'
                      : token.status === 'revoked'
                        ? 'Revoked'
                        : 'Expired'}
                  </Pill>
                  <span className="caption">
                    Created {shortDate(token.createdAt.slice(0, 10))}
                    {token.status === 'active' && ` · Ends ${dateTime(token.expiresAt)}`}
                    {token.lastUsedAt
                      ? ` · Last used ${dateTime(token.lastUsedAt)}`
                      : ' · Not used yet'}
                  </span>
                </div>
                {token.status === 'active' && (
                  <Button
                    variant="danger"
                    loading={busy === token.id}
                    disabled={Boolean(busy)}
                    aria-label={`Revoke token ending ${token.hint}`}
                    onClick={() => void revoke(token)}
                  >
                    Revoke
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
      <p className="caption" style={{ marginTop: 8 }}>
        A token ends after 30 days, when you revoke it, or when this plan is deleted
        {keep30 ? '' : ' (within 24 hours unless you keep your plan for 30 days, under Data)'}.
        {endpoint && (
          <>
            {' '}
            Endpoint: <code>{endpoint}</code>
          </>
        )}
      </p>
    </>
  )
}
