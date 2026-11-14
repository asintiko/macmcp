import { type Choice, PromptCancelled, type Prompter, type Validator } from '../../src/cli/prompts.js';
import { Ui } from '../../src/cli/ui.js';
import type { TunnelOptions, TunnelProvider } from '../../src/server/tunnel.js';

type Hook = () => void | Promise<void>;

/** One scripted reply. `before` runs when the question is asked, before it is answered. */
export type Answer = ({ select: string | RegExp } | { input: string } | { secret: string } | { confirm: boolean } | { cancel: true }) & { before?: Hook };

export interface Asked {
  kind: 'select' | 'input' | 'secret' | 'confirm';
  message: string;
  choices?: string[];
  /** Validation messages shown for rejected answers. */
  errors: string[];
}

/** Answers the wizard's questions from a list, and records what was asked. */
export class ScriptedPrompter implements Prompter {
  readonly asked: Asked[] = [];
  private readonly queue: Answer[];

  constructor(answers: Answer[] = []) {
    this.queue = [...answers];
  }

  /** Answers that were never asked for. */
  get unused(): number {
    return this.queue.length;
  }

  private async next(kind: Asked['kind'], message: string): Promise<Answer> {
    const answer = this.queue.shift();
    if (!answer) throw new Error(`Unexpected ${kind} prompt: ${message}`);
    await answer.before?.();
    if ('cancel' in answer) throw new PromptCancelled();
    if (!(kind in answer)) throw new Error(`"${message}" is a ${kind} prompt, but the script answers with ${JSON.stringify(answer)}`);
    return answer;
  }

  async select<T>(options: { message: string; choices: Choice<T>[] }): Promise<T> {
    this.asked.push({ kind: 'select', message: options.message, choices: options.choices.map((c) => c.name), errors: [] });
    const { select } = (await this.next('select', options.message)) as { select: string | RegExp };
    const choice = options.choices.find((c) => (typeof select === 'string' ? c.name.includes(select) : select.test(c.name)));
    if (!choice) throw new Error(`No choice matching ${String(select)} among: ${options.choices.map((c) => c.name).join(' | ')}`);
    return choice.value;
  }

  private async text(kind: 'input' | 'secret', options: { message: string; validate?: Validator }): Promise<string> {
    const record: Asked = { kind, message: options.message, errors: [] };
    this.asked.push(record);
    for (;;) {
      const answer = (await this.next(kind, options.message)) as unknown as Record<string, string>;
      const value = answer[kind] as string;
      const verdict = options.validate ? await options.validate(value) : true;
      if (verdict === true) return value;
      // The real prompt shows the message and waits for another attempt.
      record.errors.push(verdict);
    }
  }

  input(options: { message: string; validate?: Validator }): Promise<string> {
    return this.text('input', options);
  }

  secret(options: { message: string; validate?: Validator }): Promise<string> {
    return this.text('secret', options);
  }

  async confirm(options: { message: string }): Promise<boolean> {
    this.asked.push({ kind: 'confirm', message: options.message, errors: [] });
    return ((await this.next('confirm', options.message)) as { confirm: boolean }).confirm;
  }
}

export interface CapturedUi {
  ui: Ui;
  /** Everything written so far. */
  text(): string;
  clear(): void;
}

/** A Ui that writes into memory, without colours or animation. */
export function captureUi(columns = 100): CapturedUi {
  let buffer = '';
  const ui = new Ui({
    stream: {
      write: (text: string) => {
        buffer += text;
        return true;
      },
      isTTY: false,
      columns,
    },
    color: false,
    env: {},
  });
  return {
    ui,
    text: () => buffer,
    clear: () => {
      buffer = '';
    },
  };
}

export interface FakeTunnelProvider extends TunnelProvider {
  /** Options of every start attempt. */
  starts: TunnelOptions[];
  closed: number;
}

/** A tunnel provider that opens nothing: fails with the queued errors first, then "succeeds". */
export function fakeTunnelProvider(options: { url?: string | ((options: TunnelOptions) => string); failures?: unknown[] } = {}): FakeTunnelProvider {
  const failures = [...(options.failures ?? [])];
  const provider: FakeTunnelProvider = {
    name: 'fake',
    starts: [],
    closed: 0,
    async start(startOptions) {
      provider.starts.push(startOptions);
      if (failures.length > 0) throw failures.shift();
      const url = typeof options.url === 'function' ? options.url(startOptions) : (options.url ?? 'https://fake-tunnel.example');
      return {
        url,
        close: async () => {
          provider.closed += 1;
        },
      };
    },
  };
  return provider;
}
