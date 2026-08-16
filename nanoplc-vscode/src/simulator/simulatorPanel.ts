import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";

import {
  IR_VERSION,
  PlcSimulator,
  pouIrName,
  type NanoPlcProject,
  type PlcIr,
  type PlcPrimitiveType,
  type SimulatorSnapshot,
} from "@nanoplc/ir-schema";

import {
  ioCapacityFromProfile,
  loadEditorIoProfile,
  loadProjectPouCatalog,
  type EditorIoProfilePayload,
  type PouCatalogItem,
} from "../project/editorIoProfile";
import { pickProjectLocation, PROJECT_FILENAME, readJsonFile } from "../project/projectPaths";

const VIEW_TYPE = "nanoplc.simulatorIo";
const WATCHES_STATE_PREFIX = "nanoplc.simWatches:";

type SimIoKind = "DI" | "DO" | "AI";

type SimWatchItem =
  | { id: string; kind: "io"; ioKind: SimIoKind; moduleId: string; channel: number }
  | { id: string; kind: "var"; programId: string; name: string };

interface SimulatorContext {
  ir: PlcIr;
  rootPath: string;
  ioProfile: EditorIoProfilePayload;
  programs: PouCatalogItem[];
}

let activeSimulator: PlcSimulator | undefined;
let activePanel: vscode.WebviewPanel | undefined;
let activeContext: SimulatorContext | undefined;
let extensionUri: vscode.Uri | undefined;
let statusBarItem: vscode.StatusBarItem | undefined;
let workspaceState: vscode.Memento | undefined;

function getRefreshMs(): number {
  return vscode.workspace.getConfiguration("nanoplc").get<number>("simulatorRefreshMs", 50);
}

function loadIr(rootPath: string): PlcIr | undefined {
  const irPath = path.join(rootPath, "build", "ir.json");
  if (!fs.existsSync(irPath)) {
    return undefined;
  }
  const ir = readJsonFile<PlcIr>(irPath);
  if (ir.ir_version !== IR_VERSION) {
    void vscode.window.showWarningMessage(
      `NanoPLC: build/ir.json ir_version ${ir.ir_version} may not match tooling (${IR_VERSION}). Recompile.`
    );
  }
  return ir;
}

function watchesStateKey(rootPath: string): string {
  return `${WATCHES_STATE_PREFIX}${rootPath}`;
}

function ioWatchId(ioKind: SimIoKind, moduleId: string, channel: number): string {
  return `io:${ioKind}:${moduleId}:${channel}`;
}

function varWatchId(programId: string, name: string): string {
  return `var:${programId}:${name}`;
}

function isSimIoKind(value: unknown): value is SimIoKind {
  return value === "DI" || value === "DO" || value === "AI";
}

function parseWatches(raw: unknown): SimWatchItem[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: SimWatchItem[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const o = item as Record<string, unknown>;
    if (o.kind === "io" && isSimIoKind(o.ioKind) && typeof o.moduleId === "string" && typeof o.channel === "number") {
      out.push({
        id: typeof o.id === "string" ? o.id : ioWatchId(o.ioKind, o.moduleId, o.channel),
        kind: "io",
        ioKind: o.ioKind,
        moduleId: o.moduleId,
        channel: o.channel,
      });
      continue;
    }
    if (o.kind === "var" && typeof o.programId === "string" && typeof o.name === "string") {
      out.push({
        id: typeof o.id === "string" ? o.id : varWatchId(o.programId, o.name),
        kind: "var",
        programId: o.programId,
        name: o.name,
      });
    }
  }
  return out;
}

function ioChannels(profile: EditorIoProfilePayload, ioKind: SimIoKind) {
  const key = ioKind.toLowerCase() as "di" | "do" | "ai";
  if (profile.modules.length > 0) {
    return profile.modules.map((mod) => ({
      id: mod.id,
      name: mod.name,
      channels: mod[key],
    }));
  }
  return [{ id: "device", name: "Device", channels: profile[key] }];
}

