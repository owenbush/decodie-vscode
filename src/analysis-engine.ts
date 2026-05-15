import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { generateText } from 'ai';
import { DataParser, IndexEntry, SessionEntry, SessionFile } from '@owenbush/decodie-core';
import { resolveProvider } from './llm/provider';

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

/**
 * Determine the next session ID for today: analyze-YYYY-MM-DD-NNN
 */
function nextSessionId(workspaceRoot: string): string {
  const today = new Date().toISOString().slice(0, 10);
  const prefix = `analyze-${today}-`;
  const sessionsDir = path.join(workspaceRoot, '.decodie', 'sessions');

  let maxN = 0;
  if (fs.existsSync(sessionsDir)) {
    for (const file of fs.readdirSync(sessionsDir)) {
      if (file.startsWith(prefix) && file.endsWith('.json')) {
        const numStr = file.slice(prefix.length, -5);
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

function generateEntryId(): string {
  const ts = Math.floor(Date.now() / 1000);
  const rand = crypto.randomBytes(2).toString('hex');
  return `entry-${ts}-${rand}`;
}

function anchorHash(anchor: string): string {
  return crypto.createHash('sha256').update(anchor).digest('hex').slice(0, 8);
}

/**
 * Attempt to repair truncated JSON by closing open structures.
 */
export function repairJson(text: string): string {
  let s = text.trim();

  s = s.replace(/,\s*$/, '');

  const quoteCount = (s.match(/(?<!\\)"/g) || []).length;
  if (quoteCount % 2 !== 0) {
    s += '"';
  }

  let braces = 0;
  let brackets = 0;
  let inString = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '"' && (i === 0 || s[i - 1] !== '\\')) {
      inString = !inString;
    } else if (!inString) {
      if (ch === '{') braces++;
      else if (ch === '}') braces--;
      else if (ch === '[') brackets++;
      else if (ch === ']') brackets--;
    }
  }

  s = s.replace(/,?\s*"[^"]*":\s*"?[^"{}[\]]*$/, '');

  braces = 0;
  brackets = 0;
  inString = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '"' && (i === 0 || s[i - 1] !== '\\')) {
      inString = !inString;
    } else if (!inString) {
      if (ch === '{') braces++;
      else if (ch === '}') braces--;
      else if (ch === '[') brackets++;
      else if (ch === ']') brackets--;
    }
  }

  while (brackets > 0) { s += ']'; brackets--; }
  while (braces > 0) { s += '}'; braces--; }

  return s;
}

/**
 * Extract JSON from a response that may contain markdown fences or surrounding text.
 */
export function extractJson(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) {
    return trimmed;
  }

  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) {
    return fenceMatch[1].trim();
  }

  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    return trimmed.slice(firstBrace, lastBrace + 1);
  }

  return trimmed;
}

const SYSTEM_PROMPT = `You are a code analysis assistant. Analyze the code and return a JSON object with an "entries" array containing 2-4 entries.

CRITICAL: Keep explanations concise (2-3 sentences max). Keep code_snippet short (key lines only). This avoids truncation.

Each entry: { "title": string, "code_snippet": string, "explanation": string, "alternatives_considered": string, "key_concepts": [string], "topics": [lowercase-kebab-strings], "experience_level": "foundational"|"intermediate"|"advanced"|"ecosystem", "decision_type": "explanation"|"rationale"|"pattern"|"warning"|"convention", "references": [{"file": string, "anchor": string, "anchor_hash": string}], "external_docs": [{"label": string, "url": string}] }

Rules:
- 2-4 most significant patterns only
- Anchors: function signatures or class declarations, NOT line numbers
- anchor_hash: first 8 hex chars of SHA-256 of anchor text
- Return ONLY valid JSON, no markdown fences, no extra text`;

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

export async function analyzeCode(params: {
  code: string;
  filePath: string;
  workspaceRoot: string;
  onProgress?: (msg: string) => void;
}): Promise<GeneratedEntry[]> {
  const { code, filePath, workspaceRoot, onProgress } = params;

  onProgress?.('Loading credentials...');
  const { model } = resolveProvider(workspaceRoot);

  const parser = new DataParser(workspaceRoot);
  const config = parser.loadConfig();
  const userLevel = config.user_experience_level;

  onProgress?.('Analyzing code...');
  const userMessage = `Analyze the following code from file \`${filePath}\`. The developer's experience level is "${userLevel}".\n\n\`\`\`\n${code}\n\`\`\``;

  const result = await generateText({
    model,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userMessage }],
    maxOutputTokens: 4096,
  });

  const responseText = result.text;
  if (!responseText) {
    throw new Error('No response from LLM');
  }

  onProgress?.('Processing results...');

  let parsed: { entries: RawAnalysisEntry[] };
  const jsonText = extractJson(responseText);
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    try {
      parsed = JSON.parse(repairJson(jsonText));
    } catch {
      console.error('Decodie: Failed to parse response. Raw text:', responseText.slice(0, 500));
      throw new Error('Failed to parse LLM response as JSON');
    }
  }

  if (!parsed.entries || !Array.isArray(parsed.entries)) {
    throw new Error('LLM response missing "entries" array');
  }

  parsed.entries = parsed.entries.filter((e) => e.title && e.explanation);

  const sessionId = nextSessionId(workspaceRoot);
  const now = new Date().toISOString();

  const generatedEntries: GeneratedEntry[] = parsed.entries.map((raw) => {
    const id = generateEntryId();

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

  const indexPath = path.join(workspaceRoot, '.decodie', 'index.json');
  let index: { version: string; project: string; entries: IndexEntry[] };

  try {
    parser.invalidateCache();
    const loaded = parser.loadIndex();
    index = { version: loaded.version, project: loaded.project, entries: [...loaded.entries] };
  } catch {
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
