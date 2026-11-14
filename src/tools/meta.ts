import { readFile } from 'node:fs/promises';
import * as z from 'zod';
import { assetPath } from '../assets.js';
import { ToolError } from '../core/errors.js';
import { MODE_LABEL } from '../core/permissions.js';
import { platformSummary } from '../core/platform.js';
import { LIMITS } from '../core/runtime.js';
import { NAME, VERSION } from '../version.js';
import { type AnyTool, defineTool, TOOL_GROUPS, type ToolGroup, type ToolRegistry } from './registry.js';

/** Topics served by `usage_guide`; each has a file in assets/guides. */
export const GUIDE_TOPICS = ['overview'] as const;

export function metaTools(registry: () => ToolRegistry): AnyTool[] {
  const serverInfo = defineTool({
    name: 'server_info',
    title: 'Server information',
    group: 'meta',
    access: 'any',
    alwaysAvailable: true,
    description:
      'Describe this mcpclaude server: permission level, project directory, working directory, platform, sandbox status and which tool groups can be used. Call this first in every session.',
    input: z.object({}),
    examples: [{ note: 'Find out what you are allowed to do.', arguments: {} }],
    hints: { readOnly: true, idempotent: true },
    async handler(_args, { runtime }) {
      const configured = runtime.configured;
      const groups: Record<string, { tools: number; status: string }> = {};
      for (const tool of registry().all()) {
        const refusal = registry().refusal({ ...tool, alwaysAvailable: false }, runtime);
        const status = !refusal
          ? 'available'
          : refusal.code === 'PERMISSION_DENIED'
            ? runtime.disabledGroups.has(tool.group)
              ? 'disabled by the user'
              : 'requires Full System Access'
            : refusal.code === 'UNSUPPORTED_PLATFORM'
              ? 'not available on this host'
              : refusal.code === 'PAUSED'
                ? 'paused by the user'
                : 'waiting for setup';
        const entry = (groups[tool.group] ??= { tools: 0, status });
        entry.tools += 1;
        // A group is as available as its most available tool.
        if (status === 'available') entry.status = status;
      }
      const data = {
        server: { name: NAME, version: VERSION, uptime_seconds: Math.round((Date.now() - runtime.startedAt) / 1000) },
        status: !configured ? 'setup_pending' : runtime.paused ? 'paused' : 'ready',
        permission_mode: configured ? runtime.mode : null,
        permission_summary: !configured
          ? 'The user has not finished setup yet; tool calls are refused until they choose a directory and permission level.'
          : runtime.mode === 'project'
            ? `${MODE_LABEL.project}: files and commands are confined to the project directory. Desktop control, applications and system-wide tools are not available.`
            : `${MODE_LABEL.full}: no path restrictions; shell, files, applications and desktop control are all available without confirmation prompts.`,
        project_directory: configured ? runtime.projectDir : null,
        working_directory: configured ? runtime.cwd : null,
        platform: await platformSummary(runtime.platform),
        command_sandbox: runtime.sandboxStatus(),
        desktop_control: runtime.desktopAvailable,
        tool_groups: Object.fromEntries(
          (Object.keys(TOOL_GROUPS) as ToolGroup[])
            .filter((group) => groups[group])
            .map((group) => [group, { title: TOOL_GROUPS[group].title, ...groups[group] }]),
        ),
        limits: {
          default_command_output_chars: LIMITS.outputChars,
          max_request_body_bytes: LIMITS.requestBodyBytes,
          max_inline_read_bytes: LIMITS.inlineReadBytes,
        },
        time: new Date().toISOString(),
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        guides: [...GUIDE_TOPICS],
      };
      return { data };
    },
  });

  const usageGuide = defineTool({
    name: 'usage_guide',
    title: 'Usage guide',
    group: 'meta',
    access: 'any',
    alwaysAvailable: true,
    description:
      'Return a how-to guide for working with this server. Read "overview" once, then the topic that matches your task before starting multi-step work.',
    input: z.object({
      topic: z.enum(GUIDE_TOPICS).default('overview').describe('Which guide to return.'),
    }),
    examples: [{ note: 'Read the general guide.', arguments: { topic: 'overview' } }],
    hints: { readOnly: true, idempotent: true },
    async handler({ topic }) {
      try {
        return await readFile(assetPath('guides', `${topic}.md`), 'utf8');
      } catch {
        throw new ToolError('NOT_FOUND', `Guide not found: ${topic}`);
      }
    },
  });

  return [serverInfo, usageGuide];
}
