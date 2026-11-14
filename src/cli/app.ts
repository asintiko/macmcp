import { rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { ConfigStore, stateDir as resolveStateDir } from '../config/store.js';
import { ngrokProvider, type TunnelProvider } from '../server/tunnel.js';
import { createToolRegistry } from '../tools/index.js';
import { NAME, VERSION } from '../version.js';
import { type CliOptions, HELP, parseCli, UsageError } from './args.js';
import { runDoctor } from './doctor.js';
import { runLive } from './live.js';
import { createTerminalPrompter, PromptCancelled, type Prompter } from './prompts.js';
import { startSession, StartupError } from './session.js';
import { renderToolsJson, renderToolsMarkdown, renderToolsText } from './tooldocs.js';
import { maskSecret, Ui } from './ui.js';

export interface MainDeps {
  argv: string[];
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  ui?: Ui;
  errorUi?: Ui;
  prompter?: Prompter;
  tunnelProvider?: TunnelProvider;
  stdin?: NodeJS.ReadStream;
}

async function runTools(options: CliOptions, ui: Ui): Promise<number> {
  const registry = createToolRegistry();
  const text = options.format === 'markdown' ? renderToolsMarkdown(registry) : options.format === 'json' ? `${renderToolsJson(registry)}\n` : `${renderToolsText(registry)}\n`;
  if (options.output) {
    await writeFile(options.output, text);
    ui.success(`Wrote ${options.output} (${registry.all().length} tools)`);
  } else {
    ui.write(text);
  }
  return 0;
}

async function runConfig(options: CliOptions, ui: Ui, stateDir: string): Promise<number> {
  const store = new ConfigStore(stateDir);
  if (options.reset) {
    await rm(store.file, { force: true });
    ui.success(`Deleted ${store.file}. A new access token is generated on the next start.`);
    return 0;
  }
  const config = await store.load();
  ui.heading('mcpclaude settings');
  ui.info(`File            ${store.file}`);
  ui.info(`Access token    ${config.accessToken ? (options.showToken ? config.accessToken : `${maskSecret(config.accessToken)}  (--show-token prints it)`) : 'none yet (generated on first start)'}`);
  ui.info(`ngrok authtoken ${config.ngrokAuthtoken ? maskSecret(config.ngrokAuthtoken) : 'not saved'}`);
  ui.info(`ngrok domain    ${config.ngrokDomain ?? 'automatic'}`);
  ui.info(`Local port      ${config.port ?? 'default'}`);
  ui.info(`Recent projects ${(config.recentDirectories ?? []).join(', ') || 'none'}`);
  ui.line();
  ui.dim(`Audit logs: ${path.join(stateDir, 'logs')}   Delete saved settings: mcpclaude config --reset`);
  return 0;
}

/** Entry point, separated from process globals so it can be driven by tests. Returns the exit code. */
export async function main(deps: MainDeps): Promise<number> {
  const env = deps.env ?? process.env;
  const ui = deps.ui ?? new Ui({ env });
  const errorUi = deps.errorUi ?? new Ui({ stream: process.stderr, env });

  let options: CliOptions;
  try {
    options = parseCli(deps.argv);
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    errorUi.line(`${NAME}: ${err.message}`);
    errorUi.line(`Run "${NAME} --help" for usage.`);
    return 2;
  }

  const stateDir = resolveStateDir(env);
  const tunnelProvider = deps.tunnelProvider ?? ngrokProvider;
  const platform = process.platform;

  switch (options.command) {
    case 'help':
      ui.write(HELP);
      return 0;
    case 'version':
      ui.line(VERSION);
      return 0;
    case 'tools':
      return runTools(options, ui);
    case 'config':
      return runConfig(options, ui, stateDir);
    case 'doctor':
      return runDoctor({ ui, env, home: homedir(), platform, stateDir, offline: options.offline, tunnelProvider });
    case 'start':
      break;
  }

  const stdin = deps.stdin ?? process.stdin;
  const interactive = stdin.isTTY === true && ui.tty;
  ui.line();
  ui.line(`${ui.paint(NAME, 'bold', 'cyan')} ${ui.paint(VERSION, 'dim')}  MCP server for remote cloud agents on macOS`);
  if (platform !== 'darwin') ui.warn('This is not macOS: desktop control and the command sandbox are unavailable here.');

  try {
    const session = await startSession({
      options,
      ui,
      prompter: deps.prompter ?? createTerminalPrompter(),
      interactive,
      env,
      cwd: deps.cwd ?? process.cwd(),
      home: homedir(),
      platform,
      stateDir,
      tunnelProvider,
    });
    await runLive(session, ui, { stdin });
    return 0;
  } catch (err) {
    if (err instanceof PromptCancelled) {
      ui.line();
      ui.info('Cancelled.');
      return 130;
    }
    if (err instanceof StartupError) {
      ui.line();
      errorUi.error(err.message);
      if (err.hint) errorUi.line(`  ${err.hint}`);
      return 1;
    }
    throw err;
  }
}
