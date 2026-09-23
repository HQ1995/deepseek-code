/** OpenAI-compatible endpoint capability probe. The only outbound HTTP the
 * catalog performs itself; model identity still comes from native discovery. */

/** Canonical levels accepted by dsh-llm-pi-ai's reasoningEfforts schema. */
const PI_AI_REASONING_EFFORTS = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
/** Match dsh-llm-pi-ai's discovery response ceiling for caller-supplied URLs. */
const MODEL_LIST_MAX_BYTES = 4 * 1024 * 1024
const PROBE_TIMEOUT_MS = 5000
const textDecoder = new TextDecoder()

/** dsh-llm-pi-ai's canonical-level -> wire-value map (`null` only for off). */
export type PiAiReasoningEfforts = Record<string, string | null>

/** Per-model effort support: `false` means the endpoint declares none. */
export type EndpointCapabilities = Map<string, false | PiAiReasoningEfforts>

const nonEmpty = (value: unknown): value is string => typeof value === 'string' && value.length > 0

/** One list entry: `{id, value?, wire_value?}` objects or bare level strings. */
function listedEffort(item: unknown): [string, string | null] | undefined {
  if (typeof item === 'string') return PI_AI_REASONING_EFFORTS.has(item) ? [item, item] : undefined
  if (item === null || typeof item !== 'object') return undefined
  const value = item as Record<string, unknown>
  const id = nonEmpty(value.id) ? value.id : nonEmpty(value.value) ? value.value : undefined
  if (id === undefined || !PI_AI_REASONING_EFFORTS.has(id)) return undefined
  const explicitWire = value.wire_value ?? value.wireValue
  const wire = explicitWire === undefined && value.id !== undefined ? value.value : explicitWire
  if (wire === null && id === 'off') return [id, null]
  return [id, nonEmpty(wire) ? wire : id]
}

/** Strictly translate common OpenAI-compatible /models reasoning extensions
 * into dsh-llm-pi-ai's canonical-level -> wire-value map. Unknown levels are
 * ignored instead of being persisted into a schema that would reject them. */
export function endpointReasoningEfforts(entry: Record<string, unknown>): false | PiAiReasoningEfforts | undefined {
  const supports = entry.supports_reasoning_effort ?? entry.supportsReasoningEffort
  if (supports === false) return false
  const raw = entry.reasoning_efforts ?? entry.reasoningEfforts
  if (raw === false) return false
  const pairs: Array<[string, string | null]> = Array.isArray(raw)
    ? raw.map(listedEffort).filter(pair => pair !== undefined)
    : raw !== null && typeof raw === 'object'
      ? Object.entries(raw as Record<string, unknown>)
        .filter(([id, wire]) => PI_AI_REASONING_EFFORTS.has(id) && ((wire === null && id === 'off') || nonEmpty(wire)))
        .map(([id, wire]) => [id, wire as string | null])
      : []
  const result: PiAiReasoningEfforts = Object.fromEntries(pairs)
  return Object.keys(result).length > 0 ? result : undefined
}

/** Parse only per-model capability metadata from a `/models` listing. */
export function endpointModelCapabilities(value: unknown): EndpointCapabilities {
  const data = value !== null && typeof value === 'object'
    ? (value as { data?: unknown }).data
    : undefined
  const capabilities: EndpointCapabilities = new Map()
  if (!Array.isArray(data)) return capabilities
  for (const raw of data) {
    if (raw === null || typeof raw !== 'object') continue
    const entry = raw as Record<string, unknown>
    if (!nonEmpty(entry.id) || capabilities.has(entry.id)) continue
    const reasoningEfforts = endpointReasoningEfforts(entry)
    if (reasoningEfforts !== undefined) capabilities.set(entry.id, reasoningEfforts)
  }
  return capabilities
}

/** Read an untrusted model listing without buffering beyond the dsh ceiling. */
async function readBoundedModelListing(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get('content-length') ?? Number.NaN)
  if (Number.isFinite(declared) && declared > MODEL_LIST_MAX_BYTES) {
    await response.body?.cancel().catch(() => {})
    throw new Error('model listing exceeds 4 MiB')
  }
  if (response.body === null) throw new Error('model listing has no response body')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > MODEL_LIST_MAX_BYTES) throw new Error('model listing exceeds 4 MiB')
      chunks.push(value)
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
  const body = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return JSON.parse(textDecoder.decode(body)) as unknown
}

/** Best-effort second read for endpoint capability extensions that dsh's
 * official discovery intentionally drops from LlmDiscoveredModel. Rejects on
 * HTTP failure, oversized or malformed listings and the 5 s probe timeout. */
export async function discoverEndpointModelCapabilities(
  baseURL: string,
  apiKey?: string,
  request: typeof fetch = globalThis.fetch,
): Promise<EndpointCapabilities> {
  const url = baseURL.replace(/\/+$/, '') + '/models'
  const response = await request(url, {
    method: 'GET',
    headers: {
      accept: 'application/json',
      ...apiKey === undefined ? {} : { authorization: 'Bearer ' + apiKey },
    },
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error('model listing returned HTTP ' + String(response.status))
  return endpointModelCapabilities(await readBoundedModelListing(response))
}
