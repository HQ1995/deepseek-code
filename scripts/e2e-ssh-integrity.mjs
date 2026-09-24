#!/usr/bin/env node
/** dsh-ssh must refuse a helper or bootstrap whose digest differs before it
 * exposes a provider; the SSH execution world relies on this.
 * Usage: e2e-ssh-integrity.mjs <extracted-runtime> <config.json> */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { releaseSdk } from './release-sdk.mjs'

const { sdk } = releaseSdk(process.argv[2])
const { Context } = await sdk('@deepseek-ai/cordis')
const { default: SshConnection } = await sdk('@deepseek-ai/dsh-ssh')
const config = JSON.parse(await readFile(process.argv[3], 'utf8'))
for (const field of ['helperHash', 'bootstrapHash']) {
  const ctx = new Context()
  try {
    await assert.rejects(async () => { await ctx.plugin(SshConnection, { ...config, [field]: '0'.repeat(64) }) }, /digest differs/)
    console.log('PASS mismatched ' + field + ' rejected before provider exposure')
  } finally { await ctx.fiber.dispose() }
}
