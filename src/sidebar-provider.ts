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

    webviewView.webview.onDidReceiveMessage((msg) => {
      this._handleWebviewMessage(msg);
    });

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

  private _handleWebviewMessage(msg: { type: string; entryId?: string; file?: string; line?: number }): void {
    if (msg.type === 'openEntry') {
      if (msg.entryId) {
        try {
          this._parser.invalidateCache();
          const fullEntry = this._parser.getEntryWithContent(msg.entryId);
          this._view?.webview.postMessage({
            type: 'showEntry',
            entry: fullEntry,
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
  font-size: var(--vscode-font-size, 13px);
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
  flex: 1; padding: 7px 2px; text-align: center;
  font-size: 11px; font-weight: 500; cursor: pointer;
  border-bottom: 2px solid transparent; opacity: 0.6;
  transition: opacity 0.15s, border-color 0.15s;
}
.tab:hover { opacity: 0.9; }
.tab.active { opacity: 1; border-bottom-color: var(--vscode-focusBorder, #0786f7); }
.tab .count { font-size: 9px; opacity: 0.5; }

#content { padding: 8px; display: flex; flex-direction: column; gap: 10px; }

/* States */
.state-msg { text-align: center; opacity: 0.7; margin-top: 32px; padding: 0 12px; }
.state-msg p { margin-top: 6px; font-size: 12px; }
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
.entry-list-title { font-weight: 600; font-size: 12px; line-height: 1.3; }
.entry-list-meta { font-size: 10px; opacity: 0.6; }
.entry-list-file {
  font-size: 10px; opacity: 0.4;
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
  font-size: 10px; font-weight: 600; text-transform: uppercase;
  padding: 2px 6px; border-radius: 3px; color: #000;
  white-space: nowrap; flex-shrink: 0;
}
.level-foundational { background: #34d399; }
.level-intermediate { background: #0786f7; color: #fff; }
.level-advanced { background: #a78bfa; }
.level-ecosystem { background: #fbbf24; }

.entry-title { font-weight: 600; font-size: 13px; line-height: 1.3; }
.entry-meta { font-size: 11px; opacity: 0.7; margin-bottom: 8px; }
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
  font-size: 10px; background: var(--vscode-badge-background);
  color: var(--vscode-badge-foreground); padding: 2px 6px; border-radius: 3px;
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
var analyzing = null; // { filePath, detail } or null
var filters = { level: null, type: null, topic: null };

tabCurrent.addEventListener('click', function() { setTab('current'); });
tabAll.addEventListener('click', function() { setTab('all'); });
tabEntry.addEventListener('click', function() { if (currentEntry) setTab('entry'); });

function setTab(tab) {
  if (tab !== 'entry') previousTab = activeTab !== 'entry' ? activeTab : previousTab;
  activeTab = tab;
  tabCurrent.className = 'tab' + (tab === 'current' ? ' active' : '');
  tabAll.className = 'tab' + (tab === 'all' ? ' active' : '');
  tabEntry.className = 'tab' + (tab === 'entry' ? ' active' : '');
  render();
}

function render() {
  if (activeTab === 'entry' && currentEntry) {
    renderEntryDetail(currentEntry);
  } else if (activeTab === 'current') {
    renderCurrentFile();
  } else {
    renderAllEntries();
  }
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

  content.innerHTML = '<div class="entry-detail">' +
    '<div class="back-link" id="backLink">&larr; Back</div>' +
    '<div class="entry-card">' +
      '<div class="entry-header"><span class="level-badge ' + lc + '">' + esc(ll) + '</span>' +
      '<span class="entry-title">' + esc(entry.title) + '</span></div>' +
      '<div class="entry-meta"><span class="decision-type">' + esc(entry.decision_type || '') + '</span>' + topics + '</div>' +
      fileLinks + code + explanation + alternatives + concepts + docs +
    '</div></div>';

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
      tabEntry.style.display = '';
      setTab('entry');
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
