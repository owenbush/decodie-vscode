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

    // Listen to active editor changes
    vscode.window.onDidChangeActiveTextEditor(
      () => this._onActiveEditorChanged(),
      null,
    );

    // Set up file system watcher for .decodie JSON files
    this._fileWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(this._workspaceRoot, '.decodie/**/*.json'),
    );

    this._fileWatcher.onDidChange(() => this._onDecodieDataChanged());
    this._fileWatcher.onDidCreate(() => this._onDecodieDataChanged());
    this._fileWatcher.onDidDelete(() => this._onDecodieDataChanged());

    // Trigger initial update
    this._onActiveEditorChanged();

    // Clean up watcher when view is disposed
    webviewView.onDidDispose(() => {
      this._fileWatcher?.dispose();
    });
  }

  /** Public refresh method callable from outside the provider. */
  public refresh(): void {
    this._parser.invalidateCache();
    this._updateForActiveEditor();
  }

  /** Return the file watcher disposable so the extension can track it. */
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
        type: 'empty',
        message: 'Open a file to see related Decodie entries.',
      });
      return;
    }

    const filePath = editor.document.uri.fsPath;
    const relativePath = path.relative(this._workspaceRoot, filePath);

    // Normalize to forward slashes for cross-platform matching
    const normalizedPath = relativePath.split(path.sep).join('/');

    this._view.webview.postMessage({ type: 'loading' });

    try {
      const index = this._parser.loadIndex();

      // Filter entries where any reference file matches the active file
      const matchingEntries = index.entries.filter((entry) =>
        entry.references.some((ref) => {
          const normalizedRef = ref.file.split(path.sep).join('/');
          return normalizedRef === normalizedPath;
        }),
      );

      if (matchingEntries.length === 0) {
        this._decorationManager?.clearDecorations(editor);
        this._view.webview.postMessage({
          type: 'empty',
          message: `No Decodie entries reference ${normalizedPath}.`,
        });
        return;
      }

      // Get full content for each matching entry
      const fullEntries: FullEntry[] = matchingEntries.map((entry) => {
        try {
          return this._parser.getEntryWithContent(entry.id);
        } catch {
          // If we can't load full content, return index entry with empty resolutions
          return {
            ...entry,
            reference_resolutions: [],
          };
        }
      });

      this._decorationManager?.updateDecorations(editor, fullEntries);

      this._view.webview.postMessage({
        type: 'updateEntries',
        entries: fullEntries,
      });
    } catch {
      this._view.webview.postMessage({
        type: 'empty',
        message: 'No .decodie/index.json found in this workspace.',
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
    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size, 13px);
      color: var(--vscode-editor-foreground);
      background: var(--vscode-sideBar-background);
      padding: 8px;
    }

    #root {
      display: flex;
      flex-direction: column;
      gap: 10px;
    }

    /* States */
    .state-loading,
    .state-empty {
      text-align: center;
      opacity: 0.7;
      margin-top: 40px;
    }

    .state-loading .spinner {
      display: inline-block;
      width: 20px;
      height: 20px;
      border: 2px solid var(--vscode-editor-foreground);
      border-top-color: transparent;
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
      margin-bottom: 8px;
    }

    @keyframes spin {
      to { transform: rotate(360deg); }
    }

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

    .entry-title {
      font-weight: 600;
      font-size: 13px;
      line-height: 1.3;
    }

    .entry-meta {
      font-size: 11px;
      opacity: 0.7;
      margin-bottom: 8px;
    }

    .decision-type {
      font-style: italic;
    }

    /* Code snippet */
    .code-block {
      background: var(--vscode-textCodeBlock-background);
      border-radius: 3px;
      padding: 8px;
      margin: 8px 0;
      overflow-x: auto;
      font-size: 12px;
    }

    .code-block pre {
      margin: 0;
      white-space: pre;
    }

    .code-block code {
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: var(--vscode-editor-font-size, 12px);
    }

    /* Collapsible sections */
    details {
      margin: 4px 0;
    }

    details summary {
      cursor: pointer;
      font-size: 12px;
      font-weight: 600;
      padding: 4px 0;
      user-select: none;
      opacity: 0.9;
    }

    details summary:hover {
      opacity: 1;
    }

    details .section-content {
      font-size: 12px;
      line-height: 1.5;
      padding: 4px 0 4px 12px;
      white-space: pre-wrap;
      word-wrap: break-word;
    }

    /* Key concepts */
    .key-concepts {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
      padding: 4px 0 4px 12px;
    }

    .concept-tag {
      font-size: 10px;
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
      padding: 2px 6px;
      border-radius: 3px;
    }

    /* External docs */
    .external-docs {
      margin-top: 6px;
      font-size: 12px;
    }

    .external-docs a {
      color: var(--vscode-textLink-foreground);
      text-decoration: none;
    }

    .external-docs a:hover {
      text-decoration: underline;
    }

    .doc-link {
      display: block;
      padding: 2px 0;
    }

    /* Reference status */
    .ref-status {
      margin-top: 6px;
      font-size: 11px;
      display: flex;
      flex-direction: column;
      gap: 2px;
    }

    .ref-line {
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .status-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      display: inline-block;
      flex-shrink: 0;
    }

    .status-resolved { background: #34d399; }
    .status-drifted { background: #fbbf24; }
    .status-fuzzy { background: #fb923c; }
    .status-stale { background: #f05252; }
  </style>
</head>
<body>
  <div id="root">
    <div class="state-empty">
      <h3>Decodie</h3>
      <p>Open a file to see related entries.</p>
    </div>
  </div>

  <script>
    const root = document.getElementById('root');

    function escapeHtml(str) {
      if (!str) return '';
      return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }

    function renderLoading() {
      root.innerHTML = '<div class="state-loading"><div class="spinner"></div><p>Loading entries...</p></div>';
    }

    function renderEmpty(message) {
      root.innerHTML = '<div class="state-empty"><h3>Decodie</h3><p>' + escapeHtml(message) + '</p></div>';
    }

    function renderEntries(entries) {
      if (!entries || entries.length === 0) {
        renderEmpty('No entries for the current file.');
        return;
      }

      root.innerHTML = entries.map(renderCard).join('');
    }

    function renderCard(entry) {
      const levelClass = 'level-' + (entry.experience_level || 'intermediate');
      const levelLabel = entry.experience_level || 'intermediate';

      let topicsStr = '';
      if (entry.topics && entry.topics.length > 0) {
        topicsStr = ' &middot; ' + entry.topics.map(escapeHtml).join(', ');
      }

      let codeBlock = '';
      if (entry.code_snippet) {
        codeBlock = '<div class="code-block"><pre><code>' + escapeHtml(entry.code_snippet) + '</code></pre></div>';
      }

      let explanationSection = '';
      if (entry.explanation) {
        explanationSection = '<details><summary>Explanation</summary><div class="section-content">' + escapeHtml(entry.explanation) + '</div></details>';
      }

      let alternativesSection = '';
      if (entry.alternatives_considered) {
        alternativesSection = '<details><summary>Alternatives</summary><div class="section-content">' + escapeHtml(entry.alternatives_considered) + '</div></details>';
      }

      let keyConceptsSection = '';
      if (entry.key_concepts && entry.key_concepts.length > 0) {
        const tags = entry.key_concepts.map(function(c) {
          return '<span class="concept-tag">' + escapeHtml(c) + '</span>';
        }).join('');
        keyConceptsSection = '<details><summary>Key Concepts</summary><div class="key-concepts">' + tags + '</div></details>';
      }

      let externalDocs = '';
      if (entry.external_docs && entry.external_docs.length > 0) {
        const links = entry.external_docs.map(function(doc) {
          return '<span class="doc-link">&#x1F4CE; <a href="' + escapeHtml(doc.url) + '">' + escapeHtml(doc.label) + '</a></span>';
        }).join('');
        externalDocs = '<div class="external-docs">' + links + '</div>';
      }

      let refStatus = '';
      if (entry.reference_resolutions && entry.reference_resolutions.length > 0) {
        const lines = entry.reference_resolutions.map(function(res) {
          const statusClass = 'status-' + res.status;
          let location = res.resolved_file || res.reference.file;
          if (res.resolved_line) {
            location += ':' + res.resolved_line;
          }
          return '<div class="ref-line"><span class="status-dot ' + statusClass + '"></span><span>' + escapeHtml(res.status) + ' at ' + escapeHtml(location) + '</span></div>';
        }).join('');
        refStatus = '<div class="ref-status">' + lines + '</div>';
      }

      return '<div class="entry-card">' +
        '<div class="entry-header">' +
          '<span class="level-badge ' + levelClass + '">' + escapeHtml(levelLabel) + '</span>' +
          '<span class="entry-title">' + escapeHtml(entry.title) + '</span>' +
        '</div>' +
        '<div class="entry-meta"><span class="decision-type">' + escapeHtml(entry.decision_type || '') + '</span>' + topicsStr + '</div>' +
        codeBlock +
        explanationSection +
        alternativesSection +
        keyConceptsSection +
        externalDocs +
        refStatus +
      '</div>';
    }

    window.addEventListener('message', function(event) {
      const msg = event.data;
      switch (msg.type) {
        case 'loading':
          renderLoading();
          break;
        case 'empty':
          renderEmpty(msg.message || 'No entries.');
          break;
        case 'updateEntries':
          renderEntries(msg.entries);
          break;
      }
    });
  </script>
</body>
</html>`;
  }
}
