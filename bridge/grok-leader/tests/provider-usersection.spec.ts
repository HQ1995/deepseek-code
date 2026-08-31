/**
 * Pure provider-settings helpers (module scope, no socket harness needed).
 * These moved out of apply() as the first slice of the leader's god-function
 * refactor; they are behavior-pinned here so future slices do not need to
 * re-prove them through the full end-to-end socket suite.
 */
import { describe, expect, it } from 'vitest'
import {
  hasUserProviderRoute,
  knownRouteBaseUrls,
  providerUserProfile,
  providerUserSection,
} from '../src/index.ts'

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
    const svc = settingsService([{ ns: 'agent-presets', user: { default: 'standard' } }])
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
    expect(hasUserProviderRoute(settingsService([{ ns: 'agent-presets', user: {} }]), 'provider-a')).toBe(false)
    expect(hasUserProviderRoute(settingsService([{ ns: 'llm-pi-ai', user: { providers: undefined } }]), 'provider-a')).toBe(false)
  })
})

describe('knownRouteBaseUrls', () => {
  it('collects every persisted baseURL in order', () => {
    const svc = settingsService([{ ns: 'llm-pi-ai', user: userSection() }])
    expect(knownRouteBaseUrls(svc)).toEqual(['https://a.example/v1'])
  })

  it('returns [] when no route carries a baseURL', () => {
    const svc = settingsService([{ ns: 'llm-pi-ai', user: userSection() }])
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
