import type { CallToolResult, ServerContext } from '@modelcontextprotocol/server';
import * as z from 'zod';
import { summarizeArgs } from '../core/audit.js';
import { formatToolError, ToolError, toToolError } from '../core/errors.js';
import { MODE_LABEL } from '../core/permissions.js';
import type { Runtime } from '../core/runtime.js';
import { currentRequest } from '../server/context.js';

export type ToolGroup =
  | 'meta'
  | 'shell'
  | 'process'
  | 'files'
  | 'navigation'
  | 'transfer'
  | 'system'
  | 'apps'
  | 'windows'
  | 'computer'
  | 'ui'
  | 'scripting'
  | 'after_effects'
  | 'blender';

export const TOOL_GROUPS: Record<ToolGroup, { title: string; summary: string }> = {
  meta: { title: 'Server', summary: 'What this server is, how it is configured, and how to use it.' },
  shell: { title: 'Shell and scripts', summary: 'Run shell commands and scripts in any language.' },
  process: { title: 'Processes', summary: 'Long-running and background processes, and system process control.' },
  files: { title: 'Files', summary: 'Read, write, edit, search and organise files and directories.' },
  navigation: { title: 'Project and navigation', summary: 'Working directory and project overview.' },
  transfer: { title: 'Uploads and downloads', summary: 'Move files between the agent, the Mac and the internet.' },
  system: { title: 'System information', summary: 'Hardware, OS, environment and installed developer tools.' },
  apps: { title: 'Applications', summary: 'Launch, switch between and quit applications.' },
  windows: { title: 'Windows', summary: 'List and manage application windows.' },
  computer: { title: 'Computer Use', summary: 'See the screen and control mouse and keyboard.' },
  ui: { title: 'Interface elements', summary: 'Menus, buttons, fields and dialogs through the Accessibility API.' },
  scripting: { title: 'macOS scripting', summary: 'AppleScript and JavaScript for Automation.' },
  after_effects: { title: 'Adobe After Effects', summary: 'ExtendScript and rendering.' },
  blender: { title: 'Blender', summary: 'Python scripting, live sessions and rendering.' },
};

export interface ToolExample {
  /** What the example does, for the documentation. */
  note?: string;
  arguments: Record<string, unknown>;
}

export interface ImageOutput {
  base64: string;
  mimeType: string;
}

export interface ToolOutput {
  /** Text shown to the agent. Defaults to `data` rendered as JSON. */
  text?: string;
  /** Machine-readable result, returned as MCP structuredContent. */
  data?: Record<string, unknown>;
  images?: ImageOutput[];
}

export interface ToolContext {
  runtime: Runtime;
  /** Aborted when the client cancels the request or disconnects. */
  signal: AbortSignal;
  /** Report progress to clients that asked for it; a no-op otherwise. */
  progress(message: string): Promise<void>;
}

export interface ToolHints {
  /** The tool does not change anything. */
  readOnly?: boolean;
  /** The tool may delete or overwrite data. */
  destructive?: boolean;
  /** Repeating the call with the same arguments has no further effect. */
  idempotent?: boolean;
  /** The tool reaches beyond this machine (network). */
  openWorld?: boolean;
}

export interface ToolDefinition<Shape extends z.ZodRawShape> {
  name: string;
  title: string;
  group: ToolGroup;
  /** `any`: both permission modes. `full`: Full System Access only. */
  access: 'any' | 'full';
  /** Needs the macOS desktop driver. */
  desktop?: boolean;
  /** May be called before setup finishes and while paused (informational tools only). */
  alwaysAvailable?: boolean;
  /** What the tool does and how to use it. */
  description: string;
  input: z.ZodObject<Shape>;
  /** At least one example call. */
  examples: ToolExample[];
  hints?: ToolHints;
  handler: (args: z.infer<z.ZodObject<Shape>>, ctx: ToolContext) => Promise<ToolOutput | string>;
}

// Tools with different argument shapes live in one list.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyTool = ToolDefinition<any>;

export function defineTool<Shape extends z.ZodRawShape>(definition: ToolDefinition<Shape>): AnyTool {
  return definition;
}

export interface JsonSchema {
  type?: string;
  description?: string;
  enum?: unknown[];
  default?: unknown;
  minimum?: number;
  maximum?: number;
  items?: JsonSchema;
  properties?: Record<string, JsonSchema>;
  required?: string[];
}

const schemaCache = new WeakMap<AnyTool, JsonSchema>();

/** JSON Schema of a tool's arguments as a client sends them: parameters with defaults are optional. */
export function inputJsonSchema(tool: AnyTool): JsonSchema {
  let schema = schemaCache.get(tool);
  if (!schema) {
    const raw = z.toJSONSchema(tool.input, { io: 'input' }) as JsonSchema & { $schema?: string; additionalProperties?: unknown };
    delete raw.$schema;
    delete raw.additionalProperties;
    schema = raw;
    schemaCache.set(tool, schema);
  }
  return schema;
}

/** The arguments worth showing in logs: values equal to the parameter's default are left out. */
export function explicitArguments(tool: AnyTool, args: Record<string, unknown>): Record<string, unknown> {
  const properties = inputJsonSchema(tool).properties ?? {};
  const shown: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    const fallback = properties[key]?.default;
    if (fallback !== undefined && JSON.stringify(fallback) === JSON.stringify(value)) continue;
    shown[key] = value;
  }
  return shown;
}

