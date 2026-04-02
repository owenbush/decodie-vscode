import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import Anthropic from '@anthropic-ai/sdk';
import * as vscode from 'vscode';
import { DataParser, IndexEntry, SessionEntry, SessionFile } from '@owenbush/decodie-core';

/** Entry returned from analysis before writing to disk */
export interface GeneratedEntry {
  id: string;
  title: string;
  code_snippet: string;
  explanation: string;
  alternatives_considered: string;
  key_concepts: string[];
  topics: string[];
  experience_level: 'foundational' | 'intermediate' | 'advanced' | 'ecosystem';
  decision_type: 'explanation' | 'rationale' | 'pattern' | 'warning' | 'convention';
  references: { file: string; anchor: string; anchor_hash: string }[];
  external_docs: { label: string; url: string }[];
}

interface AuthCredentials {
  type: 'oauth' | 'apikey';
  token: string;
}

/**
 * Parse a .env file manually: read lines, skip comments/blanks, split on first `=`.
 */
function parseEnvFile(filePath: string): Record<string, string> {
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
function loadAuth(workspaceRoot: string): AuthCredentials {
  const envPath = path.join(workspaceRoot, '.decodie', '.env');
  const env = parseEnvFile(envPath);

  if (env.CLAUDE_CODE_OAUTH_TOKEN) {
    return { type: 'oauth', token: env.CLAUDE_CODE_OAUTH_TOKEN };
  }
  if (env.CLAUDE_API_KEY) {
    return { type: 'apikey', token: env.CLAUDE_API_KEY };
  }

  // Fall back to VSCode settings
  const config = vscode.workspace.getConfiguration('decodie');
  const apiKey = config.get<string>('apiKey');
  if (apiKey) {
    return { type: 'apikey', token: apiKey };
  }

  throw new Error(
    'No Anthropic credentials found. Add CLAUDE_API_KEY to .decodie/.env or set decodie.apiKey in VSCode settings.'
  );
}

/**
 * Determine the next session ID for today: analyze-YYYY-MM-DD-NNN
 */
function nextSessionId(workspaceRoot: string): string {
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const prefix = `analyze-${today}-`;
  const sessionsDir = path.join(workspaceRoot, '.decodie', 'sessions');

  let maxN = 0;
  if (fs.existsSync(sessionsDir)) {
    for (const file of fs.readdirSync(sessionsDir)) {
      if (file.startsWith(prefix) && file.endsWith('.json')) {
        const numStr = file.slice(prefix.length, -5); // strip prefix and .json
        const num = parseInt(numStr, 10);
        if (!isNaN(num) && num > maxN) {
          maxN = num;
        }
      }
    }
  }

  const next = String(maxN + 1).padStart(3, '0');
  return `${prefix}${next}`;
}

/**
 * Generate a unique entry ID: entry-{unix-timestamp}-{random-4-hex}
 */
function generateEntryId(): string {
  const ts = Math.floor(Date.now() / 1000);
  const rand = crypto.randomBytes(2).toString('hex');
  return `entry-${ts}-${rand}`;
}

/**
 * Compute anchor hash: first 8 hex chars of SHA-256 of anchor text.
 */
function anchorHash(anchor: string): string {
  return crypto.createHash('sha256').update(anchor).digest('hex').slice(0, 8);
}

const SYSTEM_PROMPT = `You are a code analysis assistant for the Decodie learning documentation system. Your job is to analyze provided code and identify patterns, decisions, conventions, and concepts worth documenting for a developer learning this codebase.

Analyze the code and return a JSON object with an "entries" array containing 3-5 of the most significant patterns or decisions.

Each entry must have these fields:
- "title": A concise, descriptive title for the pattern/decision
- "code_snippet": The relevant code excerpt (keep it focused, not the entire file)
- "explanation": A clear explanation emphasizing WHY this approach was chosen, not just WHAT it does
- "alternatives_considered": What alternatives exist and why they weren't chosen
- "key_concepts": An array of concept strings the developer should understand
- "topics": An array of lowercase kebab-case topic tags (e.g., "error-handling", "type-safety")
- "experience_level": One of "foundational", "intermediate", "advanced", "ecosystem"
- "decision_type": One of "explanation", "rationale", "pattern", "warning", "convention"
- "references": An array of objects with { "file": "<relative-path>", "anchor": "<code-anchor>", "anchor_hash": "<first-8-hex-of-sha256-of-anchor>" }
- "external_docs": An array of objects with { "label": "<description>", "url": "<url>" }

Guidelines:
- Be selective: pick the 3-5 most significant and educational patterns
- Emphasize "why" over "what" in explanations
- For anchors, use function signatures, class declarations, or distinctive code blocks (NOT line numbers)
- For anchor_hash, compute the first 8 hex characters of the SHA-256 hash of the anchor text
- Topics should be specific and useful for filtering (e.g., "dependency-injection" not just "code")
- External docs should link to official documentation when relevant

Return ONLY valid JSON with no markdown formatting or code fences. The response must be parseable by JSON.parse().`;

interface RawAnalysisEntry {
  title: string;
  code_snippet: string;
  explanation: string;
  alternatives_considered: string;
  key_concepts: string[];
  topics: string[];
  experience_level: string;
  decision_type: string;
  references: { file: string; anchor: string; anchor_hash: string }[];
  external_docs: { label: string; url: string }[];
}

/**
 * Main analysis function: sends code to Claude and writes structured entries.
 */
export async function analyzeCode(params: {
  code: string;
  filePath: string;
  workspaceRoot: string;
  onProgress?: (msg: string) => void;
}): Promise<GeneratedEntry[]> {
  const { code, filePath, workspaceRoot, onProgress } = params;

  // 1. Load auth
  onProgress?.('Loading credentials...');
  const auth = loadAuth(workspaceRoot);

  // 2. Load config for user experience level
  const parser = new DataParser(workspaceRoot);
  const config = parser.loadConfig();
  const userLevel = config.user_experience_level;

  // 3. Get model from settings
  const vscodeConfig = vscode.workspace.getConfiguration('decodie');
  const model = vscodeConfig.get<string>('model') || 'claude-sonnet-4-6';

  // 4. Send request to Claude
  onProgress?.('Analyzing code with Claude...');
  const userMessage = `Analyze the following code from file \`${filePath}\`. The developer's experience level is "${userLevel}".\n\n\`\`\`\n${code}\n\`\`\``;

  let responseText: string;

  if (auth.type === 'apikey') {
    // Use Anthropic SDK directly for API keys
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
    // Use Claude Agent SDK for OAuth tokens (same as decodie-ui)
    const { query } = await import('@anthropic-ai/claude-agent-sdk');
    const fullPrompt = SYSTEM_PROMPT + '\n\n' + userMessage;

    const conversation = query({
      prompt: fullPrompt,
      options: {
        model,
        maxTurns: 1,
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

  // 5. Parse response
  onProgress?.('Processing results...');

  let parsed: { entries: RawAnalysisEntry[] };
  try {
    parsed = JSON.parse(responseText);
  } catch {
    // Try extracting JSON from markdown code fences
    const match = responseText.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (match) {
      parsed = JSON.parse(match[1]);
    } else {
      throw new Error('Failed to parse Claude response as JSON');
    }
  }

  if (!parsed.entries || !Array.isArray(parsed.entries)) {
    throw new Error('Claude response missing "entries" array');
  }

  // 7. Generate entry IDs and compute anchor hashes
  const sessionId = nextSessionId(workspaceRoot);
  const now = new Date().toISOString();

  const generatedEntries: GeneratedEntry[] = parsed.entries.map((raw) => {
    const id = generateEntryId();

    // Recompute anchor hashes to ensure correctness
    const references = (raw.references || []).map((ref) => ({
      file: ref.file || filePath,
      anchor: ref.anchor,
      anchor_hash: anchorHash(ref.anchor),
    }));

    return {
      id,
      title: raw.title,
      code_snippet: raw.code_snippet,
      explanation: raw.explanation,
      alternatives_considered: raw.alternatives_considered || '',
      key_concepts: raw.key_concepts || [],
      topics: raw.topics || [],
      experience_level: validateLevel(raw.experience_level),
      decision_type: validateDecisionType(raw.decision_type),
      references,
      external_docs: raw.external_docs || [],
    };
  });

  // 8. Write session file
  onProgress?.('Writing entries...');
  const sessionsDir = path.join(workspaceRoot, '.decodie', 'sessions');
  if (!fs.existsSync(sessionsDir)) {
    fs.mkdirSync(sessionsDir, { recursive: true });
  }

  const sessionEntries: SessionEntry[] = generatedEntries.map((e) => ({
    id: e.id,
    title: e.title,
    code_snippet: e.code_snippet,
    explanation: e.explanation,
    alternatives_considered: e.alternatives_considered,
    key_concepts: e.key_concepts,
  }));

  const sessionFile: SessionFile = {
    session_id: sessionId,
    timestamp_start: now,
    timestamp_end: new Date().toISOString(),
    summary: `Analysis of ${filePath}`,
    entries: sessionEntries,
  };

  const sessionPath = path.join(sessionsDir, `${sessionId}.json`);
  fs.writeFileSync(sessionPath, JSON.stringify(sessionFile, null, 2) + '\n', 'utf-8');

  // 9. Update index.json atomically
  const indexPath = path.join(workspaceRoot, '.decodie', 'index.json');
  let index: { version: string; project: string; entries: IndexEntry[] };

  try {
    parser.invalidateCache();
    const loaded = parser.loadIndex();
    index = { version: loaded.version, project: loaded.project, entries: [...loaded.entries] };
  } catch {
    // If index doesn't exist yet, create a minimal one
    const projectName = path.basename(workspaceRoot);
    index = { version: '1.0', project: projectName, entries: [] };
  }

  const newIndexEntries: IndexEntry[] = generatedEntries.map((e) => ({
    id: e.id,
    title: e.title,
    experience_level: e.experience_level,
    topics: e.topics,
    decision_type: e.decision_type,
    session_id: sessionId,
    timestamp: now,
    lifecycle: 'active' as const,
    references: e.references,
    external_docs: e.external_docs,
    cross_references: [],
    content_file: `sessions/${sessionId}.json`,
    superseded_by: null,
  }));

  index.entries.push(...newIndexEntries);

  // Atomic write: write to .tmp, then rename
  const tmpPath = indexPath + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(index, null, 2) + '\n', 'utf-8');
  fs.renameSync(tmpPath, indexPath);

  return generatedEntries;
}

function validateLevel(level: string): GeneratedEntry['experience_level'] {
  const valid = ['foundational', 'intermediate', 'advanced', 'ecosystem'] as const;
  if (valid.includes(level as typeof valid[number])) {
    return level as GeneratedEntry['experience_level'];
  }
  return 'intermediate';
}

function validateDecisionType(dt: string): GeneratedEntry['decision_type'] {
  const valid = ['explanation', 'rationale', 'pattern', 'warning', 'convention'] as const;
  if (valid.includes(dt as typeof valid[number])) {
    return dt as GeneratedEntry['decision_type'];
  }
  return 'explanation';
}
