/**
 * Shared types for the Microsoft Teams channel plugin.
 *
 * Phase 1: type definitions only. No runtime behaviour lives here.
 */

/**
 * A pending pairing attempt — created when an unknown sender DMs the bot.
 * Stored in access.json under `pending[<code>]`.
 */
export interface PendingEntry {
  /** Entra ID Object ID of the user awaiting approval. */
  aadObjectId: string
  /**
   * Bot Framework conversation reference identifying the 1:1 DM thread.
   * Serialised JSON — restored to send the "you're paired" confirm.
   */
  conversationReference: string
  /** Optional display name captured for the operator's eyes only. Never trusted. */
  displayName?: string
  createdAt: number
  expiresAt: number
  /** Number of pairing-code replies sent. Capped to avoid spamming a typo loop. */
  replies: number
}

/**
 * Per-channel group policy (Teams group chat or channel-scoped install).
 * Phase 1 ships `personal` scope only; this type reserves the shape for
 * Phase 5 when group scope lands.
 */
export interface GroupPolicy {
  /** When true, only inbound messages that @-mention the bot trigger delivery. */
  requireMention: boolean
  /** AAD Object IDs allowed to trigger inside this group. Empty = any allowlisted member. */
  allowFrom: string[]
}

/**
 * Persistent access state. Lives at <stateDir>/access.json.
 *
 * Mutated only by the /teams:access skill (running in the operator's terminal session).
 * The server re-reads on every inbound activity so policy changes apply
 * without a restart.
 */
export interface Access {
  /** How DMs from senders not in `allowFrom` are handled. */
  dmPolicy: 'pairing' | 'allowlist' | 'disabled'
  /** Entra ID Object IDs allowed to DM the bot. */
  allowFrom: string[]
  /** Teams group chats / channels opted in. Keyed on conversation ID. */
  groups: Record<string, GroupPolicy>
  /** In-flight pairing attempts, keyed on the 6-character pairing code. */
  pending: Record<string, PendingEntry>
  /** Case-insensitive regexes that count as a mention inside a group. */
  mentionPatterns?: string[]
  /** Tenant ID this server is willing to accept tokens from. Defence in depth. */
  allowedTenantId?: string
}

/**
 * Outcome of the inbound gate. Mirrors the Telegram plugin's GateResult.
 */
export type GateResult =
  | { action: 'deliver'; access: Access }
  | { action: 'drop'; reason: string }
  | { action: 'pair'; code: string; isResend: boolean }

/**
 * Minimal shape of the Bot Framework Activity fields we read.
 * Re-declared rather than imported so callers can mock without pulling
 * the full botbuilder type tree.
 */
export interface InboundActivity {
  type: 'message' | 'invoke' | string
  text?: string
  from: { id: string; aadObjectId?: string; name?: string }
  conversation: { id: string; tenantId?: string; conversationType?: string }
  channelId: string
  id?: string
  timestamp?: string
  attachments?: unknown[]
}
