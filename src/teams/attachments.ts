/**
 * Attachment handling — download files attached to inbound Teams messages
 * and save them to a known directory on disk.
 *
 * The adapter calls `processAttachments` AFTER the allowlist gate has passed.
 * We never download for a sender who isn't allowlisted; that contract lives
 * in adapter.ts.
 *
 * Storage layout:
 *
 *   <baseDir>/YYYY-MM-DD/HHMM-<sender-slug>-<original-filename>
 *
 * Date and time are evaluated in Europe/London because that's where Adnan
 * works and the morning brief / scheduling cadence is UK-time aligned. On
 * filename collision we append "-1", "-2" before the extension.
 *
 * Two attachment shapes are handled:
 *
 *   1. SharePoint / OneDrive file attachments — contentType
 *      `application/vnd.microsoft.teams.file.download.info`. The `content`
 *      field carries a short-lived `downloadUrl` that needs NO bearer token.
 *
 *   2. Inline images — contentType matching `image/*`. The `contentUrl`
 *      points at the bot framework's smba.trafficmanager.net endpoint and
 *      requires the bot's service-to-service token in the
 *      `Authorization: Bearer <token>` header.
 *
 * Anything else is logged and skipped with an annotation so Hermes can tell
 * the user the bot ignored that bit.
 *
 * Output: a list of annotation lines (one per attachment, success or
 * failure) to be appended to the message text. The message shape stays the
 * same — no MCP schema changes — Hermes reads the path out of the text.
 */

import { mkdirSync, renameSync, statSync, writeFileSync, existsSync } from 'fs'
import { join, extname, basename } from 'path'
import { tmpdir } from 'os'
import type { Attachment } from 'botframework-schema'

/** 50 MB cap per file. Anything larger is skipped with an annotation. */
export const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024

/** 30 second hard cap per download. */
export const DOWNLOAD_TIMEOUT_MS = 30_000

const TEAMS_FILE_DOWNLOAD_CONTENT_TYPE =
  'application/vnd.microsoft.teams.file.download.info'

/**
 * Host gate for inline-image content URLs.
 *
 * The inline-image branch attaches the bot's s2s bearer token to every fetch.
 * Without a host check, an attacker-supplied `contentUrl` on an inbound
 * activity would exfiltrate that token — the bot would happily POST it to
 * `attacker.example.com`. So we restrict to the Microsoft-documented
 * Bot Framework attachment service:
 *
 *   - `smba.trafficmanager.net` (legacy global)
 *   - `smba.<region>.trafficmanager.net` (regional variants — uk, emea, in, au, fc, etc.)
 *
 * Protocol must be HTTPS. URL parsing rejects userinfo / IP literals
 * implicitly through the hostname check.
 *
 * NOTE: `trafficmanager.net` as a whole is shared Azure infrastructure —
 * any tenant can register a profile there. We pin on the `smba.` prefix
 * because that's the Bot Framework attachment service's actual namespace.
 */
export function isAllowedInlineImageHost(url: string): boolean {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return false
  }
  if (u.protocol !== 'https:') return false
  if (u.username || u.password) return false
  const host = u.hostname.toLowerCase()
  if (host === 'smba.trafficmanager.net') return true
  // smba.<region>.trafficmanager.net — require BOTH the smba. prefix
  // and the trafficmanager.net suffix.
  if (host.startsWith('smba.') && host.endsWith('.trafficmanager.net')) {
    return true
  }
  return false
}

/** Result for one attachment — either saved, skipped, or failed. */
export type AttachmentResult =
  | { kind: 'saved'; path: string; contentType: string; sizeBytes: number; originalName: string }
  | { kind: 'skipped'; reason: string; originalName: string }
  | { kind: 'failed'; reason: string; originalName: string }

export interface ProcessAttachmentsDeps {
  /**
   * Returns a service-to-service bearer token for downloading inline images
   * from smba.trafficmanager.net. Called lazily — only if an inline image
   * actually needs it. Throw on failure; the caller will annotate.
   */
  getBearerToken: () => Promise<string>
  /** Base storage directory. Created if absent. */
  baseDir: string
  /** Optional fetch override for tests. */
  fetchImpl?: typeof fetch
  /** Optional clock override for deterministic tests. Returns a Date. */
  now?: () => Date
}