/** Description sent to MCP clients: usage notes, access note and one example call. */
export function renderDescription(tool: AnyTool): string {
  const parts = [tool.description.trim()];
  if (tool.access === 'full') parts.push('Requires Full System Access mode.');
  const example = tool.examples[0];
  if (example) parts.push(`Example: ${JSON.stringify(example.arguments)}`);
  return parts.join('\n');
}

export class ToolRegistry {
  private readonly byName = new Map<string, AnyTool>();

  constructor(tools: AnyTool[]) {
    for (const tool of tools) {
      if (!/^[a-z][a-z0-9_]{1,62}$/.test(tool.name)) throw new Error(`Invalid tool name: ${tool.name}`);
      if (this.byName.has(tool.name)) throw new Error(`Duplicate tool name: ${tool.name}`);
      this.byName.set(tool.name, tool);
    }
  }

  all(): AnyTool[] {
    return [...this.byName.values()];
  }

  get(name: string): AnyTool | undefined {
    return this.byName.get(name);
  }

  /** Whether the tool can exist at all on this host with the user's group selection. */
  private supported(tool: AnyTool, runtime: Runtime): boolean {
    if (runtime.disabledGroups.has(tool.group)) return false;
    return !tool.desktop || runtime.desktopAvailable;
  }

  /** Tools to advertise. Before setup finishes the mode is unknown, so everything is listed. */
  listed(runtime: Runtime): AnyTool[] {
    return this.all().filter((tool) => {
      if (!this.supported(tool, runtime)) return false;
      if (!runtime.configured) return true;
      return tool.access === 'any' || runtime.mode === 'full';
    });
  }

  /** Why the tool cannot run right now, or undefined if it can. */
  refusal(tool: AnyTool, runtime: Runtime): ToolError | undefined {
    if (runtime.disabledGroups.has(tool.group)) {
      return new ToolError('PERMISSION_DENIED', `The "${tool.group}" tool group was disabled by the user when starting mcpclaude.`);
    }
    if (tool.desktop && !runtime.desktopAvailable) {
      return new ToolError('UNSUPPORTED_PLATFORM', `${tool.name} needs macOS desktop control, which is not available on this host.`);
    }
    if (tool.alwaysAvailable) return undefined;
    try {
      runtime.assertOperational();
    } catch (err) {
      return toToolError(err);
    }
    if (tool.access === 'full' && runtime.mode !== 'full') {
      return new ToolError(
        'PERMISSION_DENIED',
        `${tool.name} requires ${MODE_LABEL.full}, but this server is running in ${MODE_LABEL.project} mode.`,
        'Only the user can change this, by restarting mcpclaude and choosing Full System Access. Tell them what you need it for.',
      );
    }
    return undefined;
  }
}

function toResult(output: ToolOutput | string): CallToolResult {
  const normalized: ToolOutput = typeof output === 'string' ? { text: output } : output;
  const content: CallToolResult['content'] = [];
  const text = normalized.text ?? (normalized.data !== undefined ? JSON.stringify(normalized.data, null, 2) : undefined);
  if (text !== undefined && text !== '') content.push({ type: 'text', text });
  for (const image of normalized.images ?? []) {
    content.push({ type: 'image', data: image.base64, mimeType: image.mimeType });
  }
  if (content.length === 0) content.push({ type: 'text', text: 'Done.' });
  const result: CallToolResult = { content };
  if (normalized.data !== undefined) result.structuredContent = normalized.data;
  return result;
}

/**
 * Run a tool on behalf of an MCP request: gate checks, handler, result conversion, audit.
 * Never throws; failures become MCP error results.
 */
export async function invokeTool(
  tool: AnyTool,
  args: Record<string, unknown>,
  runtime: Runtime,
  registry: ToolRegistry,
  mcp?: ServerContext,
): Promise<CallToolResult> {
  const started = Date.now();
  const client = currentRequest()?.client;
  let failure: ToolError | undefined;
  let result: CallToolResult;

  try {
    const refusal = registry.refusal(tool, runtime);
    if (refusal) throw refusal;

    let step = 0;
    const context: ToolContext = {
      runtime,
      signal: mcp?.mcpReq.signal ?? new AbortController().signal,
      progress: async (message) => {
        const token = mcp?.mcpReq._meta?.progressToken;
        if (token === undefined || !mcp) return;
        await mcp.mcpReq
          .notify({ method: 'notifications/progress', params: { progressToken: token, progress: ++step, message } })
          .catch(() => undefined);
      },
    };
    result = toResult(await tool.handler(args, context));
  } catch (err) {
    failure = toToolError(err);
    result = { content: [{ type: 'text', text: formatToolError(failure) }], isError: true };
  }

  const durationMs = Date.now() - started;
  const summary = summarizeArgs(explicitArguments(tool, args));
  const event = {
    tool: tool.name,
    args: summary,
    ok: !failure,
    durationMs,
    ...(failure ? { code: failure.code, error: failure.message } : {}),
    ...(client ? { client } : {}),
  };
  runtime.audit.record({
    time: new Date(started).toISOString(),
    ...event,
    ...(runtime.configured ? { mode: runtime.mode } : {}),
  });
  runtime.events.emit('tool', event);
  return result;
}
