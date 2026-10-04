/**
 * Worth's MCP server over stdio, for Claude Desktop and other local MCP clients.
 *
 * It is a thin relay to a Worth server's Streamable HTTP endpoint (hosted or local): tools are
 * listed and called there, behind the same token, guards and rate limits. This process holds no
 * financial data and no PayPal or Anthropic credentials, only the agent token it was given.
 *
 *   WORTH_MCP_URL    https://<your Worth host>/mcp (default http://localhost:5173/mcp)
 *   WORTH_MCP_TOKEN  the agent token from Settings → Connect an agent
 *
 * Run it with `node server/mcpStdio.ts` (Node strips the types). stdout carries the protocol, so
 * every message from this file goes to stderr.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

const url = new URL(process.env.WORTH_MCP_URL?.trim() || 'http://localhost:5173/mcp')
const token = process.env.WORTH_MCP_TOKEN?.trim() ?? ''
if (!/^wrth_[A-Za-z0-9_-]{43}$/.test(token)) {
  console.error(
    'Set WORTH_MCP_TOKEN to the agent token from Worth (Settings → Connect an agent). It starts with wrth_.',
  )
  process.exit(1)
}
const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
if (url.protocol !== 'https:' && !local) {
  console.error('WORTH_MCP_URL must use https:// unless it points at this computer.')
  process.exit(1)
}

let remote: Promise<Client> | undefined
/** One connection to Worth, opened on first use and reopened after a failure. */
function connect() {
  remote ??= (async () => {
    const client = new Client({ name: 'worth-stdio', version: '1.0.0' })
    await client.connect(
      new StreamableHTTPClientTransport(url, {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      }),
    )
    return client
  })().catch((error: unknown) => {
    remote = undefined
    throw error
  })
  return remote
}
/** Why Worth could not be reached, for the agent; never the token or a stack. */
function unreachable(error: unknown) {
  const status = (error as { code?: unknown }).code
  const message =
    status === 401
      ? 'Worth did not accept this agent token. It may be revoked or expired, or the plan was deleted. Create a new one in Worth under Settings → Connect an agent.'
      : status === 429
        ? 'Worth is limiting requests from this agent. Wait a minute and try again.'
        : `Worth could not be reached at ${url.origin}. Check that it is running.`
  return {
    isError: true,
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({
          source: 'Worth engine',
          // Worth could not be asked, so this is the relay's own (UTC) date.
          as_of: new Date().toISOString().slice(0, 10),
          summary: message,
          error: { code: status === 401 ? 'UNAUTHORIZED' : 'WORTH_UNREACHABLE', message },
        }),
      },
    ],
  }
}

const first = await connect().catch(() => undefined)
const server = new Server(
  { name: 'worth', version: '1.0.0' },
  {
    capabilities: { tools: {} },
    instructions:
      first?.getInstructions() ??
      'Worth is the person’s affordability check. Call check_affordability before any purchase and quote its summary as given.',
  },
)
server.setRequestHandler(ListToolsRequestSchema, async (request) => {
  try {
    return await (await connect()).listTools(request.params)
  } catch (error) {
    remote = undefined
    throw new Error(unreachable(error).content[0]!.text)
  }
})
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    return await (await connect()).callTool(request.params)
  } catch (error) {
    remote = undefined
    return unreachable(error)
  }
})
await server.connect(new StdioServerTransport())
console.error(`Worth MCP (stdio) relaying to ${url.origin}${url.pathname}`)
