/**
 * Attachment-handling tests.
 *
 * Two layers:
 *   1. Pure helpers (senderSlug, sanitiseFilename, pickPath, composeMessageWithAnnotations).
 *   2. processAttachments end-to-end with a fake `fetch` injected — covers
 *      the SharePoint download, inline-image bearer-token path, size-limit
 *      refusal, collision suffixing, download failure, and the empty-text
 *      file-only message composition.
 */

import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { Attachment } from 'botframework-schema'

import {
  composeMessageWithAnnotations,
  ensureBaseDir,
  formatAnnotation,
  MAX_ATTACHMENT_BYTES,
  pickPath,
  processAttachments,
  sanitiseFilename,
  senderSlug,
} from '../src/teams/attachments'

const FIXED_NOW = new Date('2026-05-18T19:43:00Z') // 20:43 BST in London

function makeFetch(handlers: Record<string, (req: { url: string; headers: Record<string, string> }) => Response>): typeof fetch {
  // Map URL → handler. Default to 404 so a typo blows up loudly.
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const u = typeof url === 'string' ? url : (url as URL).toString?.() ?? String(url)
    const headers: Record<string, string> = {}
    if (init?.headers) {
      const h = init.headers as Record<string, string>
      for (const k of Object.keys(h)) headers[k] = h[k] as string
    }
    const handler = handlers[u]
    if (!handler) return new Response('not found', { status: 404 })
    return handler({ url: u, headers })
  }) as unknown as typeof fetch
}

describe('senderSlug', () => {
  test('lowercases and collapses non-alnum runs to dashes', () => {
    expect(senderSlug('Adnan Khan')).toBe('adnan-khan')
    expect(senderSlug("O'Reilly,  Sam")).toBe('o-reilly-sam')
    expect(senderSlug('---Test---')).toBe('test')
  })
  test('empty / weird input falls back to "unknown"', () => {
    expect(senderSlug('')).toBe('unknown')
    expect(senderSlug('@@@@')).toBe('unknown')
  })
})

describe('sanitiseFilename', () => {
  test('strips path separators and refuses traversal', () => {
    expect(sanitiseFilename('../../etc/passwd')).toBe('passwd')
    expect(sanitiseFilename('a/b/c.pdf')).toBe('c.pdf')
  })
  test('keeps unicode-free, alnum-ish names intact', () => {
    expect(sanitiseFilename('report v2.pdf')).toBe('report v2.pdf')
  })
  test('replaces control / weird chars with underscore', () => {
    expect(sanitiseFilename('weird:name?.pdf')).toBe('weird_name_.pdf')
  })
  test('empty / dots-only input becomes "file"', () => {
    expect(sanitiseFilename(undefined)).toBe('file')
    expect(sanitiseFilename('')).toBe('file')
    expect(sanitiseFilename('...')).toBe('file')
  })
})

describe('pickPath', () => {
  let baseDir: string
  beforeEach(() => { baseDir = mkdtempSync(join(tmpdir(), 'cct-pickpath-')) })
  afterEach(() => { rmSync(baseDir, { recursive: true, force: true }) })

  test('returns straight path when no collision', () => {
    const p = pickPath(baseDir, '1943-adnan-khan', 'report.pdf')
    expect(p).toBe(join(baseDir, '1943-adnan-khan-report.pdf'))
  })

  test('appends -1, -2 on collisions', () => {
    writeFileSync(join(baseDir, '1943-adnan-khan-report.pdf'), 'x')
    const p1 = pickPath(baseDir, '1943-adnan-khan', 'report.pdf')
    expect(p1).toBe(join(baseDir, '1943-adnan-khan-report-1.pdf'))
    writeFileSync(p1, 'y')
    const p2 = pickPath(baseDir, '1943-adnan-khan', 'report.pdf')
    expect(p2).toBe(join(baseDir, '1943-adnan-khan-report-2.pdf'))
  })

  test('handles files without an extension', () => {
    writeFileSync(join(baseDir, '1943-adnan-khan-notes'), 'x')
    const p = pickPath(baseDir, '1943-adnan-khan', 'notes')
    expect(p).toBe(join(baseDir, '1943-adnan-khan-notes-1'))
  })
})

