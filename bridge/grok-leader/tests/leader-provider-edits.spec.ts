/** Leader provider management over the socket: updating and removing routes. */
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { makeClient, makeHarness, mockDefaultModel, register, type ClientHandle } from './support/leader-harness.ts'

/** Shared mock harness for the provider update/remove suites. */
interface ManageSettingsMock {
  calls: Array<{ ns: string; ops: Array<{ op: string; path: string[]; value: unknown }> }>
  providers: Record<string, unknown>
  mutate(ns: string, ops: Array<{ op: string; path: string[]; value: unknown }>): Promise<void>
  describe(): Array<{ ns: string; user?: unknown }>
}

const makeManageSettings = (): ManageSettingsMock => {
  const mock: ManageSettingsMock = {
    calls: [],
    providers: {},
    async mutate(ns, ops) {
      mock.calls.push({ ns, ops })
      for (const op of ops) {
        if (op.path.length !== 2) throw new Error('unexpected op')
        if (op.op === 'set') mock.providers[op.path[1]] = op.value
        else if (op.op === 'unset') delete mock.providers[op.path[1]]
        else throw new Error('unexpected op')
      }
    },
    describe: () => [{ ns: 'llm-pi-ai', user: { providers: mock.providers } }],
  }
  return mock
}

const manageLlm = (settings: ManageSettingsMock) => ({
  listProviders: () => {
    const rows = [{ id: 'deepseek', name: 'DeepSeek' }]
    for (const id of Object.keys(settings.providers)) rows.push({ id, name: (settings.providers[id] as { displayName?: string }).displayName ?? id })
    return rows
  },
  listModels: async (provider: string) => provider === 'deepseek'
    ? [{ provider: 'deepseek', id: 'deepseek-chat', name: 'DeepSeek Chat' }]
    : [{ provider, id: provider + '-model', name: provider + ' Model' }],
})

async function startManageHarness(settings: ManageSettingsMock, model?: string, credentials?: unknown): Promise<{ client: ClientHandle; settings: ManageSettingsMock }> {
  const llm = manageLlm(settings)
  const made = await makeHarness({ llm, settings: settings as unknown as Context['settings'], model, credentials })
  const client = await makeClient(made.socketPath)
  register(client)
  await client.next() // registered
  return { client, settings }
}

