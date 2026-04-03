import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { SidebarProvider } from './sidebar-provider';
import { DecorationManager } from './decoration-manager';
import { DecodieCodeLensProvider } from './codelens-provider';
import { analyzeCode } from './analysis-engine';

export function activate(context: vscode.ExtensionContext) {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceRoot) {
    return;
  }

  const decorationManager = new DecorationManager(context);
  const codeLensProvider = new DecodieCodeLensProvider(workspaceRoot);
  const sidebarProvider = new SidebarProvider(context.extensionUri, workspaceRoot, decorationManager);

  // Wire up file watcher to also refresh CodeLens
  const watcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(workspaceRoot, '.decodie/**/*.json'),
  );
  watcher.onDidChange(() => codeLensProvider.refresh());
  watcher.onDidCreate(() => codeLensProvider.refresh());
  watcher.onDidDelete(() => codeLensProvider.refresh());

  context.subscriptions.push(
    decorationManager,
    codeLensProvider,
    watcher,
    vscode.languages.registerCodeLensProvider({ scheme: 'file' }, codeLensProvider),
    vscode.window.registerWebviewViewProvider('decodie.sidebar', sidebarProvider),

    vscode.commands.registerCommand('decodie.viewEntry', async (entryId: string) => {
      await vscode.commands.executeCommand('decodie.sidebar.focus');
      sidebarProvider.showEntryById(entryId);
    }),

    vscode.commands.registerCommand('decodie.refreshSidebar', () => {
      sidebarProvider.refresh();
      codeLensProvider.refresh();
    }),

    vscode.commands.registerCommand('decodie.analyzeSelection', async (_uri?: vscode.Uri) => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showErrorMessage('Decodie: No active editor');
        return;
      }

      const selection = editor.selection;
      if (selection.isEmpty) {
        vscode.window.showErrorMessage('Decodie: No text selected');
        return;
      }

      const code = editor.document.getText(selection);
      const filePath = path.relative(workspaceRoot, editor.document.uri.fsPath);

      await runAnalysis(code, filePath, workspaceRoot, sidebarProvider, codeLensProvider);
    }),

    vscode.commands.registerCommand('decodie.analyzeFile', async (...args: unknown[]) => {
      const uri = args[0] instanceof vscode.Uri ? args[0] : undefined;
      let filePath: string;
      let code: string;

      if (uri) {
        const absolutePath = uri.fsPath;
        try {
          code = fs.readFileSync(absolutePath, 'utf-8');
        } catch (err) {
          vscode.window.showErrorMessage(`Decodie: Failed to read file: ${(err as Error).message}`);
          return;
        }
        filePath = path.relative(workspaceRoot, absolutePath);
        await vscode.window.showTextDocument(uri, { preserveFocus: true });
      } else {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
          vscode.window.showErrorMessage('Decodie: No active editor');
          return;
        }
        code = editor.document.getText();
        filePath = path.relative(workspaceRoot, editor.document.uri.fsPath);
      }

      await runAnalysis(code, filePath, workspaceRoot, sidebarProvider, codeLensProvider);
    }),
  );
}

async function runAnalysis(
  code: string,
  filePath: string,
  workspaceRoot: string,
  sidebarProvider: SidebarProvider,
  codeLensProvider: DecodieCodeLensProvider,
): Promise<void> {
  if (!workspaceRoot || !filePath) {
    vscode.window.showErrorMessage('Decodie: No workspace or file path');
    return;
  }

  await vscode.commands.executeCommand('decodie.sidebar.focus');
  sidebarProvider.showAnalyzing(filePath);

  try {
    const entries = await analyzeCode({
      code,
      filePath,
      workspaceRoot,
      onProgress: (msg: string) => {
        sidebarProvider.showAnalyzing(filePath, msg);
      },
    });

    vscode.window.showInformationMessage(`Decodie: Created ${entries.length} entries`);
    sidebarProvider.refreshForFile(filePath);
    codeLensProvider.refresh();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof Error && err.stack) {
      console.error('Decodie analysis error:', err.stack);
    }
    sidebarProvider.showError(message);
    vscode.window.showErrorMessage(`Decodie: ${message}`);
  }
}

export function deactivate() {}
