import { describe, expect, it } from 'vitest'
import { describeAction, clip, compactArgs, contentLabel, contentTypeLabel, formatValue, setVariableLine } from './preview'
import { formatNodeAction, parseNodeAction } from './actions'

describe('clip', () => {
  it('collapses whitespace and cuts long text with an ellipsis', () => {
    expect(clip('  Halo \n  dunia  ')).toBe('Halo dunia')
    expect(clip('abcdefghij', 5)).toBe('abcd…')
  })
})

describe('content labels', () => {
  it('names the type and previews its text, as the legacy editor does', () => {
    expect(contentLabel('builtin_single-choice', { 'text$en': 'Silakan pilih layanan' })).toBe('Single choice · Silakan pilih layanan')
    expect(contentLabel('builtin_text', { 'text$en': 'Halo' })).toBe('Text · Halo')
    expect(contentLabel('builtin_image', { title: 'Promo' })).toBe('Image · Promo')
    expect(contentLabel('builtin_carousel', { items: [{}, {}, {}] })).toBe('Carousel · 3 cards')
    expect(contentLabel('builtin_carousel', { items: [{}] })).toBe('Carousel · 1 card')
  })

  it('cuts a long preview and falls back to the type alone when there is no text', () => {
    expect(contentLabel('builtin_text', { 'text$en': 'x'.repeat(200) })).toMatch(/^Text · x{47}…$/)
    expect(contentLabel('builtin_text', {})).toBe('Text')
  })

  it('names unknown types from their id', () => {
    expect(contentTypeLabel('builtin_video')).toBe('Video')
    expect(contentTypeLabel('custom-thing')).toBe('Custom thing')
  })
})

describe('say actions with args', () => {
  it('splits the content id from its JSON args', () => {
    expect(parseNodeAction('say #!builtin_single-choice-CzQ4vI {"skill":"choice"}')).toEqual({
      kind: 'say',
      contentId: 'builtin_single-choice-CzQ4vI',
      args: '{"skill":"choice"}',
    })
    expect(parseNodeAction('say #!abc')).toEqual({ kind: 'say', contentId: 'abc', args: '' })
  })

  it('keeps the args when the action is written back', () => {
    const raw = 'say #!abc {"skill":"choice"}'
    expect(formatNodeAction(parseNodeAction(raw))).toBe(raw)
  })

  it('shows the friendly label for a say action and the args as a badge', () => {
    const view = describeAction('say #!builtin_single-choice-CzQ4vI {"skill":"choice"}', {
      'builtin_single-choice-CzQ4vI': 'Single choice · Silakan pilih …',
    })
    expect(view).toMatchObject({ kind: 'say', label: 'Single choice · Silakan pilih …', badge: '{"skill":"choice"}', mono: false })
  })

  it('falls back to the id when the element is not loaded', () => {
    expect(describeAction('say #!missing-id', {}).label).toBe('missing-id')
  })
})

describe('setVariable actions', () => {
  it('reads as an assignment and renders null, 0 and empty strings faithfully', () => {
    expect(setVariableLine('{"name":"x","type":"temp","value":null}')).toBe('temp.x = null')
    expect(setVariableLine('{"name":"x","type":"temp","value":0}')).toBe('temp.x = 0')
    expect(setVariableLine('{"name":"x","type":"session","value":""}')).toBe('session.x = ""')
    expect(setVariableLine('{"name":"x","type":"temp","value":"hi"}')).toBe('temp.x = hi')
    expect(setVariableLine('{"name":"x","type":"temp","value":false}')).toBe('temp.x = false')
    expect(setVariableLine('{"name":"x","type":"temp","value":{"a":1}}')).toBe('temp.x = {"a":1}')
  })

  it('describes the row with the action name as detail', () => {
    const view = describeAction('builtin/setVariable {"name":"skill-choice-valid","type":"temp","value":null}', {})
    expect(view).toMatchObject({ kind: 'code', label: 'temp.skill-choice-valid = null', detail: 'builtin/setVariable', mono: true })
  })

  it('leaves non-assignment args to the generic row', () => {
    expect(setVariableLine('not json')).toBeNull()
    expect(formatValue(undefined)).toBe('undefined')
  })
})

describe('other code actions', () => {
  it('shows the name with compact args', () => {
    expect(describeAction('builtin/http {"url": "https://x"}', {})).toMatchObject({
      kind: 'code',
      label: 'builtin/http',
      badge: '{"url":"https://x"}',
    })
    expect(describeAction('builtin/noop', {})).toMatchObject({ label: 'builtin/noop', badge: null })
  })

  it('compacts JSON and keeps non-JSON args', () => {
    expect(compactArgs('{ "a" : 1 }')).toBe('{"a":1}')
    expect(compactArgs('raw text')).toBe('raw text')
  })
})
