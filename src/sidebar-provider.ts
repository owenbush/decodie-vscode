import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { marked } from 'marked';
import {
  DataParser,
  FullEntry,
  IndexEntry,
  SessionEntry,
  SessionFile,
} from '@owenbush/decodie-core';
import { DecorationManager } from './decoration-manager';
import { askQuestion, loadConversation, saveConversation, ConversationTurn } from './qa-engine';
import { ExplainResult } from './explain-engine';

/** Render markdown to HTML using marked */
function renderMarkdown(text: string): string {
  return marked.parse(text, { async: false, breaks: true }) as string;
}

export class SidebarProvider implements vscode.WebviewViewProvider {
  private _view?: vscode.WebviewView;
  private _parser: DataParser;
  private _debounceTimer: ReturnType<typeof setTimeout> | undefined;
  private _fileWatcher: vscode.FileSystemWatcher | undefined;
  private _disposables: vscode.Disposable[] = [];
  private _lastExplainResult: { result: ExplainResult; filePath: string } | null = null;

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly _workspaceRoot: string,
    private readonly _decorationManager?: DecorationManager,
  ) {
    this._parser = new DataParser(this._workspaceRoot);

    // Register editor change listener once (not per resolveWebviewView call)
    this._disposables.push(
      vscode.window.onDidChangeActiveTextEditor(() => this._onActiveEditorChanged()),
    );

    // File watcher registered once
    this._fileWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(this._workspaceRoot, '.decodie/**/*.json'),
    );
    this._fileWatcher.onDidChange(() => this._onDecodieDataChanged());
    this._fileWatcher.onDidCreate(() => this._onDecodieDataChanged());
    this._fileWatcher.onDidDelete(() => this._onDecodieDataChanged());
    this._disposables.push(this._fileWatcher);
  }

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ) {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri],
    };

    webviewView.webview.html = this._getHtml();

    webviewView.webview.onDidReceiveMessage((msg) => {
      this._handleWebviewMessage(msg);
    });

    // When the webview becomes visible, restore state
    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        this._restoreState();
      }
    });

    webviewView.onDidDispose(() => {
      this._view = undefined;
    });

    // Restore state after a short delay to let the webview script load
    setTimeout(() => this._restoreState(), 100);
  }

  public refresh(): void {
    this._parser.invalidateCache();
    this._updateForActiveEditor();
  }

  /** Restore the sidebar to its previous state (unsaved explain or file entries). */
  private _restoreState(): void {
    this._updateForActiveEditor();
    // If there's an unsaved explain result, re-show it
    if (this._lastExplainResult) {
      this._view?.webview.postMessage({
        type: 'showExplain',
        result: this._lastExplainResult.result,
        filePath: this._lastExplainResult.filePath,
      });
    }
  }

  /** Show a specific entry by ID in the Entry tab. */
  public showEntryById(entryId: string): void {
    try {
      this._parser.invalidateCache();
      const fullEntry = this._parser.getEntryWithContent(entryId);
      const savedConvo = loadConversation(this._workspaceRoot, entryId);
      const renderedConvo = savedConvo.map((turn) => ({
        ...turn,
        html: turn.role === 'assistant' ? renderMarkdown(turn.content) : undefined,
      }));
      this._view?.webview.postMessage({
        type: 'showEntry',
        entry: fullEntry,
        conversation: renderedConvo,
      });
    } catch (err) {
      console.error('Decodie: Failed to load entry', entryId, err);
    }
  }

  public refreshForFile(relativeFilePath: string): void {
    this._parser.invalidateCache();
    if (!this._view) {
      return;
    }

    const normalizedPath = relativeFilePath.split(path.sep).join('/');

    try {
      const index = this._parser.loadIndex();

      const matchingEntries = index.entries.filter((entry) =>
        entry.references.some((ref) =>
          ref.file.split(path.sep).join('/') === normalizedPath,
        ),
      );

      const fullEntries: FullEntry[] = matchingEntries.map((entry) => {
        try {
          return this._parser.getEntryWithContent(entry.id);
        } catch {
          return { ...entry, reference_resolutions: [] };
        }
      });

      const allEntries = index.entries.filter((e) => e.lifecycle === 'active');

      this._view.webview.postMessage({
        type: 'update',
        currentFile: normalizedPath,
        currentFileEntries: fullEntries,
        allEntries,
      });

      if (fullEntries.length > 0) {
        this._view.webview.postMessage({
          type: 'showEntry',
          entry: fullEntries[0],
        });
      }
    } catch {
      this._updateForActiveEditor();
    }
  }

  public showAnalyzing(filePath: string, detail?: string): void {
    // Send current data so All tab has entries while analyzing
    if (this._view) {
      try {
        const index = this._parser.loadIndex();
        const allEntries = index.entries.filter((e) => e.lifecycle === 'active');
        this._view.webview.postMessage({
          type: 'update',
          currentFile: filePath,
          currentFileEntries: [],
          allEntries,
        });
      } catch {
        // no index yet, that's fine
      }
    }
    this._view?.webview.postMessage({
      type: 'analyzing',
      filePath,
      detail: detail || 'Starting analysis...',
    });
  }

  public showError(message: string): void {
    this._view?.webview.postMessage({ type: 'error', message });
  }

  public showExplaining(filePath: string, detail?: string): void {
    this._view?.webview.postMessage({
      type: 'explaining',
      filePath,
      detail: detail || 'Starting explanation...',
    });
  }

  public showExplainResult(result: ExplainResult, filePath: string): void {
    this._lastExplainResult = { result, filePath };
    this._view?.webview.postMessage({
      type: 'showExplain',
      result,
      filePath,
    });
  }

  private _nextExplainSessionId(): string {
    const today = new Date().toISOString().slice(0, 10);
    const prefix = `explain-${today}-`;
    const sessionsDir = path.join(this._workspaceRoot, '.decodie', 'sessions');

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

  private _saveExplainAsEntry(result: ExplainResult, filePath: string): void {
    try {
      const sessionId = this._nextExplainSessionId();
      const sessionsDir = path.join(this._workspaceRoot, '.decodie', 'sessions');
      if (!fs.existsSync(sessionsDir)) {
        fs.mkdirSync(sessionsDir, { recursive: true });
      }

      const ts = Math.floor(Date.now() / 1000);
      const rand = crypto.randomBytes(2).toString('hex');
      const entryId = `entry-${ts}-${rand}`;
      const now = new Date().toISOString();

      const anchor = result.code_snippet.slice(0, 100);
      const anchorHash = crypto
        .createHash('sha256')
        .update(result.code_snippet)
        .digest('hex')
        .slice(0, 8);

      const sessionEntry: SessionEntry = {
        id: entryId,
        title: result.title,
        code_snippet: result.code_snippet,
        explanation: result.summary,
        alternatives_considered: '',
        key_concepts: result.key_concepts,
        breakdowns: result.breakdowns,
        issues: result.issues,
        improvements: result.improvements,
      };

      const sessionFile: SessionFile = {
        session_id: sessionId,
        timestamp_start: now,
        timestamp_end: now,
        summary: `Explanation of ${filePath}`,
        entries: [sessionEntry],
      };

      const sessionPath = path.join(sessionsDir, `${sessionId}.json`);
      const sessionTmp = sessionPath + '.tmp';
      fs.writeFileSync(sessionTmp, JSON.stringify(sessionFile, null, 2) + '\n', 'utf-8');
      fs.renameSync(sessionTmp, sessionPath);

      // Update index.json
      const indexPath = path.join(this._workspaceRoot, '.decodie', 'index.json');
      let index: { version: string; project: string; entries: IndexEntry[] };
      try {
        this._parser.invalidateCache();
        const loaded = this._parser.loadIndex();
        index = {
          version: loaded.version,
          project: loaded.project,
          entries: [...loaded.entries],
        };
      } catch {
        const projectName = path.basename(this._workspaceRoot);
        index = { version: '1.0', project: projectName, entries: [] };
      }

      const newIndexEntry: IndexEntry = {
        id: entryId,
        title: result.title,
        experience_level: result.experience_level,
        topics: result.topics,
        decision_type: 'explanation',
        session_id: sessionId,
        timestamp: now,
        lifecycle: 'active',
        references: [
          {
            file: filePath,
            anchor,
            anchor_hash: anchorHash,
          },
        ],
        external_docs: [],
        cross_references: [],
        content_file: `sessions/${sessionId}.json`,
        superseded_by: null,
      };

      index.entries.push(newIndexEntry);

      const indexTmp = indexPath + '.tmp';
      fs.writeFileSync(indexTmp, JSON.stringify(index, null, 2) + '\n', 'utf-8');
      fs.renameSync(indexTmp, indexPath);

      this._parser.invalidateCache();
      this.refreshForFile(filePath);
      vscode.window.showInformationMessage(`Decodie: Saved explanation as entry`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('Decodie: Failed to save explain entry', err);
      vscode.window.showErrorMessage(`Decodie: Failed to save entry: ${message}`);
    }
  }

  public getFileWatcherDisposable(): vscode.Disposable | undefined {
    return this._fileWatcher;
  }

  private _handleWebviewMessage(msg: {
    type: string;
    entryId?: string;
    file?: string;
    line?: number;
    question?: string;
    conversation?: ConversationTurn[];
    entry?: FullEntry;
    result?: ExplainResult;
    filePath?: string;
  }): void {
    if (msg.type === 'saveExplain' && msg.result && msg.filePath) {
      this._lastExplainResult = null; // Clear cache — it's now a persisted entry
      this._saveExplainAsEntry(msg.result, msg.filePath);
      return;
    }

    if (msg.type === 'openEntry') {
      if (msg.entryId) {
        try {
          this._parser.invalidateCache();
          const fullEntry = this._parser.getEntryWithContent(msg.entryId);

          // Load saved conversation and pre-render markdown
          const savedConvo = loadConversation(this._workspaceRoot, msg.entryId);
          const renderedConvo = savedConvo.map((turn) => ({
            ...turn,
            html: turn.role === 'assistant' ? renderMarkdown(turn.content) : undefined,
          }));

          this._view?.webview.postMessage({
            type: 'showEntry',
            entry: fullEntry,
            conversation: renderedConvo,
          });
        } catch (err) {
          console.error('Decodie: Failed to load entry', msg.entryId, err);
        }
      }

      if (msg.file) {
        const absPath = path.join(this._workspaceRoot, msg.file);
        const uri = vscode.Uri.file(absPath);
        const line = (msg.line && msg.line > 0) ? msg.line - 1 : 0;
        vscode.window.showTextDocument(uri, {
          selection: new vscode.Range(line, 0, line, 0),
          preserveFocus: true,
        });
      }
    }

    if (msg.type === 'askQuestion' && msg.entry && msg.question) {
      const entry = msg.entry;
      // Strip html field from conversation turns before sending to API
      const conversation: ConversationTurn[] = (msg.conversation || []).map((t) => ({
        role: t.role,
        content: t.content,
      }));

      let streamBuffer = '';

      askQuestion({
        entry,
        question: msg.question,
        conversation,
        workspaceRoot: this._workspaceRoot,
        onDelta: (text) => {
          streamBuffer += text;
          // Send pre-rendered markdown HTML on each delta
          this._view?.webview.postMessage({
            type: 'qaDelta',
            html: renderMarkdown(streamBuffer),
          });
        },
        onDone: () => {
          // Send final rendered HTML
          this._view?.webview.postMessage({
            type: 'qaDone',
            html: renderMarkdown(streamBuffer),
          });
        },
        onError: (error) => {
          this._view?.webview.postMessage({ type: 'qaError', error });
        },
      }).then((fullResponse) => {
        if (entry.id && fullResponse) {
          const updatedConvo: ConversationTurn[] = [
            ...conversation,
            { role: 'user', content: msg.question! },
            { role: 'assistant', content: fullResponse },
          ];
          saveConversation(this._workspaceRoot, entry.id, updatedConvo);
        }
      });
    }
  }

  private _onDecodieDataChanged(): void {
    this._parser.invalidateCache();
    this._debouncedUpdate();
  }

  private _onActiveEditorChanged(): void {
    this._debouncedUpdate();
  }

  private _debouncedUpdate(): void {
    if (this._debounceTimer) {
      clearTimeout(this._debounceTimer);
    }
    this._debounceTimer = setTimeout(() => {
      this._updateForActiveEditor();
    }, 300);
  }

  private _updateForActiveEditor(): void {
    if (!this._view) {
      return;
    }

    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      this._view.webview.postMessage({
        type: 'update',
        currentFile: null,
        currentFileEntries: [],
        allEntries: [],
      });
      return;
    }

    const filePath = editor.document.uri.fsPath;
    const relativePath = path.relative(this._workspaceRoot, filePath);
    const normalizedPath = relativePath.split(path.sep).join('/');

    try {
      const index = this._parser.loadIndex();

      const matchingEntries = index.entries.filter((entry) =>
        entry.references.some((ref) =>
          ref.file.split(path.sep).join('/') === normalizedPath,
        ),
      );

      const fullEntries: FullEntry[] = matchingEntries.map((entry) => {
        try {
          return this._parser.getEntryWithContent(entry.id);
        } catch {
          return { ...entry, reference_resolutions: [] };
        }
      });

      const allEntries = index.entries.filter((e) => e.lifecycle === 'active');

      this._decorationManager?.updateDecorations(editor, fullEntries);

      this._view.webview.postMessage({
        type: 'update',
        currentFile: normalizedPath,
        currentFileEntries: fullEntries,
        allEntries,
      });
    } catch {
      this._view.webview.postMessage({
        type: 'update',
        currentFile: null,
        currentFileEntries: [],
        allEntries: [],
      });
    }
  }

  private _getHtml(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
  font-family: var(--vscode-font-family);
  font-size: 14px;
  color: var(--vscode-editor-foreground);
  background: var(--vscode-sideBar-background);
}

/* Tabs */
.tabs {
  display: flex;
  border-bottom: 1px solid var(--vscode-panel-border);
  position: sticky; top: 0;
  background: var(--vscode-sideBar-background);
  z-index: 10;
}
.tab {
  flex: 1; padding: 8px 2px; text-align: center;
  font-size: 12px; font-weight: 500; cursor: pointer;
  border-bottom: 2px solid transparent; opacity: 0.6;
  transition: opacity 0.15s, border-color 0.15s;
}
.tab:hover { opacity: 0.9; }
.tab.active { opacity: 1; border-bottom-color: var(--vscode-focusBorder, #0786f7); }
.tab .count { font-size: 10px; opacity: 0.5; }

#content { padding: 8px; display: flex; flex-direction: column; gap: 10px; }

/* States */
.state-msg { text-align: center; opacity: 0.7; margin-top: 32px; padding: 0 12px; }
.state-msg p { margin-top: 6px; font-size: 13px; }
.spinner {
  display: inline-block; width: 20px; height: 20px;
  border: 2px solid var(--vscode-editor-foreground);
  border-top-color: transparent; border-radius: 50%;
  animation: spin 0.8s linear infinite; margin-bottom: 8px;
}
@keyframes spin { to { transform: rotate(360deg); } }
.error-msg { color: var(--vscode-errorForeground, #f05252); }

/* Filter bar */
.filter-toggle {
  font-size: 11px; cursor: pointer; opacity: 0.7; padding: 4px 0;
  user-select: none; display: flex; align-items: center; gap: 4px;
}
.filter-toggle:hover { opacity: 1; }
.filter-bar {
  display: none; flex-wrap: wrap; gap: 4px; padding: 4px 0 8px;
}
.filter-bar.open { display: flex; }
.filter-chip {
  font-size: 10px; padding: 2px 8px; border-radius: 10px; cursor: pointer;
  border: 1px solid var(--vscode-panel-border);
  background: transparent; color: var(--vscode-editor-foreground); opacity: 0.7;
  transition: all 0.15s;
}
.filter-chip:hover { opacity: 1; }
.filter-chip.active {
  background: var(--vscode-focusBorder, #0786f7); color: #fff;
  border-color: var(--vscode-focusBorder, #0786f7); opacity: 1;
}
.filter-section { width: 100%; font-size: 10px; opacity: 0.5; margin-top: 4px; }

/* List item */
.entry-list-item {
  border: 1px solid var(--vscode-panel-border); border-radius: 4px;
  padding: 8px 10px; background: var(--vscode-editor-background);
  cursor: pointer; transition: border-color 0.15s;
}
.entry-list-item:hover { border-color: var(--vscode-focusBorder, #0786f7); }
.entry-list-header { display: flex; align-items: center; gap: 6px; margin-bottom: 2px; }
.entry-list-title { font-weight: 600; font-size: 13px; line-height: 1.3; }
.entry-list-meta { font-size: 12px; opacity: 0.6; }
.entry-list-file {
  font-size: 11px; opacity: 0.4;
  font-family: var(--vscode-editor-font-family, monospace); margin-top: 2px;
}

/* Detail view */
.entry-detail { display: flex; flex-direction: column; gap: 10px; }
.back-link {
  font-size: 11px; cursor: pointer;
  color: var(--vscode-textLink-foreground); opacity: 0.8; padding: 4px 0;
}
.back-link:hover { opacity: 1; text-decoration: underline; }

.entry-card {
  border: 1px solid var(--vscode-panel-border); border-radius: 4px;
  padding: 10px; background: var(--vscode-editor-background);
}
.entry-header { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; }

.level-badge {
  font-size: 11px; font-weight: 600; text-transform: uppercase;
  padding: 2px 6px; border-radius: 3px; color: #000;
  white-space: nowrap; flex-shrink: 0;
}
.level-foundational { background: #34d399; }
.level-intermediate { background: #0786f7; color: #fff; }
.level-advanced { background: #a78bfa; }
.level-ecosystem { background: #fbbf24; }

.entry-title { font-weight: 600; font-size: 14px; line-height: 1.3; }
.entry-meta { font-size: 12px; opacity: 0.7; margin-bottom: 8px; }
.decision-type { font-style: italic; }

.entry-file-link {
  font-size: 10px; opacity: 0.5; margin-bottom: 4px;
  font-family: var(--vscode-editor-font-family, monospace);
  cursor: pointer; color: var(--vscode-textLink-foreground);
  display: flex; align-items: center; gap: 4px;
}
.entry-file-link:hover { opacity: 0.8; text-decoration: underline; }

/* Code block with syntax highlighting */
.code-block {
  background: var(--vscode-textCodeBlock-background);
  border-radius: 3px; padding: 8px; margin: 8px 0;
  overflow-x: auto; font-size: 12px;
}
.code-block pre { margin: 0; white-space: pre; }
.code-block code {
  font-family: var(--vscode-editor-font-family, monospace);
  font-size: var(--vscode-editor-font-size, 12px);
}
/* Syntax token colors */
.tok-kw { color: var(--vscode-symbolIcon-keywordForeground, #c586c0); }
.tok-str { color: var(--vscode-symbolIcon-stringForeground, #ce9178); }
.tok-num { color: var(--vscode-symbolIcon-numberForeground, #b5cea8); }
.tok-cm { color: var(--vscode-symbolIcon-commentForeground, #6a9955); font-style: italic; }
.tok-fn { color: var(--vscode-symbolIcon-functionForeground, #dcdcaa); }
.tok-ty { color: var(--vscode-symbolIcon-classForeground, #4ec9b0); }
.tok-op { opacity: 0.8; }
.tok-pn { opacity: 0.7; }

details { margin: 4px 0; }
details summary {
  cursor: pointer; font-size: 13px; font-weight: 600;
  padding: 4px 0; user-select: none; opacity: 0.9;
}
details summary:hover { opacity: 1; }
details .section-content {
  font-size: 13px; line-height: 1.5;
  padding: 4px 0 4px 12px;
  white-space: pre-wrap; word-wrap: break-word;
}

.key-concepts { display: flex; flex-wrap: wrap; gap: 4px; padding: 4px 0 4px 12px; }
.concept-tag {
  font-size: 11px; background: var(--vscode-badge-background);
  color: var(--vscode-badge-foreground); padding: 2px 6px; border-radius: 3px;
}

.external-docs { margin-top: 6px; font-size: 13px; }
.external-docs a { color: var(--vscode-textLink-foreground); text-decoration: none; }
.external-docs a:hover { text-decoration: underline; }
.doc-link { display: block; padding: 2px 0; }

.ref-status { margin-top: 6px; font-size: 12px; display: flex; flex-direction: column; gap: 2px; }
.ref-line { display: flex; align-items: center; gap: 6px; }
.status-dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; flex-shrink: 0; }
.status-resolved { background: #34d399; }
.status-drifted { background: #fbbf24; }
.status-fuzzy { background: #fb923c; }
.status-stale { background: #f05252; }

/* Q&A */
.qa-section { margin-top: 12px; border-top: 1px solid var(--vscode-panel-border); padding-top: 10px; }
.qa-header { font-size: 13px; font-weight: 600; margin-bottom: 8px; }
.qa-conversation { display: flex; flex-direction: column; gap: 8px; margin-bottom: 10px; }
.qa-msg { font-size: 13px; line-height: 1.5; padding: 8px 10px; border-radius: 6px; white-space: pre-wrap; word-wrap: break-word; }
.qa-user { background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); }
.qa-assistant { background: var(--vscode-textCodeBlock-background); }
.qa-streaming { opacity: 0.8; }
.qa-streaming::after { content: '\\25CF'; animation: blink 1s infinite; margin-left: 2px; }
@keyframes blink { 50% { opacity: 0; } }
.qa-input-row { display: flex; gap: 6px; }
.qa-input {
  flex: 1; padding: 6px 8px; font-size: 13px;
  font-family: var(--vscode-font-family);
  background: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
  border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
  border-radius: 4px; outline: none; resize: none;
  min-height: 32px; max-height: 120px;
}
.qa-input:focus { border-color: var(--vscode-focusBorder, #0786f7); }
.qa-send {
  padding: 6px 12px; font-size: 12px; font-weight: 500; cursor: pointer;
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
  border: none; border-radius: 4px;
  align-self: flex-end;
}
.qa-send:hover { background: var(--vscode-button-hoverBackground); }
.qa-send:disabled { opacity: 0.5; cursor: default; }
.qa-error { color: var(--vscode-errorForeground, #f05252); font-size: 12px; margin-top: 4px; }
.qa-msg code {
  font-family: var(--vscode-editor-font-family, monospace);
  background: var(--vscode-textCodeBlock-background);
  padding: 1px 4px; border-radius: 3px; font-size: 12px;
}
.qa-msg pre { margin: 6px 0; overflow-x: auto; }
.qa-msg pre code { display: block; padding: 8px; background: var(--vscode-textCodeBlock-background); border-radius: 3px; }
.qa-msg p { margin: 4px 0; }
.qa-msg ul, .qa-msg ol { margin: 4px 0; padding-left: 20px; }
.qa-msg li { margin: 2px 0; }
.qa-msg h1, .qa-msg h2, .qa-msg h3, .qa-msg h4 { margin: 8px 0 4px; font-size: 13px; }
.qa-msg strong { font-weight: 600; }
.qa-msg em { font-style: italic; }
.qa-msg a { color: var(--vscode-textLink-foreground); }

/* Explain layout */
.explain-header {
  display: flex; gap: 8px; align-items: center;
  margin-bottom: 10px;
}
.explain-save-btn {
  padding: 6px 12px; font-size: 12px; font-weight: 500; cursor: pointer;
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
  border: none; border-radius: 4px;
}
.explain-save-btn:hover { background: var(--vscode-button-hoverBackground); }
.explain-save-btn:disabled { opacity: 0.5; cursor: default; }
.explain-summary {
  font-size: 13px; line-height: 1.5;
  padding: 10px; border-radius: 4px;
  background: var(--vscode-textCodeBlock-background);
  margin-bottom: 12px;
}
.breakdown-card {
  border: 1px solid var(--vscode-panel-border);
  border-radius: 4px; padding: 10px; margin: 8px 0;
  background: var(--vscode-editor-background);
}
.breakdown-pattern {
  display: inline-block; font-size: 10px; text-transform: uppercase;
  padding: 2px 6px; border-radius: 3px;
  background: rgba(7,134,247,0.15); color: var(--vscode-textLink-foreground);
  margin-bottom: 6px;
}
.breakdown-explanation { font-size: 12px; margin-top: 6px; line-height: 1.5; }
.issue-item, .improvement-item {
  padding: 8px 10px; margin: 6px 0;
  border: 1px solid var(--vscode-panel-border); border-radius: 4px;
  background: var(--vscode-editor-background);
}
.severity-badge {
  display: inline-block; font-size: 10px; font-weight: 600;
  text-transform: uppercase; padding: 2px 6px; border-radius: 3px;
  margin-right: 6px; color: #000;
}
.severity-info { background: #0786f7; color: #fff; }
.severity-warning { background: #fbbf24; }
.severity-error { background: #f05252; color: #fff; }
.issue-description, .improvement-description { font-size: 12px; font-weight: 500; }
.issue-suggestion, .improvement-rationale {
  font-size: 12px; opacity: 0.8; margin-top: 4px; font-style: italic;
}
.section-title {
  font-size: 12px; font-weight: 600; text-transform: uppercase;
  letter-spacing: 0.05em; opacity: 0.7; margin: 16px 0 8px;
}
</style>
</head>
<body>
<div class="tabs">
  <div class="tab active" data-tab="current" id="tabCurrent">File <span class="count" id="countCurrent"></span></div>
  <div class="tab" data-tab="all" id="tabAll">All <span class="count" id="countAll"></span></div>
  <div class="tab" data-tab="entry" id="tabEntry" style="display:none">Entry</div>
</div>
<div id="content">
  <div class="state-msg"><p>Open a file to see related entries.</p></div>
</div>

<script>
var vscode = acquireVsCodeApi();
var content = document.getElementById('content');
var tabCurrent = document.getElementById('tabCurrent');
var tabAll = document.getElementById('tabAll');
var tabEntry = document.getElementById('tabEntry');
var countCurrent = document.getElementById('countCurrent');
var countAll = document.getElementById('countAll');

var activeTab = 'current';
var previousTab = 'current';
var state = { currentFile: null, currentFileEntries: [], allEntries: [] };
var currentEntry = null;
var currentExplain = null; // { result, filePath } or null
var explaining = null; // { filePath, detail } while loading
var analyzing = null; // { filePath, detail } or null
var filters = { level: null, type: null, topic: null };
var qaConversation = []; // [{role, content, html?}]
var qaStreaming = false;
var qaStreamHtml = '';

tabCurrent.addEventListener('click', function() { setTab('current'); });
tabAll.addEventListener('click', function() { setTab('all'); });
tabEntry.addEventListener('click', function() { if (currentEntry || currentExplain || explaining) setTab('entry'); });

function setTab(tab) {
  if (tab !== 'entry') previousTab = activeTab !== 'entry' ? activeTab : previousTab;
  activeTab = tab;
  tabCurrent.className = 'tab' + (tab === 'current' ? ' active' : '');
  tabAll.className = 'tab' + (tab === 'all' ? ' active' : '');
  tabEntry.className = 'tab' + (tab === 'entry' ? ' active' : '');
  render();
}

function render() {
  if (activeTab === 'entry') {
    if (explaining && !currentExplain) {
      content.innerHTML = '<div class="state-msg"><div class="spinner"></div>' +
        '<p>Explaining ' + esc(explaining.filePath) + '</p>' +
        '<p>' + esc(explaining.detail || '') + '</p></div>';
      return;
    }
    if (currentExplain) {
      renderExplain();
      return;
    }
    if (currentEntry) {
      renderEntryDetail(currentEntry);
      return;
    }
    content.innerHTML = '<div class="state-msg"><p>Nothing to show.</p></div>';
    return;
  }
  if (activeTab === 'current') {
    renderCurrentFile();
  } else {
    renderAllEntries();
  }
}

function renderExplain() {
  var r = currentExplain.result;
  var fp = currentExplain.filePath;

  var summaryHtml = '<div class="explain-summary">' + esc(r.summary) + '</div>';

  var codeHtml = r.code_snippet
    ? '<div class="code-block"><pre><code>' + highlight(r.code_snippet) + '</code></pre></div>'
    : '';

  var breakdownsHtml = '';
  if (r.breakdowns && r.breakdowns.length > 0) {
    breakdownsHtml = '<div class="section-title">Breakdown</div>' +
      r.breakdowns.map(function(b) {
        var patternBadge = b.pattern
          ? '<div class="breakdown-pattern">' + esc(b.pattern) + '</div>'
          : '';
        var excerpt = b.code_excerpt
          ? '<div class="code-block"><pre><code>' + highlight(b.code_excerpt) + '</code></pre></div>'
          : '';
        return '<div class="breakdown-card">' + patternBadge + excerpt +
          '<div class="breakdown-explanation">' + esc(b.explanation) + '</div></div>';
      }).join('');
  }

  var issuesHtml = '';
  if (r.issues && r.issues.length > 0) {
    issuesHtml = '<div class="section-title">Issues</div>' +
      r.issues.map(function(i) {
        var sev = i.severity || 'info';
        var suggestion = i.suggestion
          ? '<div class="issue-suggestion">' + esc(i.suggestion) + '</div>'
          : '';
        return '<div class="issue-item">' +
          '<span class="severity-badge severity-' + esc(sev) + '">' + esc(sev) + '</span>' +
          '<span class="issue-description">' + esc(i.description) + '</span>' +
          suggestion + '</div>';
      }).join('');
  }

  var improvementsHtml = '';
  if (r.improvements && r.improvements.length > 0) {
    improvementsHtml = '<div class="section-title">Improvements</div>' +
      r.improvements.map(function(im) {
        var rationale = im.rationale
          ? '<div class="improvement-rationale">' + esc(im.rationale) + '</div>'
          : '';
        return '<div class="improvement-item">' +
          '<div class="improvement-description">' + esc(im.description) + '</div>' +
          rationale + '</div>';
      }).join('');
  }

  var conceptsHtml = '';
  if (r.key_concepts && r.key_concepts.length > 0) {
    conceptsHtml = '<div class="section-title">Key Concepts</div>' +
      '<div class="key-concepts">' +
      r.key_concepts.map(function(c) {
        return '<span class="concept-tag">' + esc(c) + '</span>';
      }).join('') + '</div>';
  }

  var lc = 'level-' + (r.experience_level || 'intermediate');
  var ll = r.experience_level || 'intermediate';

  content.innerHTML = '<div class="entry-detail">' +
    '<div class="explain-header">' +
      '<button class="explain-save-btn" id="explainSaveBtn">Save as entry</button>' +
      '<span class="level-badge ' + lc + '">' + esc(ll) + '</span>' +
      '<span class="entry-title">' + esc(r.title) + '</span>' +
    '</div>' +
    '<div class="entry-file-link" data-file="' + esc(fp) + '" data-line="0">' + esc(fp) + '</div>' +
    summaryHtml +
    codeHtml +
    breakdownsHtml +
    issuesHtml +
    improvementsHtml +
    conceptsHtml +
    '</div>';

  var saveBtn = document.getElementById('explainSaveBtn');
  if (saveBtn) {
    saveBtn.addEventListener('click', function() {
      saveBtn.disabled = true;
      saveBtn.textContent = 'Saving...';
      vscode.postMessage({
        type: 'saveExplain',
        result: currentExplain.result,
        filePath: currentExplain.filePath,
      });
    });
  }

  content.querySelectorAll('.entry-file-link').forEach(function(el) {
    el.addEventListener('click', function() {
      var f = el.getAttribute('data-file');
      var l = parseInt(el.getAttribute('data-line') || '0', 10);
      vscode.postMessage({ type: 'openEntry', file: f, line: l });
    });
  });
}

function renderCurrentFile() {
  // Show analyzing banner if active
  var html = '';
  if (analyzing) {
    html += '<div class="state-msg"><div class="spinner"></div>' +
      '<p>Analyzing ' + esc(analyzing.filePath) + '</p>' +
      '<p>' + esc(analyzing.detail) + '</p></div>';
  }

  if (state.currentFileEntries.length === 0 && !analyzing) {
    var msg = state.currentFile
      ? 'No entries for ' + esc(state.currentFile)
      : 'Open a file to see related entries.';
    content.innerHTML = '<div class="state-msg"><p>' + msg + '</p></div>';
    return;
  }

  if (state.currentFileEntries.length > 0) {
    html += state.currentFileEntries.map(function(e) { return renderListItem(e); }).join('');
  }
  content.innerHTML = html;
  attachClickHandlers();
}

function renderAllEntries() {
  if (state.allEntries.length === 0) {
    content.innerHTML = '<div class="state-msg"><p>No entries in this project.</p></div>';
    return;
  }

  var filtered = applyFilters(state.allEntries);
  var allTopics = collectTopics(state.allEntries);
  var allLevels = collectValues(state.allEntries, 'experience_level');
  var allTypes = collectValues(state.allEntries, 'decision_type');

  var filterHtml = '<div class="filter-toggle" id="filterToggle">&#9662; Filters</div>' +
    '<div class="filter-bar" id="filterBar">';

  if (allLevels.length > 1) {
    filterHtml += '<div class="filter-section">Level</div>';
    filterHtml += allLevels.map(function(l) {
      return '<span class="filter-chip' + (filters.level === l ? ' active' : '') +
        '" data-filter="level" data-value="' + esc(l) + '">' + esc(l) + '</span>';
    }).join('');
  }
  if (allTypes.length > 1) {
    filterHtml += '<div class="filter-section">Type</div>';
    filterHtml += allTypes.map(function(t) {
      return '<span class="filter-chip' + (filters.type === t ? ' active' : '') +
        '" data-filter="type" data-value="' + esc(t) + '">' + esc(t) + '</span>';
    }).join('');
  }
  if (allTopics.length > 0) {
    filterHtml += '<div class="filter-section">Topic</div>';
    filterHtml += allTopics.slice(0, 20).map(function(t) {
      return '<span class="filter-chip' + (filters.topic === t ? ' active' : '') +
        '" data-filter="topic" data-value="' + esc(t) + '">' + esc(t) + '</span>';
    }).join('');
  }
  filterHtml += '</div>';

  var listHtml = filtered.map(function(e) { return renderListItem(e); }).join('');
  if (filtered.length === 0) {
    listHtml = '<div class="state-msg"><p>No entries match filters.</p></div>';
  }

  content.innerHTML = filterHtml + listHtml;

  // Filter toggle
  document.getElementById('filterToggle').addEventListener('click', function() {
    var bar = document.getElementById('filterBar');
    bar.classList.toggle('open');
    this.innerHTML = (bar.classList.contains('open') ? '&#9652;' : '&#9662;') + ' Filters';
  });

  // Filter chips
  content.querySelectorAll('.filter-chip').forEach(function(chip) {
    chip.addEventListener('click', function() {
      var key = chip.getAttribute('data-filter');
      var val = chip.getAttribute('data-value');
      if (filters[key] === val) {
        filters[key] = null;
      } else {
        filters[key] = val;
      }
      render();
    });
  });

  attachClickHandlers();
}

function applyFilters(entries) {
  return entries.filter(function(e) {
    if (filters.level && e.experience_level !== filters.level) return false;
    if (filters.type && e.decision_type !== filters.type) return false;
    if (filters.topic && (!e.topics || e.topics.indexOf(filters.topic) === -1)) return false;
    return true;
  });
}

function collectTopics(entries) {
  var counts = {};
  entries.forEach(function(e) {
    (e.topics || []).forEach(function(t) { counts[t] = (counts[t] || 0) + 1; });
  });
  return Object.keys(counts).sort(function(a, b) { return counts[b] - counts[a]; });
}

function collectValues(entries, key) {
  var seen = {};
  entries.forEach(function(e) { if (e[key]) seen[e[key]] = true; });
  return Object.keys(seen).sort();
}

function attachClickHandlers() {
  content.querySelectorAll('.entry-list-item').forEach(function(item) {
    item.addEventListener('click', function() {
      var id = item.getAttribute('data-id');
      var file = item.getAttribute('data-file');
      var line = parseInt(item.getAttribute('data-line') || '0', 10);
      vscode.postMessage({ type: 'openEntry', entryId: id, file: file, line: line });
    });
  });
}

function esc(str) {
  if (!str) return '';
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

/* Simple syntax highlighter — uses RegExp() strings to avoid issues with
   forward slashes in regex literals inside inline script tags */
function highlight(code) {
  if (!code) return '';
  var h = esc(code);
  var CM = '<span class="tok-cm">$1<\\/span>';
  var STR = '<span class="tok-str">$1<\\/span>';
  var NUM = '<span class="tok-num">$1<\\/span>';
  var KW = '<span class="tok-kw">$1<\\/span>';
  var TY = '<span class="tok-ty">$1<\\/span>';
  var FN = '<span class="tok-fn">$1<\\/span>';
  // Use hex escapes to avoid template literal + esbuild escaping issues
  // \\x5c = backslash in the output string
  var B = '\\x5cb'; // word boundary
  var D = '\\x5cd'; // digit
  var W = '\\x5cw'; // word char
  var S = '\\x5cs'; // whitespace
  // Line comments
  h = h.replace(new RegExp('(\\/\\/.*$|#.*$)', 'gm'), CM);
  // Numbers
  h = h.replace(new RegExp(B + '(' + D + '+' + '\\x5c.?' + D + '*)' + B, 'g'), NUM);
  // Strings (HTML-escaped quotes)
  h = h.replace(new RegExp('(&quot;(?:[^&]|&(?!quot;))*?&quot;)', 'g'), STR);
  // Keywords
  var kws = 'const|let|var|function|class|interface|type|enum|import|export|from|return|if|else|for|while|do|switch|case|break|continue|new|this|super|extends|implements|async|await|yield|throw|try|catch|finally|typeof|instanceof|in|of|void|null|undefined|true|false|default|static|public|private|protected|readonly|abstract|declare|module|namespace|require|def|self|lambda|raise|except|pass|with|as|elif|print|None|True|False';
  h = h.replace(new RegExp(B + '(' + kws + ')' + B, 'g'), KW);
  // Types (PascalCase)
  h = h.replace(new RegExp(B + '([A-Z][a-zA-Z0-9]+)' + B, 'g'), TY);
  // Function calls
  h = h.replace(new RegExp(B + '([a-zA-Z_]' + W + '*)' + S + '*(?=\\x5c\\x28)', 'g'), FN);
  return h;
}

function renderListItem(entry) {
  var lc = 'level-' + (entry.experience_level || 'intermediate');
  var ll = entry.experience_level || 'intermediate';
  var dt = entry.decision_type || '';
  var topics = (entry.topics && entry.topics.length > 0)
    ? ' &middot; ' + entry.topics.slice(0, 3).map(esc).join(', ') : '';

  var file = '';
  var filePath = '';
  var line = 0;
  if (entry.references && entry.references.length > 0) {
    filePath = entry.references[0].file || '';
    file = '<div class="entry-list-file">' + esc(filePath) + '</div>';
  }
  if (entry.reference_resolutions && entry.reference_resolutions.length > 0) {
    var res = entry.reference_resolutions[0];
    if (res.resolved_line) line = res.resolved_line;
    if (res.resolved_file) filePath = res.resolved_file;
  }

  return '<div class="entry-list-item" data-id="' + esc(entry.id) + '" data-file="' + esc(filePath) + '" data-line="' + line + '">' +
    '<div class="entry-list-header"><span class="level-badge ' + lc + '">' + esc(ll) + '</span>' +
    '<span class="entry-list-title">' + esc(entry.title) + '</span></div>' +
    '<div class="entry-list-meta"><span class="decision-type">' + esc(dt) + '</span>' + topics + '</div>' +
    file + '</div>';
}

function renderEntryDetail(entry) {
  var lc = 'level-' + (entry.experience_level || 'intermediate');
  var ll = entry.experience_level || 'intermediate';
  var topics = (entry.topics && entry.topics.length > 0)
    ? ' &middot; ' + entry.topics.map(esc).join(', ') : '';

  var fileLinks = '';
  if (entry.reference_resolutions && entry.reference_resolutions.length > 0) {
    fileLinks = entry.reference_resolutions.map(function(r) {
      var loc = r.resolved_file || r.reference.file;
      var line = r.resolved_line || 0;
      var label = loc + (line ? ':' + line : '');
      return '<div class="entry-file-link" data-file="' + esc(loc) + '" data-line="' + line + '">' +
        '<span class="status-dot status-' + r.status + '"></span> ' + esc(label) + '</div>';
    }).join('');
  } else if (entry.references && entry.references.length > 0) {
    fileLinks = entry.references.map(function(ref) {
      return '<div class="entry-file-link" data-file="' + esc(ref.file) + '" data-line="0">' + esc(ref.file) + '</div>';
    }).join('');
  }

  var code = entry.code_snippet
    ? '<div class="code-block"><pre><code>' + highlight(entry.code_snippet) + '</code></pre></div>' : '';

  var explanation = entry.explanation
    ? '<details open><summary>Explanation</summary><div class="section-content">' + esc(entry.explanation) + '</div></details>' : '';

  var alternatives = entry.alternatives_considered
    ? '<details><summary>Alternatives</summary><div class="section-content">' + esc(entry.alternatives_considered) + '</div></details>' : '';

  var concepts = '';
  if (entry.key_concepts && entry.key_concepts.length > 0) {
    concepts = '<details open><summary>Key Concepts</summary><div class="key-concepts">' +
      entry.key_concepts.map(function(c) { return '<span class="concept-tag">' + esc(c) + '</span>'; }).join('') +
      '</div></details>';
  }

  var docs = '';
  if (entry.external_docs && entry.external_docs.length > 0) {
    docs = '<div class="external-docs">' +
      entry.external_docs.map(function(d) {
        return '<span class="doc-link">&#x1F4CE; <a href="' + esc(d.url) + '">' + esc(d.label) + '</a></span>';
      }).join('') + '</div>';
  }

  // Build conversation HTML
  var convoHtml = '';
  if (qaConversation.length > 0) {
    convoHtml = qaConversation.map(function(turn) {
      var cls = turn.role === 'user' ? 'qa-user' : 'qa-assistant';
      var body = turn.html || esc(turn.content);
      return '<div class="qa-msg ' + cls + '">' + body + '</div>';
    }).join('');
  }

  // Streaming response
  var streamHtml = '';
  if (qaStreaming) {
    streamHtml = '<div class="qa-msg qa-assistant qa-streaming" id="qaStream">' + (qaStreamHtml || '') + '</div>';
  }

  var qaSection = '<div class="qa-section">' +
    '<div class="qa-header">Ask about this entry</div>' +
    '<div class="qa-conversation" id="qaConvo">' + convoHtml + streamHtml + '</div>' +
    '<div class="qa-input-row">' +
      '<textarea class="qa-input" id="qaInput" placeholder="Ask a question..." rows="1"' +
        (qaStreaming ? ' disabled' : '') + '></textarea>' +
      '<button class="qa-send" id="qaSend"' + (qaStreaming ? ' disabled' : '') + '>Ask</button>' +
    '</div>' +
    '<div class="qa-error" id="qaError"></div>' +
  '</div>';

  content.innerHTML = '<div class="entry-detail">' +
    '<div class="back-link" id="backLink">&larr; Back</div>' +
    '<div class="entry-card">' +
      '<div class="entry-header"><span class="level-badge ' + lc + '">' + esc(ll) + '</span>' +
      '<span class="entry-title">' + esc(entry.title) + '</span></div>' +
      '<div class="entry-meta"><span class="decision-type">' + esc(entry.decision_type || '') + '</span>' + topics + '</div>' +
      fileLinks + code + explanation + alternatives + concepts + docs +
    '</div>' +
    qaSection +
  '</div>';

  document.getElementById('backLink').addEventListener('click', function() {
    setTab(previousTab);
  });

  // File link clicks
  content.querySelectorAll('.entry-file-link').forEach(function(el) {
    el.addEventListener('click', function() {
      var f = el.getAttribute('data-file');
      var l = parseInt(el.getAttribute('data-line') || '0', 10);
      vscode.postMessage({ type: 'openEntry', file: f, line: l });
    });
  });

  // Q&A input
  var qaInput = document.getElementById('qaInput');
  var qaSend = document.getElementById('qaSend');

  function sendQuestion() {
    var q = qaInput.value.trim();
    if (!q || qaStreaming) return;
    qaInput.value = '';
    qaStreaming = true;
    qaStreamHtml = '';
    vscode.postMessage({
      type: 'askQuestion',
      entry: currentEntry,
      question: q,
      conversation: qaConversation,
    });
    // Add user message immediately and re-render
    qaConversation.push({ role: 'user', content: q });
    render();
    // Scroll to bottom
    var convoEl = document.getElementById('qaConvo');
    if (convoEl) convoEl.scrollTop = convoEl.scrollHeight;
  }

  if (qaSend) {
    qaSend.addEventListener('click', sendQuestion);
  }
  if (qaInput) {
    qaInput.addEventListener('keydown', function(e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendQuestion();
      }
    });
    // Auto-resize
    qaInput.addEventListener('input', function() {
      qaInput.style.height = 'auto';
      qaInput.style.height = Math.min(qaInput.scrollHeight, 120) + 'px';
    });
    // Focus the input
    if (!qaStreaming) qaInput.focus();
  }
}

window.addEventListener('message', function(event) {
  var msg = event.data;
  switch (msg.type) {
    case 'update':
      state = {
        currentFile: msg.currentFile,
        currentFileEntries: msg.currentFileEntries || [],
        allEntries: msg.allEntries || [],
      };
      countCurrent.textContent = state.currentFileEntries.length > 0 ? '(' + state.currentFileEntries.length + ')' : '';
      countAll.textContent = state.allEntries.length > 0 ? '(' + state.allEntries.length + ')' : '';
      // Clear analyzing state when update arrives (analysis done or file changed)
      if (msg.currentFileEntries && msg.currentFileEntries.length > 0) {
        analyzing = null;
      }
      if (activeTab !== 'entry') render();
      break;
    case 'showEntry':
      currentEntry = msg.entry;
      currentExplain = null;
      explaining = null;
      qaConversation = msg.conversation || [];
      qaStreaming = false;
      qaStreamHtml = '';
      tabEntry.style.display = '';
      setTab('entry');
      break;
    case 'explaining':
      explaining = { filePath: msg.filePath, detail: msg.detail };
      currentExplain = null;
      tabEntry.style.display = '';
      setTab('entry');
      break;
    case 'showExplain':
      currentExplain = { result: msg.result, filePath: msg.filePath };
      explaining = null;
      tabEntry.style.display = '';
      setTab('entry');
      break;
    case 'qaDelta':
      qaStreamHtml = msg.html || '';
      var streamEl = document.getElementById('qaStream');
      if (streamEl) {
        streamEl.innerHTML = qaStreamHtml;
        var convoEl2 = document.getElementById('qaConvo');
        if (convoEl2) convoEl2.scrollTop = convoEl2.scrollHeight;
      } else {
        render();
      }
      break;
    case 'qaDone':
      if (msg.html) {
        qaConversation.push({ role: 'assistant', content: '', html: msg.html });
      }
      qaStreaming = false;
      qaStreamHtml = '';
      render();
      break;
    case 'qaError':
      qaStreaming = false;
      qaStreamHtml = '';
      render();
      var errEl = document.getElementById('qaError');
      if (errEl) errEl.textContent = msg.error || 'Failed to get response';
      break;
    case 'analyzing':
      analyzing = { filePath: msg.filePath, detail: msg.detail };
      // Show status regardless of current tab
      if (activeTab === 'current') render();
      break;
    case 'error':
      analyzing = null;
      content.innerHTML = '<div class="state-msg error-msg"><p>Error: ' + esc(msg.message) + '</p></div>';
      break;
  }
});
</script>
</body>
</html>`;
  }
}
