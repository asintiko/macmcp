import { metaTools } from './meta.js';
import { type AnyTool, ToolRegistry } from './registry.js';

/** Every tool the server can offer, in documentation order. */
export function createToolRegistry(): ToolRegistry {
  const tools: AnyTool[] = [];
  // server_info reports on the registry it is part of.
  const registry: { current?: ToolRegistry } = {};
  tools.push(...metaTools(() => registry.current as ToolRegistry));
  registry.current = new ToolRegistry(tools);
  return registry.current;
}