describe('x.ai/providers/update', () => {
  it('merges the form over the current profile, preserving models and unsetting emptied fields', async () => {
    const settings = makeManageSettings()
    settings.providers['acme-gateway'] = {
      displayName: 'Acme',
      apiKeyEnv: 'ACME_KEY',
      api: 'openai-completions',
      baseURL: 'https://acme.test/v1',
      models: [{ id: 'gw-model' }],
    }
    const { client } = await startManageHarness(settings)
    const res = await client.request(1, 'x.ai/providers/update', {
      providerId: 'acme-gateway',
      displayName: '',
      apiKeyEnv: 'ACME_KEY',
      api: '',
      baseURL: 'https://new.test/v1',
    })
    expect(res.error).toBeUndefined()
    expect(settings.calls).toHaveLength(1)
    expect(settings.calls[0].ns).toBe('llm-pi-ai')
    expect(settings.calls[0].ops).toEqual([{
      op: 'set',
      path: ['providers', 'acme-gateway'],
      value: {
        apiKeyEnv: 'ACME_KEY',
        baseURL: 'https://new.test/v1',
        models: [{ id: 'gw-model' }],
      },
    }])
    expect(res.result).toMatchObject({
      providers: [{ id: 'deepseek' }, { id: 'acme-gateway', baseURL: 'https://new.test/v1' }],
    })
  })

  it('an omitted field keeps the current profile value', async () => {
    const settings = makeManageSettings()
    settings.providers['acme-gateway'] = {
      displayName: 'Acme',
      apiKeyEnv: 'ACME_KEY',
      api: 'openai-completions',
      baseURL: 'https://acme.test/v1',
    }
    const { client } = await startManageHarness(settings)
    const res = await client.request(1, 'x.ai/providers/update', { providerId: 'acme-gateway', displayName: 'Renamed' })
    expect(res.error).toBeUndefined()
    expect(settings.calls).toHaveLength(1)
    expect(settings.calls[0].ops).toEqual([{
      op: 'set',
      path: ['providers', 'acme-gateway'],
      value: {
        displayName: 'Renamed',
        apiKeyEnv: 'ACME_KEY',
        api: 'openai-completions',
        baseURL: 'https://acme.test/v1',
      },
    }])
  })

  it('refuses an unknown provider without writing settings', async () => {
    const settings = makeManageSettings()
    const { client } = await startManageHarness(settings)
    const res = await client.request(1, 'x.ai/providers/update', { providerId: 'nope', api: 'openai-completions' })
    expect(res.error).toMatchObject({ code: -32602, message: 'provider "nope" does not exist' })
    expect(settings.calls).toHaveLength(0)
  })

  it('refuses an invalid api before touching settings', async () => {
    const settings = makeManageSettings()
    settings.providers['acme-gateway'] = { displayName: 'Acme' }
    const { client } = await startManageHarness(settings)
    const res = await client.request(1, 'x.ai/providers/update', { providerId: 'acme-gateway', api: 'grpc' })
    expect(res.error).toMatchObject({ code: -32602 })
    expect(settings.calls).toHaveLength(0)
  })

  it('returns non-secret credential status for the edit form', async () => {
    const settings = makeManageSettings()
    settings.providers['acme-gateway'] = { apiKeyEnv: 'ACME_KEY' }
    const credentials = {
      describe: async (ref: string) => ({
        configured: ref === 'ACME_KEY',
        source: ref === 'ACME_KEY' ? 'env' : undefined,
        writable: ref !== 'ACME_KEY',
      }),
      set: async () => {},
      unset: async () => {},
    }
    const { client } = await startManageHarness(settings, undefined, credentials)
    const listed = await client.request(1, 'x.ai/models/list', {})
    expect(listed.result).toMatchObject({
      _meta: {
        providers: [{
          id: 'deepseek',
        }, {
          id: 'acme-gateway',
          credential: { configured: true, source: 'env', writable: false },
        }],
      },
    })
  })

  it('cleans an unshared saved key after changing its reference', async () => {
    const settings = makeManageSettings()
    settings.providers['acme-gateway'] = { apiKeyEnv: 'OLD_ACME_KEY' }
    const unset = vi.fn(async () => {})
    const credentials = {
      describe: async () => ({ configured: true, source: 'file', writable: true }),
      set: async () => {},
      unset,
    }
    const { client } = await startManageHarness(settings, undefined, credentials)
    const res = await client.request(1, 'x.ai/providers/update', {
      providerId: 'acme-gateway',
      apiKeyEnv: 'NEW_ACME_KEY',
    })
    expect(res.error).toBeUndefined()
    expect(unset).toHaveBeenCalledWith('OLD_ACME_KEY')
  })

  it('keeps a saved key still referenced by another provider', async () => {
    const settings = makeManageSettings()
    settings.providers['acme-gateway'] = { apiKeyEnv: 'SHARED_KEY' }
    settings.providers['acme-copy'] = { apiKeyEnv: 'SHARED_KEY' }
    const unset = vi.fn(async () => {})
    const credentials = {
      describe: async () => ({ configured: true, source: 'file', writable: true }),
      set: async () => {},
      unset,
    }
    const { client } = await startManageHarness(settings, undefined, credentials)
    const res = await client.request(1, 'x.ai/providers/update', {
      providerId: 'acme-gateway',
      apiKeyEnv: 'NEW_KEY',
    })
    expect(res.error).toBeUndefined()
    expect(unset).not.toHaveBeenCalled()
  })

  it('replaces a saved key without putting it in provider settings', async () => {
    const settings = makeManageSettings()
    settings.providers['acme-gateway'] = { apiKeyEnv: 'ACME_KEY' }
    const set = vi.fn(async () => {})
    const credentials = { set }
    const { client } = await startManageHarness(settings, undefined, credentials)
    const res = await client.request(1, 'x.ai/providers/update', {
      providerId: 'acme-gateway',
      apiKeyEnv: 'ACME_KEY',
      credentialSource: 'saved',
      apiKey: 'replacement-secret',
    })
    expect(res.error).toBeUndefined()
    expect(set).toHaveBeenCalledWith('ACME_KEY', 'replacement-secret')
    expect(settings.providers['acme-gateway']).toEqual({ apiKeyEnv: 'ACME_KEY' })
  })

  it('environment mode removes an unshadowed saved key on the same ref', async () => {
    const settings = makeManageSettings()
    settings.providers['acme-gateway'] = { apiKeyEnv: 'ACME_KEY' }
    const unset = vi.fn(async () => {})
    const credentials = {
      describe: async () => ({ configured: true, source: 'file', writable: true }),
      set: async () => {},
      unset,
    }
    const { client } = await startManageHarness(settings, undefined, credentials)
    const res = await client.request(1, 'x.ai/providers/update', {
      providerId: 'acme-gateway',
      apiKeyEnv: 'ACME_KEY',
      credentialSource: 'environment',
      apiKey: '',
    })
    expect(res.error).toBeUndefined()
    expect(unset).toHaveBeenCalledWith('ACME_KEY')
  })
})