describe('composeMessageWithAnnotations', () => {
  test('returns text unchanged when no annotations', () => {
    expect(composeMessageWithAnnotations('hi', [])).toBe('hi')
  })
  test('appends annotations after a blank line', () => {
    expect(composeMessageWithAnnotations('look at this', ['[Attached: /tmp/x.pdf (application/pdf, 1.0 KB)]']))
      .toBe('look at this\n\n[Attached: /tmp/x.pdf (application/pdf, 1.0 KB)]')
  })
  test('returns just annotations when text is empty (file-only message)', () => {
    expect(composeMessageWithAnnotations('', ['[Attached: /tmp/x.pdf (application/pdf, 1.0 KB)]']))
      .toBe('[Attached: /tmp/x.pdf (application/pdf, 1.0 KB)]')
  })
})

describe('processAttachments — SharePoint file download', () => {
  let baseDir: string
  beforeEach(() => { baseDir = mkdtempSync(join(tmpdir(), 'cct-att-')) })
  afterEach(() => { rmSync(baseDir, { recursive: true, force: true }) })

  test('downloads, saves with prefixed path, returns saved annotation', async () => {
    const downloadUrl = 'https://sp.example/download/xyz'
    const fetchImpl = makeFetch({
      [downloadUrl]: () => new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 }),
    })
    const att: Attachment = {
      contentType: 'application/vnd.microsoft.teams.file.download.info',
      name: 'report.pdf',
      content: { downloadUrl, fileType: 'pdf', uniqueId: 'abc' },
    } as Attachment

    const { annotations, results } = await processAttachments([att], 'Adnan Khan', {
      baseDir,
      fetchImpl,
      getBearerToken: async () => 'never-called',
      now: () => FIXED_NOW,
    })

    expect(results.length).toBe(1)
    expect(results[0]!.kind).toBe('saved')
    const saved = results[0] as { kind: 'saved'; path: string; sizeBytes: number; contentType: string }
    expect(saved.path).toBe(join(baseDir, '2026-05-18', '2043-adnan-khan-report.pdf'))
    expect(saved.sizeBytes).toBe(4)
    expect(saved.contentType).toBe('application/pdf')
    expect(existsSync(saved.path)).toBe(true)
    expect(readFileSync(saved.path)).toEqual(Buffer.from([1, 2, 3, 4]))
    expect(annotations[0]).toContain('[Attached:')
    expect(annotations[0]).toContain('2043-adnan-khan-report.pdf')
  })

  test('skips when declared fileSize exceeds the 50 MB cap', async () => {
    let fetched = false
    const fetchImpl = makeFetch({})
    const att: Attachment = {
      contentType: 'application/vnd.microsoft.teams.file.download.info',
      name: 'huge.bin',
      content: {
        downloadUrl: 'https://sp.example/will/not/be/fetched',
        fileType: 'bin',
        fileSize: MAX_ATTACHMENT_BYTES + 1,
      },
    } as Attachment
    const wrappedFetch = (async (...args: Parameters<typeof fetch>) => {
      fetched = true
      return fetchImpl(...args)
    }) as typeof fetch

    const { annotations, results } = await processAttachments([att], 'Adnan Khan', {
      baseDir,
      fetchImpl: wrappedFetch,
      getBearerToken: async () => '',
      now: () => FIXED_NOW,
    })
    expect(fetched).toBe(false)
    expect(results[0]!.kind).toBe('skipped')
    expect(annotations[0]).toContain('[Attachment skipped:')
    expect(annotations[0]).toContain('exceeds 50.0 MB limit')
  })

  test('returns failed annotation when fetch errors (no message dropped)', async () => {
    const att: Attachment = {
      contentType: 'application/vnd.microsoft.teams.file.download.info',
      name: 'flaky.pdf',
      content: { downloadUrl: 'https://sp.example/will-503', fileType: 'pdf' },
    } as Attachment
    const fetchImpl = makeFetch({
      'https://sp.example/will-503': () => new Response('boom', { status: 503 }),
    })
    const { annotations, results } = await processAttachments([att], 'Adnan Khan', {
      baseDir,
      fetchImpl,
      getBearerToken: async () => '',
      now: () => FIXED_NOW,
    })
    expect(results[0]!.kind).toBe('failed')
    expect(annotations[0]).toContain('[Attachment failed: flaky.pdf')
    expect(annotations[0]).toContain('HTTP 503')
  })

  test('collision suffix — two same-named files in the same minute land on -1', async () => {
    const url = 'https://sp.example/dup'
    const fetchImpl = makeFetch({
      [url]: () => new Response(new Uint8Array([9]), { status: 200 }),
    })
    const att = (): Attachment => ({
      contentType: 'application/vnd.microsoft.teams.file.download.info',
      name: 'notes.txt',
      content: { downloadUrl: url, fileType: 'txt' },
    }) as Attachment
    const opts = {
      baseDir,
      fetchImpl,
      getBearerToken: async () => '',
      now: () => FIXED_NOW,
    }
    const r1 = await processAttachments([att()], 'Adnan Khan', opts)
    const r2 = await processAttachments([att()], 'Adnan Khan', opts)
    expect((r1.results[0] as any).path).toBe(join(baseDir, '2026-05-18', '2043-adnan-khan-notes.txt'))
    expect((r2.results[0] as any).path).toBe(join(baseDir, '2026-05-18', '2043-adnan-khan-notes-1.txt'))
  })
})

