import { describe, expect, it } from 'vitest'
import { assembleCatalog, modelSelectionFromRequest, providerNote, resolveSelection, type CatalogSources, type ProviderModels } from '../src/wire-catalog.ts'
import type { ModelInfo } from '../src/native-seams.ts'

const listing = (provider: string, ids: string[], metadata: Record<string, Partial<ModelInfo>> = {}): ProviderModels => ({
  provider,
  models: ids.map(id => ({ id, name: id.toUpperCase() })),
  metadata: new Map(Object.entries(metadata).map(([id, info]) => [id, { provider, id, ...info }])),
})
const sources = (overrides: Partial<CatalogSources>): CatalogSources => ({
  rows: [], providers: [], config: {}, defaultSelection: undefined, ...overrides,
})
const efforts = (...ids: string[]) => ({ reasoning: { efforts: ids.map(id => ({ id })) } })

describe('assembleCatalog', () => {
  it('keeps the first bare id and qualifies later owners without colliding with listed raw ids', () => {
    const { catalog } = assembleCatalog(sources({ rows: [listing('a', ['m', 'b:m']), listing('b', ['m'])] }))
    expect(catalog.availableModels.map(model => model.modelId)).toEqual(['m', 'b:m', 'b:m (2)'])
    expect(catalog.routesByModel.get('b:m (2)')).toEqual({ provider: 'b', model: 'm' })
    expect(catalog.providerModelToWireId.get('a\u0000b:m')).toBe('b:m')
  })

  it('prefers the saved effort, then the adapter default, and never invents one', () => {
    const rows = [listing('p', ['m'], { m: { reasoning: { defaultEffort: 'high', efforts: [{ id: 'low' }, { id: 'high' }] } } })]
    const saved = assembleCatalog(sources({ rows, defaultSelection: { provider: 'p', model: 'm', reasoningEffort: 'low' } }))
    expect(saved.catalog.availableModels[0]!._meta).toMatchObject({ reasoningEffort: 'low', reasoningEfforts: ['low', 'high'] })
    const unsupported = assembleCatalog(sources({ rows, defaultSelection: { provider: 'p', model: 'm', reasoningEffort: 'max' } }))
    expect(unsupported.catalog.availableModels[0]!._meta?.reasoningEffort).toBe('high')
    const plain = assembleCatalog(sources({ rows: [listing('p', ['m'])] }))
    expect(plain.catalog.availableModels[0]!._meta).toEqual({ provider: 'p', supportsReasoningEffort: false, acceptsImages: false })
  })

  it('falls back to the first advertised model and reports a requested model the catalog lost', () => {
    const result = assembleCatalog(sources({ rows: [listing('p', ['a', 'b'])], config: { provider: 'p', model: 'gone' } }))
    expect(result.missingRequested).toBe('gone')
    expect(result.catalog).toMatchObject({ currentModelId: 'a', currentProviderId: 'p' })
    const empty = assembleCatalog(sources({}))
    expect(empty).toEqual({ catalog: expect.objectContaining({ currentModelId: '', currentProviderId: '' }) })
  })

  it('reads image support from exact metadata before the static listing', () => {
    const row: ProviderModels = { provider: 'p', models: [{ id: 'v', name: 'V', inputModalities: ['text'] }], metadata: new Map([['v', { provider: 'p', id: 'v', inputModalities: ['text', 'image'], ...efforts('high') }]]) }
    const { catalog } = assembleCatalog(sources({ rows: [row] }))
    expect(catalog.availableModels[0]!._meta).toMatchObject({ acceptsImages: true, inputModalities: ['text', 'image'] })
  })
})

describe('selection resolution', () => {
  const catalog = assembleCatalog(sources({ rows: [listing('a', ['m'], { m: efforts('low', 'high') }), listing('b', ['m'], { m: efforts('high') })] })).catalog

  it('lets a qualified wire id infer its provider and keeps an accepted explicit effort', () => {
    expect(resolveSelection(catalog, {}, undefined, { model: 'b:m', reasoningEffort: 'high' })).toEqual({ provider: 'b', model: 'm', reasoningEffort: 'high' })
  })

  it('drops an effort the chosen model does not accept', () => {
    expect(resolveSelection(catalog, {}, undefined, { model: 'b:m', reasoningEffort: 'low' })).toEqual({ provider: 'b', model: 'm' })
  })

  it('fails closed for an explicit model the catalog does not carry', () => {
    expect(() => resolveSelection(catalog, {}, undefined, { provider: 'a', model: 'missing' })).toThrow('requested provider/model is not in the catalog: a/missing')
  })

  it('seeds an unconfigured session from the catalog, and returns nothing for an empty catalog', () => {
    expect(resolveSelection(catalog, {}, undefined, undefined)).toEqual({ provider: 'a', model: 'm' })
    expect(resolveSelection(assembleCatalog(sources({})).catalog, {}, undefined, undefined)).toBeUndefined()
  })

  it('orders request overrides before deployment config before the saved default', () => {
    const saved = { provider: 's', model: 'saved', reasoningEffort: 'low' }
    expect(modelSelectionFromRequest({ provider: 'c', model: 'config' }, saved, { model: 'meta' })).toEqual({ provider: 'c', model: 'meta' })
    expect(modelSelectionFromRequest({}, saved, null)).toEqual(saved)
    expect(modelSelectionFromRequest({ provider: '', model: '' }, undefined, {})).toBeUndefined()
  })
})

describe('provider notes', () => {
  it('prefers the configuration error, then a listing failure, then the empty-provider pointer', () => {
    expect(providerNote('bad profile', 0, 'unreachable')).toBe('bad profile')
    expect(providerNote(undefined, 0, 'fetch failed\n  at connect')).toBe('could not list models: fetch failed at connect')
    expect(providerNote(undefined, 0, '   ')).toBe('could not list models: unknown error')
    expect(providerNote(undefined, 0)).toMatch(/^no models yet/)
    expect(providerNote(undefined, 3)).toBeUndefined()
  })

  it('keeps a long listing failure to one bounded line', () => {
    const note = providerNote(undefined, 0, 'x'.repeat(500))!
    expect(note.startsWith('could not list models: ')).toBe(true)
    expect(note.length).toBe('could not list models: '.length + 200)
    expect(note.endsWith('…')).toBe(true)
  })
})
