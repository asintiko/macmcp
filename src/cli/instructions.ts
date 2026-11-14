import type { AuthMode } from '../server/auth.js';

export interface ConnectionDetails {
  authMode: AuthMode;
  token: string | undefined;
  /** Public base URL of the tunnel, if any. */
  publicBaseUrl: string | undefined;
  localBaseUrl: string;
}

export interface ConnectionInfo {
  /** The one URL to paste into a provider: includes the access token in token mode. */
  connectionUrl: string;
  /** Endpoint without credentials, for clients that send the token in a header. */
  endpointUrl: string;
  /** Value of the Authorization header in token mode. */
  authorization: string | undefined;
  /** Whether the URLs are reachable from the internet. */
  public: boolean;
}

export function connectionInfo(details: ConnectionDetails): ConnectionInfo {
  const base = details.publicBaseUrl ?? details.localBaseUrl;
  const endpointUrl = `${base}/mcp`;
  const tokenMode = details.authMode === 'token' && details.token !== undefined;
  return {
    connectionUrl: tokenMode ? `${endpointUrl}/${details.token}` : endpointUrl,
    endpointUrl,
    authorization: tokenMode ? `Bearer ${details.token}` : undefined,
    public: details.publicBaseUrl !== undefined,
  };
}

/** Lines shown in the terminal once the endpoint is up. Plain text; the caller adds styling. */
export function connectionInstructions(details: ConnectionDetails): string[] {
  const info = connectionInfo(details);
  const lines: string[] = [];

  if (info.authorization) {
    lines.push(
      'MCP server URL — paste this into your AI provider.',
      'It contains your access token: treat it like a password.',
      '',
      `  ${info.connectionUrl}`,
      '',
      'For clients that can send a header, keep the token out of the URL:',
      `  URL     ${info.endpointUrl}`,
      `  Header  Authorization: ${info.authorization}`,
    );
  } else {
    lines.push(
      'MCP server URL — paste this into your AI provider.',
      'Authentication is OFF: anyone who learns this URL can use the server.',
      '',
      `  ${info.connectionUrl}`,
    );
  }

  lines.push('');
  if (!info.public) {
    lines.push(
      'No tunnel is running, so this URL only works on this Mac.',
      'Cloud agents need a public HTTPS URL: start without --no-tunnel, or pass --public-url.',
      '',
    );
  }
  lines.push(
    'How to connect',
    '  Claude (claude.ai, Desktop)  Customize → Connectors → "+" → Add custom connector',
    '                               → paste the URL → "No sign in"',
  );
  if (info.authorization) {
    lines.push(
      `  Claude Code                  claude mcp add --transport http mac ${info.endpointUrl} \\`,
      `                                 --header "Authorization: ${info.authorization}"`,
    );
  } else {
    lines.push(`  Claude Code                  claude mcp add --transport http mac ${info.endpointUrl}`);
  }
  lines.push(
    '  ChatGPT                      Plugins → "+" → Add custom MCP server → paste the URL',
    '                               → "No authentication"',
    '  API clients, Cursor, VS Code, Gemini CLI and others: docs/PROVIDERS.md',
  );
  return lines;
}
