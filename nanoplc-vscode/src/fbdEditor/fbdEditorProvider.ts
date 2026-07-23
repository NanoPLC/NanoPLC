import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";

import {
  FBD_SOURCE_SCHEMA_VERSION,
  findDeviceCatalogEntry,
  listDeviceIoChannels,
  resolveDeviceTree,
  type DeviceIoChannel,
  type FbdSource,
  type IoModuleChannels,
  type NanoPlcProject,
} from "@nanoplc/ir-schema";

import { loadProjectIoProfile } from "../project/projectIoLoader";

import { FBD_BLOCK_CATALOG } from "./blockCatalog";
import { ensureLayout } from "./layout";
import { PROJECT_FILENAME, readJsonFile } from "../project/projectPaths";

const VIEW_TYPE = "nanoplc.fbdEditor";

interface WebviewDocumentPayload {
  schema_version: number;
  name: string;
  blocks: FbdSource["blocks"];
  wires: FbdSource["wires"];
  layout: Record<string, { x: number; y: number }>;
}

export interface EditorIoProfilePayload {
  di: DeviceIoChannel[];
  do: DeviceIoChannel[];
  ai: DeviceIoChannel[];
  modules: IoModuleChannels[];
  source: "catalog" | "io-map" | "none";
}

function attachModuleMeta(
  channels: DeviceIoChannel[],
  moduleId: string,
  moduleName: string
): DeviceIoChannel[] {
  return channels.map((ch) => ({ ...ch, moduleId, moduleName }));
}

function catalogModuleProfile(
  project: NanoPlcProject,
  entryLabel: string,
  channels: { di: DeviceIoChannel[]; do: DeviceIoChannel[]; ai: DeviceIoChannel[] }
): EditorIoProfilePayload {
  const { modules } = resolveDeviceTree(project);
  const mod = modules[0];
  const moduleId = mod?.id ?? "device";
  const moduleName = mod?.name ?? entryLabel;
  const di = attachModuleMeta(channels.di, moduleId, moduleName);
  const doList = attachModuleMeta(channels.do, moduleId, moduleName);
  const ai = attachModuleMeta(channels.ai, moduleId, moduleName);
  return {
    di,
    do: doList,
    ai,
    modules: [{ id: moduleId, name: moduleName, di, do: doList, ai }],
    source: "catalog",
  };
}

interface PendingFbdEdit {
  timer: ReturnType<typeof setTimeout>;
  apply: () => Promise<void>;
  resolve: () => void;
  reject: (err: unknown) => void;
}

/** Debounced webview→document edits awaiting flush (keyed by document URI). */
const pendingFbdEdits = new Map<string, PendingFbdEdit>();

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

function findProjectRootForDocument(documentUri: vscode.Uri): string | undefined {
  let dir = path.dirname(documentUri.fsPath);
  const workspaceRoot = vscode.workspace.getWorkspaceFolder(documentUri)?.uri.fsPath;
  while (true) {
    if (fs.existsSync(path.join(dir, PROJECT_FILENAME))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      break;
    }
    if (workspaceRoot && !dir.startsWith(workspaceRoot)) {
      break;
    }
    dir = parent;
  }
  return undefined;
}

function loadEditorIoProfile(projectRoot: string): EditorIoProfilePayload {
  try {
    const project = readJsonFile<NanoPlcProject>(path.join(projectRoot, PROJECT_FILENAME));
    const merged = loadProjectIoProfile(projectRoot, project);
    if (merged.di.length > 0 || merged.do.length > 0 || merged.ai.length > 0) {
      const hasExpansion = (project.modules?.length ?? 0) > 1;
      return {
        di: merged.di,
        do: merged.do,
        ai: merged.ai,
        modules: merged.modules,
        source: hasExpansion ? "io-map" : project.device?.catalog_id ? "catalog" : "io-map",
      };
    }

    const catalogId = project.device?.catalog_id;
    if (catalogId) {
      const entry = findDeviceCatalogEntry(catalogId);
      if (entry) {
        const channels = listDeviceIoChannels(entry.io);
        return catalogModuleProfile(project, entry.label, channels);
      }
    }
  } catch {
    // Ignore.
  }

  return { di: [], do: [], ai: [], modules: [], source: "none" };
}

/** Apply any debounced FBD webview edits so compile/build see the latest graph. */
export async function flushPendingFbdDocumentEdits(): Promise<void> {
  const pending = [...pendingFbdEdits.entries()];
  pendingFbdEdits.clear();
  await Promise.all(
    pending.map(async ([, entry]) => {
      clearTimeout(entry.timer);
      try {
        await entry.apply();
        entry.resolve();
      } catch (err) {
        entry.reject(err);
      }
    })
  );
}

