import { describe, expect, it } from 'vitest'
import { contentPreview, fieldKey, listField, textField } from './ContentForm'
import { contentLabel, contentPreviewText } from './preview'

describe('language-suffixed fields', () => {
  it('reads items$<lang> and writes back to the key the element uses', () => {
    const data = { 'items$en': [{}, {}, {}] }
    expect(listField(data, 'items')).toHaveLength(3)
    expect(fieldKey(data, 'items')).toBe('items$en')
    expect(fieldKey({}, 'items')).toBe('items')
  })

  it('prefers the exact key over a suffixed one', () => {
    expect(textField({ title: 'a', 'title$en': 'b' }, 'title')).toBe('a')
    expect(textField({ 'title$id': 'Judul' }, 'title')).toBe('Judul')
  })
})

describe('carousel preview', () => {
  it('counts the cards of items$en, not 0', () => {
    expect(contentPreview('builtin_carousel', { 'items$en': [{}, {}, {}] })).toBe('Carousel (3)')
    expect(contentLabel('builtin_carousel', { 'items$en': [{}, {}, {}] })).toBe('Carousel · 3 cards')
  })
})

describe('image and file preview', () => {
  it('shows the title when there is one, else the file name, never the id', () => {
    expect(contentPreview('builtin_image', { 'title$en': 'Banner promo', 'image$en': '/api/v1/bots/x/media/banner.png' })).toBe('Banner promo')
    expect(contentPreview('builtin_image', { 'image$en': '/api/v1/bots/x/media/banner.png?v=2' })).toBe('banner.png')
    expect(contentPreviewText('builtin_file', { 'file$en': '/media/brosur.pdf' })).toBe('brosur.pdf')
    expect(contentLabel('builtin_image', { 'title$en': 'Promo' })).toBe('Image · Promo')
  })
})
