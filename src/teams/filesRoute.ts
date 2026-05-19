/**
 * `/files/<token>` HTTP handler.
 *
 * Multi-use-within-TTL download endpoint. The token in the path is the
 * secret; while it's live (default 30 min), any GET serves the file.
 * Expired or unknown tokens get 410 Gone.
 *
 * Multi-use is the pragmatic shape because Microsoft's link-safety
 * infrastructure pre-fetches every URL server-side before the recipient
 * sees the card — a single-use token gets consumed by that preview
 * before the user can click. The 256-bit token + short TTL is the
 * security model. See docs/specs/2026-05-19-outbound-file-transfers.md.
 */

import type { Outbox } from './outbox.js'

/** Tokens are URL-safe base64 (`base64url`). No path separators or escapes. */
const TOKEN_RE = /^[A-Za-z0-9_-]+$/

export async function handleFilesRequest(req: Request, outbox: Outbox): Promise<Response> {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return new Response('method not allowed', { status: 405 })
  }

  const url = new URL(req.url)
  // Pathname will be "/files/<token>" — discard the leading "/files/" and
  // refuse anything weird (further path segments, percent-encoded slashes,
  // empty token).
  const prefix = '/files/'
  if (!url.pathname.startsWith(prefix)) {
    return new Response('not found', { status: 404 })
  }
  const tail = url.pathname.slice(prefix.length)
  if (tail.length === 0 || !TOKEN_RE.test(tail)) {
    return new Response('not found', { status: 404 })
  }

  const entry = outbox.read(tail)
  if (!entry) {
    return new Response('gone', { status: 410 })
  }

  const headers = new Headers({
    'content-type': entry.mime,
    'content-disposition': `attachment; filename="${entry.filename.replace(/"/g, '\\"')}"`,
    'content-length': String(entry.sizeBytes),
    'cache-control': 'no-store',
  })

  if (req.method === 'HEAD') {
    return new Response(null, { status: 200, headers })
  }
  // The DOM type for BodyInit is strict about ArrayBufferLike generics, so
  // we cast to bypass a benign type-system mismatch — Bun accepts Buffer
  // here at runtime.
  return new Response(entry.content as unknown as BodyInit, { status: 200, headers })
}
