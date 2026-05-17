/**
 * Bot Framework HTTP listener — the inbound side.
 *
 * Phase 2 implementation:
 *
 *   - Spins up a `Bun.serve` listener on TEAMS_PLUGIN_BIND_HOST:TEAMS_PLUGIN_PORT
 *     (loopback by default).
 *   - Routes POST /api/messages through CloudAdapter.process so the SDK's JWT
 *     validator runs before anything else. Failure → 401.
 *   - For each authenticated message activity:
 *       1. Pull `aadObjectId`, `conversation.id`, `text`, `from.name`,
 *          `conversation.tenantId`.
 *       2. Allowlist check — drop silently if not allowed (with one stderr
 *          line per unique rejected ID, matching the Telegram pattern).
 *       3. Tenant defence-in-depth: compare conversation.tenantId against the
 *          configured tenant. Drop mismatches.
 *       4. Capture the conversation reference so the outbound side can find
 *          its way back.
 *       5. Hand the payload to the channel-event sink.
 *   - Also exposes GET /health — unauthenticated, returns 200, lets the
 *     reverse proxy / Caddy / monitoring confirm reachability without an
 *     activity round-trip.
 *
 * We deliberately use `Bun.serve` instead of restify here. CloudAdapter's
 * `Request` and `Response` interfaces are minimal (see node_modules/botbuilder/
 * lib/interfaces/) — we adapt a Bun Request to that shape with a few-line shim.
 * Dropping restify saves two transitive trees and removes a dep we don't need.
 * Documented in docs/dependencies.md.
 */

import {
  CloudAdapter,
  TurnContext,
  type Activity,
  type ConversationReference,
} from 'botbuilder'
import type { Config } from '../config.js'
import type { Allowlist } from '../pairing/allowlist.js'
import type { ConversationRefStore } from './conversationRefs.js'

/**
 * Sink type — what the adapter pushes when an inbound message clears the gate.
 * The server wires this to `mcp.notification(...)`. Keeping the interface
 * narrow means we can unit-test the adapter without spinning up MCP.
 */
export type ChannelEventSink = (event: {
  text: string
  conversationId: string
  aadObjectId: string
  tenantId: string
  fromName: string
  messageId?: string
  ts?: string
}) => void

export interface AdapterDeps {
  config: Config
  adapter: CloudAdapter
  allowlist: Allowlist
  refs: ConversationRefStore
  onEvent: ChannelEventSink
}

/** Set of AAD IDs we've already logged a "rejected" line for. */
const rejectedSeen = new Set<string>()

/**
 * Adapt a Bun-native fetch-style Request to the minimal `Request` interface
 * CloudAdapter expects. The SDK only reads `body`, `headers`, and `method`.
 * `body` must be the parsed JSON (the SDK throws if it gets a stream).
 */
async function toBotRequest(req: Request): Promise<{ body: unknown; headers: Record<string, string>; method: string }> {
  // Lowercase all headers so the SDK finds 'authorization' regardless of how
  // the upstream proxy capitalised it.
  const headers: Record<string, string> = {}
  req.headers.forEach((v, k) => {
    headers[k.toLowerCase()] = v
  })
  let body: unknown = {}
  try {
    const raw = await req.text()
    body = raw.length === 0 ? {} : JSON.parse(raw)
  } catch {
    // Empty / non-JSON body — let CloudAdapter return its own 400. Don't
    // throw here because the framework's error message is what an operator
    // would expect to see.
    body = ''
  }
  return { body, headers, method: req.method }
}

/**
 * Build the minimal `Response` shape CloudAdapter requires, accumulating the
 * outcome so we can return a Bun-native `Response` once `end()` is called.
 *
 * The SDK calls `.status(n)`, `.header(name, val)`, `.send(body)`, `.end()`
 * in that order. We resolve a single promise on `.end()` so the caller can
 * await the response.
 */
function makeResponseSink(): {
  res: {
    socket: unknown
    status: (code: number) => unknown
    header: (name: string, value: unknown) => unknown
    send: (...args: unknown[]) => unknown
    end: (...args: unknown[]) => unknown
  }
  done: Promise<Response>
} {
  let statusCode = 200
  const headers = new Headers()
  let body: BodyInit | undefined
  let resolve!: (r: Response) => void
  const done = new Promise<Response>(r => (resolve = r))
  const res = {
    // CloudAdapter never uses `socket` for non-WS POSTs but the type
    // demands it exists.
    socket: undefined,
    status(code: number) {
      statusCode = code
      return res
    },
    header(name: string, value: unknown) {
      headers.set(name, String(value))
      return res
    },
    send(...args: unknown[]) {
      if (args.length === 0) return res
      const v = args[0]
      if (v === undefined || v === null) return res
      if (typeof v === 'string') {
        body = v
      } else if (v instanceof Uint8Array || v instanceof ArrayBuffer) {
        body = v as BodyInit
      } else {
        if (!headers.has('content-type')) headers.set('content-type', 'application/json')
        body = JSON.stringify(v)
      }
      return res
    },
    end(...args: unknown[]) {
      // Some callers pass the body to .end() directly.
      if (args.length > 0 && args[0] !== undefined && body === undefined) {
        res.send(...args)
      }
      resolve(new Response(body ?? null, { status: statusCode, headers }))
      return res
    },
  }
  return { res, done }
}

