import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { generateText } from 'ai';
import { DataParser, IndexEntry, SessionFile } from '@owenbush/decodie-core';
import { resolveProvider } from './llm/provider';
import { extractJson, repairJson } from './analysis-engine';

export interface GeneratedOverviewEntry {
  id: string;
  title: string;
  purpose: string;
  structure: string;
  entry_points?: string[];
  dependencies?: string[];
  topics: string[];
  references: { file: string; anchor: string; anchor_hash: string }[];
  external_docs: { label: string; url: string }[];
  sources: string[];
  regenerated: boolean;
}

function nextOverviewSessionId(workspaceRoot: string): string {
  const today = new Date().toISOString().slice(0, 10);
  const prefix = `overview-${today}-`;
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

const STRUCTURAL_FILES = [
  'package.json', 'composer.json', 'pyproject.toml', 'Cargo.toml',
  'go.mod', 'build.gradle', 'pom.xml', 'Gemfile', 'Makefile',
  'tsconfig.json', 'README.md', 'readme.md',
];

const SOURCE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs', '.java',
  '.php', '.rb', '.cs', '.swift', '.kt', '.vue', '.svelte',
]);

function gatherDirectoryContext(dirPath: string, workspaceRoot: string, maxFiles: number = 8): string {
  const parts: string[] = [];
  const relDir = path.relative(workspaceRoot, dirPath) || '.';

  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  const listing = entries
    .filter((e) => !e.name.startsWith('.') && e.name !== 'node_modules' && e.name !== 'dist' && e.name !== 'vendor')
    .map((e) => e.isDirectory() ? `${e.name}/` : e.name);
  parts.push(`## Directory listing: ${relDir}\n${listing.join('\n')}`);

  for (const name of STRUCTURAL_FILES) {
    const filePath = path.join(dirPath, name);
    if (fs.existsSync(filePath)) {
      try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const truncated = content.length > 3000 ? content.slice(0, 3000) + '\n...(truncated)' : content;
        parts.push(`## ${path.join(relDir, name)}\n\`\`\`\n${truncated}\n\`\`\``);
      } catch { /* skip unreadable */ }
    }
  }

  let sampled = 0;
  for (const entry of entries) {
    if (sampled >= maxFiles) break;
    if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
      const filePath = path.join(dirPath, entry.name);
      try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const truncated = content.length > 2000 ? content.slice(0, 2000) + '\n...(truncated)' : content;
        parts.push(`## ${path.join(relDir, entry.name)}\n\`\`\`\n${truncated}\n\`\`\``);
        sampled++;
      } catch { /* skip */ }
    }
  }

  if (sampled < maxFiles) {
    for (const entry of entries) {
      if (sampled >= maxFiles) break;
      if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules' && entry.name !== 'dist' && entry.name !== 'vendor') {
        const subDir = path.join(dirPath, entry.name);
        try {
          const subEntries = fs.readdirSync(subDir, { withFileTypes: true });
          const subListing = subEntries
            .filter((e) => !e.name.startsWith('.'))
            .slice(0, 20)
            .map((e) => e.isDirectory() ? `${e.name}/` : e.name);
          parts.push(`## ${path.join(relDir, entry.name)}/\n${subListing.join('\n')}`);
        } catch { /* skip */ }
      }
    }
  }

  return parts.join('\n\n');
}

const SYSTEM_PROMPT = `You are a code documentation assistant. Generate a high-level overview of the given target — answering "what is this and how is it organized."

Return a JSON object with these fields:
- "title": string — concise title naming the target and its purpose, e.g. "Overview: src/auth/ — token issuance and verification"
- "purpose": string — 2-4 sentences describing what this code is for. Lead with intent, not implementation.
- "structure": string — how the code is organized (sections, modules, key files/directories and their roles).
- "entry_points": string[] (optional) — callable surfaces: exported functions, CLI commands, HTTP routes, hooks. Omit if none are meaningful.
- "dependencies": string[] (optional) — notable internal or external dependencies and what they provide. Omit trivial ones.
- "topics": string[] — lowercase kebab-case tags reflecting the target's domain.
- "external_docs": [{"label": string, "url": string}] — relevant documentation links.

Write in plain prose. Calibrate length to scope — a utility file overview may be a paragraph; a project overview may be several.
Return ONLY valid JSON, no markdown fences, no extra text.`;

interface RawOverviewResponse {
  title: string;
  purpose: string;
  structure: string;
  entry_points?: string[];
  dependencies?: string[];
  topics: string[];
  external_docs: { label: string; url: string }[];
}

