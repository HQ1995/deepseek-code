/** The host-services seam: every optional DSH service the bridge reads, by name, at call time. */
import { describe, expect, it } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createHostServices, type HostServices } from '../src/host-services.ts'

const fakeContext = (services: Record<string, unknown>) => {
  const reads: string[] = []
  return { reads, get(name: string) { reads.push(name); return services[name] } }
}
const fakeAgent = (services: Record<string, unknown>): Agent =>
  ({ ctx: { get: (name: string) => services[name] } } as unknown as Agent)

/** Reader → the host service name it resolves. */
const serviceNames: Record<Exclude<keyof HostServices, 'flush' | 'messageProjection' | 'agentTools' | 'presetService'>, string> = {
  settings: 'settings', llm: 'llm', credentials: 'credentials', agentDefaultModel: 'agentDefaultModel',
  persistence: 'sessionPersistence', attachments: 'attachments', commands: 'commands', schedule: 'schedule',
  profileContext: 'profileContext', pluginManager: 'pluginManager', loader: 'loader', configEditor: 'configEditor', ssh: 'ssh',
  sessionTitles: 'sessionTitle', sessionReferences: 'sessionReferenceResolver', sessionQuery: 'sessionQuery',
  sessionProjectionCache: 'sessionProjectionCache', sessionProjections: 'sessionProjections',
  permissionPresets: 'permissionPresets', agentTeams: 'agentTeams', browser: 'dscodeBrowser',
  inspector: 'dscodeInspector', appExit: 'appExit',
}

describe('host services seam', () => {
  it('names every reader the seam offers', () => {
    const host = createHostServices(fakeContext({}), { roster: () => undefined })
    expect(Object.keys(host).sort()).toEqual([...Object.keys(serviceNames), 'flush', 'messageProjection', 'agentTools', 'presetService'].sort())
  })

  it('reads each service by its host name at call time and retains nothing', () => {
    const services: Record<string, unknown> = {}
    const ctx = fakeContext(services)
    const host = createHostServices(ctx, { roster: () => undefined })
    for (const [reader, name] of Object.entries(serviceNames) as Array<[keyof typeof serviceNames, string]>) {
      const read = host[reader] as () => unknown
      // Absent until the row publishes, which may be after apply.
      expect(read()).toBeUndefined()
      const instance = { service: name }
      services[name] = instance
      expect(read()).toBe(instance)
      // A remounted or torn-down row is not served from a stale capture.
      delete services[name]
      expect(read()).toBeUndefined()
    }
    expect(ctx.reads).toEqual(Object.values(serviceNames).flatMap(name => [name, name, name]))
  })

  it('flushes through the session store and resolves quietly without one', async () => {
    const flushed: object[] = []
    const services: Record<string, unknown> = {}
    const host = createHostServices(fakeContext(services), { roster: () => undefined })
    const session = { id: 'session' }
    await expect(host.flush(session)).resolves.toBeUndefined()
    services.sessions = { flush: async (target: object) => { flushed.push(target); return 'flushed' } }
    await expect(host.flush(session)).resolves.toBe('flushed')
    expect(flushed).toEqual([session])
    services.sessions = { flush: async () => { throw new Error('disk full') } }
    await expect(host.flush(session)).rejects.toThrow('disk full')
  })

  it('names the message projections registered on the session store, at call time', () => {
    const services: Record<string, unknown> = {}
    const host = createHostServices(fakeContext(services), { roster: () => undefined })
    expect(host.messageProjection('image/offload')).toBe(false)
    services.sessions = { flush: async () => {} }
    expect(host.messageProjection('image/offload')).toBe(false)
    const projections = [{ type: 'image/offload' }]
    services.sessions = { flush: async () => {}, messageProjections: projections }
    expect(host.messageProjection('image/offload')).toBe(true)
    expect(host.messageProjection('redact/apply')).toBe(false)
    // A plugin registering later is seen by the next read.
    projections.push({ type: 'redact/apply' })
    expect(host.messageProjection('redact/apply')).toBe(true)
  })

  it('resolves a preset service from the roster, then the agent context, then the host', () => {
    const hostServices: Record<string, unknown> = { jobs: 'host jobs', skills: 'host skills', goals: 'host goals' }
    const agentServices: Record<string, unknown> = { jobs: 'agent jobs', skills: 'agent skills' }
    const rosterServices: Record<string, unknown> = { jobs: 'preset jobs' }
    const agent = fakeAgent(agentServices)
    const seen: Array<[Agent, string]> = []
    const host = createHostServices(fakeContext(hostServices), {
      roster: () => ({ serviceFor: (scope, name) => { seen.push([scope as Agent, name]); return rosterServices[name] } }),
    })
    expect(host.presetService(agent, 'jobs')).toBe('preset jobs')
    expect(host.presetService(agent, 'skills')).toBe('agent skills')
    expect(host.presetService(agent, 'goals')).toBe('host goals')
    expect(host.presetService(agent, 'terminals')).toBeUndefined()
    expect(seen.map(([scope, name]) => [scope === agent, name])).toEqual([[true, 'jobs'], [true, 'skills'], [true, 'goals'], [true, 'terminals']])
    // A roster that is not up yet, or one without per-agent services, falls through.
    const bare = createHostServices(fakeContext(hostServices), { roster: () => undefined })
    expect(bare.presetService(agent, 'jobs')).toBe('agent jobs')
    const noScope = createHostServices(fakeContext(hostServices), { roster: () => ({}) })
    expect(noScope.presetService(agent, 'goals')).toBe('host goals')
  })

  it("reads an agent's tool registry from that agent's context, not the host", () => {
    const tools = { schemas: () => [] }
    const host = createHostServices(fakeContext({ tools: { schemas: () => [{ name: 'host-only' }] } }), { roster: () => undefined })
    expect(host.agentTools(fakeAgent({ tools }))).toBe(tools)
    expect(host.agentTools(fakeAgent({}))).toBeUndefined()
  })
})
