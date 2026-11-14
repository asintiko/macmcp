import { parseArgs } from 'node:util';
import type { PermissionMode } from '../core/permissions.js';
import { TOOL_GROUPS } from '../tools/registry.js';
import { isValidAccessToken } from '../server/auth.js';

export type Command = 'start' | 'doctor' | 'tools' | 'config' | 'help' | 'version';

export interface CliOptions {
  command: Command;
  /** Project directory (skips wizard step 2). */
  dir?: string;
  /** Permission level (skips the question in wizard step 3). */
  mode?: PermissionMode;
  /** Skip confirmations; with missing answers, take the safe default. */
  yes: boolean;
  noAuth: boolean;
  token?: string;
  rotateToken: boolean;
  port?: number;
  noTunnel: boolean;
  publicUrl?: string;
  ngrokAuthtoken?: string;
  ngrokDomain?: string;
  excludeTools: string[];
  allowRead: string[];
  allowWrite: string[];
  unsafeNoSandbox: boolean;
  /** `tools`: output format. */
  format: 'text' | 'markdown' | 'json';
  /** `tools`: write to this file instead of standard output. */
  output?: string;
  /** `config`: delete saved settings. */
  reset: boolean;
  /** `config`: print the access token in full. */
  showToken: boolean;
  /** `doctor`: skip checks that need the network. */
  offline: boolean;
}

export class UsageError extends Error {}

export const DEFAULT_PORT = 7332;

export const HELP = `mcpclaude — MCP server that lets cloud AI agents work on this Mac

Usage
  mcpclaude [options]              Run the setup wizard and start the server
  mcpclaude doctor                 Check dependencies, the tunnel and macOS permissions
  mcpclaude tools [--format …]     List the MCP tools this server offers
  mcpclaude config [--reset]       Show or clear saved settings

Setup (anything not given here is asked interactively)
  -d, --dir <path>                 Project directory the agent works in
  -m, --mode <project|full>        Permission level:
                                     project  Project-Only Access: files and commands are
                                              confined to the project directory
                                     full     Full System Access: the whole Mac, including
                                              applications and desktop control
  -y, --yes                        Do not ask for confirmations

Connection
      --no-auth                    No authentication: anyone who knows the URL can connect
      --token <token>              Use this access token instead of the saved one
      --rotate-token               Generate a new access token (old URLs stop working)
  -p, --port <number>              Local port (default ${DEFAULT_PORT}; a free port is used if taken)
      --ngrok-authtoken <token>    ngrok authtoken (otherwise NGROK_AUTHTOKEN, saved settings
                                   or your ngrok CLI configuration)
      --ngrok-domain <domain>      Reserved or static ngrok domain to use
      --no-tunnel                  Do not start ngrok (local use, or your own tunnel)
      --public-url <url>           Public base URL when you run your own tunnel

Restrictions
      --exclude-tools <groups>     Comma-separated tool groups to switch off
                                   (${Object.keys(TOOL_GROUPS).filter((g) => g !== 'meta').join(', ')})
      --allow-read <path>          Project-Only mode: extra directory commands may read (repeatable)
      --allow-write <path>         Project-Only mode: extra directory commands may write (repeatable)
      --unsafe-no-sandbox          Project-Only mode: run commands unconfined if the macOS
                                   sandbox cannot be applied

Other
      --format <text|markdown|json>  Output format of "tools"
      --output <file>              Write "tools" output to a file
      --reset                      With "config": delete saved settings
      --show-token                 With "config": print the access token in full
      --offline                    With "doctor": skip checks that need the internet
  -h, --help                       Show this help
  -v, --version                    Show the version

While the server runs:  p pause/resume   i show connection details   q quit
Documentation: docs/README.md
`;

const COMMANDS: Command[] = ['start', 'doctor', 'tools', 'config', 'help', 'version'];

