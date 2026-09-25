/** DSH's LocalizedText as dscode shows it: the process locale's translation. */
import { describe, expect, it } from 'vitest'
import { environmentLocale, pick } from '../src/localized-text.ts'

describe('localized text', () => {
  it('picks the exact tag, then its language, then English', () => {
    const text = { en: 'English', zh: '中文', 'zh-tw': '繁體' }
    expect(pick(text, 'zh-tw')).toBe('繁體')
    expect(pick(text, 'zh-cn')).toBe('中文')
    expect(pick(text, 'ZH-TW')).toBe('繁體')
    expect(pick(text, 'fr-fr')).toBe('English')
    expect(pick(text, undefined)).toBe('English')
    expect(pick('Plain', 'zh-cn')).toBe('Plain')
  })

  it('treats blank, inherited and malformed text as missing', () => {
    expect(pick({ en: 'English', zh: '  ' }, 'zh')).toBe('English')
    expect(pick({ en: '' }, 'en')).toBeUndefined()
    expect(pick('  ', 'en')).toBeUndefined()
    expect(pick({ en: 'English' }, 'constructor')).toBe('English')
    expect(pick({ en: 7, zh: ['中文'] }, 'zh')).toBeUndefined()
    expect(pick(undefined, 'en')).toBeUndefined()
    expect(pick(null, 'en')).toBeUndefined()
    expect(pick(42, 'en')).toBeUndefined()
  })

  it('reads the process locale by POSIX precedence', () => {
    expect(environmentLocale({ LC_ALL: 'zh_CN.UTF-8', LANG: 'en_US.UTF-8' })).toBe('zh-cn')
    expect(environmentLocale({ LC_ALL: '', LC_MESSAGES: 'de_DE@euro', LANG: 'en_US' })).toBe('de-de')
    expect(environmentLocale({ LANG: 'C.UTF-8' })).toBeUndefined()
    expect(environmentLocale({ LANG: 'POSIX' })).toBeUndefined()
    expect(environmentLocale({})).toBeUndefined()
  })
})
