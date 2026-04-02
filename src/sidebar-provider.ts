import * as vscode from 'vscode';

export class SidebarProvider implements vscode.WebviewViewProvider {
  private _view?: vscode.WebviewView;

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly _workspaceRoot: string,
  ) {}

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
  }

  private _getHtml(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body {
      font-family: var(--vscode-font-family);
      color: var(--vscode-foreground);
      padding: 12px;
    }
    .empty-state {
      text-align: center;
      opacity: 0.7;
      margin-top: 40px;
    }
    .empty-state h3 {
      margin-bottom: 8px;
    }
  </style>
</head>
<body>
  <div class="empty-state">
    <h3>Decodie</h3>
    <p>No entries for the current file.</p>
    <p><small>Open a file with associated Decodie entries to see them here.</small></p>
  </div>
</body>
</html>`;
  }
}
