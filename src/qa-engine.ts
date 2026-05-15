import * as fs from 'fs';
import * as path from 'path';
import { streamText } from 'ai';
import { FullEntry } from '@owenbush/decodie-core';
import { resolveProvider } from './llm/provider';

export interface ConversationTurn {
  role: 'user' | 'assistant';
  content: string;
}

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

  const { model } = resolveProvider(workspaceRoot);

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

  const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  for (const turn of conversation) {
    messages.push({ role: turn.role, content: turn.content });
  }
  messages.push({ role: 'user', content: question });

  let fullResponse = '';

  try {
    let streamError: unknown;
    const result = streamText({
      model,
      system: systemPrompt,
      messages,
      maxOutputTokens: 1024,
      onError({ error }) {
        streamError = error;
      },
    });

    for await (const delta of result.textStream) {
      fullResponse += delta;
      onDelta(delta);
    }

    if (streamError) throw streamError;

    onDone();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    onError(msg);
  }

  return fullResponse;
}

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

export function saveConversation(workspaceRoot: string, entryId: string, conversation: ConversationTurn[]): void {
  const dir = path.join(workspaceRoot, '.decodie', 'conversations');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const filePath = path.join(dir, `${entryId}.json`);
  fs.writeFileSync(filePath, JSON.stringify({ conversation }, null, 2) + '\n', 'utf-8');
}
