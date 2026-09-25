/** A settings service shaped like DSH 0.1.7-rc.2's SettingsForms: real
 * schemastery forms, real redaction and the real conflict error over
 * in-memory layers, with the bundles that declare its rows. */
import { vi } from 'vitest'
import Schema from '@deepseek-ai/schemastery'
import { redactSecrets, SettingsConflictError, type SettingsDescriptor, type SettingsNamespace } from '@deepseek-ai/dsh-settings'
import type { SettingsLike } from '../../src/native-seams.ts'
import type { BundleLike } from '../../src/plugin-rows.ts'

type Ops = ReadonlyArray<{ op: 'set' | 'unset'; path: readonly string[]; value?: unknown }>
const isPlain = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const merge = (under: unknown, over: unknown): unknown => !isPlain(under) || !isPlain(over) ? over
  : Object.fromEntries([...new Set([...Object.keys(under), ...Object.keys(over)])].map(key =>
    [key, Object.hasOwn(over, key) ? merge(under[key], over[key]) : under[key]]))
const edit = (section: Record<string, unknown>, op: Ops[number]): Record<string, unknown> => {
  const [head, ...rest] = op.path
  const next = { ...section }
  if (rest.length === 0) {
    if (op.op === 'set') next[head!] = op.value
    else delete next[head!]
  } else next[head!] = edit(isPlain(next[head!]) ? next[head!] as Record<string, unknown> : {}, { ...op, path: rest })
  return next
}

export function fakeSettingsService(options: { applies?: string; writable?: boolean } = {}) {
  const forms: Record<string, { schema: Schema; base: Record<string, unknown> }> = {
    'bash-sandbox': { schema: Schema.object({
      cwd: Schema.string().description('Working directory for commands'),
      timeoutMs: Schema.number().default(120000),
      env: Schema.dict(Schema.string()).default({}),
      limits: Schema.object({ maxOutputBytes: Schema.natural().default(64000), graceMs: Schema.natural().default(3000) }),
    }), base: { timeoutMs: 60000 } },
    'web-search': { schema: Schema.object({
      apiKey: Schema.string().role('secret'),
      apiKeyEnv: Schema.string().role('credential-ref').default('DEEPSEEK_API_KEY'),
      endpoints: Schema.dict(Schema.object({ url: Schema.string(), token: Schema.string().role('secret') })).default({}),
      model: Schema.string().default('deepseek-v4-flash'),
    }), base: {} },
  }
  const user: Record<string, Record<string, unknown>> = { 'bash-sandbox': { limits: { graceMs: 5000 } }, 'web-search': { apiKey: 'sk-live-secret' } }
  const revisions: Record<string, number> = { 'bash-sandbox': 3, 'web-search': 0 }
  const describe = vi.fn((describeOptions?: { redactSecrets?: boolean }): SettingsDescriptor[] => Object.entries(forms).map(([ns, { schema, base }]) => {
    const value = schema(merge(base, user[ns]) as never), resolvedBase = schema(base as never)
    const redact = (layer: unknown) => describeOptions?.redactSecrets === true ? redactSecrets(schema as never, layer).value : layer
    return { ns: ns as SettingsNamespace, autoGenerate: true, schema: schema.toJSON(), revision: revisions[ns]!, applies: (options.applies ?? 'live') as 'live',
      value: redact(value), base: redact(resolvedBase), user: redact(user[ns]),
      ...describeOptions?.redactSecrets === true ? { secrets: redactSecrets(schema as never, value).secrets } : {} }
  }))
  const mutate = vi.fn(async (ns: string, ops: Ops, expectedRevision?: number) => {
    if (expectedRevision !== undefined && expectedRevision !== revisions[ns]) {
      throw new SettingsConflictError(ns as SettingsNamespace, expectedRevision, revisions[ns]!)
    }
    const next = ops.reduce(edit, user[ns]!)
    forms[ns]!.schema(merge(forms[ns]!.base, next) as never)
    user[ns] = next
    revisions[ns]! += 1
  })
  const service: SettingsLike = { describe, mutate, ...options.writable === undefined ? {} : { writable: options.writable } }
  const bundles: BundleLike[] = [
    { name: '@deepseek-ai/dsh-web-app', enabled: false, installed: true, optional: false, removable: false, overrides: [],
      rows: [{ rowId: 'bash-sandbox', moduleName: '@deepseek-ai/dsh-bash-sandbox' }] },
    { name: '@deepseek-ai/dsh-base', meta: { title: 'Base' }, enabled: true, installed: true, optional: false, removable: false, overrides: [],
      rows: [{ rowId: 'bash-sandbox', moduleName: '@deepseek-ai/dsh-bash-sandbox' }, { rowId: 'web-search', moduleName: '@deepseek-ai/dsh-web-search-deepseek' }] },
  ]
  return { service, bundles, user, revisions, describe, mutate }
}
