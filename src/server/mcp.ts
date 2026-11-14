import { createMcpHandler, type McpHttpHandler, McpServer, type ToolAnnotations } from '@modelcontextprotocol/server';
import { MODE_LABEL } from '../core/permissions.js';
import { LIMITS, type Runtime } from '../core/runtime.js';
import { GUIDE_TOPICS } from '../tools/meta.js';
import { type AnyTool, invokeTool, renderDescription, type ToolRegistry } from '../tools/registry.js';
import { NAME, VERSION } from '../version.js';
import { currentRequest } from './context.js';

/** Server-level guidance that MCP clients may put in the model's context. */
export function serverInstructions(runtime: Runtime): string {
  const lines = ['mcpclaude gives you tools on the user\'s own Mac, reached through a tunnel.'];
  if (!runtime.configured) {
    lines.push('Setup is still in progress in the user\'s terminal: tools are listed but calls are refused until it finishes.');
  } else if (runtime.mode === 'project') {
    lines.push(
      `Permission level: ${MODE_LABEL.project}. Files and commands are confined to ${runtime.projectDir}; desktop control is not available.`,
    );
  } else {
    lines.push(`Permission level: ${MODE_LABEL.full}. Project directory: ${runtime.projectDir}.`);
  }
  lines.push(
    `Call server_info first. usage_guide(topic) explains how to work with this server; topics: ${GUIDE_TOPICS.join(', ')}.`,
    'run_command returns a process_id instead of killing a command that is still running; poll it with read_process_output.',
    'Mouse coordinates are pixels of the most recent full screenshot. Take a screenshot before acting and after each step.',
  );
  return lines.join('\n');
}

function annotations(tool: AnyTool): ToolAnnotations {
  return {
    title: tool.title,
    readOnlyHint: tool.hints?.readOnly ?? false,
    destructiveHint: tool.hints?.destructive ?? false,
    idempotentHint: tool.hints?.idempotent ?? false,
    openWorldHint: tool.hints?.openWorld ?? false,
  };
}

/**
 * Build the MCP server for one request. The SDK's stateless handler asks for a fresh instance
 * per request, so nothing is kept here: all state is in the Runtime.
 */
export function buildMcpServer(runtime: Runtime, registry: ToolRegistry): McpServer {
  const server = new McpServer(
    { name: NAME, title: 'mcpclaude (remote Mac)', version: VERSION },
    { instructions: serverInstructions(runtime) },
  );
  // Tools hidden in the current mode are still registered for tools/call, so that an agent
  // working from an older tool list gets an explanation rather than "tool not found".
  const calling = currentRequest()?.methods.includes('tools/call') ?? false;
  const listed = new Set(registry.listed(runtime).map((tool) => tool.name));
  for (const tool of registry.all()) {
    if (!calling && !listed.has(tool.name)) continue;
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: renderDescription(tool),
        inputSchema: tool.input,
        annotations: annotations(tool),
      },
      (args: Record<string, unknown>, ctx) => invokeTool(tool, args, runtime, registry, ctx),
    );
  }
  return server;
}

export function createMcpEndpoint(runtime: Runtime, registry: ToolRegistry, onError?: (error: Error) => void): McpHttpHandler {
  return createMcpHandler(() => buildMcpServer(runtime, registry), {
    maxRequestBodySize: LIMITS.requestBodyBytes,
    onerror: (error) => onError?.(error),
  });
}
