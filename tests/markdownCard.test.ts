/**
 * Markdown → Adaptive Card renderer tests.
 *
 * The contract under test: simple prose returns null (caller sends plain
 * text), structured markdown returns a card whose body preserves the
 * structure Teams text messages would strip.
 */

import { describe, expect, test } from 'bun:test'
import { markdownToAdaptiveCard, needsCard } from '../src/teams/markdownCard'

function bodyOf(md: string) {
  const r = markdownToAdaptiveCard(md)
  expect(r).not.toBeNull()
  return r!.attachment.content.body as any[]
}

describe('needsCard', () => {
  test('single paragraph of prose does not need a card', () => {
    expect(needsCard('Done — the brief is queued for 7am.')).toBe(false)
  })

  test('bold and links alone do not need a card', () => {
    expect(needsCard('All **nine** tickets closed — see [the board](https://example.com).')).toBe(false)
  })

  test('two paragraphs need a card', () => {
    expect(needsCard('First paragraph.\n\nSecond paragraph.')).toBe(true)
  })

  test('lists, headings, fences, quotes, tables all need a card', () => {
    expect(needsCard('- one\n- two')).toBe(true)
    expect(needsCard('## Section')).toBe(true)
    expect(needsCard('```\ncode\n```')).toBe(true)
    expect(needsCard('> quoted')).toBe(true)
    expect(needsCard('| a | b |')).toBe(true)
  })
})

describe('markdownToAdaptiveCard', () => {
  test('returns null for simple prose', () => {
    expect(markdownToAdaptiveCard('Just a short answer.')).toBeNull()
  })

  test('renders headings with weight and size', () => {
    const body = bodyOf('## Status\n\nAll good.')
    expect(body[0]).toMatchObject({ type: 'TextBlock', text: 'Status', weight: 'Bolder', size: 'Medium' })
    expect(body[1]).toMatchObject({ type: 'TextBlock', text: 'All good.' })
  })

  test('keeps list markdown in a single TextBlock for native bullets', () => {
    const body = bodyOf('Findings:\n\n- first\n- second\n1. third')
    const list = body.find(b => typeof b.text === 'string' && b.text.includes('- first'))
    expect(list).toBeDefined()
    expect(list.text).toBe('- first\n- second\n1. third')
  })

  test('code fences become monospace containers, content verbatim', () => {
    const body = bodyOf('Run this:\n\n```\nGet-CsOnlineUser -Identity ads\n```')
    const container = body.find(b => b.type === 'Container')
    expect(container.items[0]).toMatchObject({
      fontType: 'Monospace',
      text: 'Get-CsOnlineUser -Identity ads',
    })
  })

  test('blockquotes become subtle emphasis containers', () => {
    const body = bodyOf('He said:\n\n> exactly this\n> and this')
    const container = body.find(b => b.type === 'Container')
    expect(container.items[0].isSubtle).toBe(true)
    expect(container.items[0].text).toContain('exactly this')
  })

  test('tables fall back to monospace so columns survive', () => {
    const body = bodyOf('| a | b |\n|---|---|\n| 1 | 2 |')
    const container = body.find(b => b.type === 'Container')
    expect(container.items[0].fontType).toBe('Monospace')
    expect(container.items[0].text).toContain('| a | b |')
  })

  test('paragraphs joined across single newlines, split on blank lines', () => {
    const body = bodyOf('Line one\nstill line one.\n\nParagraph two.')
    expect(body[0].text).toBe('Line one still line one.')
    expect(body[1].text).toBe('Paragraph two.')
  })

  test('summary is the plainified first line', () => {
    const r = markdownToAdaptiveCard('## **Nine** tickets closed\n\nDetails follow.')
    expect(r!.summary).toBe('Nine tickets closed')
  })

  test('card declares full width for Teams', () => {
    const r = markdownToAdaptiveCard('a\n\nb')
    expect(r!.attachment.content.msteams).toEqual({ width: 'Full' })
    expect(r!.attachment.contentType).toBe('application/vnd.microsoft.card.adaptive')
  })

  test('unclosed fence does not lose content or hang', () => {
    const body = bodyOf('Before\n\n```\ndangling code')
    const container = body.find(b => b.type === 'Container')
    expect(container.items[0].text).toBe('dangling code')
  })
})
