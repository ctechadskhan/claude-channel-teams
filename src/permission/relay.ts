/**
 * Permission relay — Phase 3.
 *
 * Two halves to the dance:
 *
 *   1. Claude Code emits `notifications/claude/channel/permission_request` to us
 *      when it wants the channel to relay a tool-approval prompt. We translate
 *      that into a plain-text DM in the operator's allowlisted conversation:
 *
 *          🔒 Tool approval needed [<id>]: <toolName> with args <summary>.
 *          Reply 'yes <id>' or 'no <id>'.
 *
 *      `<id>` is the `request_id` Claude Code minted — five lowercase letters
 *      from [a-km-z] (no 'l') per the channels reference.
 *
 *   2. The operator types `yes <id>` or `no <id>` into Teams. The adapter
 *      intercepts that text BEFORE forwarding to MCP (see adapter.ts) and
 *      asks the relay to resolve the pending request, which emits
 *      `notifications/claude/channel/permission` with `behavior: 'allow' | 'deny'`.
 *
 * The reply regex matches the canonical channels-reference shape so we don't
 * have to debate variants. Strict on purpose — bare "yes" / "no" or chatter
 * around the id would be ambiguous with a regular reply.
 *
 * State is in-memory. A plugin restart loses pending requests; that's the
 * same behaviour as the Telegram plugin. Claude Code reissues the approval
 * prompt locally if the timeout fires.
 *
 * "Primary operator" limitation (documented in security.md):
 * v1 sends the prompt to a single conversation — the most-recently-active
 * allowlisted one. Multi-operator broadcast is a Phase 5 feature alongside
 * Adaptive Cards.
 */

export const PERMISSION_REPLY_RE = /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i

export const DEFAULT_PERMISSION_TIMEOUT_MS = 5 * 60 * 1000 // 5 minutes

export type PermissionBehavior = 'allow' | 'deny'

export interface PermissionRequest {
  request_id: string
  tool_name: string
  description: string
  input_preview: string
}

interface PendingSlot {
  request: PermissionRequest
  askedAt: number
  conversationId: string
  timeoutHandle: ReturnType<typeof setTimeout>
}

export interface PermissionRelayDeps {
  /** Push the relayed prompt out as a Teams DM. Throws are logged, not rethrown. */
  sendDm: (conversationId: string, text: string) => Promise<void>
  /** Emit `notifications/claude/channel/permission` upstream to Claude Code. */
  emitVerdict: (request_id: string, behavior: PermissionBehavior) => void
  /** Configurable for tests. */
  timeoutMs?: number
  /**
   * Resolve the "primary operator" conversation — the most-recently-active
   * allowlisted conversation we've seen. v1 single-operator design.
   * Return undefined when no conversation has been seen yet; we log and skip.
   */
  resolveTargetConversation: () => string | undefined
}

export interface PermissionRelay {
  /** Called when Claude Code sends a permission_request. */
  onRequest(req: PermissionRequest): Promise<void>
  /**
   * Called by the adapter when it has matched the PERMISSION_REPLY_RE on an
   * inbound message from an already-gate-approved sender. Returns true if the
   * id was a pending request (caller should NOT forward the message as
   * regular chat); false otherwise (caller falls through to the normal
   * channel event).
   */
  resolve(request_id: string, behavior: PermissionBehavior): boolean
  /** Test/diagnostic accessor. */
  pendingCount(): number
  /** Drop everything — used by shutdown. */
  clear(): void
}

/**
 * Truncate input_preview for the DM. We want a hint of what's about to run
 * without dumping a multi-kilobyte JSON blob into Teams.
 */
function summariseInput(s: string, max = 200): string {
  if (!s) return ''
  // Collapse whitespace; Teams renders single-line text nicely.
  const collapsed = s.replace(/\s+/g, ' ').trim()
  if (collapsed.length <= max) return collapsed
  return collapsed.slice(0, max - 1) + '…'
}

export function formatPromptText(req: PermissionRequest): string {
  const args = summariseInput(req.input_preview)
  const argsPart = args ? ` with args ${args}` : ''
  return (
    `🔒 Tool approval needed [${req.request_id}]: ${req.tool_name}${argsPart}. ` +
    `Reply 'yes ${req.request_id}' or 'no ${req.request_id}'.`
  )
}

export function createPermissionRelay(
  deps: PermissionRelayDeps,
): PermissionRelay {
  const pending = new Map<string, PendingSlot>()
  const timeoutMs = deps.timeoutMs ?? DEFAULT_PERMISSION_TIMEOUT_MS

  function clearSlot(request_id: string): PendingSlot | undefined {
    const slot = pending.get(request_id)
    if (!slot) return undefined
    clearTimeout(slot.timeoutHandle)
    pending.delete(request_id)
    return slot
  }

  return {
    async onRequest(req: PermissionRequest): Promise<void> {
      // Reissue protection — Claude Code may resend if the first attempt
      // didn't see a verdict. Replace the prior slot rather than stacking.
      clearSlot(req.request_id)

      const conversationId = deps.resolveTargetConversation()
      if (!conversationId) {
        process.stderr.write(
          `teams channel: permission_request ${req.request_id} dropped — no allowlisted conversation seen yet\n`,
        )
        return
      }

      const text = formatPromptText(req)
      try {
        await deps.sendDm(conversationId, text)
      } catch (err) {
        process.stderr.write(
          `teams channel: permission_request ${req.request_id} send failed: ${err}\n`,
        )
        return
      }

      const handle = setTimeout(() => {
        // Timeout — drop the pending slot. Claude Code maintains its own
        // approval timeout; we just stop holding state for it.
        if (pending.has(req.request_id)) {
          pending.delete(req.request_id)
          process.stderr.write(
            `teams channel: permission_request ${req.request_id} timed out after ${timeoutMs}ms\n`,
          )
        }
      }, timeoutMs)
      // Don't keep the event loop alive solely on a pending approval.
      ;(handle as { unref?: () => void }).unref?.()

      pending.set(req.request_id, {
        request: req,
        askedAt: Date.now(),
        conversationId,
        timeoutHandle: handle,
      })
    },

    resolve(request_id: string, behavior: PermissionBehavior): boolean {
      const id = request_id.toLowerCase()
      const slot = clearSlot(id)
      if (!slot) return false
      deps.emitVerdict(id, behavior)
      return true
    },

    pendingCount(): number {
      return pending.size
    },

    clear(): void {
      for (const id of Array.from(pending.keys())) {
        clearSlot(id)
      }
    },
  }
}
