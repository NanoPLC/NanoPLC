import * as vscode from "vscode";

import { analyzeSt, completeSt, hoverSt, type StSymbol } from "@nanoplc/ir-schema";

const LANGUAGE = "iec-st";

function symbolKind(kind: StSymbol["kind"]): vscode.SymbolKind {
  if (kind === "program") {
    return vscode.SymbolKind.Module;
  }
  if (kind === "function") {
    return vscode.SymbolKind.Function;
  }
  if (kind === "function_block") {
    return vscode.SymbolKind.Class;
  }
  return vscode.SymbolKind.Variable;
}

function completionKind(kind: "keyword" | "type" | "variable"): vscode.CompletionItemKind {
  if (kind === "type") {
    return vscode.CompletionItemKind.TypeParameter;
  }
  if (kind === "variable") {
    return vscode.CompletionItemKind.Variable;
  }
  return vscode.CompletionItemKind.Keyword;
}

function refresh(collection: vscode.DiagnosticCollection, document: vscode.TextDocument): void {
  if (document.languageId !== LANGUAGE) {
    return;
  }
  const analysis = analyzeSt(document.getText());
  collection.set(
    document.uri,
    analysis.diagnostics.map((item) => {
      const start = new vscode.Position(item.line, item.start);
      const end = new vscode.Position(item.line, item.end);
      const diagnostic = new vscode.Diagnostic(
        new vscode.Range(start, end),
        item.message,
        item.severity === "warning" ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Error
      );
      diagnostic.code = item.code;
      diagnostic.source = "nanoplc";
      return diagnostic;
    })
  );
}

/** Diagnostics, completion, hover, and outline for `iec-st` files. Structural only. */
export function registerStLanguage(context: vscode.ExtensionContext): vscode.Disposable {
  const collection = vscode.languages.createDiagnosticCollection("nanoplc-st");
  const selector = { language: LANGUAGE };
  for (const document of vscode.workspace.textDocuments) {
    refresh(collection, document);
  }
  context.subscriptions.push(
    collection,
    vscode.workspace.onDidOpenTextDocument((document) => refresh(collection, document)),
    vscode.workspace.onDidChangeTextDocument((event) => refresh(collection, event.document)),
    vscode.workspace.onDidCloseTextDocument((document) => collection.delete(document.uri)),
    vscode.languages.registerCompletionItemProvider(selector, {
      provideCompletionItems(document, position) {
        return completeSt(document.getText(), position.line, position.character).map((item) => {
          const completion = new vscode.CompletionItem(item.label, completionKind(item.kind));
          completion.detail = item.detail;
          return completion;
        });
      },
    }),
    vscode.languages.registerHoverProvider(selector, {
      provideHover(document, position) {
        const text = hoverSt(document.getText(), position.line, position.character);
        if (!text) {
          return undefined;
        }
        return new vscode.Hover(new vscode.MarkdownString().appendCodeblock(text, "iec-st"));
      },
    }),
    vscode.languages.registerDocumentSymbolProvider(selector, {
      provideDocumentSymbols(document) {
        return analyzeSt(document.getText()).symbols.map(
          (symbol) =>
            new vscode.DocumentSymbol(
              symbol.name,
              symbol.detail,
              symbolKind(symbol.kind),
              new vscode.Range(symbol.line, symbol.start, symbol.line, symbol.end),
              new vscode.Range(symbol.line, symbol.start, symbol.line, symbol.end)
            )
        );
      },
    })
  );
  return collection;
}
