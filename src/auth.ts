import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

export interface AuthCredentials {
  type: 'oauth' | 'apikey';
  token: string;
}

/**
 * Parse a .env file: read lines, skip comments/blanks, split on first `=`.
 */
export function parseEnvFile(filePath: string): Record<string, string> {
  const result: Record<string, string> = {};
  if (!fs.existsSync(filePath)) {
    return result;
  }
  const content = fs.readFileSync(filePath, 'utf-8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) {
      continue;
    }
    const key = trimmed.slice(0, eqIndex).trim();
    const value = trimmed.slice(eqIndex + 1).trim();
    result[key] = value;
  }
  return result;
}

/**
 * Load authentication credentials from .decodie/.env or VSCode settings.
 */
export function loadAuth(workspaceRoot: string): AuthCredentials {
  const envPath = path.join(workspaceRoot, '.decodie', '.env');
  const env = parseEnvFile(envPath);

  if (env.CLAUDE_CODE_OAUTH_TOKEN) {
    return { type: 'oauth', token: env.CLAUDE_CODE_OAUTH_TOKEN };
  }
  if (env.CLAUDE_API_KEY) {
    return { type: 'apikey', token: env.CLAUDE_API_KEY };
  }

  const config = vscode.workspace.getConfiguration('decodie');
  const apiKey = config.get<string>('apiKey');
  if (apiKey) {
    return { type: 'apikey', token: apiKey };
  }

  throw new Error(
    'No credentials found. Add CLAUDE_CODE_OAUTH_TOKEN or CLAUDE_API_KEY to .decodie/.env'
  );
}
