/**
 * Pairing flow — Phase 3.
 *
 * State lives at `<stateDir>/pending.json`, owner-only (0600), atomic-written.
 *
 * File schema:
 *
 *   {
 *     "version": 1,
 *     "entries": [
 *       {
 *         "pair_id":          "<8-char hex>",
 *         "aad_object_id":    "<lowercase guid>",
 *         "tenant_id":        "<guid>",
 *         "from_name":        "<display name, untrusted>",
 *         "conversation_id":  "<bot framework conversation id>",
 *         "code":             "<6-char alnum>",
 *         "created_at":       "<ISO-8601>",
 *         "last_reminder_at": "<ISO-8601 | null>",
 *         "reply_count":      0,
 *         "status":           "awaiting_confirm"
 *       }
 *     ]
 *   }
 *
 * Lifecycle:
 *
 *   1. Unknown sender DMs the bot. `recordIncoming()` returns either:
 *        - { action: 'send_initial', code }  — fresh pending; gate sends the DM.
 *        - { action: 'send_reminder', code } — pending exists, 10+ minutes
 *           since the last DM and reply_count < 2; gate sends the reminder.
 *        - { action: 'suppress' }            — pending exists but we've
 *           already sent the cap of 2 messages, or it's too soon for the
 *           reminder. Drop silently.
 *
 *   2. Operator runs /teams:access — calls `list_pending` to inspect, then
 *      `approve_pair {pair_id, code}` or `deny_pair {pair_id}`.
 *
 *   3. Approval validates the code, transfers the entry to the allowlist via
 *      the caller-supplied `addEntry` callback, removes the pending row, and
 *      asks the caller to send a confirmation DM through the existing
 *      conversation reference.
 *
 *   4. Denial removes the pending row. Silent by default — denying should
 *      not leak that the bot exists.
 *
 * Defensive notes:
 *   - pair_id and code are separate. The operator must supply BOTH on
 *     approve. The pair_id is shown in /teams:access listings; the code is
 *     shown in the user's DM. This makes "approve the pending one"
 *     prompt-injection-resistant — the attacker can't supply both halves
 *     unless they're already controlling both ends.
 *   - The pending file is hard-capped — `MAX_PENDING` entries. A spammer
 *     can't push us into unbounded memory by DMing the bot repeatedly from
 *     fresh accounts.
 *   - Codes use a small "easy to read" alphanumeric set (no 0/O/1/I/l) so
 *     they can be read aloud or off a screen without typos.
 */

import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'fs'
import { dirname } from 'path'
import { randomBytes } from 'crypto'

export const PENDING_FILE_VERSION = 1
export const MAX_PENDING = 16
export const REMINDER_INTERVAL_MS = 10 * 60 * 1000 // 10 minutes
export const MAX_REPLY_COUNT = 2 // initial + 1 reminder

/** Easy-to-read code alphabet — no 0/O, no 1/I/l. */
const CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'
const CODE_LENGTH = 6

/** Pair IDs are hex — they appear in operator listings and approval calls. */
const PAIR_ID_BYTES = 4

export interface PendingEntry {
  pair_id: string
  aad_object_id: string
  tenant_id: string
  from_name: string
  conversation_id: string
  code: string
  created_at: string
  last_reminder_at: string | null
  reply_count: number
  status: 'awaiting_confirm'
}

interface PendingFile {
  version: typeof PENDING_FILE_VERSION
  entries: PendingEntry[]
}

function emptyFile(): PendingFile {
  return { version: PENDING_FILE_VERSION, entries: [] }
}

export type IncomingDecision =
  | { action: 'send_initial'; entry: PendingEntry }
  | { action: 'send_reminder'; entry: PendingEntry }
  | { action: 'suppress'; reason: string }

export interface PendingStore {
  path: string
  /**
   * Called from the inbound gate when a non-allowlisted sender arrives.
   * Returns the decision the gate should act on. Mutates state as needed
   * (incrementing reply_count, stamping last_reminder_at).
   */
  recordIncoming(input: {
    aadObjectId: string
    tenantId: string
    fromName: string
    conversationId: string
    now?: number
  }): IncomingDecision
  /**
   * Lookup helpers used by the MCP operator tools.
   */
  list(): PendingEntry[]
  findByPairId(pairId: string): PendingEntry | undefined
  /** Remove a pending entry (used by approve and deny). */
  remove(pairId: string): boolean
}

function normalizeId(id: string): string {
  return id.trim().toLowerCase()
}

function generateCode(): string {
  // crypto-strength code from the easy-to-read alphabet. Bias is negligible
  // (32 fits cleanly into 8 bits — 256 / 32 = 8 evenly).
  const bytes = randomBytes(CODE_LENGTH)
  let out = ''
  for (let i = 0; i < CODE_LENGTH; i++) {
    out += CODE_ALPHABET[bytes[i]! % CODE_ALPHABET.length]
  }
  return out
}

function generatePairId(): string {
  return randomBytes(PAIR_ID_BYTES).toString('hex')
}

