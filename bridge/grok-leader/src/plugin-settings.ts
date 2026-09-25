/** `/dsh config`: the settings DSH's settings service serves for loaded
 * plugins (each profile row's live-editable fields), read redacted and changed
 * one path at a time at the revision just described. Secret fields show only
 * as set or unset and are never written here, and no profile file is read or
 * written by hand: the service validates, persists and applies each change.
 * The plugin a namespace belongs to comes from the DSH plugin manager. */
import Schema from '@deepseek-ai/schemastery'
import { confirmation, type SelectOption } from './command-options.ts'
import { errorMessage, isRecord } from './guards.ts'
import { environmentLocale, pick } from './localized-text.ts'
import type { SettingsLike } from './native-seams.ts'
import type { BundleLike } from './plugin-rows.ts'
import { bundleTitle } from './plugin-status.ts'

export interface PluginSettingsDependencies {
  settings(): SettingsLike | undefined
  /** The profile's bundles, naming the plugin each namespace belongs to; empty without a plugin manager. */
  bundles(): Promise<readonly BundleLike[]>
}

/** A rehydrated schemastery node, as far as the form walk reads it. */
interface SchemaNode {
  type: string
  meta?: { role?: unknown; hidden?: unknown; description?: unknown }
  dict?: Record<string, SchemaNode>
  inner?: SchemaNode
  list?: SchemaNode[]
}

/** One described namespace with its schema rehydrated. */
interface Namespace {
  ns: string
  schema: SchemaNode
  value: unknown
  base: unknown
  user: unknown
  revision: number
  applies: string | undefined
  secrets: ReadonlyArray<{ readonly path: readonly string[]; readonly set: boolean }>
}

/** One listed field: a leaf of the form, an object field shown whole, or a secret slot. */
interface Field {
  path: string[]
  secret?: { set: boolean }
  value?: unknown
  base?: unknown
  overridden: boolean
  description?: string
}

/** Nested plain-object fields are listed one path deeper at most this far. */
const MAX_DEPTH = 4
/** A value or default wider than this shows as clipped compact JSON. */
const MAX_VALUE = 80

export const CONFIG_USAGE = '`/dsh config [<namespace>]` | `/dsh config set <namespace> <field> <json>` | `/dsh config reset <namespace> <field>`'

/** Inline code for a table cell: pipes escaped, a longer fence around backticks. */
const code = (text: string): string => {
  const cell = text.replace(/\|/g, '\\|')
  return cell.includes('`') ? '`` ' + cell + ' ``' : '`' + cell + '`'
}
const clip = (text: string, limit = MAX_VALUE): string => text.length > limit ? text.slice(0, limit - 1) + '…' : text
const dotted = (path: readonly string[]): string => path.join('.')
/** A path as `/dsh config` takes it back: dotted, or a JSON array when a key has a dot. */
const pathArgument = (path: readonly string[]): string => path.some(key => key.includes('.')) ? JSON.stringify(path) : dotted(path)
const own = (record: unknown, key: string): unknown => isRecord(record) || Array.isArray(record)
  ? Object.hasOwn(record, key) ? (record as Record<string, unknown>)[key] : undefined : undefined
const read = (value: unknown, path: readonly string[]): unknown => path.reduce<unknown>((node, key) => own(node, key), value)
const has = (value: unknown, path: readonly string[]): boolean => {
  const parent = read(value, path.slice(0, -1))
  return (isRecord(parent) || Array.isArray(parent)) && Object.hasOwn(parent, path.at(-1)!)
}
const samePath = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((key, index) => key === b[index])
const within = (inner: readonly string[], outer: readonly string[]) => outer.length <= inner.length && outer.every((key, index) => key === inner[index])

/** A value as it shows: compact JSON in code, `-` for none. */
export function shownValue(value: unknown): string {
  if (value === undefined) return '-'
  let json: string | undefined
  try { json = JSON.stringify(value) } catch { json = undefined }
  return code(clip((json ?? String(value)).replace(/\s+/g, ' ')))
}

/** The namespaces the service describes, redacted, with usable schemas. */
function namespaces(settings: SettingsLike): Namespace[] {
  return (settings.describe?.({ redactSecrets: true }) ?? []).flatMap(entry => {
    if (typeof entry.ns !== 'string' || typeof entry.revision !== 'number' || !isRecord(entry.schema)) return []
    let schema: SchemaNode
    try { schema = new Schema(entry.schema as never) as unknown as SchemaNode } catch { return [] }
    if (schema.type !== 'object') return []
    return [{ ns: entry.ns, schema, value: entry.value, base: entry.base, user: entry.user, revision: entry.revision,
      applies: entry.applies, secrets: entry.secrets ?? [] }]
  })
}