/**
 * Build the turn handler that bridges the SDK's TurnContext to our gate + sink.
 *
 * Exported so the unit tests can call it directly with a synthesised
 * TurnContext — bypassing the JWT validator (which requires Microsoft-signed
 * tokens, impractical to produce in tests).
 */
export function makeTurnHandler(deps: AdapterDeps): (ctx: TurnContext) => Promise<void> {
  return async function turn(ctx: TurnContext) {
    const a = ctx.activity
    // We only care about message activities in v1. Conversation update,
    // typing, etc. are ignored — they don't carry a payload Claude needs.
    if (a.type !== 'message') return

    const aadObjectIdRaw = a.from?.aadObjectId
    if (!aadObjectIdRaw) {
      // Activities without an AAD Object ID can't be authenticated against
      // the tenant allowlist. Drop. Could be a Web Chat test message.
      process.stderr.write('teams channel: drop — no aadObjectId on activity\n')
      return
    }
    const aadObjectId = aadObjectIdRaw.toLowerCase()
    const tenantId = a.conversation?.tenantId

    // Defence-in-depth tenant check: even though the SDK already validates
    // the JWT against the configured tenant, we compare the conversation
    // tenant against the pinned tenant. Belt and braces — protects against
    // a hypothetical SDK bug or future config drift that lets a wider
    // audience through.
    if (deps.config.tenantId && tenantId && tenantId.toLowerCase() !== deps.config.tenantId.toLowerCase()) {
      process.stderr.write(
        `teams channel: drop — tenant mismatch (got ${tenantId}, expected pinned tenant)\n`,
      )
      return
    }

    // Allowlist gate — the single most important application-level check.
    // A non-allowlisted sender is dropped silently. We log once per ID so
    // the operator gets a hint without flooding stderr from a spammer.
    if (!deps.allowlist.isAllowed(aadObjectId)) {
      if (!rejectedSeen.has(aadObjectId)) {
        rejectedSeen.add(aadObjectId)
        process.stderr.write(
          `teams channel: drop — sender not in allowlist (aad_object_id=${aadObjectId})\n`,
        )
      }
      return
    }

    const conversationId = a.conversation?.id
    if (!conversationId) {
      // Shouldn't happen for a message activity, but defend anyway.
      process.stderr.write('teams channel: drop — no conversation.id\n')
      return
    }

    // Capture the conversation reference for the outbound side. We do this
    // before pushing to Claude so a fast reply can always find its way back.
    const ref = TurnContext.getConversationReference(a)
    deps.refs.put(conversationId, ref, aadObjectId)

    const text = typeof a.text === 'string' ? a.text : ''
    const fromName = a.from?.name ?? ''
    const messageId = a.id
    const ts = a.timestamp ? new Date(a.timestamp).toISOString() : undefined

    deps.onEvent({
      text,
      conversationId,
      aadObjectId,
      tenantId: tenantId ?? deps.config.tenantId,
      fromName,
      messageId,
      ts,
    })
  }
}

export interface RunningListener {
  port: number
  url: string
  stop(): Promise<void>
}

/**
 * Start the HTTP listener and return a handle the caller can stop later.
 * Mounts:
 *
 *   POST /api/messages — Bot Framework messaging endpoint. The reverse proxy
 *                         (Caddy / nginx / Cloudflare Tunnel) forwards here.
 *   GET  /health        — Unauthenticated liveness. Returns "ok".
 */
export function startListener(deps: AdapterDeps): RunningListener {
  const { config, adapter } = deps
  const turn = makeTurnHandler(deps)

  const server = Bun.serve({
    hostname: config.bindHost,
    port: config.port,
    development: false,
    async fetch(req): Promise<Response> {
      const url = new URL(req.url)
      // GET /health — lets the reverse proxy + monitoring poke us without
      // a JWT. No state leak; just "process is alive".
      if (req.method === 'GET' && url.pathname === '/health') {
        return new Response('ok', { status: 200, headers: { 'content-type': 'text/plain' } })
      }
      if (url.pathname === '/api/messages') {
        if (req.method !== 'POST') {
          return new Response('method not allowed', { status: 405 })
        }
        const botReq = await toBotRequest(req)
        const { res, done } = makeResponseSink()
        // Hand the request to CloudAdapter. The SDK validates the JWT, parses
        // the activity, calls our turn handler. If the turn handler throws,
        // it's surfaced as a 500. If JWT validation fails, 401.
        try {
          // The SDK's Request type is structurally compatible with botReq.
          // Cast at the boundary so the type-check stays honest elsewhere.
          await adapter.process(botReq as never, res as never, turn)
        } catch (err) {
          process.stderr.write(`teams channel: adapter.process threw: ${err}\n`)
          // adapter.process already wrote its own response on most errors;
          // if not, give the connector a 500 so it retries.
          // (The done promise hasn't resolved yet → we resolve manually.)
          res.status(500)
          res.end('internal error')
        }
        return done
      }
      return new Response('not found', { status: 404 })
    },
    error(err) {
      process.stderr.write(`teams channel: server error: ${err.message ?? err}\n`)
      return new Response('internal error', { status: 500 })
    },
  })

  // Note the listener URL — used by tests and logged on startup.
  const port = Number(server.port)
  const url = `http://${config.bindHost}:${port}`
  process.stderr.write(`teams channel: listening on ${url} (tenant pinned to ${config.tenantId.slice(0, 8)}…)\n`)

  return {
    port,
    url,
    async stop() {
      await server.stop(true)
    },
  }
}