/** Save dirty `*.fbd.json` documents (optionally under a project root). */
export async function saveDirtyFbdDocuments(projectRoot?: string): Promise<void> {
  await flushPendingFbdDocumentEdits();
  const dirty = vscode.workspace.textDocuments.filter((doc) => {
    if (!doc.isDirty) {
      return false;
    }
    if (!doc.uri.fsPath.endsWith(".fbd.json")) {
      return false;
    }
    if (projectRoot && !doc.uri.fsPath.startsWith(projectRoot)) {
      return false;
    }
    return true;
  });
  await Promise.all(dirty.map((doc) => doc.save()));
}

export class FbdEditorProvider implements vscode.CustomTextEditorProvider {
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

    const postIoProfile = (): void => {
      const root = findProjectRootForDocument(document.uri);
      const profile = root
        ? loadEditorIoProfile(root)
        : ({ di: [], do: [], ai: [], modules: [], source: "none" } satisfies EditorIoProfilePayload);
      webviewPanel.webview.postMessage({ type: "ioProfile", payload: profile });
    };

    const postDocument = (): void => {
      try {
        const fbd = parseDocument(document.getText());
        webviewPanel.webview.postMessage({ type: "document", payload: toPayload(fbd) });
        postIoProfile();
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

    const projectRoot = findProjectRootForDocument(document.uri);
    const watchers: vscode.Disposable[] = [];
    if (projectRoot) {
      const projectWatcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(projectRoot, `{${PROJECT_FILENAME},src/io-map.json,src/modules/*.json}`)
      );
      const refreshProfile = (): void => postIoProfile();
      projectWatcher.onDidChange(refreshProfile);
      projectWatcher.onDidCreate(refreshProfile);
      projectWatcher.onDidDelete(refreshProfile);
      watchers.push(projectWatcher);
    }

    webviewPanel.webview.onDidReceiveMessage(
      async (message: { type: string; payload?: WebviewDocumentPayload }) => {
        if (message.type === "update" && message.payload) {
          applyingExternalEdit = true;
          try {
            const fbd: FbdSource = {
              schema_version: FBD_SOURCE_SCHEMA_VERSION,
              name: message.payload.name,
              blocks: message.payload.blocks,
              wires: message.payload.wires,
              layout: message.payload.layout,
            };
            await this.queueTextDocumentUpdate(document, serializeDocument(fbd));
          } finally {
            applyingExternalEdit = false;
          }
          return;
        }

        if (message.type === "compile" || message.type === "buildFirmware") {
          applyingExternalEdit = true;
          try {
            await flushPendingFbdDocumentEdits();
            if (document.isDirty) {
              await document.save();
            }
          } finally {
            applyingExternalEdit = false;
          }
          const command =
            message.type === "compile" ? "nanoplc.compileProgram" : "nanoplc.firmwareBuild";
          await vscode.commands.executeCommand(command);
        }
      }
    );

    webviewPanel.webview.html = this.getHtml(webviewPanel.webview);
    postDocument();

    webviewPanel.onDidDispose(() => {
      changeDocumentSubscription.dispose();
      for (const w of watchers) {
        w.dispose();
      }
      const key = document.uri.toString();
      const pending = pendingFbdEdits.get(key);
      if (pending) {
        clearTimeout(pending.timer);
        pendingFbdEdits.delete(key);
        pending.resolve();
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
    <div id="toolbar-actions">
      <button type="button" id="btn-compile" class="toolbar-btn">Compile</button>
      <button type="button" id="btn-build" class="toolbar-btn">Build firmware</button>
    </div>
    <span id="wire-hint" class="hint hidden">Drag from one port to another to connect (or click output then input)</span>
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

  private queueTextDocumentUpdate(document: vscode.TextDocument, text: string): Promise<void> {
    const key = document.uri.toString();
    const existing = pendingFbdEdits.get(key);
    if (existing) {
      clearTimeout(existing.timer);
      existing.resolve();
      pendingFbdEdits.delete(key);
    }

    return new Promise((resolve, reject) => {
      const apply = async (): Promise<void> => {
        if (document.getText() === text) {
          return;
        }
        const edit = new vscode.WorkspaceEdit();
        const fullRange = new vscode.Range(
          document.positionAt(0),
          document.positionAt(document.getText().length)
        );
        edit.replace(document.uri, fullRange, text);
        const ok = await vscode.workspace.applyEdit(edit);
        if (!ok) {
          throw new Error("Failed to apply FBD edit");
        }
      };

      const timer = setTimeout(() => {
        const entry = pendingFbdEdits.get(key);
        if (!entry) {
          return;
        }
        pendingFbdEdits.delete(key);
        void entry
          .apply()
          .then(() => entry.resolve())
          .catch((err) => entry.reject(err));
      }, 200);

      pendingFbdEdits.set(key, { timer, apply, resolve, reject });
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
