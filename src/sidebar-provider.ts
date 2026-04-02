import * as vscode from 'vscode';
import * as path from 'path';
import { DataParser, FullEntry } from '@owenbush/decodie-core';
import { DecorationManager } from './decoration-manager';

export class SidebarProvider implements vscode.WebviewViewProvider {
  private _view?: vscode.WebviewView;
  private _parser: DataParser;
  private _debounceTimer: ReturnType<typeof setTimeout> | undefined;
  private _fileWatcher: vscode.FileSystemWatcher | undefined;

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly _workspaceRoot: string,
    private readonly _decorationManager?: DecorationManager,
  ) {
    this._parser = new DataParser(this._workspaceRoot);
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

    vscode.window.onDidChangeActiveTextEditor(
      () => this._onActiveEditorChanged(),
      null,
    );

    this._fileWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(this._workspaceRoot, '.decodie/**/*.json'),
    );

    this._fileWatcher.onDidChange(() => this._onDecodieDataChanged());
    this._fileWatcher.onDidCreate(() => this._onDecodieDataChanged());
    this._fileWatcher.onDidDelete(() => this._onDecodieDataChanged());

    this._onActiveEditorChanged();

    webviewView.onDidDispose(() => {
      this._fileWatcher?.dispose();
    });
  }

  public refresh(): void {
    this._parser.invalidateCache();
    this._updateForActiveEditor();
  }

  /** Refresh and show entries for a specific file (e.g. after analysis). */
  public refreshForFile(relativeFilePath: string): void {
    this._parser.invalidateCache();
    if (!this._view) {
      return;
    }

    const normalizedPath = relativeFilePath.split(path.sep).join('/');

    try {
      const index = this._parser.loadIndex();

      const matchingEntries = index.entries.filter((entry) =>
        entry.references.some((ref) => {
          const normalizedRef = ref.file.split(path.sep).join('/');
          return normalizedRef === normalizedPath;
        }),
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
    } catch {
      this._updateForActiveEditor();
    }
  }

  public showAnalyzing(filePath: string, detail?: string): void {
    this._view?.webview.postMessage({
      type: 'analyzing',
      filePath,
      detail: detail || 'Starting analysis...',
    });
  }

  public showError(message: string): void {
    this._view?.webview.postMessage({ type: 'error', message });
  }

  public getFileWatcherDisposable(): vscode.Disposable | undefined {
    return this._fileWatcher;
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
        entry.references.some((ref) => {
          const normalizedRef = ref.file.split(path.sep).join('/');
          return normalizedRef === normalizedPath;
        }),
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
      font-size: var(--vscode-font-size, 13px);
      color: var(--vscode-editor-foreground);
      background: var(--vscode-sideBar-background);
    }

    /* Tabs */
    .tabs {
      display: flex;
      border-bottom: 1px solid var(--vscode-panel-border);
      position: sticky;
      top: 0;
      background: var(--vscode-sideBar-background);
      z-index: 10;
    }

    .tab {
      flex: 1;
      padding: 8px 4px;
      text-align: center;
      font-size: 12px;
      font-weight: 500;
      cursor: pointer;
      border-bottom: 2px solid transparent;
      opacity: 0.7;
      transition: opacity 0.15s, border-color 0.15s;
    }

    .tab:hover { opacity: 0.9; }

    .tab.active {
      opacity: 1;
      border-bottom-color: var(--vscode-focusBorder, #0786f7);
    }

    .tab .count {
      font-size: 10px;
      opacity: 0.6;
      margin-left: 4px;
    }

    #content {
      padding: 8px;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }

    /* States */
    .state-msg {
      text-align: center;
      opacity: 0.7;
      margin-top: 32px;
      padding: 0 12px;
    }

    .state-msg p { margin-top: 6px; font-size: 12px; }

    .spinner {
      display: inline-block;
      width: 20px; height: 20px;
      border: 2px solid var(--vscode-editor-foreground);
      border-top-color: transparent;
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
      margin-bottom: 8px;
    }

    @keyframes spin { to { transform: rotate(360deg); } }

    .error-msg { color: var(--vscode-errorForeground, #f05252); }

    /* Entry card */
    .entry-card {
      border: 1px solid var(--vscode-panel-border);
      border-radius: 4px;
      padding: 10px;
      background: var(--vscode-editor-background);
    }

    .entry-header {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 4px;
    }

    .level-badge {
      font-size: 10px;
      font-weight: 600;
      text-transform: uppercase;
      padding: 2px 6px;
      border-radius: 3px;
      color: #000;
      white-space: nowrap;
      flex-shrink: 0;
    }

    .level-foundational { background: #34d399; }
    .level-intermediate { background: #0786f7; color: #fff; }
    .level-advanced { background: #a78bfa; }
    .level-ecosystem { background: #fbbf24; }

    .entry-title { font-weight: 600; font-size: 13px; line-height: 1.3; }

    .entry-meta { font-size: 11px; opacity: 0.7; margin-bottom: 8px; }
    .decision-type { font-style: italic; }

    .entry-file {
      font-size: 10px;
      opacity: 0.5;
      margin-bottom: 4px;
      font-family: var(--vscode-editor-font-family, monospace);
    }

    .code-block {
      background: var(--vscode-textCodeBlock-background);
      border-radius: 3px;
      padding: 8px;
      margin: 8px 0;
      overflow-x: auto;
      font-size: 12px;
    }

    .code-block pre { margin: 0; white-space: pre; }
    .code-block code {
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: var(--vscode-editor-font-size, 12px);
    }

    details { margin: 4px 0; }
    details summary {
      cursor: pointer; font-size: 12px; font-weight: 600;
      padding: 4px 0; user-select: none; opacity: 0.9;
    }
    details summary:hover { opacity: 1; }
    details .section-content {
      font-size: 12px; line-height: 1.5;
      padding: 4px 0 4px 12px;
      white-space: pre-wrap; word-wrap: break-word;
    }

    .key-concepts { display: flex; flex-wrap: wrap; gap: 4px; padding: 4px 0 4px 12px; }
    .concept-tag {
      font-size: 10px;
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
      padding: 2px 6px; border-radius: 3px;
    }

    .external-docs { margin-top: 6px; font-size: 12px; }
    .external-docs a { color: var(--vscode-textLink-foreground); text-decoration: none; }
    .external-docs a:hover { text-decoration: underline; }
    .doc-link { display: block; padding: 2px 0; }

    .ref-status { margin-top: 6px; font-size: 11px; display: flex; flex-direction: column; gap: 2px; }
    .ref-line { display: flex; align-items: center; gap: 6px; }
    .status-dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; flex-shrink: 0; }
    .status-resolved { background: #34d399; }
    .status-drifted { background: #fbbf24; }
    .status-fuzzy { background: #fb923c; }
    .status-stale { background: #f05252; }
  </style>
</head>
<body>
  <div class="tabs">
    <div class="tab active" data-tab="current" id="tabCurrent">Current File <span class="count" id="countCurrent"></span></div>
    <div class="tab" data-tab="all" id="tabAll">All Entries <span class="count" id="countAll"></span></div>
  </div>
  <div id="content">
    <div class="state-msg"><p>Open a file to see related entries.</p></div>
  </div>

  <script>
    var content = document.getElementById('content');
    var tabCurrent = document.getElementById('tabCurrent');
    var tabAll = document.getElementById('tabAll');
    var countCurrent = document.getElementById('countCurrent');
    var countAll = document.getElementById('countAll');
    var activeTab = 'current';
    var state = { currentFile: null, currentFileEntries: [], allEntries: [] };

    tabCurrent.addEventListener('click', function() { setTab('current'); });
    tabAll.addEventListener('click', function() { setTab('all'); });

    function setTab(tab) {
      activeTab = tab;
      tabCurrent.className = 'tab' + (tab === 'current' ? ' active' : '');
      tabAll.className = 'tab' + (tab === 'all' ? ' active' : '');
      render();
    }

    function render() {
      if (activeTab === 'current') {
        if (state.currentFileEntries.length === 0) {
          var msg = state.currentFile
            ? 'No entries for ' + esc(state.currentFile)
            : 'Open a file to see related entries.';
          content.innerHTML = '<div class="state-msg"><p>' + msg + '</p></div>';
        } else {
          content.innerHTML = state.currentFileEntries.map(function(e) { return renderCard(e, false); }).join('');
        }
      } else {
        if (state.allEntries.length === 0) {
          content.innerHTML = '<div class="state-msg"><p>No entries in this project.</p></div>';
        } else {
          content.innerHTML = state.allEntries.map(function(e) { return renderCard(e, true); }).join('');
        }
      }
    }

    function esc(str) {
      if (!str) return '';
      return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }

    function renderCard(entry, showFile) {
      var lc = 'level-' + (entry.experience_level || 'intermediate');
      var ll = entry.experience_level || 'intermediate';
      var topics = (entry.topics && entry.topics.length > 0)
        ? ' &middot; ' + entry.topics.map(esc).join(', ') : '';

      var fileHtml = '';
      if (showFile && entry.references && entry.references.length > 0) {
        fileHtml = '<div class="entry-file">' + esc(entry.references[0].file) + '</div>';
      }

      var code = entry.code_snippet
        ? '<div class="code-block"><pre><code>' + esc(entry.code_snippet) + '</code></pre></div>' : '';

      var explanation = entry.explanation
        ? '<details><summary>Explanation</summary><div class="section-content">' + esc(entry.explanation) + '</div></details>' : '';

      var alternatives = entry.alternatives_considered
        ? '<details><summary>Alternatives</summary><div class="section-content">' + esc(entry.alternatives_considered) + '</div></details>' : '';

      var concepts = '';
      if (entry.key_concepts && entry.key_concepts.length > 0) {
        concepts = '<details><summary>Key Concepts</summary><div class="key-concepts">' +
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

      var refs = '';
      if (entry.reference_resolutions && entry.reference_resolutions.length > 0) {
        refs = '<div class="ref-status">' +
          entry.reference_resolutions.map(function(r) {
            var loc = r.resolved_file || r.reference.file;
            if (r.resolved_line) loc += ':' + r.resolved_line;
            return '<div class="ref-line"><span class="status-dot status-' + r.status + '"></span><span>' +
              esc(r.status) + ' at ' + esc(loc) + '</span></div>';
          }).join('') + '</div>';
      }

      return '<div class="entry-card">' +
        '<div class="entry-header"><span class="level-badge ' + lc + '">' + esc(ll) + '</span>' +
        '<span class="entry-title">' + esc(entry.title) + '</span></div>' +
        '<div class="entry-meta"><span class="decision-type">' + esc(entry.decision_type || '') + '</span>' + topics + '</div>' +
        fileHtml + code + explanation + alternatives + concepts + docs + refs +
        '</div>';
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
          render();
          break;
        case 'analyzing':
          content.innerHTML = '<div class="state-msg"><div class="spinner"></div>' +
            '<p>Analyzing ' + esc(msg.filePath) + '</p>' +
            '<p>' + esc(msg.detail) + '</p></div>';
          break;
        case 'error':
          content.innerHTML = '<div class="state-msg error-msg"><p>Error: ' + esc(msg.message) + '</p></div>';
          break;
      }
    });
  </script>
</body>
</html>`;
  }
}
