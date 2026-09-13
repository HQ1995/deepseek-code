/** Shared ACP request validation; independent of sockets and DSH lifetimes. */
import { RpcError } from './protocol.ts'

export const JSONRPC_METHOD_NOT_FOUND = -32601
export const JSONRPC_INVALID_PARAMS = -32602
export const JSONRPC_INTERNAL_ERROR = -32603

export const invalidParams = (detail: string): RpcError => new RpcError(JSONRPC_INVALID_PARAMS, detail)
export const internalError = (detail: string): RpcError => new RpcError(JSONRPC_INTERNAL_ERROR, detail)

export const paramRecord = (params: unknown, method: string): Record<string, unknown> => {
  if (typeof params !== 'object' || params === null || Array.isArray(params)) {
    throw invalidParams(method + ' params must be an object')
  }
  return params as Record<string, unknown>
}
