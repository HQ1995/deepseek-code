import { expect, it } from 'vitest'
import { fixtureEnvironment } from './fixtures/environment.ts'

it('isolates all launcher paths from an ambient dscode session and rejects escaped overrides', () => {
  const env = fixtureEnvironment('/fixture', {}, {
    HOME: '/ambient', DSCODE_HOME: '/ambient/profile', DSC_HOME: '/ambient/profile', DSH_PROFILE_DIR: '/ambient/profile',
    DSH_BIN: '/ambient/dsh', DSCODE_BIN: '/ambient/tui', DSCODE_SOCKET: '/ambient/socket', GROK_DEBUG_LOG: '/ambient/log',
    NODE_OPTIONS: '--require=/ambient/setup.js', PATH: '/bin',
  })
  expect(env).toMatchObject({ HOME: '/fixture', DSCODE_HOME: '/fixture/.dsh/profiles/dscode', DSH_PROFILE_DIR: '/fixture/.dsh/profiles/dscode', PATH: '/bin' })
  for (const key of ['DSH_BIN', 'DSCODE_BIN', 'DSCODE_SOCKET', 'GROK_DEBUG_LOG', 'NODE_OPTIONS']) expect(env[key]).toBeUndefined()
  expect(() => fixtureEnvironment('/fixture', { DSCODE_HOME: '/ambient/profile' })).toThrow('inside HOME')
})
