import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export const sixUrl = 'https://example.invalid/' + 'long-segment/'.repeat(24) + 'complete-target'
export const sixEmail = 'long-address-' + 'segment-'.repeat(20) + '@example.invalid'
export function nextSixReply(body) {
  const messages = body.messages ?? []
  const start = messages.findLastIndex(message => message.role === 'user' && typeof message.content === 'string' && message.content.includes('DSCODE_SIX_'))
  if (start < 0) return
  const prompt = messages[start].content
  const results = messages.slice(start + 1).filter(message => message.role === 'tool')
  if (prompt.includes('DSCODE_SIX_SKILL')) return { text: JSON.stringify(messages).includes('SIX_PRIVATE_BODY_ALPHA') ? 'DSCODE_SIX_SKILL_LOADED' : 'DSCODE_SIX_SKILL_MISSING' }
  if (prompt.includes('DSCODE_SIX_SCOPE')) return { text: JSON.stringify(messages).includes('SIX_PRIVATE_BODY_BETA') ? 'DSCODE_SIX_SCOPE_BETA' : 'DSCODE_SIX_SCOPE_MISSING' }
  if (prompt.includes('DSCODE_SIX_VIEWER')) return { text: Array.from({ length: 90 }, (_, i) => `SIX_VIEWER_LINE_${String(i).padStart(3, '0')} 中文 selection text`).join('\n\n') }
  if (prompt.includes('DSCODE_SIX_TABLE')) return { text: `| Link | Status |\n| --- | --- |\n| ${sixUrl} | URL |\n| ${sixEmail} | Email |` }
  if (prompt.includes('DSCODE_SIX_TURN')) return { text: Array.from({ length: 35 }, (_, i) => `SIX_TURN_${prompt.at(-1)}_BODY_${i}`).join('\n\n') }
  if (prompt.includes('DSCODE_SIX_LSP')) {
    const queries = [
      { operation: 'goToDefinition', line: 4, character: 9 },
      { operation: 'findReferences', line: 2, character: 14 },
      { operation: 'goToImplementation', line: 1, character: 11 },
      { operation: 'hover', line: 4, character: 1 },
    ]
    if (results.length < queries.length) return { name: 'lsp', arguments: { file_path: 'main.ts', ...queries[results.length] } }
    return { text: 'DSCODE_SIX_LSP_DONE' }
  }
  if (prompt.includes('DSCODE_SIX_CUSTOM')) return { text: 'DSCODE_SIX_CUSTOM_READY' }
}

export async function prepareNextSix(cwd) {
  await promisify(execFile)('git', ['init', '--quiet', cwd])
  const alpha = join(cwd, '.agents/skills/six-manual')
  await mkdir(alpha, { recursive: true })
  await writeFile(join(alpha, 'SKILL.md'), '---\nname: six-manual\ndescription: Six item acceptance skill\ndisable-model-invocation: true\n---\nSIX_PRIVATE_BODY_ALPHA\n')
  await writeFile(join(cwd, 'main.ts'), 'export interface Greeter { greet(): string }\nexport class Hello implements Greeter { greet() { return "hello" } }\nconst greeter: Greeter = new Hello();\ngreeter.greet();\n')
  await writeFile(join(cwd, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, target: 'ES2022' }, include: ['main.ts'] }))
}

