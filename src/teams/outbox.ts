/**
 * Outbox — token-gated staging area for outbound file transfers.
 *
 * Hermes calls `send_file` → the outbox copies the bytes into a token-scoped
 * subdirectory, mints a random token, and stores an in-memory entry. The
 * Teams client later fetches `GET /files/<token>` which calls `read()`,
 * which returns the file bytes. The token remains live until the TTL
 * expires — repeat reads are allowed because Microsoft's link-safety
 * infrastructure pre-fetches every URL server-side before the recipient
 * sees the card, and a single-use token gets consumed by the preview
 * before the user can click. The 256-bit token + short TTL is still the
 * security model; the trade is that anyone with the link inside the TTL
 * window can download.
 *
 * Lookup auto-cleans expired entries opportunistically. A periodic sweeper
 * also runs so expired tokens don't sit on disk waiting for a doomed reader.
 *
 * Boot-time `initialise()` wipes the configured directory. We refuse to do
 * that unless `dir` is a child of `safetyRoot` — defence against a
 * misconfigured `OUTBOX_DIR=/etc` taking down the system.
 */

import { randomBytes } from 'crypto'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { resolve, sep, join } from 'path'

/** Max payload size — matches the inbound attachment cap. */
const MAX_BYTES = 50 * 1024 * 1024

export interface OutboxDeps {
  dir: string
  ttlSeconds: number
  safetyRoot: string
  /** Sweeper period. Defaults to 60s. Tests override to something shorter. */
  sweepIntervalMs?: number
}

export interface MintInput {
  content: Buffer
  filename: string
  mime: string
}

export interface MintedEntry {
  token: string
  filename: string
  mime: string
  sizeBytes: number
}

export interface OutboxEntry {
  token: string
  path: string
  filename: string
  mime: string
  sizeBytes: number
  expiresAt: number
}

export interface ConsumedEntry {
  filename: string
  mime: string
  sizeBytes: number
  content: Buffer
}

export interface Outbox {
  /** Wipe + recreate the outbox dir. Call on boot before mint(). */
  initialise(): Promise<void>
  /** Stop the sweeper. */
  shutdown(): void
  mint(input: MintInput): Promise<MintedEntry>
  lookup(token: string): OutboxEntry | undefined
  /** Return the file content for a live token. Multi-use: the token remains
   *  valid until the TTL expires. Returns undefined for unknown or expired
   *  tokens. */
  read(token: string): ConsumedEntry | undefined
  /** Whether a file path is permitted as a `send_file` source. */
  isPathAllowed(absPath: string): boolean
}

function ensureUnderSafetyRoot(dir: string, safetyRoot: string): void {
  const absDir = resolve(dir)
  const absRoot = resolve(safetyRoot)
  const rootWithSep = absRoot.endsWith(sep) ? absRoot : absRoot + sep
  if (absDir !== absRoot && !absDir.startsWith(rootWithSep)) {
    throw new Error(
      `outbox: refusing to operate at ${absDir} — outside the sendable-files root (${absRoot}). ` +
        `Set OUTBOX_DIR to a path inside SENDABLE_FILES_ROOT.`,
    )
  }
}

export function createOutbox(deps: OutboxDeps): Outbox {
  ensureUnderSafetyRoot(deps.dir, deps.safetyRoot)
  const ttlMs = Math.max(1, Math.round(deps.ttlSeconds * 1000))
  const entries = new Map<string, OutboxEntry>()
  let sweeperHandle: ReturnType<typeof setInterval> | undefined

  function deleteTokenDir(token: string) {
    try {
      rmSync(join(deps.dir, token), { recursive: true, force: true })
    } catch {
      // Best-effort. A leftover dir at worst wastes space until next boot's wipe.
    }
  }

  function evictIfExpired(token: string, entry: OutboxEntry): boolean {
    if (entry.expiresAt > Date.now()) return false
    entries.delete(token)
    deleteTokenDir(token)
    return true
  }

  function sweepExpired() {
    const now = Date.now()
    for (const [token, entry] of entries) {
      if (entry.expiresAt <= now) {
        entries.delete(token)
        deleteTokenDir(token)
      }
    }
    void now
  }

  async function initialise(): Promise<void> {
    // Boot wipe — wedge against orphans from the previous boot. The
    // safety check above already refused construction outside the root.
    rmSync(deps.dir, { recursive: true, force: true })
    mkdirSync(deps.dir, { recursive: true, mode: 0o700 })
    if (sweeperHandle) clearInterval(sweeperHandle)
    sweeperHandle = setInterval(sweepExpired, deps.sweepIntervalMs ?? 60_000)
    // Don't keep the process alive solely for the sweeper.
    sweeperHandle.unref?.()
  }

  function shutdown() {
    if (sweeperHandle) clearInterval(sweeperHandle)
    sweeperHandle = undefined
  }

  async function mint(input: MintInput): Promise<MintedEntry> {
    if (input.content.length > MAX_BYTES) {
      throw new Error(
        `outbox: payload ${input.content.length} bytes exceeds 50 MB cap`,
      )
    }
    const token = randomBytes(32).toString('base64url')
    const tokenDir = join(deps.dir, token)
    mkdirSync(tokenDir, { recursive: true, mode: 0o700 })
    const path = join(tokenDir, input.filename)
    writeFileSync(path, input.content, { mode: 0o600 })
    const entry: OutboxEntry = {
      token,
      path,
      filename: input.filename,
      mime: input.mime,
      sizeBytes: input.content.length,
      expiresAt: Date.now() + ttlMs,
    }
    entries.set(token, entry)
    return {
      token,
      filename: entry.filename,
      mime: entry.mime,
      sizeBytes: entry.sizeBytes,
    }
  }

  function lookup(token: string): OutboxEntry | undefined {
    const entry = entries.get(token)
    if (!entry) return undefined
    if (evictIfExpired(token, entry)) return undefined
    return entry
  }

  function read(token: string): ConsumedEntry | undefined {
    const entry = lookup(token)
    if (!entry) return undefined
    let content: Buffer
    try {
      content = readFileSync(entry.path)
    } catch {
      // File missing on disk — drop the entry; treat as a miss.
      entries.delete(token)
      deleteTokenDir(token)
      return undefined
    }
    return {
      filename: entry.filename,
      mime: entry.mime,
      sizeBytes: entry.sizeBytes,
      content,
    }
  }

  function isPathAllowed(absPath: string): boolean {
    const abs = resolve(absPath)
    const root = resolve(deps.safetyRoot)
    const rootWithSep = root.endsWith(sep) ? root : root + sep
    return abs === root || abs.startsWith(rootWithSep)
  }

  return { initialise, shutdown, mint, lookup, read, isPathAllowed }
}
