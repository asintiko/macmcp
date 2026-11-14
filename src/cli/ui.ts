/** Terminal output helpers: colours, status lines, a spinner. No dependencies, stream injectable for tests. */

export interface OutputStream {
  write(text: string): unknown;
  isTTY?: boolean;
  columns?: number;
}

const CODES = { bold: 1, dim: 2, red: 31, green: 32, yellow: 33, blue: 34, magenta: 35, cyan: 36, gray: 90 } as const;
export type Style = keyof typeof CODES;

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export interface Spinner {
  update(text: string): void;
  succeed(text?: string): void;
  fail(text?: string): void;
  stop(): void;
}

export interface UiOptions {
  stream?: OutputStream;
  /** Force colours on or off; default: on for a TTY unless NO_COLOR is set. */
  color?: boolean;
  env?: NodeJS.ProcessEnv;
}

export class Ui {
  readonly stream: OutputStream;
  readonly color: boolean;
  /** True when the output is a terminal, so animation and cursor control make sense. */
  readonly tty: boolean;

  constructor(options: UiOptions = {}) {
    this.stream = options.stream ?? process.stdout;
    this.tty = this.stream.isTTY === true;
    const env = options.env ?? process.env;
    this.color = options.color ?? (this.tty && !env['NO_COLOR'] && env['TERM'] !== 'dumb');
  }

  get columns(): number {
    return Math.max(40, Math.min(this.stream.columns ?? 100, 200));
  }

  paint(text: string, ...styles: Style[]): string {
    if (!this.color || styles.length === 0) return text;
    return `\u001b[${styles.map((s) => CODES[s]).join(';')}m${text}\u001b[0m`;
  }

  write(text: string): void {
    this.stream.write(text);
  }

  line(text = ''): void {
    this.stream.write(`${text}\n`);
  }

  info(text: string): void {
    this.line(`  ${text}`);
  }

  success(text: string): void {
    this.line(`${this.paint('✔', 'green')} ${text}`);
  }

  warn(text: string): void {
    this.line(`${this.paint('!', 'yellow', 'bold')} ${this.paint(text, 'yellow')}`);
  }

  error(text: string): void {
    this.line(`${this.paint('✖', 'red')} ${this.paint(text, 'red')}`);
  }

  dim(text: string): void {
    this.line(this.paint(text, 'dim'));
  }

  heading(text: string): void {
    this.line();
    this.line(this.paint(text, 'bold'));
  }

  step(index: number, total: number, title: string): void {
    this.line();
    this.line(`${this.paint(`STEP ${index}/${total}`, 'cyan', 'bold')}  ${this.paint(title, 'bold')}`);
  }

  /** A titled block. Lines are printed without a right border so long URLs stay copyable. */
  block(title: string, lines: string[]): void {
    const rule = '─'.repeat(Math.max(4, Math.min(this.columns, 78) - title.length - 4));
    this.line(this.paint(`┌─ ${title} ${rule}`, 'dim'));
    for (const line of lines) this.line(`${this.paint('│', 'dim')} ${line}`);
    this.line(this.paint(`└${'─'.repeat(Math.min(this.columns, 78) - 1)}`, 'dim'));
  }

  spinner(text: string): Spinner {
    if (!this.tty) {
      // Non-interactive output: one line when the work ends.
      let current = text;
      return {
        update: (next) => {
          current = next;
        },
        succeed: (final) => this.success(final ?? current),
        fail: (final) => this.error(final ?? current),
        stop: () => undefined,
      };
    }
    let current = text;
    let frame = 0;
    const render = (): void => {
      this.write(`\r\u001b[2K${this.paint(SPINNER_FRAMES[frame % SPINNER_FRAMES.length] as string, 'cyan')} ${current}`);
      frame += 1;
    };
    render();
    const timer = setInterval(render, 80);
    const finish = (): void => {
      clearInterval(timer);
      this.write('\r\u001b[2K');
    };
    return {
      update: (next) => {
        current = next;
      },
      succeed: (final) => {
        finish();
        this.success(final ?? current);
      },
      fail: (final) => {
        finish();
        this.error(final ?? current);
      },
      stop: finish,
    };
  }
}

/** Shorten the middle of a secret for display: enough to recognise, not enough to use. */
export function maskSecret(secret: string): string {
  if (secret.length <= 12) return '•'.repeat(secret.length);
  return `${secret.slice(0, 8)}…${secret.slice(-2)}`;
}
