import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";

import {
  IR_VERSION,
  nextPlantDeviceId,
  parseVirtualPlant,
  PlcSimulator,
  pouIrName,
  PLANT_DEVICE_KINDS,
  type NanoPlcProject,
  type PlantDeviceKind,
  type PlcIr,
  type PlcPrimitiveType,
  type SimulatorSnapshot,
  type TransmitterProfile,
  type VirtualPlantConfig,
} from "@nanoplc/ir-schema";

import {
  ioCapacityFromProfile,
  loadEditorIoProfile,
  loadProjectPouCatalog,
  type EditorIoProfilePayload,
  type PouCatalogItem,
} from "../project/editorIoProfile";
import { pickProjectLocation, PROJECT_FILENAME, readJsonFile, writeJsonFile } from "../project/projectPaths";
import { refreshProjectTree } from "../project/deviceTreeCommands";
import { publishSimSnapshot } from "./simLive";
import { publishSimFieldbus, startSimFieldbus, stopSimFieldbus } from "./fieldbusHost";

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
  plant?: VirtualPlantConfig;
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
  const parsed = parseVirtualPlant(project.virtual_plant);
  if (project.virtual_plant !== undefined && parsed.diagnostics.length > 0) {
    void vscode.window.showWarningMessage(
      `NanoPLC: virtual plant ignored. ${parsed.diagnostics.map((d) => d.message).join(" ")}`
    );
  }
  return {
    ir,
    rootPath,
    ioProfile: loadEditorIoProfile(rootPath),
    programs: loadProjectPouCatalog(rootPath, project),
    plant: parsed.config,
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

  <section class="add-card" id="plant-card">
    <h2>Virtual plant</h2>
    <p class="hint">Devices sit on the process image. Sensors update before each scan; actuators follow digital outputs. This plant is not written into firmware.</p>
    <div id="plant-list"></div>
    <h3>Add device</h3>
    <div class="add-row">
      <select id="plant-kind">
        <option value="pushbutton">Pushbutton</option>
        <option value="switch">Switch</option>
        <option value="lamp">Lamp</option>
        <option value="transmitter">Transmitter</option>
        <option value="motor">Motor</option>
        <option value="valve">Valve</option>
        <option value="tank">Tank</option>
        <option value="conveyor">Conveyor</option>
      </select>
      <input id="plant-name" class="plant-name" type="text" placeholder="Name" />
      <button type="button" class="primary" id="btn-add-plant">Add</button>
    </div>
    <div class="add-row" id="plant-fields"></div>
    <p class="hint" id="plant-hint"></p>
  </section>

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
  <p class="hint">Force holds a value across scans. The plant and the program cannot clear it until Unforce. A watchdog outputs-off latch still turns digital outputs off.</p>
  <table>
    <thead>
      <tr><th>Kind</th><th>Location</th><th>Value</th><th>Force</th><th></th></tr>
    </thead>
    <tbody id="io-body"></tbody>
  </table>

  <h2>Watched variables</h2>
  <table>
    <thead>
      <tr><th>Class</th><th>Variable</th><th>Type</th><th>Value</th><th>Force</th><th></th></tr>
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
    task_passes: {},
    vars: {},
    di: [],
    ai: [],
    do: [],
  };
  postToPanel({
    type: "init",
    ioProfile: activeContext.ioProfile,
    programs: activeContext.programs,
    plant: activeContext.plant ?? { devices: [] },
    watches: currentWatches(),
    snap,
    scanPeriodMs: activeSimulator?.scanPeriodMs ?? activeContext.ir.project.scan_period_ms,
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

function isPlantKind(value: unknown): value is PlantDeviceKind {
  return typeof value === "string" && (PLANT_DEVICE_KINDS as readonly string[]).includes(value);
}

function isTransmitterProfile(value: unknown): value is TransmitterProfile {
  return value === "temperature" || value === "pressure" || value === "adc";
}

function optIndex(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function plantDraft(
  id: string,
  name: string,
  kind: PlantDeviceKind,
  msg: Record<string, unknown>
): Record<string, unknown> | undefined {
  const base = { id, name, kind };
  switch (kind) {
    case "pushbutton":
    case "switch": {
      const di = optIndex(msg.di);
      return di === undefined ? undefined : { ...base, di };
    }
    case "lamp": {
      const dout = optIndex(msg.do);
      return dout === undefined ? undefined : { ...base, do: dout };
    }
    case "transmitter": {
      const ai = optIndex(msg.ai);
      if (ai === undefined || !isTransmitterProfile(msg.profile)) {
        return undefined;
      }
      return { ...base, ai, profile: msg.profile };
    }
    case "motor": {
      const runDo = optIndex(msg.run_do);
      if (runDo === undefined) {
        return undefined;
      }
      return { ...base, run_do: runDo, running_di: optIndex(msg.running_di) };
    }
    case "valve": {
      const openDo = optIndex(msg.open_do);
      if (openDo === undefined) {
        return undefined;
      }
      return { ...base, open_do: openDo, opened_di: optIndex(msg.opened_di) };
    }
    case "tank": {
      const levelAi = optIndex(msg.level_ai);
      if (levelAi === undefined) {
        return undefined;
      }
      return {
        ...base,
        level_ai: levelAi,
        inlet_do: optIndex(msg.inlet_do),
        outlet_do: optIndex(msg.outlet_do),
        high_di: optIndex(msg.high_di),
        low_di: optIndex(msg.low_di),
      };
    }
    case "conveyor": {
      const runDo = optIndex(msg.run_do);
      if (runDo === undefined) {
        return undefined;
      }
      return { ...base, run_do: runDo, sensor_di: optIndex(msg.sensor_di) };
    }
  }
}

function savePlant(config: VirtualPlantConfig): void {
  if (!activeContext) {
    return;
  }
  const projectPath = path.join(activeContext.rootPath, PROJECT_FILENAME);
  const project = readJsonFile<NanoPlcProject>(projectPath);
  if (config.devices.length === 0) {
    delete project.virtual_plant;
  } else {
    project.virtual_plant = config;
  }
  writeJsonFile(projectPath, project);
  activeContext = { ...activeContext, plant: config.devices.length > 0 ? config : undefined };
  activeSimulator?.attachPlant(activeContext.plant);
  refreshProjectTree();
  postInit();
  if (activeSimulator) {
    pushSnapshot(activeSimulator.currentSnapshot());
  }
}

function addPlantDevice(msg: Record<string, unknown>): void {
  if (!activeContext || !isPlantKind(msg.kind)) {
    return;
  }
  const name = typeof msg.name === "string" ? msg.name.trim() : "";
  if (!name) {
    void vscode.window.showWarningMessage("NanoPLC: Enter a name for the virtual device.");
    return;
  }
  const existing = activeContext.plant?.devices ?? [];
  const draft = plantDraft(nextPlantDeviceId(msg.kind, existing), name, msg.kind, msg);
  if (!draft) {
    void vscode.window.showWarningMessage("NanoPLC: Choose the required I/O channel for this device.");
    return;
  }
  const parsed = parseVirtualPlant({ devices: [...existing, draft] });
  if (!parsed.config) {
    void vscode.window.showErrorMessage(
      `NanoPLC: ${parsed.diagnostics.map((d) => `${d.code} ${d.message}`).join(" ")}`
    );
    return;
  }
  savePlant(parsed.config);
}

function removePlantDevice(id: string): void {
  const devices = (activeContext?.plant?.devices ?? []).filter((device) => device.id !== id);
  savePlant({ devices });
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
  value?: boolean | number | string;
  kind?: string;
  profile?: string;
  di?: number;
  do?: number;
  ai?: number;
  run_do?: number;
  running_di?: number;
  open_do?: number;
  opened_di?: number;
  level_ai?: number;
  inlet_do?: number;
  outlet_do?: number;
  high_di?: number;
  low_di?: number;
  sensor_di?: number;
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
  if (msg.type === "addPlantDevice") {
    addPlantDevice(msg);
    return;
  }
  if (msg.type === "removePlantDevice" && typeof msg.id === "string") {
    removePlantDevice(msg.id);
    return;
  }
  if (!activeSimulator) {
    return;
  }
  if (msg.type === "setPlantControl" && typeof msg.id === "string") {
    if (msg.value === "load" || typeof msg.value === "boolean" || typeof msg.value === "number") {
      activeSimulator.setPlantControl(msg.id, msg.value);
      pushSnapshot(activeSimulator.currentSnapshot());
    }
    return;
  }
  if (msg.type === "toggleDi" && typeof msg.index === "number") {
    const snap = activeSimulator.currentSnapshot();
    const current = snap.di[msg.index] ?? false;
    activeSimulator.setDi(msg.index, !current);
    pushSnapshot(activeSimulator.currentSnapshot());
    return;
  }
  if (msg.type === "setAi" && typeof msg.index === "number") {
    const value = typeof msg.value === "number" && Number.isFinite(msg.value) ? msg.value : 0;
    activeSimulator.setAi(msg.index, value);
    pushSnapshot(activeSimulator.currentSnapshot());
    return;
  }
  if (msg.type === "setVar" && typeof msg.programId === "string" && typeof msg.name === "string") {
    const variable = activeContext?.programs
      .find((p) => p.id === msg.programId)
      ?.variables.find((v) => v.name === msg.name);
    activeSimulator.setVar(pouIrName(msg.programId, msg.name), coerceVarValue(variable?.type, msg.value));
    pushSnapshot(activeSimulator.currentSnapshot());
    return;
  }
  if (msg.type === "force") {
    applyForce(msg, true);
    return;
  }
  if (msg.type === "unforce") {
    applyForce(msg, false);
  }
}

function applyForce(
  msg: { kind?: string; index?: number; programId?: string; name?: string; value?: boolean | number | string },
  enable: boolean
): void {
  if (!activeSimulator) {
    return;
  }
  if (msg.kind === "di" && typeof msg.index === "number") {
    if (enable) {
      activeSimulator.forceDi(msg.index, msg.value === true);
    } else {
      activeSimulator.unforceDi(msg.index);
    }
  } else if (msg.kind === "do" && typeof msg.index === "number") {
    if (enable) {
      activeSimulator.forceDo(msg.index, msg.value === true);
    } else {
      activeSimulator.unforceDo(msg.index);
    }
  } else if (msg.kind === "ai" && typeof msg.index === "number") {
    if (enable) {
      const value = typeof msg.value === "number" && Number.isFinite(msg.value) ? msg.value : Number(msg.value);
      if (Number.isFinite(value)) {
        activeSimulator.forceAi(msg.index, value);
      }
    } else {
      activeSimulator.unforceAi(msg.index);
    }
  } else if (msg.kind === "var" && typeof msg.programId === "string" && typeof msg.name === "string") {
    const variable = activeContext?.programs
      .find((p) => p.id === msg.programId)
      ?.variables.find((v) => v.name === msg.name);
    if (enable) {
      activeSimulator.forceVar(pouIrName(msg.programId, msg.name), coerceVarValue(variable?.type, msg.value));
    } else {
      activeSimulator.unforceVar(pouIrName(msg.programId, msg.name));
    }
  } else {
    return;
  }
  pushSnapshot(activeSimulator.currentSnapshot());
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

function pushSnapshot(snap: SimulatorSnapshot): void {
  lastSnapJson = "";
  postToPanel({ type: "snapshot", snap });
  publishSimSnapshot(true, snap);
}

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
    publishSimSnapshot(true, snap);
  }
  publishSimFieldbus({ di: snap.di, do: snap.do, ai: snap.ai });
}

export async function startSimulation(context: vscode.ExtensionContext): Promise<void> {
  if (activeSimulator?.running) {
    ensurePanel(context);
    postInit();
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
  activeSimulator = new PlcSimulator(ir, ioCapacityFromProfile(simContext.ioProfile), simContext.plant);
  lastSnapJson = "";
  lastPanelUpdate = 0;
  ensurePanel(context);
  postInit();
  const project = readJsonFile<NanoPlcProject>(path.join(location.rootPath, PROJECT_FILENAME));
  const fieldbusLine = await startSimFieldbus(project, {
    read: () => {
      const snap = activeSimulator?.currentSnapshot();
      return { di: snap?.di ?? [], do: snap?.do ?? [], ai: snap?.ai ?? [] };
    },
    writeDi: (index, value) => {
      activeSimulator?.setDi(index, value);
      if (activeSimulator) {
        pushSnapshot(activeSimulator.currentSnapshot());
      }
    },
    writeDo: (index, value) => {
      activeSimulator?.setDo(index, value);
      if (activeSimulator) {
        pushSnapshot(activeSimulator.currentSnapshot());
      }
    },
    writeAi: (index, value) => {
      activeSimulator?.setAi(index, value);
      if (activeSimulator) {
        pushSnapshot(activeSimulator.currentSnapshot());
      }
    },
  });
  publishSimFieldbus({
    di: activeSimulator.currentSnapshot().di,
    do: activeSimulator.currentSnapshot().do,
    ai: activeSimulator.currentSnapshot().ai,
  });
  activeSimulator.start((snap) => onSimulatorTick(snap));
  const where = fieldbusLine ? ` Fieldbus: ${fieldbusLine}.` : "";
  void vscode.window.showInformationMessage(
    `NanoPLC: Simulation started (${ir.project.scan_period_ms} ms scan).${where}`
  );
}

export async function stopSimulation(): Promise<void> {
  activeSimulator?.stop();
  activeSimulator = undefined;
  await stopSimFieldbus();
  publishSimSnapshot(false);
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
  void stopSimFieldbus();
  activePanel?.dispose();
}
