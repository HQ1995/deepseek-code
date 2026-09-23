import readline from 'node:readline'

const input = readline.createInterface({ input: process.stdin })
const resourcesOnly = process.argv.includes('--resources-only')
input.on('line', (line) => {
  const message = JSON.parse(line)
  if (message.id === undefined) return
  let result
  if (message.method === 'initialize') {
    result = { protocolVersion: '2024-11-05', capabilities: resourcesOnly ? { resources: {} } : { tools: {} }, serverInfo: { name: 'dscode-test', version: '1.0.0' } }
  } else if (message.method === 'tools/list') {
    result = { tools: resourcesOnly ? [] : [{ name: 'echo', description: 'Echo text', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }] }
  } else if (resourcesOnly && message.method === 'resources/list') {
    result = { resources: [{ name: 'Fixture', uri: 'fixture://readme', mimeType: 'text/plain' }] }
  } else if (resourcesOnly && message.method === 'resources/templates/list') {
    result = { resourceTemplates: [{ name: 'Record', uriTemplate: 'fixture://record/{id}', mimeType: 'text/plain' }] }
  } else if (resourcesOnly && message.method === 'resources/read') {
    result = { contents: [{ uri: message.params.uri, mimeType: 'text/plain', text: `Resource ${message.params.uri}` }] }
  } else if (message.method === 'tools/call') {
    result = { content: [{ type: 'text', text: String(message.params?.arguments?.text ?? '') }] }
  } else {
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } })}\n`)
    return
  }
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n`)
})