function sanitizeWatches(
  watches: SimWatchItem[],
  profile: EditorIoProfilePayload,
  programs: PouCatalogItem[]
): SimWatchItem[] {
  const seen = new Set<string>();
  const out: SimWatchItem[] = [];
  for (const watch of watches) {
    if (seen.has(watch.id)) {
      continue;
    }
    if (watch.kind === "io") {
      const mod = ioChannels(profile, watch.ioKind).find((m) => m.id === watch.moduleId);
      const entry = mod?.channels.find((c) => c.channel === watch.channel);
      if (!entry) {
        continue;
      }
      seen.add(watch.id);
      out.push(watch);
      continue;
    }
    const prog = programs.find((p) => p.id === watch.programId);
    const variable = prog?.variables.find((v) => v.name === watch.name);
    if (!variable) {
      continue;
    }
    seen.add(watch.id);
    out.push(watch);
  }
  return out;
}

function loadWatches(rootPath: string, profile: EditorIoProfilePayload, programs: PouCatalogItem[]): SimWatchItem[] {
  const raw = workspaceState?.get(watchesStateKey(rootPath));
  return sanitizeWatches(parseWatches(raw), profile, programs);
}

async function saveWatches(rootPath: string, watches: SimWatchItem[]): Promise<void> {
  await workspaceState?.update(watchesStateKey(rootPath), watches);
}

function loadSimContext(rootPath: string, ir: PlcIr): SimulatorContext {
  const project = readJsonFile<NanoPlcProject>(path.join(rootPath, PROJECT_FILENAME));
  return {
    ir,
    rootPath,
    ioProfile: loadEditorIoProfile(rootPath),
    programs: loadProjectPouCatalog(rootPath, project),
  };
}

function getNonce(): string {
  let text = "";
  const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}

function renderHtml(webview: vscode.Webview): string {
  if (!extensionUri) {
    return "";
  }
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "media", "simulator", "simulator.js"));
  const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "media", "simulator", "simulator.css"));
  const nonce = getNonce();
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link href="${styleUri}" rel="stylesheet" />
  <title>NanoPLC Simulator</title>
</head>
<body>
  <div class="meta" id="meta">Simulation stopped</div>

  <section class="add-card">
    <h2>Add I/O</h2>
    <div class="add-row">
      <select id="io-kind">
        <option value="DI">Digital In</option>
        <option value="AI">Analog In</option>
        <option value="DO">Digital Out</option>
      </select>
      <select id="io-module"></select>
      <select id="io-channel"></select>
      <button type="button" class="primary" id="btn-add-io">Add</button>
    </div>
    <p class="hint" id="io-hint"></p>
  </section>

  <section class="add-card">
    <h2>Add variable</h2>
    <div class="add-row">
      <select id="var-program"></select>
      <select id="var-name"></select>
      <button type="button" class="primary" id="btn-add-var">Add</button>
    </div>
    <p class="hint" id="var-hint"></p>
  </section>

  <h2>Watched I/O</h2>
  <table>
    <thead>
      <tr><th>Kind</th><th>Location</th><th>Value</th><th></th></tr>
    </thead>
    <tbody id="io-body"></tbody>
  </table>

  <h2>Watched variables</h2>
  <table>
    <thead>
      <tr><th>Class</th><th>Variable</th><th>Type</th><th>Value</th><th></th></tr>
    </thead>
    <tbody id="var-body"></tbody>
  </table>

  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

function currentWatches(): SimWatchItem[] {
  if (!activeContext || !workspaceState) {
    return [];
  }
  return loadWatches(activeContext.rootPath, activeContext.ioProfile, activeContext.programs);
}

function postToPanel(message: Record<string, unknown>): void {
  if (activePanel) {
    void activePanel.webview.postMessage(message);
  }
}

function postInit(): void {
  if (!activeContext) {
    return;
  }
  const snap = activeSimulator?.currentSnapshot() ?? {
    scan_index: 0,
    elapsed_ms: 0,
    vars: {},
    di: [],
    ai: [],
    do: [],
  };
  postToPanel({
    type: "init",
    ioProfile: activeContext.ioProfile,
    programs: activeContext.programs,
    watches: currentWatches(),
    snap,
    scanPeriodMs: activeContext.ir.project.scan_period_ms,
  });
}

