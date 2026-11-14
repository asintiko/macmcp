import { emitKeypressEvents } from 'node:readline';
import type { RpcEvent, ToolCallEvent } from '../core/runtime.js';
import { formatDuration } from '../tools/util.js';
import { connectionInstructions } from './instructions.js';
import type { Session } from './session.js';
import type { Ui } from './ui.js';

function clock(): string {
  return new Date().toTimeString().slice(0, 8);
}

/** One line of the activity log for a tool call. */
export function formatToolEvent(event: ToolCallEvent, ui: Ui): string {
  const status = event.ok ? ui.paint('✔', 'green') : ui.paint('✖', 'red');
  const tail = event.ok ? formatDuration(event.durationMs) : `${event.code ?? 'ERROR'}: ${event.error ?? ''}`;
  const head = `${clock()} ${event.tool}`;
  const args = event.args && typeof event.args === 'object' && Object.keys(event.args).length > 0 ? JSON.stringify(event.args) : '';
  // Keep each entry on one terminal line.
  const room = Math.max(10, ui.columns - head.length - tail.length - 6);
  const shown = args.length > room ? `${args.slice(0, room - 1)}…` : args;
  return `${ui.paint(clock(), 'dim')} ${status} ${ui.paint(event.tool, 'bold')}${shown ? ` ${shown}` : ''} ${ui.paint(tail, event.ok ? 'dim' : 'red')}`;
}

/** A line for protocol events worth showing (a client appearing), or undefined. */
export function formatRpcEvent(event: RpcEvent, ui: Ui): string | undefined {
  const methods = event.method.split(',');
  const who = `${event.client ?? 'unknown client'}${event.remote ? ` (${event.remote})` : ''}`;
  if (methods.includes('initialize') || methods.includes('server/discover')) {
    return `${ui.paint(clock(), 'dim')} ${ui.paint('●', 'cyan')} client connected: ${who}`;
  }
  if (methods.includes('tools/list')) return `${ui.paint(clock(), 'dim')} ${ui.paint('●', 'cyan')} ${who} listed the tools`;
  return undefined;
}

export interface LiveOptions {
  stdin?: NodeJS.ReadStream;
  /** Register process signal handlers (off in tests). */
  signals?: boolean;
}

const STOP_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;

/**
 * Show what agents do until the user quits. Keys: p pause/resume, i connection details,
 * q or Ctrl+C quit. Resolves after the session has been closed.
 */
export function runLive(session: Session, ui: Ui, options: LiveOptions = {}): Promise<void> {
  const { runtime } = session;
  const stdin = options.stdin ?? process.stdin;
  const interactive = stdin.isTTY === true;

  const onTool = (event: ToolCallEvent): void => ui.line(formatToolEvent(event, ui));
  const onRpc = (event: RpcEvent): void => {
    const line = formatRpcEvent(event, ui);
    if (line) ui.line(line);
  };

  return new Promise((resolve) => {
    let stopping = false;
    const stop = async (reason: string): Promise<void> => {
      if (stopping) return;
      stopping = true;
      runtime.events.off('tool', onTool);
      runtime.events.off('rpc', onRpc);
      if (interactive) {
        stdin.off('keypress', onKey);
        stdin.setRawMode(false);
        stdin.pause();
      }
      for (const signal of STOP_SIGNALS) process.off(signal, onSignal);
      const running = runtime.processes.runningCount;
      ui.line();
      ui.info(`${reason} Stopping the tunnel and server${running > 0 ? ` and ${running} background process${running === 1 ? '' : 'es'}` : ''}…`);
      // Never hang on shutdown: a stuck tunnel or child must not keep the terminal hostage.
      const force = setTimeout(() => process.exit(0), 8000);
      force.unref();
      await session.close();
      clearTimeout(force);
      ui.success('Stopped. The public URL no longer works.');
      resolve();
    };
    const onSignal = (): void => void stop('Signal received.');

    const onKey = (_text: string | undefined, key: { name?: string; ctrl?: boolean } | undefined): void => {
      if (!key) return;
      if (key.name === 'q' || (key.ctrl && (key.name === 'c' || key.name === 'd'))) {
        void stop('Quitting.');
      } else if (key.name === 'p') {
        runtime.setPaused(!runtime.paused);
        if (runtime.paused) ui.warn('Paused: every tool call is refused until you press p again.');
        else ui.success('Resumed.');
      } else if (key.name === 'i') {
        ui.line();
        ui.block('Connection details', connectionInstructions({ ...session.details, publicBaseUrl: runtime.publicBaseUrl }));
      }
    };

    // Closing the terminal window (SIGHUP) must stop the agent's background processes too,
    // so everything is wired up before the view announces itself.
    if (options.signals !== false) {
      for (const signal of STOP_SIGNALS) process.on(signal, onSignal);
    }
    runtime.events.on('tool', onTool);
    runtime.events.on('rpc', onRpc);
    if (interactive) {
      emitKeypressEvents(stdin);
      stdin.setRawMode(true);
      stdin.resume();
      stdin.on('keypress', onKey);
    }

    ui.line();
    ui.line(ui.paint('── Activity ' + '─'.repeat(Math.max(4, Math.min(ui.columns, 78) - 12)), 'dim'));
    ui.dim(interactive ? 'Keys: p pause/resume · i connection details · q quit' : 'Press Ctrl+C to stop.');
  });
}
