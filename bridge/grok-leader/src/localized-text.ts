/** DSH's localized display text and the locale dscode shows it in. DSH's web
 * client resolves `LocalizedText` against the locale its user picked; the
 * leader has no such setting and uses the process locale. */
import { isRecord } from './guards.ts'

/** DSH's `LocalizedText` (@deepseek-ai/dsh-package-manifest): plain text, or
 * translations keyed by lower-case BCP 47 tags that always include English. */
export type LocalizedText = string | { readonly en: string; readonly [locale: string]: string }

/** The message locale by POSIX precedence (LC_ALL, LC_MESSAGES, LANG), as a
 * lower-case BCP 47 tag; undefined for the C/POSIX locale or none. */
export function environmentLocale(env: Readonly<Record<string, string | undefined>> = process.env): string | undefined {
  for (const key of ['LC_ALL', 'LC_MESSAGES', 'LANG']) {
    const value = env[key]
    if (value === undefined || value === '') continue
    const tag = value.split(/[.@]/)[0]!.replace(/_/g, '-').toLowerCase()
    return tag === '' || tag === 'c' || tag === 'posix' ? undefined : tag
  }
  return undefined
}

/** The text to show in `locale`: plain text as is; a translation map's exact
 * tag, then its language, then English. Blank text counts as missing, only a
 * map's own keys are read (a tag named `constructor` is not a translation),
 * and anything that is neither text nor a map has no text. */
export function pick(text: unknown, locale: string | undefined): string | undefined {
  const usable = (value: unknown): string | undefined => typeof value === 'string' && value.trim() !== '' ? value : undefined
  if (typeof text === 'string') return usable(text)
  if (!isRecord(text)) return undefined
  const entry = (key: string | undefined) => key === undefined || !Object.hasOwn(text, key) ? undefined : usable(text[key])
  const tag = locale?.toLowerCase()
  return entry(tag) ?? entry(tag?.split('-')[0]) ?? entry('en')
}