function readPending(path: string): PendingFile {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return emptyFile()
    throw err
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    process.stderr.write(
      `teams channel: pending file is unparseable, treating as empty (operator should inspect: ${path})\n`,
    )
    return emptyFile()
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    (parsed as PendingFile).version !== PENDING_FILE_VERSION ||
    !Array.isArray((parsed as PendingFile).entries)
  ) {
    process.stderr.write(
      `teams channel: pending file has unexpected shape, treating as empty (${path})\n`,
    )
    return emptyFile()
  }
  // Defensively coerce — never trust on-disk shape entirely.
  const entries: PendingEntry[] = []
  for (const e of (parsed as PendingFile).entries) {
    if (!e || typeof e !== 'object') continue
    const ee = e as Partial<PendingEntry>
    if (
      typeof ee.pair_id !== 'string' ||
      typeof ee.aad_object_id !== 'string' ||
      typeof ee.conversation_id !== 'string' ||
      typeof ee.code !== 'string'
    ) {
      continue
    }
    entries.push({
      pair_id: ee.pair_id,
      aad_object_id: ee.aad_object_id,
      tenant_id: typeof ee.tenant_id === 'string' ? ee.tenant_id : '',
      from_name: typeof ee.from_name === 'string' ? ee.from_name : '',
      conversation_id: ee.conversation_id,
      code: ee.code,
      created_at:
        typeof ee.created_at === 'string' ? ee.created_at : new Date().toISOString(),
      last_reminder_at:
        typeof ee.last_reminder_at === 'string' ? ee.last_reminder_at : null,
      reply_count:
        typeof ee.reply_count === 'number' && ee.reply_count >= 0
          ? ee.reply_count
          : 1,
      status: 'awaiting_confirm',
    })
  }
  return { version: PENDING_FILE_VERSION, entries }
}

function writePending(path: string, data: PendingFile): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const tmp = path + '.tmp'
  // Mode 0600 — pending state isn't a credential but it leaks identity
  // (display names, AAD IDs of would-be senders). Owner-only.
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 })
  try {
    chmodSync(tmp, 0o600)
  } catch {
    // chmod can fail on Windows; mode in writeFileSync covers POSIX.
  }
  // Atomic swap.
  renameSync(tmp, path)
}

export function createPendingStore(path: string): PendingStore {
  // Touch the file on first boot so the operator can see where it lives.
  try {
    readFileSync(path, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      writePending(path, emptyFile())
      process.stderr.write(
        `teams channel: pending pairings store initialised at ${path}\n`,
      )
    }
  }

  return {
    path,

    recordIncoming({ aadObjectId, tenantId, fromName, conversationId, now }): IncomingDecision {
      const ts = now ?? Date.now()
      const target = normalizeId(aadObjectId)
      const file = readPending(path)

      // Existing pending for this sender? Reminder logic.
      const existing = file.entries.find(
        e => normalizeId(e.aad_object_id) === target,
      )
      if (existing) {
        // Refresh the conversation_id — Teams sometimes rotates these and
        // the operator's eventual confirmation DM needs a live one.
        if (existing.conversation_id !== conversationId) {
          existing.conversation_id = conversationId
        }
        if (existing.reply_count >= MAX_REPLY_COUNT) {
          return {
            action: 'suppress',
            reason: 'reply_count cap reached; awaiting operator',
          }
        }
        const lastTs = existing.last_reminder_at
          ? Date.parse(existing.last_reminder_at)
          : Date.parse(existing.created_at)
        if (Number.isFinite(lastTs) && ts - lastTs < REMINDER_INTERVAL_MS) {
          return {
            action: 'suppress',
            reason: 'too soon since last reminder',
          }
        }
        existing.reply_count += 1
        existing.last_reminder_at = new Date(ts).toISOString()
        writePending(path, file)
        return { action: 'send_reminder', entry: { ...existing } }
      }

      // No existing pending. Cap protection.
      if (file.entries.length >= MAX_PENDING) {
        return { action: 'suppress', reason: 'pending cap reached' }
      }

      const entry: PendingEntry = {
        pair_id: generatePairId(),
        aad_object_id: target,
        tenant_id: tenantId,
        from_name: fromName,
        conversation_id: conversationId,
        code: generateCode(),
        created_at: new Date(ts).toISOString(),
        last_reminder_at: null,
        reply_count: 1,
        status: 'awaiting_confirm',
      }
      file.entries.push(entry)
      writePending(path, file)
      return { action: 'send_initial', entry: { ...entry } }
    },

    list(): PendingEntry[] {
      return readPending(path).entries.slice()
    },

    findByPairId(pairId: string): PendingEntry | undefined {
      const target = pairId.trim().toLowerCase()
      return readPending(path).entries.find(
        e => e.pair_id.toLowerCase() === target,
      )
    },

    remove(pairId: string): boolean {
      const target = pairId.trim().toLowerCase()
      const file = readPending(path)
      const before = file.entries.length
      file.entries = file.entries.filter(
        e => e.pair_id.toLowerCase() !== target,
      )
      if (file.entries.length === before) return false
      writePending(path, file)
      return true
    },
  }
}

/** Constant-time-ish string compare. Codes are short; iteration count is
 *  fixed to the longer of the two inputs to avoid timing leaks. */
export function codesEqual(a: string, b: string): boolean {
  const x = a.trim().toUpperCase()
  const y = b.trim().toUpperCase()
  if (x.length !== y.length) return false
  let diff = 0
  for (let i = 0; i < x.length; i++) {
    diff |= x.charCodeAt(i) ^ y.charCodeAt(i)
  }
  return diff === 0
}