export function parseCli(argv: string[]): CliOptions {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        dir: { type: 'string', short: 'd' },
        mode: { type: 'string', short: 'm' },
        yes: { type: 'boolean', short: 'y', default: false },
        'no-auth': { type: 'boolean', default: false },
        token: { type: 'string' },
        'rotate-token': { type: 'boolean', default: false },
        port: { type: 'string', short: 'p' },
        'no-tunnel': { type: 'boolean', default: false },
        'public-url': { type: 'string' },
        'ngrok-authtoken': { type: 'string' },
        'ngrok-domain': { type: 'string' },
        'exclude-tools': { type: 'string', multiple: true },
        'allow-read': { type: 'string', multiple: true },
        'allow-write': { type: 'string', multiple: true },
        'unsafe-no-sandbox': { type: 'boolean', default: false },
        format: { type: 'string', default: 'text' },
        output: { type: 'string' },
        reset: { type: 'boolean', default: false },
        'show-token': { type: 'boolean', default: false },
        offline: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
        version: { type: 'boolean', short: 'v', default: false },
      },
    });
  } catch (err) {
    throw new UsageError(err instanceof Error ? err.message.split('\n')[0] : String(err));
  }
  const { values, positionals } = parsed;

  if (positionals.length > 1) throw new UsageError(`Unexpected argument: ${positionals[1]}`);
  let command: Command = 'start';
  if (positionals[0] !== undefined) {
    if (!COMMANDS.includes(positionals[0] as Command)) {
      throw new UsageError(`Unknown command "${positionals[0]}". Commands: start, doctor, tools, config.`);
    }
    command = positionals[0] as Command;
  }
  if (values.help) command = 'help';
  else if (values.version) command = 'version';

  const options: CliOptions = {
    command,
    yes: values.yes,
    noAuth: values['no-auth'],
    rotateToken: values['rotate-token'],
    noTunnel: values['no-tunnel'],
    excludeTools: [],
    allowRead: values['allow-read'] ?? [],
    allowWrite: values['allow-write'] ?? [],
    unsafeNoSandbox: values['unsafe-no-sandbox'],
    format: 'text',
    reset: values.reset,
    showToken: values['show-token'],
    offline: values.offline,
  };

  if (values.dir !== undefined) options.dir = values.dir;
  if (values.output !== undefined) options.output = values.output;
  if (values['ngrok-authtoken'] !== undefined) options.ngrokAuthtoken = values['ngrok-authtoken'];

  if (values.mode !== undefined) {
    if (values.mode !== 'project' && values.mode !== 'full') throw new UsageError(`--mode must be "project" or "full", got "${values.mode}".`);
    options.mode = values.mode;
  }
  if (values.port !== undefined) {
    const port = Number(values.port);
    if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new UsageError(`--port must be a number between 1 and 65535, got "${values.port}".`);
    options.port = port;
  }
  if (values.token !== undefined) {
    if (!isValidAccessToken(values.token)) throw new UsageError('--token must be 16-128 characters from A-Z, a-z, 0-9, "-" and "_".');
    if (values['no-auth']) throw new UsageError('--token and --no-auth cannot be combined.');
    options.token = values.token;
  }
  if (values['public-url'] !== undefined) {
    let url: URL;
    try {
      url = new URL(values['public-url']);
    } catch {
      throw new UsageError(`--public-url is not a valid URL: ${values['public-url']}`);
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new UsageError('--public-url must start with https:// or http://.');
    options.publicUrl = url.origin;
    options.noTunnel = true;
  }
  if (values['ngrok-domain'] !== undefined) {
    const domain = values['ngrok-domain'].replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain)) throw new UsageError(`--ngrok-domain is not a valid host name: ${values['ngrok-domain']}`);
    options.ngrokDomain = domain;
  }
  if (!['text', 'markdown', 'json'].includes(values.format)) throw new UsageError(`--format must be text, markdown or json, got "${values.format}".`);
  options.format = values.format as CliOptions['format'];

  const groups = (values['exclude-tools'] ?? []).flatMap((entry) => entry.split(',')).map((g) => g.trim()).filter(Boolean);
  for (const group of groups) {
    if (!(group in TOOL_GROUPS)) throw new UsageError(`Unknown tool group "${group}". Groups: ${Object.keys(TOOL_GROUPS).join(', ')}.`);
    if (group === 'meta') throw new UsageError('The "meta" group (server_info, usage_guide) cannot be switched off.');
  }
  options.excludeTools = [...new Set(groups)];
  return options;
}
