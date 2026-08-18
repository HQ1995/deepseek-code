/**
 * Grok leader wire framing: 4-byte big-endian payload length followed by a
 * JSON payload. Mirrors read_frame/write_frame in xai-grok-shell
 * leader/protocol.rs; the envelope JSON layer lives in protocol.ts.
 * @module dscode/codec
 */

/** Largest accepted frame payload, mirroring MAX_MESSAGE_SIZE in protocol.rs. */
export const MAX_MESSAGE_SIZE = 64 * 1024 * 1024

/** Cap on bytes buffered while one incomplete frame is trickling in; a peer
 * pushing past it is dropped instead of pinning unbounded memory (and
 * forcing quadratic re-concatenation of the pending buffer). */
export const MAX_PENDING_BUFFER = 8 * 1024 * 1024

/** A byte sequence violates the leader framing contract. */
export class FrameError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FrameError'
  }
}

/**
 * Prefix one payload with its 4-byte big-endian length.
 * @param payload - the frame body.
 * @returns the complete length-prefixed frame.
 */
export function encodeFrame(payload: Uint8Array): Uint8Array {
  if (payload.byteLength > MAX_MESSAGE_SIZE) {
    throw new FrameError('message too large: ' + String(payload.byteLength) + ' bytes (max: ' + String(MAX_MESSAGE_SIZE) + ')')
  }
  const frame = new Uint8Array(4 + payload.byteLength)
  new DataView(frame.buffer, frame.byteOffset, frame.byteLength).setUint32(0, payload.byteLength)
  frame.set(payload, 4)
  return frame
}

/**
 * Serialize a value as one length-prefixed JSON frame.
 * @param value - JSON-serializable envelope message.
 * @returns the complete frame.
 */
export function encodeJsonFrame(value: unknown): Uint8Array {
  return encodeFrame(new TextEncoder().encode(JSON.stringify(value)))
}

/**
 * Incremental decoder for a byte stream of length-prefixed frames. Each
 * push() returns the frames the new bytes complete; partial frames stay
 * buffered until their body arrives.
 */
export class FrameDecoder {
  #pending: Uint8Array = new Uint8Array(0)

  /**
   * Feed received bytes and collect every newly completed frame.
   * @param chunk - next received byte range.
   * @returns complete frame payloads, in wire order.
   * @throws {FrameError} when a declared payload length exceeds MAX_MESSAGE_SIZE.
   */
  push(chunk: Uint8Array): Uint8Array[] {
    // Always copy: the caller may reuse/mutate the chunk buffer while an
    // incomplete frame stays pending.
    this.#pending = this.#pending.byteLength === 0 ? chunk.slice() : concat(this.#pending, chunk)
    const frames: Uint8Array[] = []
    for (;;) {
      if (this.#pending.byteLength < 4) break
      const view = new DataView(this.#pending.buffer, this.#pending.byteOffset, this.#pending.byteLength)
      const length = view.getUint32(0)
      if (length > MAX_MESSAGE_SIZE) {
        throw new FrameError('message too large: ' + String(length) + ' bytes (max: ' + String(MAX_MESSAGE_SIZE) + ')')
      }
      if (this.#pending.byteLength < 4 + length) {
        // Incomplete frame: bound the pending buffer; the socket handler
        // warns and destroys the connection when this FrameError surfaces.
        if (this.#pending.byteLength > MAX_PENDING_BUFFER) {
          throw new FrameError('incomplete frame exceeded the ' + String(MAX_PENDING_BUFFER) + '-byte pending cap')
        }
        break
      }
      frames.push(this.#pending.slice(4, 4 + length))
      this.#pending = this.#pending.slice(4 + length)
    }
    return frames
  }
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.byteLength + b.byteLength)
  out.set(a, 0)
  out.set(b, a.byteLength)
  return out
}