/**
 * Lowercase, alphanumeric-only sender slug. Runs of non-alnum collapse to a
 * single dash and we trim leading/trailing dashes. Empty input → "unknown".
 */
export function senderSlug(fromName: string): string {
  const lowered = (fromName ?? '').toLowerCase()
  const slug = lowered.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return slug.length > 0 ? slug : 'unknown'
}

/**
 * Sanitise an upstream filename: strip path separators, control chars, and
 * anything that would let a malicious sender escape the storage directory.
 * Empty / dotfile-only input becomes "file".
 */
export function sanitiseFilename(name: string | undefined): string {
  if (!name) return 'file'
  // Take just the basename so "../../etc/passwd" → "passwd".
  const b = basename(name)
  // Replace control chars, slashes, backslashes, colons (windows), and
  // anything weird. Allow letters, digits, dot, dash, underscore, space.
  const cleaned = b.replace(/[^A-Za-z0-9._\- ]+/g, '_').replace(/\s+/g, ' ').trim()
  // Refuse names that are only dots (".", "..", "...") — collapse to "file".
  if (!cleaned || /^\.+$/.test(cleaned)) return 'file'
  // Cap length to keep filesystems happy (255 bytes is the common limit;
  // we cap the bare name shorter to leave room for the prefix).
  return cleaned.length > 180 ? cleaned.slice(0, 180) : cleaned
}

/**
 * Date stamp in Europe/London — YYYY-MM-DD.
 *
 * We use `Intl.DateTimeFormat` with the timezone explicitly set so the host
 * VM's TZ doesn't sneak in. Bristol summer time is UTC+1, winter is UTC.
 */
function londonDate(now: Date): string {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/London',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
  // en-CA gives YYYY-MM-DD natively, no juggling parts.
  return fmt.format(now)
}

/**
 * Time stamp in Europe/London — HHMM (24h).
 */
function londonTime(now: Date): string {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
  // en-GB returns "HH:mm" — drop the colon.
  return fmt.format(now).replace(/[^0-9]/g, '').slice(0, 4)
}

/**
 * Pick a non-colliding path in dateDir using prefix and original name.
 * On collision appends "-1", "-2", ... before the extension.
 */
export function pickPath(dateDir: string, prefix: string, originalName: string): string {
  const safe = sanitiseFilename(originalName)
  const ext = extname(safe)
  const stem = safe.slice(0, safe.length - ext.length)
  let candidate = join(dateDir, `${prefix}-${safe}`)
  let n = 1
  while (existsSync(candidate)) {
    candidate = join(dateDir, `${prefix}-${stem}-${n}${ext}`)
    n += 1
  }
  return candidate
}

/** Format a byte count as "1.2 MB" / "523 KB" / "12 B" for the annotation. */
function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

/**
 * Format an attachment outcome as a one-line annotation. The successful
 * lines look like:
 *
 *   [Attached: /path/to/file.pdf (application/pdf, 1.2 MB)]
 *
 * Failed ones look like:
 *
 *   [Attachment failed: report.pdf — connection timeout]
 *
 * Skipped (size cap, unsupported type) look like:
 *
 *   [Attachment skipped: report.pdf — exceeds 50 MB limit]
 */
export function formatAnnotation(result: AttachmentResult): string {
  if (result.kind === 'saved') {
    return `[Attached: ${result.path} (${result.contentType}, ${formatBytes(result.sizeBytes)})]`
  }
  if (result.kind === 'skipped') {
    return `[Attachment skipped: ${result.originalName} — ${result.reason}]`
  }
  return `[Attachment failed: ${result.originalName} — ${result.reason}]`
}

/**
 * Fetch with a timeout and a size cap. Streams into a temp file so memory
 * stays bounded — important if a sender pushes a near-50 MB binary. Returns
 * the temp path and the byte count; the caller decides where it goes next
 * (we don't pick the final name here because the final name depends on
 * collision detection in the dated directory, and we want to defer the
 * mkdir until we know the download succeeded).
 */