describe('processAttachments — inline image with bearer token', () => {
  let baseDir: string
  beforeEach(() => { baseDir = mkdtempSync(join(tmpdir(), 'cct-att-img-')) })
  afterEach(() => { rmSync(baseDir, { recursive: true, force: true }) })

  test('sends Authorization: Bearer header and saves under image/png contentType', async () => {
    const imageUrl = 'https://smba.trafficmanager.net/uk/v3/attachments/abc/views/original'
    let observedAuth: string | undefined
    const fetchImpl = makeFetch({
      [imageUrl]: ({ headers }) => {
        observedAuth = headers['Authorization'] ?? headers['authorization']
        return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), { status: 200 })
      },
    })
    const att: Attachment = {
      contentType: 'image/png',
      contentUrl: imageUrl,
    } as Attachment

    const { annotations, results } = await processAttachments([att], 'Adnan Khan', {
      baseDir,
      fetchImpl,
      getBearerToken: async () => 'TEST-BEARER-TOKEN',
      now: () => FIXED_NOW,
    })

    expect(observedAuth).toBe('Bearer TEST-BEARER-TOKEN')
    expect(results[0]!.kind).toBe('saved')
    const saved = results[0] as { path: string; contentType: string }
    expect(saved.contentType).toBe('image/png')
    // Filename synthesised from contentType since the attachment had no name.
    expect(saved.path).toMatch(/2043-adnan-khan-image\.png$/)
    expect(annotations[0]).toContain('image/png')
  })

  test('annotates failure when getBearerToken throws', async () => {
    const att: Attachment = {
      contentType: 'image/jpeg',
      contentUrl: 'https://smba.trafficmanager.net/uk/v3/attachments/x/views/original',
    } as Attachment
    const fetchImpl = makeFetch({})
    const { annotations, results } = await processAttachments([att], 'Adnan Khan', {
      baseDir,
      fetchImpl,
      getBearerToken: async () => { throw new Error('token endpoint down') },
      now: () => FIXED_NOW,
    })
    expect(results[0]!.kind).toBe('failed')
    expect(annotations[0]).toContain('bearer token unavailable')
    expect(annotations[0]).toContain('token endpoint down')
  })
})

