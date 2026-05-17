/**
 * Allowlist persistence — flat list of AAD ObjectIDs stored at
 * `<stateDir>/allowlist.json`. Phase 2.
 *
 * Design decisions in play:
 *   - F.2 — flat list of AAD ObjectIDs (no Entra group resolution).
 *   - F.5 — global allowlist; per-conversation scoping deferred to Phase 5.
 *
 * File schema:
 *
 *   {
 *     "version": 1,
 *     "entries": [
 *       { "aad_object_id": "<uuid>", "added_at": "2026-05-17T19:00:00Z", "note": "optional" }
 *     ]
 *   }
 *
 * Mutation is atomic (`<file>.tmp` + rename) so the gate path can read this
 * file safely while the pairing UI writes it. The file mode is 0600 — the
 * contents are low-sensitivity (no secrets, only AAD ObjectIDs) but integrity
 * is critical: any rogue write adds an attacker to the allowlist, which is
 * functionally a tenant-user-level RCE on the operator's session.
 *
 * The pairing UI in Phase 3 will wire `addEntry` to incoming pair-requests.
 * Phase 2 ships these functions exported but only `isAllowed` is consumed by
 * the bot proper.
 */

import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'fs'
import { dirname } from 'path'

export interface AllowlistEntry {
  /** AAD Object ID GUID. Tenant-stable, immutable per user. */
  aad_object_id: string
  /** ISO-8601 UTC when this entry was added. */
  added_at: string
  /** Free-text label, operator-supplied. Never trusted; never re-rendered. */
  note?: string
}

interface AllowlistFile {
  version: 1
  entries: AllowlistEntry[]
}

const FILE_VERSION = 1 as const

function emptyFile(): AllowlistFile {
  return { version: FILE_VERSION, entries: [] }
}

/**
 * Stateless module bound to a single allowlist file path. Created via
 * `createAllowlist(path)` from `server.ts`. We don't hold global state so
 * tests can spin multiple instances side-by-side.
 */
export interface Allowlist {
  path: string
  isAllowed(aadObjectId: string): boolean
  addEntry(aadObjectId: string, note?: string): AllowlistEntry
  removeEntry(aadObjectId: string): boolean
  listEntries(): AllowlistEntry[]
}

function normalizeId(id: string): string {
  // Case-insensitive compare — AAD ObjectIDs are GUIDs, conventionally
  // lowercase, but Microsoft endpoints sometimes echo them uppercase.
  // Lowercase everywhere so we never miss a legitimate sender on a case skew.
  return id.trim().toLowerCase()
}

function read(path: string): AllowlistFile {
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
    // Corrupt file — start fresh in-memory. Don't move aside automatically;
    // we'd lose data. Log loudly so the operator notices.
    process.stderr.write(
      `teams channel: allowlist file is unparseable, treating as empty (operator should inspect: ${path})\n`,
    )
    return emptyFile()
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    (parsed as AllowlistFile).version !== FILE_VERSION ||
    !Array.isArray((parsed as AllowlistFile).entries)
  ) {
    process.stderr.write(
      `teams channel: allowlist file has unexpected shape, treating as empty (${path})\n`,
    )
    return emptyFile()
  }
  // Defensively coerce — never trust the on-disk shape entirely.
  const entries: AllowlistEntry[] = []
  for (const e of (parsed as AllowlistFile).entries) {
    if (!e || typeof e !== 'object') continue
    const id = (e as AllowlistEntry).aad_object_id
    if (typeof id !== 'string' || id.length === 0) continue
    entries.push({
      aad_object_id: id,
      added_at: typeof e.added_at === 'string' ? e.added_at : new Date().toISOString(),
      ...(typeof e.note === 'string' ? { note: e.note } : {}),
    })
  }
  return { version: FILE_VERSION, entries }
}

function write(path: string, data: AllowlistFile): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const tmp = path + '.tmp'
  // Mode 0600: integrity-critical file. Owner-only.
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 })
  try {
    chmodSync(tmp, 0o600)
  } catch {
    // chmod can fail on Windows; mode in writeFileSync covers POSIX.
  }
  // Atomic swap — no half-written file is ever observable to a concurrent
  // reader. (Telegram source uses the same pattern.)
  renameSync(tmp, path)
}

export function createAllowlist(path: string): Allowlist {
  // On first boot ensure a file exists so the operator can see where it lives
  // and edit it by hand. The log line points at the file explicitly.
  try {
    readFileSync(path, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      write(path, emptyFile())
      process.stderr.write(
        `teams channel: allowlist initialised at ${path} — no entries; add an Object ID to allow access\n`,
      )
    }
  }

  return {
    path,
    isAllowed(aadObjectId: string): boolean {
      if (!aadObjectId) return false
      const target = normalizeId(aadObjectId)
      // Re-read on every check so changes from the pairing UI / hand-edits
      // take effect without restarting the plugin. Matches Telegram's pattern.
      const file = read(path)
      for (const e of file.entries) {
        if (normalizeId(e.aad_object_id) === target) return true
      }
      return false
    },
    addEntry(aadObjectId: string, note?: string): AllowlistEntry {
      const target = normalizeId(aadObjectId)
      if (!/^[0-9a-f-]{8,}$/.test(target)) {
        // Loose check — full GUID validation would reject legitimate IDs from
        // edge tenants. Just refuse obvious garbage to make accidental
        // misuse (e.g. passing a display name) hard.
        throw new Error(`refusing to add malformed aad_object_id: ${aadObjectId}`)
      }
      const file = read(path)
      // Idempotent: replace existing entry rather than duplicating.
      const existing = file.entries.findIndex(
        e => normalizeId(e.aad_object_id) === target,
      )
      const entry: AllowlistEntry = {
        aad_object_id: target,
        added_at: new Date().toISOString(),
        ...(note ? { note } : {}),
      }
      if (existing >= 0) file.entries[existing] = entry
      else file.entries.push(entry)
      write(path, file)
      return entry
    },
    removeEntry(aadObjectId: string): boolean {
      const target = normalizeId(aadObjectId)
      const file = read(path)
      const before = file.entries.length
      file.entries = file.entries.filter(
        e => normalizeId(e.aad_object_id) !== target,
      )
      if (file.entries.length === before) return false
      write(path, file)
      return true
    },
    listEntries(): AllowlistEntry[] {
      return read(path).entries.slice()
    },
  }
}