describe('x.ai/providers/remove', () => {
  it('unsets the route and returns the refreshed roster', async () => {
    const settings = makeManageSettings()
    settings.providers['acme-gateway'] = { displayName: 'Acme' }
    const { client } = await startManageHarness(settings, 'deepseek-chat')
    const res = await client.request(1, 'x.ai/providers/remove', { id: 'acme-gateway' })
    expect(res.error).toBeUndefined()
    expect(settings.calls).toHaveLength(1)
    expect(settings.calls[0].ops).toEqual([{ op: 'unset', path: ['providers', 'acme-gateway'] }])
    expect('acme-gateway' in settings.providers).toBe(false)
    expect(res.result).toEqual({ providers: [{ id: 'deepseek', name: 'DeepSeek' }], currentProviderId: 'deepseek' })
  })

  it('refuses the provider that owns the current model', async () => {
    const settings = makeManageSettings()
    const { client } = await startManageHarness(settings, 'deepseek-chat')
    const res = await client.request(1, 'x.ai/providers/remove', { id: 'deepseek' })
    expect(res.error).toMatchObject({ code: -32602, message: 'provider "deepseek" is in use; switch to another provider first' })
    expect(settings.calls).toHaveLength(0)
  })

  it('refuses a provider still selected by a live session even after the global default moved', async () => {
    const settings = makeManageSettings()
    settings.providers['acme-gateway'] = { displayName: 'Acme' }
    const { client } = await startManageHarness(settings, 'deepseek-chat')
    const created = await client.request(1, 'session/new', { cwd: process.cwd(), mcpServers: [] })
    const sessionId = (created.result as { sessionId: string }).sessionId
    const switched = await client.request(2, 'session/set_model', { sessionId, modelId: 'acme-gateway-model' })
    expect(switched.error).toBeUndefined()
    mockDefaultModel.current = { provider: 'deepseek', model: 'deepseek-chat' }
    await client.request(3, 'x.ai/models/list', {})

    const removed = await client.request(4, 'x.ai/providers/remove', { id: 'acme-gateway' })
    expect(removed.error).toMatchObject({ code: -32602, message: 'provider "acme-gateway" is in use; switch to another provider first' })
    expect(settings.calls).toHaveLength(0)
  })

  it('refuses an unknown provider', async () => {
    const settings = makeManageSettings()
    const { client } = await startManageHarness(settings)
    const res = await client.request(1, 'x.ai/providers/remove', { id: 'nope' })
    expect(res.error).toMatchObject({ code: -32602, message: 'provider "nope" does not exist' })
    expect(settings.calls).toHaveLength(0)
  })

  it('removes an unshared file-backed credential with its provider route', async () => {
    const settings = makeManageSettings()
    settings.providers['acme-gateway'] = {
      displayName: 'Acme',
      apiKeyEnv: 'ACME_KEY',
    }
    const unset = vi.fn(async () => {})
    const credentials = {
      describe: async () => ({ configured: true, source: 'file', writable: true }),
      set: async () => {},
      unset,
    }
    const { client } = await startManageHarness(settings, 'deepseek-chat', credentials)
    const res = await client.request(1, 'x.ai/providers/remove', { id: 'acme-gateway' })
    expect(res.error).toBeUndefined()
    expect(unset).toHaveBeenCalledWith('ACME_KEY')
  })
})
