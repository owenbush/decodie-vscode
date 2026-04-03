import * as fs from 'fs';
import * as path from 'path';
import * as child_process from 'child_process';
import * as vscode from 'vscode';
import Anthropic from '@anthropic-ai/sdk';
import { FullEntry } from '@owenbush/decodie-core';
import { loadAuth } from './auth';

export interface ConversationTurn {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * Ask a question about a Decodie entry and stream the response.
 */
export async function askQuestion(params: {
  entry: FullEntry;
  question: string;
  conversation: ConversationTurn[];
  workspaceRoot: string;
  onDelta: (text: string) => void;
  onDone: () => void;
  onError: (error: string) => void;
}): Promise<string> {
  const { entry, question, conversation, workspaceRoot, onDelta, onDone, onError } = params;

  const auth = loadAuth(workspaceRoot);

  const systemPrompt = `You are explaining a coding concept to a developer who is reviewing learning entries generated during an AI-assisted coding session.

Here is the learning entry they are reading:

Title: ${entry.title}
Code:
\`\`\`
${entry.code_snippet || '(no code snippet)'}
\`\`\`
Explanation: ${entry.explanation || '(no explanation)'}
Alternatives Considered: ${entry.alternatives_considered || '(none)'}
Key Concepts: ${(entry.key_concepts || []).join(', ') || '(none)'}

Answer concisely and helpfully. Reference the specific code when relevant. If the question goes beyond what the entry covers, say so and explain what you can.`;

  const vscodeConfig = vscode.workspace.getConfiguration('decodie');
  const model = vscodeConfig.get<string>('model') || 'claude-sonnet-4-6';

  let fullResponse = '';

  try {
    if (auth.type === 'apikey') {
      const client = new Anthropic({ apiKey: auth.token });

      const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [];
      for (const turn of conversation) {
        messages.push({ role: turn.role, content: turn.content });
      }
      messages.push({ role: 'user', content: question });

      const stream = client.messages.stream({
        model,
        max_tokens: 1024,
        system: systemPrompt,
        messages,
      });

      for await (const event of stream) {
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          fullResponse += event.delta.text;
          onDelta(event.delta.text);
        }
      }

      onDone();
    } else {
      // OAuth — use Agent SDK
      const { query } = await import('@anthropic-ai/claude-agent-sdk');

      const claudePath = resolveClaudeExecutable();
      if (!claudePath) {
        throw new Error('Claude Code CLI not found. Use an API key instead.');
      }

      const fullPrompt = systemPrompt + '\n\nDeveloper\'s question: ' + question;

      const convo = query({
        prompt: fullPrompt,
        options: {
          model,
          maxTurns: 1,
          tools: [],
          cwd: workspaceRoot,
          pathToClaudeCodeExecutable: claudePath,
          env: { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: auth.token },
        },
      });

      for await (const message of convo) {
        if (message.type === 'assistant' && message.message) {
          const content = message.message.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === 'text' && block.text) {
                fullResponse += block.text;
                onDelta(block.text);
              }
            }
          }
        }
      }

      onDone();
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    onError(msg);
  }

  return fullResponse;
}

/**
 * Load a saved conversation from .decodie/conversations/{entryId}.json
 */
export function loadConversation(workspaceRoot: string, entryId: string): ConversationTurn[] {
  const filePath = path.join(workspaceRoot, '.decodie', 'conversations', `${entryId}.json`);
  if (!fs.existsSync(filePath)) {
    return [];
  }
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    return Array.isArray(data.conversation) ? data.conversation : [];
  } catch {
    return [];
  }
}

/**
 * Save a conversation to .decodie/conversations/{entryId}.json
 */
export function saveConversation(workspaceRoot: string, entryId: string, conversation: ConversationTurn[]): void {
  const dir = path.join(workspaceRoot, '.decodie', 'conversations');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const filePath = path.join(dir, `${entryId}.json`);
  fs.writeFileSync(filePath, JSON.stringify({ conversation }, null, 2) + '\n', 'utf-8');
}

function resolveClaudeExecutable(): string | undefined {
  try {
    const result = child_process.execSync('which claude', { encoding: 'utf-8' }).trim();
    if (result && fs.existsSync(result)) {
      return result;
    }
  } catch {
    // not in PATH
  }
  const candidates = [
    path.join(process.env.HOME || '', '.local', 'bin', 'claude'),
    '/usr/local/bin/claude',
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) {
      return c;
    }
  }
  return undefined;
}
