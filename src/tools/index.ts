import { appTools } from './apps.js';
import { computerTools } from './computer.js';
import { fileTools } from './files.js';
import { metaTools } from './meta.js';
import { navigationTools } from './navigation.js';
import { processTools } from './process.js';
import { type AnyTool, ToolRegistry } from './registry.js';
import { scriptingTools } from './scripting.js';
import { shellTools } from './shell.js';
import { systemTools } from './system.js';
import { transferTools } from './transfer.js';
import { uiTools } from './ui.js';
import { windowTools } from './windows.js';

/** Every tool the server can offer, in documentation order. */
export function createToolRegistry(): ToolRegistry {
  // server_info reports on the registry it is part of.
  const holder: { registry?: ToolRegistry } = {};
  const tools: AnyTool[] = [
    ...metaTools(() => holder.registry as ToolRegistry),
    ...shellTools(),
    ...processTools(),
    ...fileTools(),
    ...navigationTools(),
    ...transferTools(),
    ...systemTools(),
    ...appTools(),
    ...windowTools(),
    ...computerTools(),
    ...uiTools(),
    ...scriptingTools(),
  ];
  holder.registry = new ToolRegistry(tools);
  return holder.registry;
}
