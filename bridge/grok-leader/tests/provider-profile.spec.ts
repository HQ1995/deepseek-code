/**
 * Pure provider-route rules from src/provider-profile.ts: reading the
 * llm-pi-ai user section, validating the /provider form and deriving the
 * persisted profiles. They are behavior-pinned here so the model catalog and
 * socket suites do not need to re-prove them end to end.
 */
import { describe, expect, it } from 'vitest'
import {
  discoveredModelUpdate, editableProfile, hasUserProviderRoute, knownRouteBaseUrls, mergeEditable, normalizeProviderForm,
  pastedApiKey, pastedApiKeyValue, pastedKeyRef, providerUserProfile, providerUserSection, requireProviderId, routeSignature, sharesCredentialRef,
} from '../src/provider-profile.ts'
import type { SettingsLike } from '../src/native-seams.ts'

const settingsWith = (providers: Record<string, unknown>): SettingsLike => ({
  mutate: async () => {},
  describe: () => [{ ns: 'llm-pi-ai', user: { providers } }],
})

/** Minimal structural stand-in for the settings seam's user-section read. */
function settingsService(expose: { ns: string; user?: unknown }[]): {
  describe?(): Array<{ ns: string; user?: unknown }>
} {
  return { describe: () => expose }
}

/** A fresh std user section mirroring what dsh-settings-file writes. */
function userSection(): Record<string, unknown> {
  return {
    providers: {
      'provider-a': { apiKeyEnv: 'A_KEY', baseURL: 'https://a.example/v1' },
      'provider-b': { apiKeyEnv: 'B_KEY' },
    },
  }
}

describe('providerUserSection', () => {
  it('returns the llm-pi-ai user section from a settings service', () => {
    const svc = settingsService([{ ns: 'llm-pi-ai', user: userSection() }])
    expect(providerUserSection(svc)).toEqual(userSection())
  })

  it('returns undefined when the llm-pi-ai ns is absent', () => {
    const svc = settingsService([{ ns: 'agent-preset-registry', user: { selectedDefault: 'standard' } }])
    expect(providerUserSection(svc)).toBeUndefined()
  })

  it('returns undefined when the user value is null or non-object', () => {
    expect(providerUserSection(settingsService([{ ns: 'llm-pi-ai', user: null }]))).toBeUndefined()
    expect(providerUserSection(settingsService([{ ns: 'llm-pi-ai', user: 'nope' }]))).toBeUndefined()
  })

  it('treats a service with no describe seam as absent', () => {
    expect(providerUserSection(undefined)).toBeUndefined()
    expect(providerUserSection({})).toBeUndefined()
  })
})

describe('providerUserProfile', () => {
  it('returns one provider profile from the section', () => {
    expect(providerUserProfile(userSection(), 'provider-a')).toEqual({ apiKeyEnv: 'A_KEY', baseURL: 'https://a.example/v1' })
    expect(providerUserProfile(userSection(), 'provider-b')).toEqual({ apiKeyEnv: 'B_KEY' })
  })

  it('returns {} for an unknown provider id', () => {
    expect(providerUserProfile(userSection(), 'provider-c')).toEqual({})
  })

  it('returns {} when the section does not expose providers', () => {
    expect(providerUserProfile(undefined, 'provider-a')).toEqual({})
    expect(providerUserProfile({}, 'provider-a')).toEqual({})
    expect(providerUserProfile({ providers: null }, 'provider-a')).toEqual({})
  })
})

describe('hasUserProviderRoute', () => {
  it('is true only for ids named in the user section', () => {
    const svc = settingsService([{ ns: 'llm-pi-ai', user: userSection() }])
    expect(hasUserProviderRoute(svc, 'provider-a')).toBe(true)
    expect(hasUserProviderRoute(svc, 'provider-b')).toBe(true)
    expect(hasUserProviderRoute(svc, 'provider-c')).toBe(false)
  })

  it('is false without a section or providers', () => {
    expect(hasUserProviderRoute(undefined, 'provider-a')).toBe(false)
    expect(hasUserProviderRoute(settingsService([{ ns: 'agent-preset-registry', user: {} }]), 'provider-a')).toBe(false)
    expect(hasUserProviderRoute(settingsService([{ ns: 'llm-pi-ai', user: { providers: undefined } }]), 'provider-a')).toBe(false)
  })
})

describe('knownRouteBaseUrls', () => {
  it('returns [] when no route carries a baseURL', () => {
    const svcB = settingsService([{ ns: 'llm-pi-ai', user: { providers: { 'provider-b': { apiKeyEnv: 'B_KEY' } } } }])
    expect(knownRouteBaseUrls(svcB)).toEqual([])
    expect(knownRouteBaseUrls(settingsService([{ ns: 'llm-pi-ai', user: { providers: {} } }]))).toEqual([])
    expect(knownRouteBaseUrls(undefined)).toEqual([])
  })

  it('skips non-object profiles and non-string baseURLs', () => {
    const svc = settingsService([{
      ns: 'llm-pi-ai',
      user: {
        providers: {
          a: { baseURL: 'https://ok.example' },
          b: 'scalar',
          c: { baseURL: 42 },
          d: { baseURL: '' },
        },
      },
    }])
    expect(knownRouteBaseUrls(svc)).toEqual(['https://ok.example'])
  })
})

