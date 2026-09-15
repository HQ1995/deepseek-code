import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const root = fileURLToPath(new URL('..', import.meta.url))
const sources = new Map<string, ts.SourceFile>()
for (const folder of ['src', 'bin']) {
  for (const entry of readdirSync(join(root, folder), { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !/\.(?:ts|mjs)$/.test(entry.name) || entry.name.endsWith('.d.ts')) continue
    const path = join(entry.parentPath, entry.name)
    sources.set(relative(root, path), ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true))
  }
}
const allEdges = new Map<string, Set<string>>()
const runtimeEdges = new Map<string, Set<string>>()
const externals = new Map<string, Set<string>>()
const runtimeExternals = new Map<string, Set<string>>()
const unresolved: string[] = []
const computedImports: string[] = []
for (const [path, source] of sources) {
  const all = new Set<string>(), runtime = new Set<string>(), external = new Set<string>(), runtimeExternal = new Set<string>()
  allEdges.set(path, all); runtimeEdges.set(path, runtime); externals.set(path, external)
  runtimeExternals.set(path, runtimeExternal)
  const edge = (specifier: string, typeOnly: boolean) => {
    if (!specifier.startsWith('.')) { external.add(specifier); if (!typeOnly) runtimeExternal.add(specifier); return }
    const target = relative(root, resolve(root, dirname(path), specifier))
    if (!sources.has(target)) unresolved.push(path + ' -> ' + target)
    all.add(target)
    if (!typeOnly) runtime.add(target)
  }
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause
      const named = clause?.namedBindings
      const typeOnly = clause?.isTypeOnly === true || (clause?.name === undefined && named !== undefined
        && ts.isNamedImports(named) && named.elements.length > 0 && named.elements.every(element => element.isTypeOnly))
      edge(node.moduleSpecifier.text, typeOnly)
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.exportClause
      edge(node.moduleSpecifier.text, node.isTypeOnly || (clause !== undefined && ts.isNamedExports(clause)
        && clause.elements.length > 0 && clause.elements.every(element => element.isTypeOnly)))
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const argument = node.arguments[0]
      if (argument && ts.isStringLiteral(argument)) edge(argument.text, false)
      else computedImports.push(path + ': ' + argument?.getText(source))
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
}
// Package provenance resolves this existing launcher module from the package
// root in both source and lib builds. Model that edge rather than ignoring it.
allEdges.get('src/package-location.ts')!.add('bin/update.mjs')
runtimeEdges.get('src/package-location.ts')!.add('bin/update.mjs')

