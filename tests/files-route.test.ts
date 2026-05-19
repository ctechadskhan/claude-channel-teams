/**
 * /files/<token> HTTP route tests.
 *
 * We avoid spinning up a real Bun.serve listener by exposing the route
 * handler as a pure function and exercising it directly. The integration
 * with the listener is covered implicitly because the same handler is
 * what `startListener` mounts.
 */

import { describe, expect, test } from 'bun:test'
import { handleFilesRequest } from '../src/teams/filesRoute'
import type { Outbox, ConsumedEntry } from '../src/teams/outbox'

function makeOutboxStub(opts: { entry?: ConsumedEntry; consumed: string[] }): Outbox {
  return {
    async initialise() {},
    shutdown() {},
    async mint() {
      throw new Error('mint not implemented in stub')
    },
    lookup() {
      return undefined
    },
    read(token: string) {
      opts.consumed.push(token)
      return opts.entry
    },
    isPathAllowed() {
      return true
    },
  }
}

describe('/files/<token>', () => {
  test('returns 200 with the file body and Content-Disposition for a live token', async () => {
    const consumed: string[] = []
    const outbox = makeOutboxStub({
      entry: {
        filename: 'brief.pdf',
        mime: 'application/pdf',
        sizeBytes: 7,
        content: Buffer.from('PDF-DAT'),
      },
      consumed,
    })
    const req = new Request('https://hermes.vcshosted.uk/files/abc123', { method: 'GET' })
    const res = await handleFilesRequest(req, outbox)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/pdf')
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="brief.pdf"')
    expect(res.headers.get('content-length')).toBe('7')
    expect(await res.text()).toBe('PDF-DAT')
    expect(consumed).toEqual(['abc123'])
  })

  test('returns 410 Gone for an unknown or expired token', async () => {
    const consumed: string[] = []
    const outbox = makeOutboxStub({ consumed })
    const req = new Request('https://hermes.vcshosted.uk/files/never', { method: 'GET' })
    const res = await handleFilesRequest(req, outbox)
    expect(res.status).toBe(410)
    expect(consumed).toEqual(['never'])
  })

  test('strips query string from the token segment', async () => {
    const consumed: string[] = []
    const outbox = makeOutboxStub({ consumed })
    const req = new Request('https://hermes.vcshosted.uk/files/clean?download=true&v=1', {
      method: 'GET',
    })
    await handleFilesRequest(req, outbox)
    expect(consumed).toEqual(['clean'])
  })

  test('returns 405 for non-GET/HEAD methods', async () => {
    const outbox = makeOutboxStub({ consumed: [] })
    const req = new Request('https://hermes.vcshosted.uk/files/abc', { method: 'POST' })
    const res = await handleFilesRequest(req, outbox)
    expect(res.status).toBe(405)
  })

  test('HEAD returns 200 with headers but no body for a live token', async () => {
    const consumed: string[] = []
    const outbox = makeOutboxStub({
      entry: {
        filename: 'note.txt',
        mime: 'text/plain',
        sizeBytes: 4,
        content: Buffer.from('hi!\n'),
      },
      consumed,
    })
    const req = new Request('https://hermes.vcshosted.uk/files/abc', { method: 'HEAD' })
    const res = await handleFilesRequest(req, outbox)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/plain')
    expect(res.headers.get('content-length')).toBe('4')
    expect((await res.arrayBuffer()).byteLength).toBe(0)
  })

  test('rejects a malformed path with 404', async () => {
    const outbox = makeOutboxStub({ consumed: [] })
    const req = new Request('https://hermes.vcshosted.uk/files/', { method: 'GET' })
    const res = await handleFilesRequest(req, outbox)
    expect(res.status).toBe(404)
  })

  test('refuses tokens with path traversal characters', async () => {
    const consumed: string[] = []
    const outbox = makeOutboxStub({ consumed })
    const req = new Request('https://hermes.vcshosted.uk/files/..%2Fetc%2Fpasswd', {
      method: 'GET',
    })
    const res = await handleFilesRequest(req, outbox)
    expect(res.status).toBe(404)
    expect(consumed).toEqual([])
  })
})
