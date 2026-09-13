// Private clipboard adapters for the generic macOS product E2E. Host clipboard
// acceptance is a separate suite: never read/write its content in this one.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export function prepareMacClipboard(bin) {
  mkdirSync(bin, { recursive: true })
  const state = join(resolve(bin), 'clipboard.txt')
  const helper = `#!/usr/bin/env node
const {readFileSync,writeFileSync,existsSync}=require('node:fs');
const {basename}=require('node:path');
const state=${JSON.stringify(state)};
switch(basename(process.argv[1])) {
  case 'pbcopy': writeFileSync(state,readFileSync(0)); break;
  case 'pbpaste': if(existsSync(state)) process.stdout.write(readFileSync(state)); break;
  case 'osascript':
    if(!process.argv.slice(2).some(arg=>arg.includes('clipboard'))) process.exit(1);
    break; // No file URLs or raster image on this private clipboard.
}
`
  for (const name of ['pbcopy', 'pbpaste', 'osascript']) writeFileSync(join(bin, name), helper, { mode: 0o755 })
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error('usage: node scripts/e2e-macos-clipboard.mjs <private-bin>')
  prepareMacClipboard(resolve(process.argv[2]))
}
