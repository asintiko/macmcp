import { AsyncLocalStorage } from 'node:async_hooks';

/** Facts about the HTTP request being served, available to tool code through async context. */
export interface RequestInfo {
  /** JSON-RPC methods in the request body. */
  methods: string[];
  /** Name the MCP client reported about itself, if any. */
  client?: string;
  /** Network address of the caller as reported by the tunnel. */
  remote?: string;
}

export const requestInfo = new AsyncLocalStorage<RequestInfo>();

export function currentRequest(): RequestInfo | undefined {
  return requestInfo.getStore();
}