export async function nextSixAcceptance(ui) {
  const { send, key, type, wait, waitFor, capture, waitState, readRequests, artifact, restart, runHeadless, cwd, scratch, resize, click, mediaOpenerLog } = ui
  const requestsBefore = (await readRequests()).length
  console.log('[next-six] theme aliases and settings double-click')
  const themeConfig = () => readFile(join(scratch, 'dsc-contract/config.toml'), 'utf8')
    .catch(error => { if (error.code === 'ENOENT') return ''; throw error })
  for (const [alias, canonical] of [['light', 'grokday'], ['dark', 'groknight']]) {
    await type(`/theme ${alias}`)
    await wait(new RegExp(canonical))
    await artifact(`theme-alias-${alias}`, { screen: await capture() })
    await key('Enter')
    await waitFor(themeConfig, value => value.includes(`theme = "${canonical}"`), `theme-alias-${alias}-committed`)
  }
  await send('/settings')
  await wait(/Settings/)
  await key('/'); await type('Color theme'); await key('Enter'); await key('Enter')
  await wait(/double-click select/)
  let themeRows = (await capture()).split('\n')
  let dayRow = themeRows.findIndex(row => row.includes('Dscode Day'))
  assert.ok(dayRow >= 0, 'Day theme must be visible in the settings picker')
  await click(themeRows[dayRow].indexOf('Dscode Day') + 2, dayRow)
  await ui.settle(350)
  assert.ok((await capture()).includes('double-click select'), 'Single click must keep the picker open')
  assert.ok((await themeConfig()).includes('theme = "groknight"'), 'Single-click preview must not persist')
  await key('Escape')
  await waitFor(capture, screen => !screen.includes('double-click select'), 'theme-preview-reverted')
  await key('Enter')
  await wait(/double-click select/)
  await wait(/[●•]\s+Dscode Night/)
  themeRows = (await capture()).split('\n')
  dayRow = themeRows.findIndex(row => row.includes('Dscode Day'))
  assert.ok(dayRow >= 0)
  await click(themeRows[dayRow].indexOf('Dscode Day') + 2, dayRow, 0, 2)
  await waitFor(themeConfig, value => value.includes('theme = "grokday"'), 'theme-double-click-persisted')
  await waitFor(capture, screen => screen.includes('Settings') && !screen.includes('double-click select'), 'theme-double-click-left-picker')
  await artifact('theme-settings-double-click', { screen: await capture(), config: await themeConfig() })
  await key('Escape')
  await waitFor(capture, screen => !screen.includes('Settings'), 'theme-settings-closed')
  await send('/theme dark')
  await waitFor(themeConfig, value => value.includes('theme = "groknight"'), 'theme-restored')
  assert.equal((await readRequests()).length, requestsBefore, 'Theme and settings must not send model requests')
  console.log('[next-six] native skills')
  await type('/six-')
  await wait(/six-manual[\s\S]*User only/)
  await artifact('six-skills-slash', { screen: await capture() })
  await key('C-u')
  await send('/skills')
  await wait(/Skills/)
  await key('/'); await type('six-manual'); await key('Enter')
  await wait(/User only/)
  await key('Down')
  await artifact('six-skills-picker', { screen: await capture() })
  await key('u')
  await wait(/Use \/six-manual/)
  assert.equal((await readRequests()).length, requestsBefore, 'Use skill must only edit the draft')
  await type('DSCODE_SIX_SKILL'); await key('Enter')
  await wait(/DSCODE_SIX_SKILL_LOADED/)
  await waitState(value => value.status === 'idle', 'six-skill-idle')
  await artifact('six-skills-injected', { screen: await capture() })

  const beta = join(scratch, 'six-beta')
  await promisify(execFile)('git', ['init', '--quiet', beta])
  await mkdir(join(beta, '.agents/skills/six-manual'), { recursive: true })
  await writeFile(join(beta, '.agents/skills/six-manual/SKILL.md'), '---\nname: six-manual\ndescription: Other workspace\ndisable-model-invocation: true\n---\nSIX_PRIVATE_BODY_BETA\n')
  await runHeadless({ cwd: beta, preset: 'standard', prompt: 'Use /six-manual DSCODE_SIX_SCOPE' })
  const scoped = (await readRequests()).findLast(request => JSON.stringify(request.messages).includes('SIX_PRIVATE_BODY_BETA'))
  assert.ok(scoped && !JSON.stringify(scoped.messages).includes('SIX_PRIVATE_BODY_ALPHA'), 'Native skills must load from each session workspace')

  console.log('[next-six] viewer quote and resume')
  await send('DSCODE_SIX_VIEWER')
  let viewerRows = (await wait(/SIX_VIEWER_LINE_/)).split('\n')
  await click(6, viewerRows.findIndex(row => row.includes('SIX_VIEWER_LINE_')))
  for (let i = 0; i < 10; i++) await key('NPage')
  await wait(/SIX_VIEWER_LINE_089/)
  await waitState(value => value.status === 'idle', 'six-viewer-idle')
  await key('Space')
  await type('draft before quote')
  viewerRows = (await wait(/SIX_VIEWER_LINE_089/)).split('\n')
  await click(6, viewerRows.findIndex(row => row.includes('SIX_VIEWER_LINE_089')))
  await key('C-f')
  await wait(/SIX_VIEWER_LINE_000/)
  for (let i = 0; i < 12; i++) await key('Down')
  await key('Escape'); await key('C-f')
  await resize(120, 32)
  const beforeQuote = (await readRequests()).length
  await key('Enter')
  await wait(/draft before quote[\s\S]*> SIX_VIEWER_LINE_006/)
  assert.equal((await readRequests()).length, beforeQuote, 'Quote must not send a model request')
  await artifact('six-viewer-quote-resume-resize', { screen: await capture() })
  await key('C-z')
  await waitFor(capture, screen => screen.includes('draft before quote') && !screen.includes('> SIX_VIEWER_LINE_'), 'six-quote-single-undo')
  await key('C-u')
  await resize(200, 60)

  console.log('[next-six] wrapped table link targets')
  const vimConfig = () => readFile(join(scratch, 'dsc-contract/config.toml'), 'utf8')
    .catch(error => { if (error.code === 'ENOENT') return ''; throw error })
  if (process.platform === 'darwin') {
    await send('/vim-mode')
    await waitFor(vimConfig, value => /^vim_mode = true$/m.test(value), 'six-vim-on')
  }
  await send('DSCODE_SIX_TABLE')
  await wait(/complete-target/)
  await waitState(value => value.status === 'idle', 'six-table-idle')
  for (const width of [80, 110]) {
    await resize(width, 40)
    await wait(/complete-target/)
    const rows = (await capture()).split('\n')
    const openedBefore = await readFile(mediaOpenerLog, 'utf8').catch(() => '')
    const row = rows.findIndex(line => line.includes('long-segment/') && !line.includes('https://'))
    assert.ok(row >= 0, 'URL must wrap across table lines')
    if (process.platform === 'darwin') {
      // macOS link clicks require the physical Cmd key via CoreGraphics;
      // tmux's Ctrl mouse bit cannot synthesize it. Exercise the real keyboard
      // link path here; physical Cmd-click remains a dedicated GUI check.
      if (!/(?:Space|Tab|i):prompt/.test(await capture())) await key('Tab')
      await wait(/(?:Space|Tab|i):prompt/)
      await key('o')
      await waitFor(capture, value => value.split('\n').slice(0, 3).some(line => line.includes('https://example.invalid/')), 'six-url-highlight')
      await key('Enter')
    } else await click(rows[row].indexOf('long-segment/') + 3, row, 16)
    await waitFor(async () => { try { return await readFile(mediaOpenerLog, 'utf8') } catch { return '' } }, value => value.slice(openedBefore.length).includes(sixUrl), 'six-full-url-open')
    const emailRow = rows.findIndex(line => line.includes('segment-') && !line.includes('long-segment/'))
    assert.ok(emailRow >= 0, 'Email must remain in the rendered table')
    if (process.platform === 'darwin') {
      await key('o'); await key('o')
      await waitFor(capture, value => value.split('\n').slice(0, 3).some(line => line.includes('mailto:long-address-')), 'six-email-highlight')
      await key('Enter')
    } else await click(rows[emailRow].indexOf('segment-') + 3, emailRow, 16)
    await waitFor(async () => { try { return await readFile(mediaOpenerLog, 'utf8') } catch { return '' } }, value => value.slice(openedBefore.length).includes('mailto:' + sixEmail), 'six-full-email-open')
    await artifact(`six-table-links-${width}`, { input: process.platform === 'darwin' ? 'keyboard (physical Cmd-click not covered)' : 'Ctrl-click', screen: await capture(), opened: await readFile(mediaOpenerLog, 'utf8') })
  }
  await resize(200, 60)
  console.log('[next-six] turn navigation')
  await key('Space')
  if (process.platform !== 'darwin') {
    await send('/vim-mode')
    await wait(/Vim mode: on/)
  }
  for (const turn of ['A', 'B']) {
    await send(`DSCODE_SIX_TURN_${turn}`)
    const turnRows = (await wait(new RegExp(`SIX_TURN_${turn}_BODY_`))).split('\n')
    const turnRow = turnRows.findIndex(row => row.includes(`SIX_TURN_${turn}_BODY_`))
    await click(6, turnRow)
    await key('G'); await key('Space')
    await wait(new RegExp(`SIX_TURN_${turn}_BODY_34`))
    await waitState(value => value.status === 'idle', `six-turn-${turn}-idle`)
  }
  await key('Tab')
  for (const [nav, marker] of [['K', 'DSCODE_SIX_TURN_B'], ['K', 'DSCODE_SIX_TURN_A'], ['J', 'DSCODE_SIX_TURN_B'], ['J', 'DSCODE_SIX_TURN_B']]) {
    await key(nav)
    const screen = await wait(new RegExp(marker))
    const row = screen.split('\n').findIndex(line => line.includes(marker))
    assert.ok(row >= 0 && row < 10, `Turn boundary must align near the viewport top: ${row}`)
    await artifact(`six-turn-${nav}-${marker.at(-1)}`, { screen })
  }
  await key('Space')
  await send('/vim-mode')

  console.log('[next-six] native preset copy, read and edit')
  await send('/preset manage')
  await wait(/Agent presets[\s\S]*standard · system[\s\S]*c: copy/)
  await key('e')
  await wait(/copy this preset before editing/i)
  const customPath = join(scratch, 'profiles/dscode/preset-bundles/six-custom/cordis.patch.yml')
  await key('c'); await wait(/New preset id/); await type('six-custom'); await key('Enter')
  await waitFor(() => readFile(customPath, 'utf8').catch(error => {
    if (error.code === 'ENOENT') return ''
    throw error
  }), Boolean, 'six-preset-copied')
  await wait(/Copied six-custom\. Press e to edit/)
  assert.match(await capture(), /› six-custom/, 'Copy success must reveal and select the new preset without navigation')
  await key('/'); await type('SIX-CUSTOM'); await key('Enter')
  await wait(/Search: SIX-CUSTOM[\s\S]*› six-custom/)
  await key('/'); await key('C-u'); await type('missing-preset'); await key('Enter')
  await wait(/No matching presets/)
  await key('Escape')
  await wait(/Search:\s+\(10\/10\)[\s\S]*\/: search · c: copy/)
  await key('/'); await wait(/Type to filter/); await type('six-custom'); await key('Enter')
  await wait(/Search: six-custom\s+\(1\/10\)[\s\S]*\/: search · c: copy/)
  await artifact('six-preset-copied', { screen: await capture() })
  const originalPreset = await readFile(customPath, 'utf8')
  await key('c'); await wait(/New preset id/); await type('six-custom'); await key('Enter')
  await wait(/already exists/)
  assert.equal(await readFile(customPath, 'utf8'), originalPreset, 'Duplicate copy must preserve the existing preset')
  await key('Escape')
  await wait(/\/: search · c: copy/)
  // A live copy of the Teams preset would give every open session Team tools.
  await key('/'); await key('C-u'); await type('teams'); await key('Enter')
  await wait(/Search: teams\s+\(1\/10\)[\s\S]*› Teams mode \(experimental\)/)
  await key('c'); await wait(/New preset id/); await type('teams-copy'); await key('Enter')
  await wait(/carries Agent Team tools/)
  await key('Escape')
  await wait(/\/: search · c: copy/)
  assert.equal(existsSync(join(scratch, 'profiles/dscode/preset-bundles/teams-copy')), false, 'A refused Teams copy must write nothing')
  await key('/'); await key('C-u'); await type('six-custom'); await key('Enter')
  await wait(/Search: six-custom\s+\(1\/10\)[\s\S]*› six-custom/)
  await key('e')
  await waitFor(() => readFile(customPath, 'utf8'), content => content.includes('SIX_PRESET_EDITED'), 'six-preset-editor')
  assert.equal(await readFile(customPath, 'utf8'), originalPreset + '\n# SIX_PRESET_EDITED\n')
  await key('v')
  await wait(/Preset: six-custom/)
  await key('G')
  await wait(/SIX_PRESET_EDITED/)
  await artifact('six-preset-read', { screen: await capture() })
  await key('Escape')
  await restart()
  await runHeadless({ cwd, preset: 'six-custom', prompt: 'DSCODE_SIX_CUSTOM' })

  console.log('[next-six] real TypeScript LSP')
  await runHeadless({ cwd, preset: 'lsp', prompt: 'DSCODE_SIX_LSP' })
  const lsp = (await readRequests()).findLast(request => request.messages?.some(message => message.role === 'user' && message.content === 'DSCODE_SIX_LSP'))
  const results = lsp.messages.filter(message => message.role === 'tool')
  const standard = (await readRequests()).find(request => request.messages?.some(message => message.role === 'user' && String(message.content).includes('DSCODE_SIX_VIEWER')))
  assert.ok(standard && !standard.tools.some(tool => tool.function.name === 'lsp'), 'LSP must remain isolated from standard')
  assert.equal(results.length, 4)
  for (const result of results) assert.ok(!/LSP_[A-Z_]+|isError|tool_error/.test(String(result.content)), String(result.content))
  assert.ok(results.slice(0, 3).every(result => String(result.content).includes('main.ts')))
  assert.match(String(results[3].content), /Greeter/)
  await artifact('six-lsp-real-server', { results, tools: lsp.tools?.map(tool => tool.function?.name) })
  return { themeSettings: 'alias picker canonical commit; single-click preview/revert; double-click persistence', skills: 'native scoped injection', viewer: 'draft/undo/resume/resize', table: process.platform === 'darwin' ? 'URL and email keyboard opens after resize (physical Cmd-click not covered)' : 'URL and email fragment clicks after resize', navigation: 'real turn boundaries', presets: 'native copy/read/external edit/restart', lsp: 'four real TypeScript queries' }
}
