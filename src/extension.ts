import * as vscode from 'vscode';
import { SidebarProvider } from './sidebar-provider';

export function activate(context: vscode.ExtensionContext) {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceRoot) {
    return;
  }

  const sidebarProvider = new SidebarProvider(context.extensionUri, workspaceRoot);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('decodie.sidebar', sidebarProvider),
    vscode.commands.registerCommand('decodie.analyzeSelection', () => {
      vscode.window.showInformationMessage('Decodie: Analyze Selection - coming soon');
    }),
    vscode.commands.registerCommand('decodie.analyzeFile', () => {
      vscode.window.showInformationMessage('Decodie: Analyze File - coming soon');
    }),
  );
}

export function deactivate() {}
