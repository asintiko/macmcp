/** The questions the CLI can ask, behind an interface so the wizard can be tested with scripted answers. */

export interface Choice<T> {
  name: string;
  value: T;
  /** Shown under the list while this choice is highlighted. */
  description?: string;
}

export type Validator = (value: string) => true | string | Promise<true | string>;

export interface Prompter {
  select<T>(options: { message: string; choices: Choice<T>[]; default?: T; pageSize?: number }): Promise<T>;
  input(options: { message: string; default?: string; validate?: Validator }): Promise<string>;
  secret(options: { message: string; validate?: Validator }): Promise<string>;
  confirm(options: { message: string; default?: boolean }): Promise<boolean>;
}

/** Thrown when the user aborts a question with Ctrl+C. */
export class PromptCancelled extends Error {
  constructor() {
    super('Cancelled');
    this.name = 'PromptCancelled';
  }
}

async function guard<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof Error && (err.name === 'ExitPromptError' || err.name === 'AbortPromptError')) throw new PromptCancelled();
    throw err;
  }
}

/** Interactive prompts on the real terminal. The library is loaded on first use. */
export function createTerminalPrompter(): Prompter {
  const load = (): Promise<typeof import('@inquirer/prompts')> => import('@inquirer/prompts');
  return {
    async select(options) {
      const { select } = await load();
      return guard(() =>
        select({
          message: options.message,
          choices: options.choices.map((c) => ({ name: c.name, value: c.value, ...(c.description ? { description: c.description } : {}) })),
          ...(options.default !== undefined ? { default: options.default } : {}),
          pageSize: options.pageSize ?? 12,
          loop: false,
        }),
      );
    },
    async input(options) {
      const { input } = await load();
      return guard(() =>
        input({
          message: options.message,
          ...(options.default !== undefined ? { default: options.default } : {}),
          ...(options.validate ? { validate: options.validate } : {}),
        }),
      );
    },
    async secret(options) {
      const { password } = await load();
      return guard(() => password({ message: options.message, mask: '•', ...(options.validate ? { validate: options.validate } : {}) }));
    },
    async confirm(options) {
      const { confirm } = await load();
      return guard(() => confirm({ message: options.message, default: options.default ?? false }));
    },
  };
}
