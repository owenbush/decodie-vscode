import * as vscode from 'vscode';
import { FullEntry } from '@owenbush/decodie-core';

export class DecorationManager {
  private _decorationType: vscode.TextEditorDecorationType;

  constructor(context: vscode.ExtensionContext) {
    this._decorationType = vscode.window.createTextEditorDecorationType({
      gutterIconPath: context.asAbsolutePath('resources/entry-marker.svg'),
      gutterIconSize: '80%',
    });
  }

  /** Update decorations for the given editor based on resolved entries */
  updateDecorations(editor: vscode.TextEditor, entries: FullEntry[]): void {
    const decorations: vscode.DecorationOptions[] = [];

    for (const entry of entries) {
      if (!entry.reference_resolutions) continue;
      for (const resolution of entry.reference_resolutions) {
        if (resolution.resolved_line && resolution.status !== 'stale') {
          const line = resolution.resolved_line - 1; // 0-based
          decorations.push({
            range: new vscode.Range(line, 0, line, 0),
            hoverMessage: new vscode.MarkdownString(`**Decodie:** ${entry.title}`),
          });
        }
      }
    }

    editor.setDecorations(this._decorationType, decorations);
  }

  /** Clear all decorations from an editor */
  clearDecorations(editor: vscode.TextEditor): void {
    editor.setDecorations(this._decorationType, []);
  }

  dispose(): void {
    this._decorationType.dispose();
  }
}
