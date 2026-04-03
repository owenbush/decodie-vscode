import * as vscode from 'vscode';
import * as path from 'path';
import { DataParser, FullEntry } from '@owenbush/decodie-core';

interface EntryAtLine {
  entry: FullEntry;
  line: number;
}

export class DecodieCodeLensProvider implements vscode.CodeLensProvider {
  private _parser: DataParser;
  private _workspaceRoot: string;
  private _onDidChange = new vscode.EventEmitter<void>();
  public readonly onDidChangeCodeLenses = this._onDidChange.event;

  constructor(workspaceRoot: string) {
    this._workspaceRoot = workspaceRoot;
    this._parser = new DataParser(workspaceRoot);
  }

  public refresh(): void {
    this._parser.invalidateCache();
    this._onDidChange.fire();
  }

  public provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const relativePath = path.relative(this._workspaceRoot, document.uri.fsPath)
      .split(path.sep).join('/');

    let entries: EntryAtLine[];
    try {
      entries = this._getEntriesForFile(relativePath);
    } catch {
      return [];
    }

    return entries.map(({ entry, line }) => {
      const range = new vscode.Range(line, 0, line, 0);
      return new vscode.CodeLens(range, {
        title: `$(book) ${entry.title}`,
        command: 'decodie.viewEntry',
        arguments: [entry.id],
        tooltip: `View Decodie entry: ${entry.title}`,
      });
    });
  }

  private _getEntriesForFile(relativePath: string): EntryAtLine[] {
    const index = this._parser.loadIndex();
    const results: EntryAtLine[] = [];

    const matchingEntries = index.entries.filter((entry) =>
      entry.references.some((ref) =>
        ref.file.split(path.sep).join('/') === relativePath,
      ),
    );

    for (const indexEntry of matchingEntries) {
      let fullEntry: FullEntry;
      try {
        fullEntry = this._parser.getEntryWithContent(indexEntry.id);
      } catch {
        continue;
      }

      for (const resolution of fullEntry.reference_resolutions) {
        if (resolution.resolved_line && resolution.status !== 'stale') {
          results.push({ entry: fullEntry, line: resolution.resolved_line - 1 });
        }
      }
    }

    return results;
  }

  dispose(): void {
    this._onDidChange.dispose();
  }
}