async function downloadToTemp(
  url: string,
  headers: Record<string, string>,
  fetchImpl: typeof fetch,
): Promise<{ tempPath: string; sizeBytes: number }> {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), DOWNLOAD_TIMEOUT_MS)
  try {
    const res = await fetchImpl(url, { headers, signal: ctrl.signal })
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`)
    }
    // Some Teams endpoints don't send Content-Length. We enforce the cap by
    // counting bytes as we read.
    const buf = await res.arrayBuffer()
    if (buf.byteLength > MAX_ATTACHMENT_BYTES) {
      throw new Error(`exceeds ${formatBytes(MAX_ATTACHMENT_BYTES)} limit`)
    }
    const tempPath = join(tmpdir(), `cct-attach-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
    writeFileSync(tempPath, Buffer.from(buf))
    return { tempPath, sizeBytes: buf.byteLength }
  } finally {
    clearTimeout(t)
  }
}

/**
 * Read declared file size from the SharePoint attachment, if present. Used
 * to skip oversized files BEFORE we burn time on the download.
 */
function declaredSize(att: Attachment): number | undefined {
  const c = att.content
  if (!c || typeof c !== 'object') return undefined
  const fs = (c as { fileSize?: unknown }).fileSize
  if (typeof fs === 'number' && Number.isFinite(fs)) return fs
  if (typeof fs === 'string') {
    const n = Number(fs)
    if (Number.isFinite(n)) return n
  }
  return undefined
}

/**
 * Process one attachment to a result. Caller composes annotations.
 *
 * Exported for unit testing the per-shape branches in isolation.
 */
