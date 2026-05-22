import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";

import { IR_VERSION, PlcSimulator, type PlcIr, type SimulatorSnapshot } from "@nanoplc/ir-schema";

import { pickProjectLocation, readJsonFile } from "../project/projectPaths";

const VIEW_TYPE = "nanoplc.simulatorIo";

let activeSimulator: PlcSimulator | undefined;
let activePanel: vscode.WebviewPanel | undefined;
let statusBarItem: vscode.StatusBarItem | undefined;

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

function renderHtml(ir: PlcIr, snap: SimulatorSnapshot): string {
  const diRows = ir.io_image.di
    .map((d) => {
      const val = snap.di[d.index] ?? false;
      return `<tr>
        <td>${escapeHtml(d.symbol)}</td>
        <td>${d.index}</td>
        <td><button class="di-toggle" data-index="${d.index}">${val ? "TRUE" : "FALSE"}</button></td>
      </tr>`;
    })
    .join("");

  const doRows = ir.io_image.do
    .map((d) => {
      const val = snap.do[d.index] ?? false;
      const cls = val ? "on" : "off";
      return `<tr>
        <td>${escapeHtml(d.symbol)}</td>
        <td>${d.index}</td>
        <td class="${cls}">${val ? "TRUE" : "FALSE"}</td>
      </tr>`;
    })
    .join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-nanoplc';" />
  <style>
    body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 12px; }
    h2 { font-size: 1em; margin: 16px 0 8px; }
    table { border-collapse: collapse; width: 100%; }
    th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--vscode-panel-border); }
    button.di-toggle { min-width: 72px; cursor: pointer; }
    td.on { color: var(--vscode-testing-iconPassed); font-weight: 600; }
    td.off { color: var(--vscode-descriptionForeground); }
    .meta { font-size: 0.9em; color: var(--vscode-descriptionForeground); margin-bottom: 12px; }
  </style>
</head>
<body>
  <div class="meta">Scan #${snap.scan_index} · ${snap.elapsed_ms} ms elapsed · period ${ir.project.scan_period_ms} ms</div>
  <h2>Digital inputs (click to toggle)</h2>
  <table>
    <thead><tr><th>Symbol</th><th>Index</th><th>Value</th></tr></thead>
    <tbody>${diRows || "<tr><td colspan='3'>No DI mapped</td></tr>"}</tbody>
  </table>
  <h2>Digital outputs</h2>
  <table>
    <thead><tr><th>Symbol</th><th>Index</th><th>Value</th></tr></thead>
    <tbody>${doRows || "<tr><td colspan='3'>No DO mapped</td></tr>"}</tbody>
  </table>
  <script nonce="nanoplc">
    const vscode = acquireVsCodeApi();
    document.querySelectorAll(".di-toggle").forEach((btn) => {
      btn.addEventListener("click", () => {
        vscode.postMessage({ type: "toggleDi", index: Number(btn.dataset.index) });
      });
    });
  </script>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function updatePanel(ir: PlcIr, snap: SimulatorSnapshot): void {
  if (activePanel) {
    activePanel.webview.html = renderHtml(ir, snap);
  }
}

function ensurePanel(context: vscode.ExtensionContext, ir: PlcIr): vscode.WebviewPanel {
  if (activePanel) {
    activePanel.reveal(vscode.ViewColumn.Beside);
    return activePanel;
  }
  activePanel = vscode.window.createWebviewPanel(
    VIEW_TYPE,
    "NanoPLC Simulator",
    vscode.ViewColumn.Beside,
    { enableScripts: true, retainContextWhenHidden: true }
  );
  activePanel.onDidDispose(() => {
    activePanel = undefined;
    void stopSimulation();
  });
  activePanel.webview.onDidReceiveMessage((msg: { type: string; index?: number }) => {
    if (msg.type === "toggleDi" && activeSimulator && typeof msg.index === "number") {
      const snap = activeSimulator.currentSnapshot();
      const current = snap.di[msg.index] ?? false;
      activeSimulator.setDi(msg.index, !current);
      lastSnapJson = "";
      if (activeSimulator) {
        updatePanel(ir, activeSimulator.currentSnapshot());
      }
    }
  });
  context.subscriptions.push(activePanel);
  updatePanel(ir, activeSimulator?.currentSnapshot() ?? { scan_index: 0, elapsed_ms: 0, vars: {}, di: [], do: [] });
  return activePanel;
}

let lastSnapJson = "";
let lastPanelUpdate = 0;

function onSimulatorTick(ir: PlcIr, snap: SimulatorSnapshot): void {
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
    updatePanel(ir, snap);
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

  activeSimulator = new PlcSimulator(ir);
  lastSnapJson = "";
  lastPanelUpdate = 0;
  ensurePanel(context, ir);
  activeSimulator.start((snap) => onSimulatorTick(ir, snap));
  void vscode.window.showInformationMessage(
    `NanoPLC: Simulation started (${ir.project.scan_period_ms} ms scan). Toggle inputs in the Simulator panel.`
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