describe('processAttachments — bearer-token host gate', () => {
  let baseDir: string
  beforeEach(() => { baseDir = mkdtempSync(join(tmpdir(), 'cct-att-host-')) })
  afterEach(() => { rmSync(baseDir, { recursive: true, force: true }) })

  test('refuses to fetch an inline image with bearer when the host is not a Microsoft attachment host', async () => {
    let bearerSent: string | undefined
    let fetchedUrl: string | undefined
    const fetchImpl = makeFetch({
      'https://attacker.example.com/collect': ({ url, headers }) => {
        fetchedUrl = url
        bearerSent = headers['Authorization'] ?? headers['authorization']
        return new Response('captured', { status: 200 })
      },
    })

    const att: Attachment = {
      contentType: 'image/png',
      contentUrl: 'https://attacker.example.com/collect',
    } as Attachment

    let tokenWasRequested = false
    const { annotations, results } = await processAttachments([att], 'Adnan Khan', {
      baseDir,
      fetchImpl,
      getBearerToken: async () => {
        tokenWasRequested = true
        return 'SECRET-BOT-TOKEN'
      },
      now: () => FIXED_NOW,
    })

    expect(results[0]!.kind).toBe('failed')
    // The attacker URL must NOT have been fetched and the token must NOT have leaked.
    expect(fetchedUrl).toBeUndefined()
    expect(bearerSent).toBeUndefined()
    // We also avoid calling getBearerToken at all when the host is bad.
    expect(tokenWasRequested).toBe(false)
    expect(annotations[0]?.toLowerCase()).toMatch(/host|allow|disallow/)
  })

  test('refuses an http:// (non-TLS) image URL even on a Microsoft host', async () => {
    const fetchImpl = makeFetch({})
    const att: Attachment = {
      contentType: 'image/png',
      contentUrl: 'http://smba.trafficmanager.net/uk/v3/attachments/x',
    } as Attachment
    const { results } = await processAttachments([att], 'Adnan Khan', {
      baseDir,
      fetchImpl,
      getBearerToken: async () => 'TOKEN',
      now: () => FIXED_NOW,
    })
    expect(results[0]!.kind).toBe('failed')
  })

  test('refuses an image URL with a non-allowlisted trafficmanager.net subdomain', async () => {
    const fetchImpl = makeFetch({})
    const att: Attachment = {
      contentType: 'image/png',
      // Anyone can register an Azure Traffic Manager profile; only smba.* is the
      // documented Bot Framework attachment service prefix.
      contentUrl: 'https://attacker.trafficmanager.net/x',
    } as Attachment
    const { results } = await processAttachments([att], 'Adnan Khan', {
      baseDir,
      fetchImpl,
      getBearerToken: async () => 'TOKEN',
      now: () => FIXED_NOW,
    })
    expect(results[0]!.kind).toBe('failed')
  })

  test('allows smba.<region>.trafficmanager.net hosts', async () => {
    const url = 'https://smba.uk.trafficmanager.net/v3/attachments/x/views/original'
    const fetchImpl = makeFetch({
      [url]: () => new Response(new Uint8Array([1, 2, 3]), { status: 200 }),
    })
    const att: Attachment = {
      contentType: 'image/png',
      contentUrl: url,
    } as Attachment
    const { results } = await processAttachments([att], 'Adnan Khan', {
      baseDir,
      fetchImpl,
      getBearerToken: async () => 'TOKEN',
      now: () => FIXED_NOW,
    })
    expect(results[0]!.kind).toBe('saved')
  })
})

describe('processAttachments — unsupported types and edge cases', () => {
  let baseDir: string
  beforeEach(() => { baseDir = mkdtempSync(join(tmpdir(), 'cct-att-misc-')) })
  afterEach(() => { rmSync(baseDir, { recursive: true, force: true }) })

  test('skips an unknown attachment type with a note', async () => {
    const att: Attachment = {
      contentType: 'application/vnd.microsoft.card.adaptive',
      content: { type: 'AdaptiveCard' },
    } as Attachment
    const { annotations, results } = await processAttachments([att], 'Adnan Khan', {
      baseDir,
      fetchImpl: (() => new Response('', { status: 404 })) as unknown as typeof fetch,
      getBearerToken: async () => '',
      now: () => FIXED_NOW,
    })
    expect(results[0]!.kind).toBe('skipped')
    expect(annotations[0]).toContain('unsupported attachment type')
  })

  test('formatAnnotation shapes — saved / skipped / failed', () => {
    expect(formatAnnotation({ kind: 'saved', path: '/tmp/x.pdf', contentType: 'application/pdf', sizeBytes: 1024, originalName: 'x.pdf' }))
      .toBe('[Attached: /tmp/x.pdf (application/pdf, 1.0 KB)]')
    expect(formatAnnotation({ kind: 'skipped', reason: 'foo', originalName: 'y.bin' }))
      .toBe('[Attachment skipped: y.bin — foo]')
    expect(formatAnnotation({ kind: 'failed', reason: 'bar', originalName: 'z.zip' }))
      .toBe('[Attachment failed: z.zip — bar]')
  })
})

describe('ensureBaseDir', () => {
  test('creates a missing directory, no-op when present', () => {
    const dir = join(tmpdir(), `cct-base-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
    expect(existsSync(dir)).toBe(false)
    ensureBaseDir(dir)
    expect(existsSync(dir)).toBe(true)
    // Second call is fine.
    ensureBaseDir(dir)
    rmSync(dir, { recursive: true })
  })

  test('throws when the path exists but is not a directory', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'cct-base-not-dir-'))
    const filePath = join(tmp, 'not-a-dir')
    writeFileSync(filePath, 'x')
    // mkdirSync with recursive will throw EEXIST against a regular file —
    // either error is acceptable as long as ensureBaseDir refuses to
    // proceed. We assert it throws SOMETHING rather than silently passing.
    expect(() => ensureBaseDir(filePath)).toThrow()
    rmSync(tmp, { recursive: true })
  })
})