function postWatches(): void {
  postToPanel({ type: "watches", watches: currentWatches() });
}

function findIoIndex(ioKind: SimIoKind, moduleId: string, channel: number): number | undefined {
  if (!activeContext) {
    return undefined;
  }
  const mod = ioChannels(activeContext.ioProfile, ioKind).find((m) => m.id === moduleId);
  return mod?.channels.find((c) => c.channel === channel)?.index;
}

async function addIoWatch(ioKind: SimIoKind, moduleId: string, channel: number): Promise<void> {
  if (!activeContext) {
    return;
  }
  const index = findIoIndex(ioKind, moduleId, channel);
  if (index === undefined) {
    return;
  }
  const next = [
    ...currentWatches(),
    { id: ioWatchId(ioKind, moduleId, channel), kind: "io" as const, ioKind, moduleId, channel },
  ];
  await saveWatches(
    activeContext.rootPath,
    sanitizeWatches(next, activeContext.ioProfile, activeContext.programs)
  );
  postWatches();
}

async function addVarWatch(programId: string, name: string): Promise<void> {
  if (!activeContext) {
    return;
  }
  const next = [
    ...currentWatches(),
    { id: varWatchId(programId, name), kind: "var" as const, programId, name },
  ];
  await saveWatches(
    activeContext.rootPath,
    sanitizeWatches(next, activeContext.ioProfile, activeContext.programs)
  );
  postWatches();
}

async function removeWatch(id: string): Promise<void> {
  if (!activeContext) {
    return;
  }
  await saveWatches(
    activeContext.rootPath,
    currentWatches().filter((w) => w.id !== id)
  );
  postWatches();
}

function coerceVarValue(type: PlcPrimitiveType | undefined, value: unknown): boolean | number {
  if (type === "BOOL") {
    return value === true || value === 1 || value === "true";
  }
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) {
    return 0;
  }
  return type === "REAL" ? n : Math.trunc(n);
}

function handleWebviewMessage(msg: {
  type?: string;
  ioKind?: string;
  moduleId?: string;
  channel?: number;
  programId?: string;
  name?: string;
  id?: string;
  index?: number;
  value?: boolean | number;
}): void {
  if (msg.type === "ready") {
    postInit();
    return;
  }
  if (msg.type === "addIo" && isSimIoKind(msg.ioKind) && typeof msg.moduleId === "string" && typeof msg.channel === "number") {
    void addIoWatch(msg.ioKind, msg.moduleId, msg.channel);
    return;
  }
  if (msg.type === "addVar" && typeof msg.programId === "string" && typeof msg.name === "string") {
    void addVarWatch(msg.programId, msg.name);
    return;
  }
  if (msg.type === "removeWatch" && typeof msg.id === "string") {
    void removeWatch(msg.id);
    return;
  }
  if (!activeSimulator) {
    return;
  }
  if (msg.type === "toggleDi" && typeof msg.index === "number") {
    const snap = activeSimulator.currentSnapshot();
    const current = snap.di[msg.index] ?? false;
    activeSimulator.setDi(msg.index, !current);
    lastSnapJson = "";
    postToPanel({ type: "snapshot", snap: activeSimulator.currentSnapshot() });
    return;
  }
  if (msg.type === "setAi" && typeof msg.index === "number") {
    const value = typeof msg.value === "number" && Number.isFinite(msg.value) ? msg.value : 0;
    activeSimulator.setAi(msg.index, value);
    lastSnapJson = "";
    postToPanel({ type: "snapshot", snap: activeSimulator.currentSnapshot() });
    return;
  }
  if (msg.type === "setVar" && typeof msg.programId === "string" && typeof msg.name === "string") {
    const variable = activeContext?.programs
      .find((p) => p.id === msg.programId)
      ?.variables.find((v) => v.name === msg.name);
    activeSimulator.setVar(pouIrName(msg.programId, msg.name), coerceVarValue(variable?.type, msg.value));
    lastSnapJson = "";
    postToPanel({ type: "snapshot", snap: activeSimulator.currentSnapshot() });
  }
}