const describeText = (description: unknown, locale: string | undefined): string | undefined =>
  pick(description, locale) ?? (isRecord(description) ? pick(description[''], locale) : undefined)

/** The form's fields in schema order: leaves, plain objects one level at a
 * time, secret slots as set or unset (nested ones after the rest). */
function fields(namespace: Namespace, locale: string | undefined = environmentLocale()): Field[] {
  const rows: Field[] = []
  const slot = (path: readonly string[]) => namespace.secrets.find(secret => samePath(secret.path, path))
  const walk = (node: SchemaNode, path: string[]) => {
    for (const [key, child] of Object.entries(node.dict ?? {})) {
      if (child.meta?.hidden === true) continue
      const at = [...path, key]
      const description = describeText(child.meta?.description, locale)
      const about = description === undefined ? {} : { description }
      if (child.meta?.role === 'secret') rows.push({ path: at, secret: { set: slot(at)?.set === true }, overridden: false, ...about })
      else if (child.type === 'object' && Object.keys(child.dict ?? {}).length > 0 && at.length < MAX_DEPTH) walk(child, at)
      else rows.push({ path: at, value: read(namespace.value, at), base: read(namespace.base, at), overridden: has(namespace.user, at), ...about })
    }
  }
  walk(namespace.schema, [])
  for (const secret of namespace.secrets) {
    if (!rows.some(row => samePath(row.path, secret.path))) rows.push({ path: [...secret.path], secret: { set: secret.set }, overridden: false })
  }
  return rows
}

/** The schema node a path addresses, through objects, dicts, arrays and
 * union members; `secret` when the path lies at or under a secret field. */
function locate(node: SchemaNode, path: readonly string[]): { node: SchemaNode; secret: boolean } | undefined {
  if (node.meta?.role === 'secret') return { node, secret: true }
  const [key, ...rest] = path
  if (key === undefined) return { node, secret: false }
  if (node.type === 'union' || node.type === 'intersect') {
    for (const member of node.list ?? []) {
      const found = locate(member, path)
      if (found !== undefined) return found
    }
    return undefined
  }
  const next = node.type === 'object' ? (Object.hasOwn(node.dict ?? {}, key) ? node.dict![key] : undefined)
    : node.type === 'dict' || (node.type === 'array' && /^(0|[1-9][0-9]*)$/.test(key)) ? node.inner : undefined
  return next === undefined ? undefined : locate(next, rest)
}

/** Whether a subtree declares any secret field; a write there could carry one or drop one. */
function holdsSecret(node: SchemaNode, seen = new Set<SchemaNode>()): boolean {
  if (seen.has(node)) return false
  seen.add(node)
  if (node.meta?.role === 'secret') return true
  return [...Object.values(node.dict ?? {}), ...node.inner === undefined ? [] : [node.inner], ...node.list ?? []].some(child => holdsSecret(child, seen))
}

/** A field path: dotted (`a.b.0`) or a JSON array of keys for keys with dots. */
function parsePath(text: string): string[] | undefined {
  if (text.startsWith('[')) {
    try {
      const keys: unknown = JSON.parse(text)
      return Array.isArray(keys) && keys.length > 0 && keys.every(key => typeof key === 'string' || Number.isInteger(key)) ? keys.map(String) : undefined
    } catch { return undefined }
  }
  const keys = text.split('.')
  return keys.every(key => key !== '') ? keys : undefined
}

/** A typed value: JSON, else the text itself as a string. */
function parseValue(text: string): unknown {
  try { return JSON.parse(text) } catch { return text }
}

const appliesText = (namespace: Namespace | undefined): string => namespace?.applies === 'live'
  ? 'applied to the running leader.' : 'saved; restart dscode to apply it.'

/** Why a write failed, in the settings service's own terms. */
function failure(ns: string, error: unknown): string {
  if (isRecord(error) && error.code === 'SETTINGS_CONFLICT') return code(ns) + ' changed elsewhere; run `/dsh config ' + ns + '` again.'
  return 'Not saved: ' + errorMessage(error)
}

/** Refusal for a secret: point at a credential reference beside the secret
 * field itself, else at the plugin's own flow. */
function secretRefusal(namespace: Namespace, path: readonly string[], direct: boolean): string {
  const parent = direct ? locate(namespace.schema, path.slice(0, -1))?.node : undefined
  const reference = Object.entries(parent?.dict ?? {}).find(([, child]) => child.meta?.role === 'credential-ref')?.[0]
  const where = code(dotted(path)) + ' of ' + code(namespace.ns)
  return where + ' is or holds a secret. /dsh config shows only whether a secret is set and never writes one: a value typed here would stay in the transcript. '
    + (reference === undefined
      ? 'Set it through the plugin\'s own flow (for model providers, /provider) or its credential store.'
      : 'Name a credential instead with `/dsh config set ' + namespace.ns + ' ' + dotted([...path.slice(0, -1), reference]) + ' <NAME>`, and keep the value in the DSH credential store or that environment variable.')
}

