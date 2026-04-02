import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { SidebarProvider } from './sidebar-provider';
import { analyzeCode } from './analysis-engine';

export function activate(context: vscode.ExtensionContext) {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceRoot) {
    return;
  }

  const sidebarProvider = new SidebarProvider(context.extensionUri, workspaceRoot);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('decodie.sidebar', sidebarProvider),
    vscode.commands.registerCommand('decodie.refreshSidebar', () => {
      sidebarProvider.refresh();
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

      await runAnalysis(code, filePath, workspaceRoot);
    }),

    vscode.commands.registerCommand('decodie.analyzeFile', async (uri?: vscode.Uri) => {
      let filePath: string;
      let code: string;

      if (uri) {
        // Called from explorer context menu
        const absolutePath = uri.fsPath;
        try {
          code = fs.readFileSync(absolutePath, 'utf-8');
        } catch (err) {
          vscode.window.showErrorMessage(`Decodie: Failed to read file: ${(err as Error).message}`);
          return;
        }
        filePath = path.relative(workspaceRoot, absolutePath);
      } else {
        // Called from command palette or editor context menu
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
          vscode.window.showErrorMessage('Decodie: No active editor');
          return;
        }
        code = editor.document.getText();
        filePath = path.relative(workspaceRoot, editor.document.uri.fsPath);
      }

      await runAnalysis(code, filePath, workspaceRoot);
    }),
  );
}

async function runAnalysis(code: string, filePath: string, workspaceRoot: string): Promise<void> {
  try {
    const entries = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Decodie: Analyzing code...',
        cancellable: false,
      },
      async (progress) => {
        return analyzeCode({
          code,
          filePath,
          workspaceRoot,
          onProgress: (msg: string) => {
            progress.report({ message: msg });
          },
        });
      },
    );

    vscode.window.showInformationMessage(`Decodie: Created ${entries.length} entries`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    vscode.window.showErrorMessage(`Decodie: ${message}`);
  }
}

export function deactivate() {}