describe('provider form rules', () => {
  it('normalizes baseURL whitespace into a new form and leaves the request untouched', () => {
    const request = { id: 'gw', baseURL: '  https://gw.example/v1  ', api: 'openai-responses' }
    const form = normalizeProviderForm(request)
    expect(form).toEqual({ id: 'gw', baseURL: 'https://gw.example/v1', api: 'openai-responses' })
    expect(request.baseURL).toBe('  https://gw.example/v1  ')
  })

  it.each([
    [{ baseURL: 'ftp://gw.example' }, 'baseURL must be http/https with no userinfo'],
    [{ baseURL: 'https://user:secret@gw.example' }, 'baseURL must be http/https with no userinfo'],
    [{ baseURL: 'gw.example' }, 'baseURL must be an absolute http/https URL'],
    [{ api: 'grpc' }, 'api must be one of'],
    [{ displayName: 7 }, 'displayName must be a string'],
    [{ credentialSource: 'vault' }, 'credentialSource must be saved or environment'],
  ])('refuses %j before any write', (form, error) => {
    expect(() => normalizeProviderForm(form)).toThrow(error)
  })

  it('refuses a pasted key for an environment credential and derives the stored reference', () => {
    expect(() => pastedApiKey({ apiKey: 'sk', credentialSource: 'environment' })).toThrow('apiKey must be empty')
    expect(pastedApiKey({ apiKey: '', credentialSource: 'environment' })).toBeUndefined()
    expect(pastedKeyRef({}, 'my-gw.2')).toBe('MY_GW_2_API_KEY')
    expect(pastedKeyRef({ apiKeyEnv: 'OWN_KEY' }, 'my-gw')).toBe('OWN_KEY')
  })

  it('stores a pasted key trimmed of surrounding whitespace and keeps real key shapes', () => {
    expect(pastedApiKey({ apiKey: '  sk-abc123\n' })).toBe('sk-abc123')
    expect(pastedApiKey({})).toBeUndefined()
    // Upper-case base64 padding and embedded "=" are keys, not assignments.
    expect(pastedApiKeyValue('ABCDEF==')).toBe('ABCDEF==')
    expect(pastedApiKeyValue('sk-proj_x=y')).toBe('sk-proj_x=y')
    expect(pastedApiKeyValue('"unbalanced')).toBe('"unbalanced')
  })

  it.each([
    ['   ', 'the pasted API key is blank'],
    ['\t\n', 'the pasted API key is blank'],
    ['DEEPSEEK_API_KEY=sk-abc', 'is a shell line (NAME=value)'],
    ['export DEEPSEEK_API_KEY=sk-abc', 'is a shell line (NAME=value)'],
    ['"sk-abc"', 'wrapped in quotes'],
    ["'sk-abc'", 'wrapped in quotes'],
    ['`sk-abc`', 'wrapped in quotes'],
    ['sk abc', 'outside printable ASCII'],
    ['sk-abc\u00e9', 'outside printable ASCII'],
    ['sk-\u200babc', 'outside printable ASCII'],
  ])('refuses the pasted key %j with the reason', (key, error) => {
    expect(() => pastedApiKey({ apiKey: key })).toThrow(error)
    expect(() => pastedApiKey({ apiKey: key })).toThrow(expect.objectContaining({ code: -32602 }))
  })

  it('names the offending field in route id errors', () => {
    expect(requireProviderId('gw-2', 'provider id')).toBe('gw-2')
    expect(() => requireProviderId('GW', 'providerId')).toThrow('providerId must be lowercase kebab-case')
  })

  it('omits empty fields from a new profile; on update an absent field keeps and an empty one unsets', () => {
    expect(editableProfile({ displayName: 'GW', apiKeyEnv: '', baseURL: 'https://gw', extra: 'x' })).toEqual({ displayName: 'GW', baseURL: 'https://gw' })
    const current = { displayName: 'Old', apiKeyEnv: 'KEY', models: [{ id: 'm' }] }
    expect(mergeEditable(current, { displayName: '', baseURL: 'https://gw' })).toEqual({ apiKeyEnv: 'KEY', models: [{ id: 'm' }], baseURL: 'https://gw' })
    expect(current.displayName).toBe('Old')
  })
})

describe('provider settings section', () => {
  it('lists only persisted route endpoints and detects credential references other routes share', () => {
    const settings = settingsWith({ a: { baseURL: 'https://a', apiKeyEnv: 'K' }, b: { apiKeyEnv: 'K' }, c: 'broken' })
    expect(knownRouteBaseUrls(settings)).toEqual(['https://a'])
    const section = settings.describe!()[0]!.user as Record<string, unknown>
    expect(sharesCredentialRef(section, 'K', 'a')).toBe(true)
    expect(sharesCredentialRef(section, 'K', 'x')).toBe(true)
    expect(sharesCredentialRef({ providers: { a: { apiKeyEnv: 'K' } } }, 'K', 'a')).toBe(false)
  })
})

describe('discovered model persistence', () => {
  const route = { api: 'openai-completions', baseURL: 'https://gw', models: [{ id: 'm', name: 'Custom name' }] }
  const signature = routeSignature(route)

  it('keeps stored per-model overrides over discovered values', () => {
    expect(discoveredModelUpdate(route, signature, [{ id: 'm', name: 'Listed', maxTokens: 10 }, { id: 'n' }]))
      .toEqual([{ id: 'm', name: 'Custom name', maxTokens: 10 }, { id: 'n' }])
  })

  it('writes nothing when the route changed, has no explicit models, or already matches', () => {
    expect(discoveredModelUpdate({ ...route, baseURL: 'https://other' }, signature, [{ id: 'x' }])).toBeUndefined()
    expect(discoveredModelUpdate({ api: 'openai-completions', baseURL: 'https://gw' }, signature, [{ id: 'x' }])).toBeUndefined()
    expect(discoveredModelUpdate(route, signature, [{ id: 'm', name: 'Custom name' }])).toBeUndefined()
  })
})