function ensurePanel(context: vscode.ExtensionContext): vscode.WebviewPanel {
  if (activePanel) {
    activePanel.reveal(vscode.ViewColumn.Beside);
    return activePanel;
  }
  activePanel = vscode.window.createWebviewPanel(
    VIEW_TYPE,
    "NanoPLC Simulator",
    vscode.ViewColumn.Beside,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "media", "simulator")],
    }
  );
  activePanel.onDidDispose(() => {
    activePanel = undefined;
    activeContext = undefined;
    void stopSimulation();
  });
  activePanel.webview.onDidReceiveMessage((msg: Record<string, unknown>) => {
    handleWebviewMessage(msg);
  });
  activePanel.webview.html = renderHtml(activePanel.webview);
  context.subscriptions.push(activePanel);
  return activePanel;
}

let lastSnapJson = "";
let lastPanelUpdate = 0;

function onSimulatorTick(snap: SimulatorSnapshot): void {
  statusBarItem?.show();
  if (statusBarItem) {
    statusBarItem.text = `$(pulse) NanoPLC sim · scan ${snap.scan_index}`;
    statusBarItem.tooltip = `Elapsed ${snap.elapsed_ms} ms`;
  }

  const now = Date.now();
  const snapJson = JSON.stringify(snap);
  if (snapJson !== lastSnapJson && now - lastPanelUpdate >= getRefreshMs()) {
    lastSnapJson = snapJson;
    lastPanelUpdate = now;
    postToPanel({ type: "snapshot", snap });
  }
}

export async function startSimulation(context: vscode.ExtensionContext): Promise<void> {
  if (activeSimulator?.running) {
    void vscode.window.showInformationMessage("NanoPLC: Simulation is already running.");
    return;
  }

  const location = await pickProjectLocation();
  if (!location) {
    return;
  }

  const ir = loadIr(location.rootPath);
  if (!ir) {
    const compile = "Compile PLC program";
    const choice = await vscode.window.showWarningMessage(
      "NanoPLC: build/ir.json not found. Compile the project first.",
      compile
    );
    if (choice === compile) {
      await vscode.commands.executeCommand("nanoplc.compileProgram");
    }
    return;
  }

  extensionUri = context.extensionUri;
  workspaceState = context.workspaceState;
  const simContext = loadSimContext(location.rootPath, ir);
  activeContext = simContext;
  activeSimulator = new PlcSimulator(ir, ioCapacityFromProfile(simContext.ioProfile));
  lastSnapJson = "";
  lastPanelUpdate = 0;
  ensurePanel(context);
  postInit();
  activeSimulator.start((snap) => onSimulatorTick(snap));
  void vscode.window.showInformationMessage(
    `NanoPLC: Simulation started (${ir.project.scan_period_ms} ms scan). Add I/O or variables in the Simulator panel.`
  );
}

export async function stopSimulation(): Promise<void> {
  activeSimulator?.stop();
  activeSimulator = undefined;
  if (statusBarItem) {
    statusBarItem.text = "$(debug-stop) NanoPLC sim stopped";
  }
  void vscode.window.showInformationMessage("NanoPLC: Simulation stopped.");
}

export function registerSimulator(context: vscode.ExtensionContext): vscode.Disposable {
  extensionUri = context.extensionUri;
  workspaceState = context.workspaceState;
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 90);
  statusBarItem.command = "nanoplc.stopSimulation";
  statusBarItem.text = "$(debug-stop) NanoPLC sim stopped";
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  return vscode.Disposable.from(
    vscode.commands.registerCommand("nanoplc.startSimulation", () => {
      void startSimulation(context);
    }),
    vscode.commands.registerCommand("nanoplc.stopSimulation", () => {
      void stopSimulation();
    })
  );
}

export function disposeSimulator(): void {
  activeSimulator?.stop();
  activePanel?.dispose();
}
