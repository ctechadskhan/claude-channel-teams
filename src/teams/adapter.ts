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
import type { PendingStore } from '../pairing/pair.js'
import type { PermissionRelay } from '../permission/relay.js'
import { PERMISSION_REPLY_RE } from '../permission/relay.js'
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

/** Hook the adapter calls when an unknown sender needs the pairing DM sent. */
export type PairingDmSender = (
  conversationReference: Partial<ConversationReference>,
  text: string,
) => Promise<void>

export interface AdapterDeps {
  config: Config
  adapter: CloudAdapter
  allowlist: Allowlist
  refs: ConversationRefStore
  onEvent: ChannelEventSink
  /** Phase 3 — pending pairings store. Optional so existing tests still wire. */
  pending?: PendingStore
  /** Phase 3 — permission relay. Optional so existing tests still wire. */
  permission?: PermissionRelay
  /** Phase 3 — send a pairing DM through CloudAdapter. Optional for tests. */
  sendPairingDm?: PairingDmSender
}

/** Set of AAD IDs we've already logged a "rejected" line for. */
const rejectedSeen = new Set<string>()

/**
 * Adapt a Bun-native fetch-style Request to the minimal `Request` interface
 * CloudAdapter expects. The SDK only reads `body`, `headers`, and `method`.
 * `body` must be the parsed JSON (the SDK throws if it gets a stream).
 */
class MalformedBodyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MalformedBodyError'
  }
}

async function toBotRequest(req: Request): Promise<{ body: unknown; headers: Record<string, string>; method: string }> {
  // Lowercase all headers so the SDK finds 'authorization' regardless of how
  // the upstream proxy capitalised it.
  const headers: Record<string, string> = {}
  req.headers.forEach((v, k) => {
    headers[k.toLowerCase()] = v
  })
  const raw = await req.text()
  if (raw.length === 0) {
    throw new MalformedBodyError('empty request body')
  }
  let body: unknown
  try {
    body = JSON.parse(raw)
  } catch {
    throw new MalformedBodyError('request body is not valid JSON')
  }
  if (!body || typeof body !== 'object') {
    throw new MalformedBodyError('request body must be a JSON object')
  }
  // CloudAdapter requires `type` on the activity; without it the framework
  // throws a stack-trace-style 500. Fail at the door with a 400 so random
  // scanners don't pollute the audit log.
  if (typeof (body as { type?: unknown }).type !== 'string') {
    throw new MalformedBodyError('request body is missing required activity.type')
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

    const conversationId = a.conversation?.id
    if (!conversationId) {
      // Shouldn't happen for a message activity, but defend anyway.
      process.stderr.write('teams channel: drop — no conversation.id\n')
      return
    }
    const fromName = a.from?.name ?? ''

    // Allowlist gate — the single most important application-level check.
    // A non-allowlisted sender enters the pairing path (Phase 3) if a
    // pending store is wired; otherwise it's dropped silently.
    if (!deps.allowlist.isAllowed(aadObjectId)) {
      if (deps.pending && deps.sendPairingDm) {
        const ref = TurnContext.getConversationReference(a)
        const decision = deps.pending.recordIncoming({
          aadObjectId,
          tenantId: tenantId ?? deps.config.tenantId,
          fromName,
          conversationId,
        })
        if (decision.action === 'suppress') {
          // Hit the per-sender reply cap or the global pending cap — drop
          // silently. Log once per AAD ID so the operator sees an attempted
          // amplification but the line doesn't repeat.
          if (!rejectedSeen.has(aadObjectId)) {
            rejectedSeen.add(aadObjectId)
            process.stderr.write(
              `teams channel: pairing suppressed for ${aadObjectId} (${decision.reason})\n`,
            )
          }
          return
        }
        const lead =
          decision.action === 'send_reminder' ? 'Still pending' : 'Hi'
        const text =
          `${lead} — this bot is gated. Ask the operator to run ` +
          `/teams:access pair ${decision.entry.code} in their terminal. ` +
          `Show this code: ${decision.entry.code}.`
        process.stderr.write(
          `teams channel: pairing ${decision.action} pair_id=${decision.entry.pair_id} aad=${aadObjectId}\n`,
        )
        deps.sendPairingDm(ref, text).catch(err => {
          process.stderr.write(
            `teams channel: pairing DM send failed: ${err}\n`,
          )
        })
        return
      }
      if (!rejectedSeen.has(aadObjectId)) {
        rejectedSeen.add(aadObjectId)
        process.stderr.write(
          `teams channel: drop — sender not in allowlist (aad_object_id=${aadObjectId})\n`,
        )
      }
      return
    }

    // Capture the conversation reference for the outbound side. We do this
    // before pushing to Claude so a fast reply can always find its way back.
    const ref = TurnContext.getConversationReference(a)
    deps.refs.put(conversationId, ref, aadObjectId)

    const text = typeof a.text === 'string' ? a.text : ''
    const messageId = a.id
    const ts = a.timestamp ? new Date(a.timestamp).toISOString() : undefined

    // Permission-reply intercept — the sender is already allowlisted, so we
    // trust them with verdicts. Strict regex (see permission/relay.ts) means
    // a bare "yes" or chatty prefix falls through to the regular channel
    // event. If the id doesn't match a pending request, treat the text as a
    // normal message — better than swallowing it silently.
    if (deps.permission) {
      const match = PERMISSION_REPLY_RE.exec(text)
      if (match) {
        const verdict = match[1]!.toLowerCase().startsWith('y') ? 'allow' : 'deny'
        const id = match[2]!.toLowerCase()
        const handled = deps.permission.resolve(id, verdict)
        if (handled) {
          process.stderr.write(
            `teams channel: permission verdict ${verdict} for ${id}\n`,
          )
          return
        }
        // Fall through — unknown id may be a coincidence (operator typing
        // about a different request). Forward as chat.
      }
    }

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
        // Parse the body first so we can distinguish a malformed payload
        // from a real downstream error. Random scanners poking the public
        // endpoint shouldn't produce 500-stack-traces in the audit log.
        let botReq: { body: unknown; headers: Record<string, string>; method: string }
        try {
          botReq = await toBotRequest(req)
        } catch (err) {
          if (err instanceof MalformedBodyError) {
            // Info-level log only — these are noise, not incidents.
            process.stderr.write(
              `teams channel: 400 malformed /api/messages — ${err.message}\n`,
            )
            return new Response(err.message, {
              status: 400,
              headers: { 'content-type': 'text/plain' },
            })
          }
          process.stderr.write(`teams channel: body read failed: ${err}\n`)
          return new Response('bad request', { status: 400 })
        }
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