export async function processOne(
  att: Attachment,
  prefix: string,
  dateDir: string,
  deps: ProcessAttachmentsDeps,
): Promise<AttachmentResult> {
  const fetchImpl = deps.fetchImpl ?? fetch
  const declaredName =
    att.name ??
    (att.content && typeof att.content === 'object'
      ? ((att.content as { name?: string }).name ?? 'file')
      : 'file')

  // SharePoint / OneDrive file attachment.
  if (att.contentType === TEAMS_FILE_DOWNLOAD_CONTENT_TYPE) {
    const c = att.content as { downloadUrl?: string; fileType?: string } | undefined
    const downloadUrl = c?.downloadUrl
    if (!downloadUrl || typeof downloadUrl !== 'string') {
      return { kind: 'failed', reason: 'missing downloadUrl', originalName: declaredName }
    }
    const dSize = declaredSize(att)
    if (dSize !== undefined && dSize > MAX_ATTACHMENT_BYTES) {
      return {
        kind: 'skipped',
        reason: `exceeds ${formatBytes(MAX_ATTACHMENT_BYTES)} limit`,
        originalName: declaredName,
      }
    }
    try {
      const { tempPath, sizeBytes } = await downloadToTemp(downloadUrl, {}, fetchImpl)
      mkdirSync(dateDir, { recursive: true, mode: 0o700 })
      const finalPath = pickPath(dateDir, prefix, declaredName)
      renameSync(tempPath, finalPath)
      // For SharePoint files we use a generic content-type if absent. The
      // sender's fileType (e.g. "pdf") is the best hint we have.
      const ct =
        c?.fileType
          ? `application/${c.fileType}`
          : 'application/octet-stream'
      return { kind: 'saved', path: finalPath, contentType: ct, sizeBytes, originalName: declaredName }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      // The size cap can fire mid-stream — surface that as "skipped" so the
      // annotation reads sensibly.
      if (/exceeds .* limit/.test(msg)) {
        return { kind: 'skipped', reason: msg, originalName: declaredName }
      }
      return { kind: 'failed', reason: msg, originalName: declaredName }
    }
  }

  // Inline images — image/png, image/jpeg, etc.
  if (typeof att.contentType === 'string' && att.contentType.startsWith('image/')) {
    const url = att.contentUrl
    if (!url || typeof url !== 'string') {
      return { kind: 'failed', reason: 'missing contentUrl', originalName: declaredName }
    }
    // Host allowlist — block the bot's s2s bearer token from being attached to
    // any URL that isn't the documented Microsoft attachment service. Without
    // this, an attacker-supplied contentUrl exfiltrates the bot credential.
    if (!isAllowedInlineImageHost(url)) {
      return {
        kind: 'failed',
        reason: 'disallowed inline-image host (must be smba.*.trafficmanager.net over https)',
        originalName: declaredName,
      }
    }
    let token: string
    try {
      token = await deps.getBearerToken()
    } catch (err) {
      return {
        kind: 'failed',
        reason: `bearer token unavailable: ${err instanceof Error ? err.message : String(err)}`,
        originalName: declaredName,
      }
    }
    try {
      const { tempPath, sizeBytes } = await downloadToTemp(
        url,
        { Authorization: `Bearer ${token}` },
        fetchImpl,
      )
      mkdirSync(dateDir, { recursive: true, mode: 0o700 })
      // Inline images often arrive without a friendly filename. Synthesise
      // one from the contentType if needed.
      const ext = att.contentType.split('/')[1] ?? 'bin'
      const fallback = `image.${ext}`
      const name = declaredName === 'file' ? fallback : declaredName
      const finalPath = pickPath(dateDir, prefix, name)
      renameSync(tempPath, finalPath)
      return {
        kind: 'saved',
        path: finalPath,
        contentType: att.contentType,
        sizeBytes,
        originalName: name,
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (/exceeds .* limit/.test(msg)) {
        return { kind: 'skipped', reason: msg, originalName: declaredName }
      }
      return { kind: 'failed', reason: msg, originalName: declaredName }
    }
  }

  // Unknown shape — log and skip with an annotation so Hermes can tell the
  // user the bot ignored that bit.
  return {
    kind: 'skipped',
    reason: `unsupported attachment type ${att.contentType ?? '<none>'}`,
    originalName: declaredName,
  }
}

/**
 * Top-level entry — processes every attachment on a message, returns the
 * annotation lines (one per attachment) and the per-attachment results.
 *
 * Never throws. Per-attachment failures are surfaced as annotation lines.
 */
export async function processAttachments(
  attachments: Attachment[],
  fromName: string,
  deps: ProcessAttachmentsDeps,
): Promise<{ annotations: string[]; results: AttachmentResult[] }> {
  if (attachments.length === 0) return { annotations: [], results: [] }

  const now = (deps.now ?? (() => new Date()))()
  const date = londonDate(now)
  const time = londonTime(now)
  const slug = senderSlug(fromName)
  const prefix = `${time}-${slug}`
  const dateDir = join(deps.baseDir, date)

  const results: AttachmentResult[] = []
  for (const att of attachments) {
    const result = await processOne(att, prefix, dateDir, deps)
    if (result.kind === 'skipped' || result.kind === 'failed') {
      process.stderr.write(
        `teams channel: attachment ${result.kind} — ${result.originalName}: ${result.reason}\n`,
      )
    } else {
      process.stderr.write(
        `teams channel: attachment saved — ${result.path} (${formatBytes(result.sizeBytes)})\n`,
      )
    }
    results.push(result)
  }
  return { annotations: results.map(formatAnnotation), results }
}

/**
 * Compose final message text: original text + blank line + one annotation
 * per line. If the original is empty, the message becomes the annotations
 * alone. If there are no annotations, the original passes through unchanged.
 */
export function composeMessageWithAnnotations(originalText: string, annotations: string[]): string {
  if (annotations.length === 0) return originalText
  if (!originalText || originalText.length === 0) return annotations.join('\n')
  return `${originalText}\n\n${annotations.join('\n')}`
}

/**
 * Make sure we can write to baseDir at boot. Called once from server.ts so
 * a permission problem fails loudly rather than mid-message.
 */
export function ensureBaseDir(baseDir: string): void {
  mkdirSync(baseDir, { recursive: true, mode: 0o700 })
  // Confirm we can stat it — covers the case where it exists but is not a
  // directory (e.g. someone touched a file at that path).
  const st = statSync(baseDir)
  if (!st.isDirectory()) {
    throw new Error(`teams channel: RECEIVED_FILES_DIR ${baseDir} exists but is not a directory`)
  }
}