/** Titles of the enabled bundles that declare each row id, the first one winning. */
async function owners(dependencies: PluginSettingsDependencies): Promise<Map<string, string>> {
  const titles = new Map<string, string>()
  let bundles: readonly BundleLike[] = []
  try { bundles = await dependencies.bundles() } catch { /* titles are decoration */ }
  for (const bundle of [...bundles].sort((a, b) => Number(b.enabled) - Number(a.enabled))) {
    for (const row of bundle.rows) if (!titles.has(row.rowId)) titles.set(row.rowId, bundleTitle(bundle))
  }
  return titles
}

const summary = (rows: readonly Field[]) =>
  String(rows.length) + (rows.length === 1 ? ' field' : ' fields') + ' · ' + String(rows.filter(row => row.overridden).length) + ' overridden'

/** `/dsh config`: one row per namespace. */
async function listNamespaces(dependencies: PluginSettingsDependencies, all: readonly Namespace[]): Promise<string> {
  if (all.length === 0) return 'No loaded plugin serves settings here.'
  const titles = await owners(dependencies)
  const counted = all.map(namespace => ({ namespace, rows: fields(namespace) }))
  const overridden = counted.reduce((sum, { rows }) => sum + rows.filter(row => row.overridden).length, 0)
  return ['Settings served by loaded plugins: ' + String(all.length) + (all.length === 1 ? ' namespace' : ' namespaces')
    + ' · ' + String(overridden) + ' overridden', '', '| Namespace | Plugin | Fields | Overridden |', '| --- | --- | --- | --- |',
  ...counted.map(({ namespace, rows }) => '| ' + [code(namespace.ns), titles.get(namespace.ns) ?? '-', String(rows.length),
    String(rows.filter(row => row.overridden).length)].join(' | ') + ' |'),
  '', 'Show one: `/dsh config <namespace>`. Change a field: `/dsh config set <namespace> <field> <json>`; back to its default: `/dsh config reset <namespace> <field>`.'].join('\n')
}

/** `/dsh config <namespace>`: its fields, values, defaults and overrides. */
async function showNamespace(dependencies: PluginSettingsDependencies, namespace: Namespace): Promise<string> {
  const rows = fields(namespace)
  const title = (await owners(dependencies)).get(namespace.ns)
  const described = rows.some(row => row.description !== undefined)
  const lines = ['**' + namespace.ns + '**' + (title === undefined ? '' : ' (' + title + ')') + ': ' + summary(rows) + ' · '
    + (namespace.applies === 'live' ? 'changes apply to the running leader' : 'changes apply when dscode restarts'), '',
  '| Field | Value | Default |' + (described ? ' Description |' : ''), '| --- | --- | --- |' + (described ? ' --- |' : '')]
  for (const row of rows) {
    const value = row.secret !== undefined ? (row.secret.set ? 'set' : 'unset') + ' · secret'
      : shownValue(row.value) + (row.overridden ? ' · overridden' : '')
    const cells = [code(dotted(row.path)), value, row.secret === undefined ? shownValue(row.base) : '-']
    if (described) cells.push(clip((row.description ?? '').replace(/\s+/g, ' ').replace(/\|/g, '\\|'), 160))
    lines.push('| ' + cells.join(' | ') + ' |')
  }
  lines.push('', 'Change a field: `/dsh config set ' + namespace.ns + ' <field> <json>` (text that is not JSON is a string); back to its default: `/dsh config reset '
    + namespace.ns + ' <field>`. Secrets are never set here.')
  return lines.join('\n')
}

