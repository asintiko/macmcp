/**
 * Error model shared by all tools. A ToolError is returned to the agent as an MCP error
 * result (`isError: true`) with a stable code, a message and an optional hint.
 */
export type ToolErrorCode =
  | 'INVALID_ARGUMENT'
  | 'NOT_FOUND'
  | 'ALREADY_EXISTS'
  | 'PERMISSION_DENIED'
  | 'OUTSIDE_PROJECT'
  | 'SETUP_PENDING'
  | 'PAUSED'
  | 'TIMEOUT'
  | 'TOO_LARGE'
  | 'CONFLICT'
  | 'UNSUPPORTED_PLATFORM'
  | 'DEPENDENCY_MISSING'
  | 'MACOS_PERMISSION_REQUIRED'
  | 'CANCELLED'
  | 'FAILED'
  | 'INTERNAL';

export class ToolError extends Error {
  readonly code: ToolErrorCode;
  readonly hint?: string;

  constructor(code: ToolErrorCode, message: string, hint?: string) {
    super(message);
    this.name = 'ToolError';
    this.code = code;
    if (hint !== undefined) this.hint = hint;
  }
}

/** Map filesystem and other runtime errors onto the tool error model. */
export function toToolError(err: unknown): ToolError {
  if (err instanceof ToolError) return err;
  if (err && typeof err === 'object') {
    const e = err as NodeJS.ErrnoException;
    const where = e.path ? `: ${e.path}` : '';
    switch (e.code) {
      case 'ENOENT':
        return new ToolError('NOT_FOUND', `No such file or directory${where}`);
      case 'EEXIST':
        return new ToolError('ALREADY_EXISTS', `Already exists${where}`);
      case 'EACCES':
      case 'EPERM':
        return new ToolError(
          'PERMISSION_DENIED',
          `Operation not permitted by the operating system${where}`,
          'The mcpclaude process does not have the rights for this path, or macOS privacy protection (TCC) blocks it.',
        );
      case 'ENOTDIR':
        return new ToolError('INVALID_ARGUMENT', `Not a directory${where}`);
      case 'EISDIR':
        return new ToolError('INVALID_ARGUMENT', `Is a directory${where}`);
      case 'ENOTEMPTY':
        return new ToolError('CONFLICT', `Directory not empty${where}`, 'Pass recursive: true to delete a directory with contents.');
      case 'ENOSPC':
        return new ToolError('FAILED', 'No space left on device');
      case 'ABORT_ERR':
        return new ToolError('CANCELLED', 'The request was cancelled');
      default:
        break;
    }
    if (e.name === 'AbortError') return new ToolError('CANCELLED', 'The request was cancelled');
  }
  const message = err instanceof Error ? err.message : String(err);
  return new ToolError('INTERNAL', message || 'Unknown error');
}

export function formatToolError(err: ToolError): string {
  return `Error [${err.code}]: ${err.message}${err.hint ? `\nHint: ${err.hint}` : ''}`;
}
