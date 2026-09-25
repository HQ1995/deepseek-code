/** The DSH plugin manager seam the bridge reads bundles and rows through. */
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

describe('plugin manager seam', () => {
  it('compiles the runtime plugin manager against the structural seam it is read through', () => {
    const file = fileURLToPath(new URL('./plugin-manager-seam.mts', import.meta.url))
    const source = `
      import type { PluginManager } from '@deepseek-ai/dsh-plugin-manager'
      import type { PluginManagerLike } from '../src/plugin-rows.ts'
      export const seam = (manager: PluginManager): PluginManagerLike => manager
    `
    const options: ts.CompilerOptions = { noEmit: true, skipLibCheck: true, strict: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext, allowImportingTsExtensions: true, types: ['node'] }
    const host = ts.createCompilerHost(options), read = host.getSourceFile.bind(host)
    host.getSourceFile = (path, ...args) => path === file ? ts.createSourceFile(path, source, ts.ScriptTarget.ES2022, true) : read(path, ...args)
    const program = ts.createProgram([file], options, host)
    expect(ts.getPreEmitDiagnostics(program).map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))).toEqual([])
  })

})