/** `/dsh config set|reset <namespace> <field> [value]` through `settings.mutate` at the described revision. */
async function change(settings: SettingsLike, all: readonly Namespace[], verb: 'set' | 'reset', ns: string, pathText: string, raw: string | undefined): Promise<string> {
  const namespace = all.find(candidate => candidate.ns === ns)
  if (namespace === undefined) return code(ns) + ' is not a settings namespace of a loaded plugin. `/dsh config` lists them.'
  const path = parsePath(pathText)
  const target = path === undefined ? undefined : locate(namespace.schema, path)
  if (path === undefined || target === undefined) {
    return code(ns) + ' has no field ' + code(pathText) + '. Fields: ' + fields(namespace).map(row => code(dotted(row.path))).join(', ') + '.'
  }
  if (target.secret || holdsSecret(target.node) || namespace.secrets.some(secret => within(secret.path, path) || within(path, secret.path))) {
    return secretRefusal(namespace, path, target.secret)
  }
  if (settings.writable === false) return 'This profile does not accept settings changes.'
  if (verb === 'reset' && !has(namespace.user, path)) {
    return code(dotted(path)) + ' of ' + code(ns) + ' is not overridden; it is ' + shownValue(read(namespace.value, path)) + '.'
  }
  const op = verb === 'set' ? { op: 'set', path, value: parseValue(raw!) } : { op: 'unset', path }
  try {
    await settings.mutate(ns, [op], namespace.revision)
  } catch (error) {
    return failure(ns, error)
  }
  const after = namespaces(settings).find(candidate => candidate.ns === ns)
  const now = shownValue(read(after?.value, path))
  return verb === 'set'
    ? 'Set ' + code(dotted(path)) + ' of ' + code(ns) + ' to ' + now + '; ' + appliesText(after)
    : 'Reset ' + code(dotted(path)) + ' of ' + code(ns) + ' to its default ' + now + '; ' + appliesText(after)
}

/** The words after `config`: namespace, field and the raw value text (quotes kept). */
function configWords(text: string): { words: string[]; raw: string | undefined } {
  const rest = text.replace(/^\s*\/dsh\s+config\b/i, '').trim()
  const match = /^(\S+)(?:\s+(\S+))?(?:\s+(\S+))?(?:\s+([\s\S]+))?$/.exec(rest)
  if (match === null) return { words: [], raw: undefined }
  return { words: match.slice(1, 4).filter((word): word is string => word !== undefined), raw: match[4]?.trim() }
}

export function createPluginSettings(dependencies: PluginSettingsDependencies) {
  const service = (): SettingsLike | undefined => dependencies.settings()
  return {
    /** Whether a `/dsh` line is a config command. */
    matches: (text: string): boolean => /^\s*\/dsh\s+config(?:\s|$)/i.test(text),
    /** Run one `/dsh config …` line. */
    async execute(text: string): Promise<string> {
      const settings = service()
      if (settings?.describe === undefined) return 'The DSH settings service is not running in this leader; restart dscode and retry.'
      await settings.ready?.catch(() => undefined)
      const all = namespaces(settings)
      const { words, raw } = configWords(text)
      const [first, ns, path] = words
      if (first === undefined) return await listNamespaces(dependencies, all)
      if (first === 'set' || first === 'reset') {
        if (ns === undefined || path === undefined || (first === 'set' ? raw === undefined : raw !== undefined)) {
          return first === 'set' ? 'Usage: `/dsh config set <namespace> <field> <json>`' : 'Usage: `/dsh config reset <namespace> <field>`'
        }
        return await change(settings, all, first, ns, path, raw)
      }
      if (words.length > 1 || raw !== undefined) return 'Usage: ' + CONFIG_USAGE
      const namespace = all.find(candidate => candidate.ns === first)
      return namespace === undefined ? code(first) + ' is not a settings namespace of a loaded plugin. `/dsh config` lists them.'
        : await showNamespace(dependencies, namespace)
    },
    /** Options after `/dsh config`: the namespaces, then a namespace's view and resets. */
    async options(query: string): Promise<SelectOption[]> {
      const settings = service()
      if (settings?.describe === undefined) return []
      const all = namespaces(settings)
      const ns = query.slice('config'.length).trim()
      if (ns === '') {
        const titles = await owners(dependencies)
        return all.map(namespace => ({ id: 'config ' + namespace.ns, label: namespace.ns, next: true,
          detail: [titles.get(namespace.ns), summary(fields(namespace))].filter(part => part !== undefined).join(' · ') }))
      }
      const namespace = all.find(candidate => candidate.ns === ns)
      if (namespace === undefined) return []
      const rows = fields(namespace)
      return [{ id: 'config ' + ns, label: 'Show every field', detail: summary(rows) },
        ...rows.filter(row => row.overridden).map(row => ({ id: 'config reset ' + ns + ' ' + pathArgument(row.path), label: 'Reset ' + dotted(row.path),
          detail: 'now ' + clip(JSON.stringify(row.value) ?? '-', 40) + ' · default ' + clip(JSON.stringify(row.base) ?? '-', 40),
          confirmation: confirmation('Reset ' + dotted(row.path) + '?', 'It returns to its default, ' + (JSON.stringify(row.base) ?? 'none') + '.', 'Reset') }))]
    },
  }
}

export type PluginSettings = ReturnType<typeof createPluginSettings>
