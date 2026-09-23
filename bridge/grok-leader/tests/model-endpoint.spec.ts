import { describe, expect, it } from 'vitest'
import { discoverEndpointModelCapabilities, endpointReasoningEfforts } from '../src/model-endpoint.ts'

describe('endpoint reasoning extensions', () => {
  it('maps listed levels, objects and wire values onto canonical levels only', () => {
    expect(endpointReasoningEfforts({ reasoning_efforts: ['low', 'turbo', { id: 'high', value: 'HIGH' }, { value: 'max' }, { id: 'off', value: null }] }))
      .toEqual({ low: 'low', high: 'HIGH', max: 'max', off: null })
    expect(endpointReasoningEfforts({ reasoningEfforts: { medium: 'mid', minimal: '', off: null, turbo: 'x' } })).toEqual({ medium: 'mid', off: null })
  })

  it('distinguishes an explicit refusal from an absent extension', () => {
    expect(endpointReasoningEfforts({ supports_reasoning_effort: false, reasoning_efforts: ['low'] })).toBe(false)
    expect(endpointReasoningEfforts({ reasoningEfforts: false })).toBe(false)
    expect(endpointReasoningEfforts({ reasoning_efforts: ['turbo'] })).toBeUndefined()
    expect(endpointReasoningEfforts({})).toBeUndefined()
  })
})

describe('endpoint capability probe', () => {
  const respond = (body: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(body), init)

  it('reads the first entry per model id and sends the bearer only when given a key', async () => {
    const seen: Array<{ url: string; auth: string | null }> = []
    const request = (async (url: string, init: RequestInit) => {
      seen.push({ url, auth: new Headers(init.headers).get('authorization') })
      return respond({ data: [{ id: 'a', reasoning_efforts: ['low'] }, { id: 'a', reasoning_efforts: ['max'] }, { id: 'b' }, 'noise'] })
    }) as typeof fetch
    const capabilities = await discoverEndpointModelCapabilities('https://gw.example/v1//', 'sk-test', request)
    expect([...capabilities]).toEqual([['a', { low: 'low' }]])
    await discoverEndpointModelCapabilities('https://gw.example/v1', undefined, request)
    expect(seen).toEqual([
      { url: 'https://gw.example/v1/models', auth: 'Bearer sk-test' },
      { url: 'https://gw.example/v1/models', auth: null },
    ])
  })

  it('rejects HTTP failures and listings declared beyond the 4 MiB ceiling', async () => {
    await expect(discoverEndpointModelCapabilities('https://gw', undefined, (async () => respond({}, { status: 503 })) as typeof fetch))
      .rejects.toThrow('HTTP 503')
    const oversized = (async () => respond({ data: [] }, { headers: { 'content-length': String(5 * 1024 * 1024) } })) as typeof fetch
    await expect(discoverEndpointModelCapabilities('https://gw', undefined, oversized)).rejects.toThrow('exceeds 4 MiB')
  })
})
