import { describe, expect, it } from 'vitest'
import {
  discoveredModelUpdate, editableProfile, knownRouteBaseUrls, mergeEditable, normalizeProviderForm, pastedApiKey, pastedKeyRef,
  requireProviderId, routeSignature, sharesCredentialRef,
} from '../src/provider-profile.ts'
import type { SettingsLike } from '../src/native-seams.ts'

const settingsWith = (providers: Record<string, unknown>): SettingsLike => ({
  mutate: async () => {},
  describe: () => [{ ns: 'llm-pi-ai', user: { providers } }],
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
