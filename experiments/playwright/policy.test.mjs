import assert from 'node:assert/strict'
import { test } from 'node:test'
import { browserDenial, navigationOrigins, prefix } from './policy.mjs'

const origins = navigationOrigins(['http://127.0.0.1:3456'])
const deny = (name, args = {}) => browserDenial({ name: prefix + name, arguments: args }, origins)

test('explicit HTTP(S) origins are required', () => {
  for (const value of [[], ['file:///tmp'], ['https://example.com/'], ['https://user@example.com'], ['invalid']]) {
    assert.throws(() => navigationOrigins(value))
  }
})
test('unreviewed tools and host execution or transfer tools fail closed', () => {
  for (const tool of ['browser_run_code_unsafe', 'browser_evaluate', 'browser_file_upload', 'browser_drop', 'browser_tabs', 'browser_install', 'browser_future_tool']) {
    assert.match(deny(tool), /disabled/)
  }
  assert.equal(browserDenial({ name: 'unrelated', arguments: {} }, origins), undefined)
})
test('direct navigation validates scheme, credentials and exact origin', () => {
  assert.equal(deny('browser_navigate', { url: 'http://127.0.0.1:3456/path?q=1' }), undefined)
  for (const url of ['file:///tmp/a', 'javascript:alert(1)', 'blob:http://127.0.0.1:3456/id', 'http://127.0.0.1:3457/', 'http://user@127.0.0.1:3456/', 'https://example.com', '//127.0.0.1:3456/', null]) {
    assert.equal(typeof deny('browser_navigate', { url }), 'string')
  }
})
test('output paths and private MCP metadata are rejected even when empty', () => {
  for (const key of ['filename', 'paths', '_meta']) {
    assert.match(deny('browser_take_screenshot', { [key]: '' }), /disabled/)
  }
  assert.equal(deny('browser_take_screenshot', {}), undefined)
})