describe('architecture ownership and dependency gate', () => {
  it('reuses the host projection/schema packages instead of bundling duplicate runtime copies', () => {
    const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>; peerDependencies: Record<string, string>; devDependencies: Record<string, string>; dsh: { testedVersion: string }
    }
    for (const [name, version] of [['@deepseek-ai/dsh-session-projection', manifest.dsh.testedVersion], ['zod', '^4.4.3']]) {
      expect(manifest.dependencies[name!]).toBeUndefined()
      expect(manifest.peerDependencies[name!]).toBe(version)
      expect(manifest.devDependencies[name!]).toBe(version)
    }
  })

  it('preserves durable event vocabulary for consumers of the built public type entry', () => {
    // Deliberately consume emitted declarations, not src/index.ts: source
    // compilation includes every augmentation and can hide a missing type edge.
    // Like the package/runtime gates, this requires the normal pre-test build.
    const consumer = join(root, 'tests', 'public-type-consumer.mts')
    const content = `
      import type {} from '../lib/types/index.js'
      import type { ToolResultContentBlock } from '../lib/types/index.js'
      import type { SessionEventMap } from '@deepseek-ai/dsh-session/types'
      import type { SessionProjectionStateMap } from '@deepseek-ai/dsh-session-projection/types'
      const native: SessionEventMap['model/selection'] = { provider: 'native', model: 'model' }
      const legacy: SessionEventMap['dscode/model-selected'] = { provider: 'legacy', model: 'model' }
      const older: SessionEventMap['model/selected'] = { provider: 'older', model: 'model', reasoningEffort: 'high' }
      const content: ToolResultContentBlock = { type: 'content', content: { type: 'text', text: 'preserved' } }
      const preset: SessionProjectionStateMap['dscodePresetHistory'] = { selected: 'standard', locked: false }
      void [native, legacy, older, content, preset]
    `
    const options: ts.CompilerOptions = { noEmit: true, skipLibCheck: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, types: [] }
    const host = ts.createCompilerHost(options), read = host.getSourceFile.bind(host)
    host.getSourceFile = (path, ...args) => path === consumer ? ts.createSourceFile(path, content, ts.ScriptTarget.ES2022, true) : read(path, ...args)
    const program = ts.createProgram([consumer], options, host)
    expect(ts.getPreEmitDiagnostics(program).map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))).toEqual([])
  })

  it('resolves every local edge and requires computed imports to be explicitly accounted for', () => {
    expect(unresolved).toEqual([])
    expect(computedImports.sort()).toEqual([
      'bin/bootstrap.mjs: pathToFileURL(candidate).href', // validated active/recovery-stage updater
      "bin/bootstrap.mjs: pathToFileURL(join(profile, plugin, 'dscode.mjs')).href", // recovered installed launcher
      'bin/update.mjs: pathToFileURL(binding).href', // external pinned native file-lock binding
      "src/package-location.ts: pathToFileURL(join(PACKAGE_DIRECTORY, 'bin/update.mjs')).href",
    ])
  })

  it('has no runtime cycle across bridge and launcher modules', () => {
    const done = new Set<string>(), stack: string[] = [], cycles: string[] = []
    const visit = (path: string) => {
      if (stack.includes(path)) { cycles.push([...stack.slice(stack.indexOf(path)), path].join(' -> ')); return }
      if (done.has(path)) return
      stack.push(path)
      for (const target of runtimeEdges.get(path) ?? []) visit(target)
      stack.pop(); done.add(path)
    }
    for (const path of runtimeEdges.keys()) visit(path)
    expect(cycles).toEqual([])
  })

  it('never imports implementation dependencies through the entrypoint, including type-only back edges', () => {
    expect([...allEdges].filter(([, targets]) => targets.has('src/index.ts')).map(([path]) => path)).toEqual([])
  })

  it.each([
    ['model-catalog', ['acp', 'protocol']],
    ['leader-transport', ['acp', 'codec', 'protocol']],
    ['leader-lifecycle', []],
    ['prompt-queue', ['acp', 'projection', 'prompt-content']],
    ['prompt-content', ['acp', 'projection']],
    ['session-work', ['acp']],
    ['session-discovery', ['acp', 'session-list']],
    ['session-commands', ['acp', 'session-presets', 'session-work', 'session-output', 'prompt-content', 'prompt-queue']],
    ['session-artifacts', ['acp', 'projection', 'session-output', 'session-work']],
    ['session-input', ['acp', 'model-catalog', 'prompt-content', 'prompt-queue', 'session-models', 'projection']],
    ['session-registry', ['acp', 'session-work']],
    ['session-lifecycle', ['acp', 'mcp', 'prompt-queue', 'session-output', 'session-models', 'session-presets', 'session-registry', 'native-interactions', 'session-work', 'session-discovery', 'projection']],
    ['session-models', ['acp', 'model-catalog', 'session-migration']],
    ['session-presets', ['acp', 'model-catalog', 'preset-history']],
    ['preset-history', []],
    ['session-output', ['projection', 'image-output']],
    ['native-tasks', ['acp', 'reminders', 'session-output', 'session-work', 'job-output']],
    ['native-children', ['acp', 'child-history', 'workflows', 'prompt-content', 'projection', 'session-output', 'session-work', 'image-output']],
    ['native-session-status', ['acp', 'prompt-content', 'projection', 'session-output', 'session-work']],
    ['native-interactions', ['acp', 'leader-transport']],
    ['native-execution', ['acp', 'package-location', 'session-work']],
    ['native-asides', ['acp', 'session-work']],
    ['native-capabilities', []],
    ['profile-plugins', ['package-location', 'acp']],
  ] as const)('keeps the %s implementation behind its declared dependencies', (name, allowed) => {
    const actual = [...allEdges.get('src/' + name + '.ts')!]
    expect(actual.filter(target => !allowed.some(dependency => target === 'src/' + dependency + '.ts'))).toEqual([])
    // Session models name the native mount context in their interface, but do
    // not use a Cordis runtime or receive the host context as a dependency bag.
    if (name === 'session-models' || name === 'session-presets') expect([...runtimeExternals.get('src/' + name + '.ts')!]).not.toContain('@deepseek-ai/cordis')
    else if (!['profile-plugins', 'native-tasks'].includes(name)) expect([...externals.get('src/' + name + '.ts')!]).not.toContain('@deepseek-ai/cordis')
  })

  it('allows only the explicitly deferred synchronous Session readers, never new dependencies', () => {
    const deprecated = new Set(['snapshotEvents', 'eventAt', 'ownEvents'])
    const reads: Record<string, number> = {}
    for (const [path, source] of sources) {
      const visit = (node: ts.Node) => {
        const name = ts.isPropertyAccessExpression(node) ? node.name.text
          : ts.isElementAccessExpression(node) && ts.isStringLiteral(node.argumentExpression) ? node.argumentExpression.text : undefined
        if (name !== undefined && deprecated.has(name)) {
          const key = path + ':' + name
          reads[key] = (reads[key] ?? 0) + 1
        }
        ts.forEachChild(node, visit)
      }
      visit(source)
    }
    // Remove entries as their owners migrate. Do not copy these exceptions to
    // new callers or conceal a complete log read behind a synchronous alias.
    expect(reads).toEqual({
      'src/native-children.ts:snapshotEvents': 2, // live child pages and interruption overview
      'src/workflows.ts:snapshotEvents': 1, // bounded incremental seed/tail
      'src/native-tasks.ts:ownEvents': 1, // optional Schedule projection absence
    })
  })

  it('does not move socket/provider/queue engines or mutable registries back into composition', () => {
    const source = sources.get('src/index.ts')!
    const violations: string[] = []
    const forbidden = new Set(['queueSeq', 'promptQueue', 'sessionOperations', 'teardowns', 'discoveredRoutes', 'discoveredModels', 'runPrompt', 'handleConnection',
      'projectOutputTails', 'assistantStreams', 'lastUsage', 'jobSubscriptions', 'jobSnapshots', 'jobOutputSnapshots', 'reminderSnapshots',
      'liveWorkflows', 'workflowIndexes', 'childStates', 'workflowChildDiscovery', 'childSettlements', 'childLogs', 'childRefreshes', 'goalSnapshots',
      'modelEfforts', 'reconcileSessionReasoningEfforts', 'setSessionModel', 'notifyModelsUpdate',
      'composePreset', 'presetRequestFromMeta', 'sessionPresetFromLog', 'presetSwitchLocked', 'persistPresetDefault', 'SHIPPED_PRESET_DISPLAY',
      'newSession', 'loadSession', 'forkSession', 'executeRewind', 'readPersistedSession', 'publishSession', 'sessionOperation',
      'sessionListIndex', 'searchSessions', 'DEFAULT_SESSION_LIST_LIMIT', 'availableCommands', 'commandCatalog', 'broadcastAvailableCommands', 'runDshCommand', 'runPresetCommand', 'settleBridgeCommand', 'sessionSkills', 'listSkills', 'runtimeDoctor', 'terminalControls', 'execFileAsync', 'renameSession', 'contextSnapshot', 'prompt', 'cancel', 'durablePromptContent', 'btw', 'idleExitTimer', 'idleExitGeneration', 'cancelIdleExit', 'scheduleIdleExit', 'teardownClient', 'quiescing', 'quiesce', 'toolNamesFor', 'capabilitiesFor', 'listMcpServers', 'permissionDecision', 'applyPermissionMode', 'setSessionMode', 'validateSessionMeta', 'textToId'])
    const visit = (node: ts.Node) => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && forbidden.has(node.name.text)) violations.push(node.name.text)
      if (ts.isNewExpression(node) && ts.isIdentifier(node.expression)
        && ['Map', 'Set', 'AbortController'].includes(node.expression.text)) violations.push('new ' + node.expression.text)
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)
        && ['setTimeout', 'setInterval'].includes(node.expression.text)) violations.push(node.expression.text)
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
        && ts.isIdentifier(node.expression.expression) && ['sessions', 'connections'].includes(node.expression.expression.text)
        && ['set', 'delete', 'clear'].includes(node.expression.name.text)) violations.push(node.expression.getText(source))
      ts.forEachChild(node, visit)
    }
    visit(source)
    expect(violations).toEqual([])
    expect(externals.get('src/index.ts')).not.toContain('node:net')
  })
})
