import * as vscode from "vscode";

import { FBD_SOURCE_SCHEMA_VERSION, type FbdSource } from "@nanoplc/ir-schema";

import { FBD_BLOCK_CATALOG } from "./blockCatalog";
import { ensureLayout } from "./layout";

const VIEW_TYPE = "nanoplc.fbdEditor";

interface WebviewDocumentPayload {
  schema_version: number;
  name: string;
  blocks: FbdSource["blocks"];
  wires: FbdSource["wires"];
  layout: Record<string, { x: number; y: number }>;
}

function parseDocument(text: string): FbdSource {
  return JSON.parse(text) as FbdSource;
}

function serializeDocument(fbd: FbdSource): string {
  const out: FbdSource = {
    schema_version: fbd.schema_version ?? FBD_SOURCE_SCHEMA_VERSION,
    name: fbd.name,
    blocks: fbd.blocks,
    wires: fbd.wires,
  };
  if (fbd.layout && Object.keys(fbd.layout).length > 0) {
    out.layout = fbd.layout;
  }
  return `${JSON.stringify(out, null, 2)}\n`;
}

function toPayload(fbd: FbdSource): WebviewDocumentPayload {
  return {
    schema_version: fbd.schema_version,
    name: fbd.name,
    blocks: fbd.blocks,
    wires: fbd.wires,
    layout: ensureLayout(fbd),
  };
}

export class FbdEditorProvider implements vscode.CustomTextEditorProvider {
  private readonly pendingUpdates = new WeakMap<vscode.TextDocument, ReturnType<typeof setTimeout>>();

  constructor(private readonly context: vscode.ExtensionContext) {}

  public static register(context: vscode.ExtensionContext): vscode.Disposable {
    const provider = new FbdEditorProvider(context);
    return vscode.window.registerCustomEditorProvider(VIEW_TYPE, provider, {
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: false,
    });
  }

  async resolveCustomTextEditor(
    document: vscode.TextDocument,
    webviewPanel: vscode.WebviewPanel,
    _token: vscode.CancellationToken
  ): Promise<void> {
    webviewPanel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "media")],
    };

    let applyingExternalEdit = false;

    const postDocument = (): void => {
      try {
        const fbd = parseDocument(document.getText());
        webviewPanel.webview.postMessage({ type: "document", payload: toPayload(fbd) });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        webviewPanel.webview.postMessage({ type: "parseError", message });
      }
    };

    const changeDocumentSubscription = vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.uri.toString() !== document.uri.toString()) {
        return;
      }
      if (applyingExternalEdit) {
        return;
      }
      postDocument();
    });

    webviewPanel.webview.onDidReceiveMessage(async (message: { type: string; payload?: WebviewDocumentPayload }) => {
      if (message.type !== "update" || !message.payload) {
        return;
      }
      applyingExternalEdit = true;
      try {
        const fbd: FbdSource = {
          schema_version: FBD_SOURCE_SCHEMA_VERSION,
          name: message.payload.name,
          blocks: message.payload.blocks,
          wires: message.payload.wires,
          layout: message.payload.layout,
        };
        await this.updateTextDocument(document, serializeDocument(fbd));
      } finally {
        applyingExternalEdit = false;
      }
    });

    webviewPanel.webview.html = this.getHtml(webviewPanel.webview);
    postDocument();

    webviewPanel.onDidDispose(() => {
      changeDocumentSubscription.dispose();
      const pending = this.pendingUpdates.get(document);
      if (pending) {
        clearTimeout(pending);
      }
    });
  }

  private getHtml(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "media", "fbd-editor", "fbdEditor.js")
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "media", "fbd-editor", "fbdEditor.css")
    );
    const nonce = getNonce();
    const catalogJson = JSON.stringify(FBD_BLOCK_CATALOG).replace(/</g, "\\u003c");

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}' ${webview.cspSource};" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link href="${styleUri}" rel="stylesheet" />
  <title>FBD Editor</title>
</head>
<body>
  <div id="toolbar">
    <span id="doc-title">FBD</span>
    <span id="wire-hint" class="hint hidden">Click an output port, then an input port</span>
    <span id="parse-error" class="error hidden"></span>
  </div>
  <div id="workspace">
    <aside id="palette"></aside>
    <div id="canvas-wrap">
      <div id="canvas-viewport">
        <div id="canvas-world">
          <svg id="wires" xmlns="http://www.w3.org/2000/svg"></svg>
          <div id="blocks"></div>
        </div>
      </div>
    </div>
    <aside id="properties">
      <h3>Properties</h3>
      <div id="properties-body"><p class="muted">Select a block</p></div>
    </aside>
  </div>
  <script nonce="${nonce}">
    window.__NANOPLC_BLOCK_CATALOG__ = ${catalogJson};
  </script>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }

  private async updateTextDocument(document: vscode.TextDocument, text: string): Promise<void> {
    const pending = this.pendingUpdates.get(document);
    if (pending) {
      clearTimeout(pending);
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(async () => {
        this.pendingUpdates.delete(document);
        if (document.getText() === text) {
          resolve();
          return;
        }
        const edit = new vscode.WorkspaceEdit();
        const fullRange = new vscode.Range(
          document.positionAt(0),
          document.positionAt(document.getText().length)
        );
        edit.replace(document.uri, fullRange, text);
        try {
          const ok = await vscode.workspace.applyEdit(edit);
          if (!ok) {
            reject(new Error("Failed to apply FBD edit"));
            return;
          }
          resolve();
        } catch (err) {
          reject(err);
        }
      }, 200);
      this.pendingUpdates.set(document, timeout);
    });
  }
}

function getNonce(): string {
  let text = "";
  const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}

export function registerFbdEditor(context: vscode.ExtensionContext): vscode.Disposable {
  return FbdEditorProvider.register(context);
}
