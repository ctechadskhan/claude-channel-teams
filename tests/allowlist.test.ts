/**
 * Allowlist module tests.
 *
 * Covers: initialisation, atomic add, duplicate-add (idempotent), remove,
 * case-insensitive compare, and the malformed-ID refusal.
 */

import { describe, expect, test, beforeEach } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createAllowlist } from '../src/pairing/allowlist'

const FIXTURE_ID = '00000000-0000-4000-8000-000000000001'
const ANOTHER_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'

describe('allowlist', () => {
  let dir: string
  let file: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cct-allowlist-'))
    file = join(dir, 'allowlist.json')
  })

  test('creates empty file on first boot', () => {
    const al = createAllowlist(file)
    expect(al.listEntries()).toEqual([])
    expect(readFileSync(file, 'utf8')).toContain('"version": 1')
    // File mode should be 0600 — credentials-adjacent.
    const mode = statSync(file).mode & 0o777
    expect(mode).toBe(0o600)
    rmSync(dir, { recursive: true })
  })

  test('isAllowed is case-insensitive', () => {
    const al = createAllowlist(file)
    al.addEntry(FIXTURE_ID.toLowerCase())
    expect(al.isAllowed(FIXTURE_ID.toUpperCase())).toBe(true)
    expect(al.isAllowed(ANOTHER_ID)).toBe(false)
    rmSync(dir, { recursive: true })
  })

  test('addEntry is idempotent (replace, not duplicate)', () => {
    const al = createAllowlist(file)
    al.addEntry(FIXTURE_ID, 'first note')
    al.addEntry(FIXTURE_ID, 'updated')
    const entries = al.listEntries()
    expect(entries.length).toBe(1)
    expect(entries[0]?.note).toBe('updated')
    rmSync(dir, { recursive: true })
  })

  test('removeEntry returns true when removed, false when absent', () => {
    const al = createAllowlist(file)
    al.addEntry(FIXTURE_ID)
    expect(al.removeEntry(FIXTURE_ID.toUpperCase())).toBe(true)
    expect(al.isAllowed(FIXTURE_ID)).toBe(false)
    expect(al.removeEntry(FIXTURE_ID)).toBe(false)
    rmSync(dir, { recursive: true })
  })

  test('refuses malformed AAD Object ID', () => {
    const al = createAllowlist(file)
    expect(() => al.addEntry('not a guid')).toThrow(/refusing/)
    rmSync(dir, { recursive: true })
  })

  test('rejects unknown sender, allows fixture sender after seeding', () => {
    const al = createAllowlist(file)
    expect(al.isAllowed(FIXTURE_ID)).toBe(false)
    al.addEntry(FIXTURE_ID)
    expect(al.isAllowed(FIXTURE_ID)).toBe(true)
    rmSync(dir, { recursive: true })
  })
})
