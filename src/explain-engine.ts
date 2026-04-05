import Anthropic from '@anthropic-ai/sdk';
import * as vscode from 'vscode';
import { loadAuth } from './auth';
import { resolveClaudeExecutable, extractJson, repairJson } from './analysis-engine';

/** Result returned from explain — ephemeral, not persisted unless user saves */
export interface ExplainResult {
  title: string;
  summary: string;
  code_snippet: string;
  breakdowns: Array<{ code_excerpt: string; explanation: string; pattern?: string }>;
  issues: Array<{ severity: 'info' | 'warning' | 'error'; description: string; suggestion: string }>;
  improvements: Array<{ description: string; rationale: string }>;
  key_concepts: string[];
  topics: string[];
  experience_level: 'foundational' | 'intermediate' | 'advanced' | 'ecosystem';
  file_path: string;
}

const SYSTEM_PROMPT = `You are a code explanation assistant. Your job is to help a developer deeply understand a piece of code.

Return a JSON object with this exact shape:
{
  "title": "concise title for the explanation",
  "summary": "2-3 sentence high-level overview of what the code does and why it is interesting",
  "breakdowns": [{"code_excerpt": "exact snippet from the code", "explanation": "what this part does and why", "pattern": "optional short pattern name"}],
  "issues": [{"severity": "info|warning|error", "description": "what the issue is", "suggestion": "how to fix it"}],
  "improvements": [{"description": "suggested improvement", "rationale": "why it would help"}],
  "key_concepts": ["concept 1", "concept 2"],
  "topics": ["kebab-case-topic"],
  "experience_level": "foundational|intermediate|advanced|ecosystem"
}

Rules:
- Skip trivial code in breakdowns. Pick 2-5 of the most complex or interesting sections only.
- code_excerpt must be copied verbatim from the provided code.
- Keep explanations concise (2-4 sentences) to avoid truncation.
- Issues and improvements are optional — include empty arrays if none apply.
- topics must be lowercase-kebab-case.
- Return ONLY valid JSON, no markdown fences, no extra text.`;

interface RawExplainResult {
  title?: string;
  summary?: string;
  breakdowns?: Array<{ code_excerpt?: string; explanation?: string; pattern?: string }>;
  issues?: Array<{ severity?: string; description?: string; suggestion?: string }>;
  improvements?: Array<{ description?: string; rationale?: string }>;
  key_concepts?: string[];
  topics?: string[];
  experience_level?: string;
}

function validateLevel(level: string | undefined): ExplainResult['experience_level'] {
  const valid = ['foundational', 'intermediate', 'advanced', 'ecosystem'] as const;
  if (level && valid.includes(level as typeof valid[number])) {
    return level as ExplainResult['experience_level'];
  }
  return 'intermediate';
}

function validateSeverity(s: string | undefined): 'info' | 'warning' | 'error' {
  if (s === 'warning' || s === 'error' || s === 'info') {
    return s;
  }
  return 'info';
}

/**
 * Explain code: sends to Claude and returns a structured ExplainResult.
 * Does NOT write to disk — the caller (sidebar) handles persistence on save.
 */
export async function explainCode(params: {
  code: string;
  filePath: string;
  workspaceRoot: string;
  onProgress?: (msg: string) => void;
}): Promise<ExplainResult> {
  const { code, filePath, workspaceRoot, onProgress } = params;

  onProgress?.('Loading credentials...');
  const auth = loadAuth(workspaceRoot);

  const vscodeConfig = vscode.workspace.getConfiguration('decodie');
  const model = vscodeConfig.get<string>('model') || 'claude-sonnet-4-6';

  onProgress?.('Explaining code with Claude...');
  const userMessage = `Explain the following code from file \`${filePath}\`.\n\n\`\`\`\n${code}\n\`\`\``;

  let responseText: string;

  if (auth.type === 'apikey') {
    const client = new Anthropic({ apiKey: auth.token });
    const response = await client.messages.create({
      model,
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMessage }],
    });

    const textBlock = response.content.find((b) => b.type === 'text');
    if (!textBlock || textBlock.type !== 'text') {
      throw new Error('No text response from Claude');
    }
    responseText = textBlock.text;
  } else {
    const { query } = await import('@anthropic-ai/claude-agent-sdk');
    const fullPrompt = SYSTEM_PROMPT + '\n\n' + userMessage;

    const claudePath = resolveClaudeExecutable();
    if (!claudePath) {
      throw new Error('Claude Code CLI not found. Install it from https://docs.anthropic.com/en/docs/claude-code or use an API key instead.');
    }

    const conversation = query({
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

    let collected = '';
    for await (const message of conversation) {
      if (message.type === 'assistant' && message.message) {
        const content = message.message.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'text' && block.text) {
              collected += block.text;
            }
          }
        }
      }
    }

    if (!collected) {
      throw new Error('No response from Claude');
    }
    responseText = collected;
  }

  onProgress?.('Processing results...');

  let parsed: RawExplainResult;
  const jsonText = extractJson(responseText);
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    try {
      parsed = JSON.parse(repairJson(jsonText));
    } catch {
      console.error('Decodie: Failed to parse explain response. Raw text:', responseText.slice(0, 500));
      throw new Error('Failed to parse Claude response as JSON');
    }
  }

  if (!parsed.title || !parsed.summary) {
    throw new Error('Claude response missing required fields (title or summary)');
  }

  const breakdowns = (parsed.breakdowns || [])
    .filter((b) => b && b.code_excerpt && b.explanation)
    .map((b) => ({
      code_excerpt: b.code_excerpt as string,
      explanation: b.explanation as string,
      pattern: b.pattern,
    }));

  const issues = (parsed.issues || [])
    .filter((i) => i && i.description)
    .map((i) => ({
      severity: validateSeverity(i.severity),
      description: i.description as string,
      suggestion: i.suggestion || '',
    }));

  const improvements = (parsed.improvements || [])
    .filter((i) => i && i.description)
    .map((i) => ({
      description: i.description as string,
      rationale: i.rationale || '',
    }));

  return {
    title: parsed.title,
    summary: parsed.summary,
    code_snippet: code,
    breakdowns,
    issues,
    improvements,
    key_concepts: parsed.key_concepts || [],
    topics: parsed.topics || [],
    experience_level: validateLevel(parsed.experience_level),
    file_path: filePath,
  };
}
