import readline from 'node:readline'

const input = readline.createInterface({ input: process.stdin })
input.on('line', (line) => {
  const message = JSON.parse(line)
  if (message.id === undefined) return
  let result
  if (message.method === 'initialize') {
    result = { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'dscode-test', version: '1.0.0' } }
  } else if (message.method === 'tools/list') {
    result = { tools: [{ name: 'echo', description: 'Echo text', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }] }
  } else if (message.method === 'tools/call') {
    result = { content: [{ type: 'text', text: String(message.params?.arguments?.text ?? '') }] }
  } else {
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } })}\n`)
    return
  }
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n`)
})
