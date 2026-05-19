/**
 * Outbox tests — token store + filesystem management for outbound files.
 *
 * Each test gets its own temp outbox dir to keep state isolated.
 */

import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { createOutbox } from '../src/teams/outbox'

let dir: string

beforeEach(() => {
  dir = join(tmpdir(), `cct-outbox-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
})

afterEach(() => {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {}
})

describe('outbox', () => {
  test('mints a token and writes the file into a token-scoped subdirectory', async () => {
    const outbox = createOutbox({
      dir,
      ttlSeconds: 60,
      safetyRoot: tmpdir(),
    })
    const entry = await outbox.mint({
      content: Buffer.from('hello forge'),
      filename: 'note.txt',
      mime: 'text/plain',
    })
    expect(entry.token).toBeString()
    expect(entry.token.length).toBeGreaterThan(20)
    expect(entry.filename).toBe('note.txt')
    expect(entry.mime).toBe('text/plain')
    expect(entry.sizeBytes).toBe(11)
    // File is on disk inside a directory named after the token.
    const expected = join(dir, entry.token, 'note.txt')
    expect(existsSync(expected)).toBe(true)
    expect(readFileSync(expected, 'utf8')).toBe('hello forge')
  })

  test('lookup returns the entry while the token is live', async () => {
    const outbox = createOutbox({ dir, ttlSeconds: 60, safetyRoot: tmpdir() })
    const minted = await outbox.mint({
      content: Buffer.from('payload'),
      filename: 'a.txt',
      mime: 'text/plain',
    })
    const looked = outbox.lookup(minted.token)
    expect(looked).toBeDefined()
    expect(looked?.filename).toBe('a.txt')
    expect(looked?.path).toBe(join(dir, minted.token, 'a.txt'))
  })

  test('read returns the entry with file content and leaves the token live for repeat reads', async () => {
    const outbox = createOutbox({ dir, ttlSeconds: 60, safetyRoot: tmpdir() })
    const minted = await outbox.mint({
      content: Buffer.from('once'),
      filename: 'x.bin',
      mime: 'application/octet-stream',
    })
    const first = outbox.read(minted.token)
    expect(first).toBeDefined()
    expect(first?.filename).toBe('x.bin')
    expect(first?.mime).toBe('application/octet-stream')
    expect(first?.sizeBytes).toBe(4)
    expect(first?.content.toString('utf8')).toBe('once')
    // File and directory still present — multi-use within TTL.
    expect(existsSync(join(dir, minted.token, 'x.bin'))).toBe(true)
    // Second read returns the same content.
    const second = outbox.read(minted.token)
    expect(second?.content.toString('utf8')).toBe('once')
    // Lookup still finds the entry.
    expect(outbox.lookup(minted.token)?.filename).toBe('x.bin')
  })

  test('read returns undefined after TTL expires and cleans up the file', async () => {
    const outbox = createOutbox({ dir, ttlSeconds: 0.05, safetyRoot: tmpdir() })
    const minted = await outbox.mint({
      content: Buffer.from('decay'),
      filename: 'fade.txt',
      mime: 'text/plain',
    })
    await new Promise(r => setTimeout(r, 100))
    expect(outbox.read(minted.token)).toBeUndefined()
    expect(existsSync(join(dir, minted.token, 'fade.txt'))).toBe(false)
  })

  test('lookup returns undefined for an expired token and cleans up the file', async () => {
    const outbox = createOutbox({
      dir,
      ttlSeconds: 0.05,
      safetyRoot: tmpdir(),
    })
    const minted = await outbox.mint({
      content: Buffer.from('decayed'),
      filename: 'old.txt',
      mime: 'text/plain',
    })
    await new Promise(r => setTimeout(r, 100))
    expect(outbox.lookup(minted.token)).toBeUndefined()
    // File on disk should also be cleaned up by the lookup-time check.
    expect(existsSync(join(dir, minted.token, 'old.txt'))).toBe(false)
  })

  test('rejects mint when the payload exceeds the 50 MB cap', async () => {
    const outbox = createOutbox({ dir, ttlSeconds: 60, safetyRoot: tmpdir() })
    // 51 MB
    const big = Buffer.alloc(51 * 1024 * 1024)
    await expect(
      outbox.mint({ content: big, filename: 'huge.bin', mime: 'application/octet-stream' }),
    ).rejects.toThrow(/50 MB/)
    // Nothing left on disk.
    expect(existsSync(dir) ? require('fs').readdirSync(dir).length : 0).toBe(0)
  })

  test('refuses to construct when outbox dir falls outside safetyRoot', () => {
    expect(() =>
      createOutbox({
        dir: '/etc/outbox',
        ttlSeconds: 60,
        safetyRoot: '/home/ccuser/workspace/',
      }),
    ).toThrow(/outside the sendable-files root/)
  })

  test('initialise() wipes the outbox dir contents and recreates it 0700', async () => {
    mkdirSync(dir, { recursive: true })
    const stale = join(dir, 'left-over.txt')
    writeFileSync(stale, 'from previous boot')
    expect(existsSync(stale)).toBe(true)

    const outbox = createOutbox({ dir, ttlSeconds: 60, safetyRoot: tmpdir() })
    await outbox.initialise()

    expect(existsSync(stale)).toBe(false)
    expect(existsSync(dir)).toBe(true)
  })

  test('shutdown() stops the sweeper without throwing', async () => {
    const outbox = createOutbox({ dir, ttlSeconds: 60, safetyRoot: tmpdir() })
    await outbox.initialise()
    expect(() => outbox.shutdown()).not.toThrow()
  })

  test('sweeper deletes expired entries on its own schedule', async () => {
    const outbox = createOutbox({
      dir,
      ttlSeconds: 0.05,
      safetyRoot: tmpdir(),
      sweepIntervalMs: 30,
    })
    await outbox.initialise()
    const minted = await outbox.mint({
      content: Buffer.from('decayed'),
      filename: 'old.txt',
      mime: 'text/plain',
    })
    await new Promise(r => setTimeout(r, 200))
    // Sweeper should have removed the entry by now without anyone calling lookup.
    expect(existsSync(join(dir, minted.token, 'old.txt'))).toBe(false)
    outbox.shutdown()
  })
})

describe('outbox path allow-root check', () => {
  test('isPathAllowed returns true for files under the allow-root', () => {
    // Mount the outbox under the same root we're testing isPathAllowed against.
    const root = join(tmpdir(), 'cct-allow-root-true')
    mkdirSync(root, { recursive: true })
    const outbox = createOutbox({ dir: join(root, 'outbox'), ttlSeconds: 60, safetyRoot: root })
    expect(outbox.isPathAllowed(join(root, 'file.txt'))).toBe(true)
    expect(outbox.isPathAllowed(join(root, 'sub', 'file.txt'))).toBe(true)
    rmSync(root, { recursive: true, force: true })
  })

  test('isPathAllowed returns false for files outside the allow-root', () => {
    const root = join(tmpdir(), 'cct-allow-root-false')
    mkdirSync(root, { recursive: true })
    const outbox = createOutbox({ dir: join(root, 'outbox'), ttlSeconds: 60, safetyRoot: root })
    expect(outbox.isPathAllowed('/etc/shadow')).toBe(false)
    expect(outbox.isPathAllowed(join(root, '..', '..', 'etc', 'shadow'))).toBe(false)
    rmSync(root, { recursive: true, force: true })
  })
})