export async function generateOverview(params: {
  target: string;
  scope: 'file' | 'directory' | 'project';
  workspaceRoot: string;
  onProgress?: (msg: string) => void;
}): Promise<GeneratedOverviewEntry> {
  const { target, scope, workspaceRoot, onProgress } = params;

  onProgress?.('Loading credentials...');
  const { model } = resolveProvider(workspaceRoot);
  const parser = new DataParser(workspaceRoot);

  onProgress?.('Reading project structure...');
  let contextText: string;
  const absoluteTarget = path.resolve(workspaceRoot, target);

  if (scope === 'file') {
    const content = fs.readFileSync(absoluteTarget, 'utf-8');
    contextText = `## File: ${target}\n\`\`\`\n${content}\n\`\`\``;
  } else {
    contextText = gatherDirectoryContext(absoluteTarget, workspaceRoot);
  }

  const canonicalTarget = scope === 'file'
    ? target
    : target === '.' || target === './' ? './' : (target.endsWith('/') ? target : target + '/');

  onProgress?.('Generating overview...');
  const userMessage = `Generate an overview of the following ${scope}:\n\nTarget: \`${target}\`\n\n${contextText}`;

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

  let parsed: RawOverviewResponse;
  const jsonText = extractJson(responseText);
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    try {
      parsed = JSON.parse(repairJson(jsonText));
    } catch {
      console.error('Decodie: Failed to parse overview response. Raw text:', responseText.slice(0, 500));
      throw new Error('Failed to parse LLM response as JSON');
    }
  }

  if (!parsed.purpose || !parsed.structure) {
    throw new Error('LLM response missing required "purpose" or "structure" fields');
  }

  // Check for existing overview to regenerate
  let existingId: string | undefined;
  let regenerated = false;
  try {
    parser.invalidateCache();
    const index = parser.loadIndex();
    const existing = index.entries.find(
      (e) => e.decision_type === 'overview' && Array.isArray(e.sources) && e.sources.length === 1 && e.sources[0] === canonicalTarget
    );
    if (existing) {
      existingId = existing.id;
      regenerated = true;
    }
  } catch { /* no index yet */ }

  const entryId = existingId || generateEntryId();
  const sessionId = nextOverviewSessionId(workspaceRoot);
  const now = new Date().toISOString();

  const references: { file: string; anchor: string; anchor_hash: string }[] = [];
  if (scope === 'file') {
    const firstLine = fs.readFileSync(absoluteTarget, 'utf-8').split('\n').find((l) => l.trim().length > 0) || target;
    references.push({ file: target, anchor: firstLine.trim(), anchor_hash: anchorHash(firstLine.trim()) });
  }

  const overviewEntry: GeneratedOverviewEntry = {
    id: entryId,
    title: parsed.title || `Overview: ${target}`,
    purpose: parsed.purpose,
    structure: parsed.structure,
    entry_points: parsed.entry_points,
    dependencies: parsed.dependencies,
    topics: parsed.topics || [],
    references,
    external_docs: parsed.external_docs || [],
    sources: [canonicalTarget],
    regenerated,
  };

  onProgress?.('Writing entry...');
  const sessionsDir = path.join(workspaceRoot, '.decodie', 'sessions');
  if (!fs.existsSync(sessionsDir)) {
    fs.mkdirSync(sessionsDir, { recursive: true });
  }

  const sessionFile: SessionFile = {
    session_id: sessionId,
    timestamp_start: now,
    timestamp_end: new Date().toISOString(),
    summary: `Overview of ${target}${regenerated ? ' (regenerated)' : ''}`,
    entries: [
      {
        id: entryId,
        title: overviewEntry.title,
        decision_type: 'overview',
        purpose: parsed.purpose,
        structure: parsed.structure,
        entry_points: parsed.entry_points,
        dependencies: parsed.dependencies,
      },
    ],
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

  const newIndexEntry: IndexEntry = {
    id: entryId,
    title: overviewEntry.title,
    experience_level: 'foundational',
    topics: overviewEntry.topics,
    decision_type: 'overview',
    session_id: sessionId,
    timestamp: now,
    lifecycle: 'active',
    references: overviewEntry.references,
    external_docs: overviewEntry.external_docs,
    cross_references: [],
    content_file: `sessions/${sessionId}.json`,
    superseded_by: null,
    sources: overviewEntry.sources,
  };

  if (regenerated) {
    const idx = index.entries.findIndex((e) => e.id === entryId);
    if (idx !== -1) {
      index.entries[idx] = newIndexEntry;
    } else {
      index.entries.unshift(newIndexEntry);
    }
  } else {
    index.entries.unshift(newIndexEntry);
  }

  const tmpPath = indexPath + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(index, null, 2) + '\n', 'utf-8');
  fs.renameSync(tmpPath, indexPath);

  return overviewEntry;
}
