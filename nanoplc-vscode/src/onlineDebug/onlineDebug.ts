import * as childProcess from "child_process";
import * as path from "path";
import * as vscode from "vscode";

import type { NanoPlcProject } from "@nanoplc/ir-schema";

import { buildIdfTerminalCommand, quoteShellPath, resolveExportScriptPath } from "../idfPaths";
import { resolveProjectFirmwareRoot } from "../project/projectFirmware";
import { pickProjectLocation, readJsonFile } from "../project/projectPaths";
import { ensureToolchainReady } from "../toolchainOnboarding";
import { parseNp1Line, type OnlineSnapshot } from "./protocol";

let monitorProc: childProcess.ChildProcess | undefined;
let panel: vscode.WebviewPanel | undefined;
let lastSnap: OnlineSnapshot | undefined;
let status: vscode.StatusBarItem | undefined;

function ensureStatus(): vscode.StatusBarItem {
  if (!status) {
    status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 95);
    status.command = "nanoplc.attachOnlineDebug";
  }
  return status;
}

function renderHtml(snap: OnlineSnapshot | undefined, connected: boolean): string {
  const rows: string[] = [];
  if (snap) {
    rows.push(`<tr><td colspan="2"><b>seq</b> ${snap.seq} · magic 0x${snap.magic.toString(16)}</td></tr>`);
    snap.di.forEach((v, i) => rows.push(`<tr><td>DI[${i}]</td><td>${v ? "TRUE" : "FALSE"}</td></tr>`));
    snap.do.forEach((v, i) => rows.push(`<tr><td>DO[${i}]</td><td>${v ? "TRUE" : "FALSE"}</td></tr>`));
    snap.ai.forEach((v, i) => rows.push(`<tr><td>AI[${i}]</td><td>${v}</td></tr>`));
    for (const [name, value] of Object.entries(snap.vars)) {
      const shown = typeof value === "boolean" ? (value ? "TRUE" : "FALSE") : String(value);
      rows.push(`<tr><td>${name}</td><td>${shown}</td></tr>`);
    }
  }
  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8" />
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 12px; }
  table { border-collapse: collapse; width: 100%; }
  td { padding: 4px 8px; border-bottom: 1px solid var(--vscode-widget-border); }
  .muted { opacity: 0.7; }
</style></head>
<body>
  <h2>Online debug (UART)</h2>
  <p class="muted">${connected ? "Listening for #NP1 frames…" : "Disconnected."} Read-only telemetry.</p>
  <table>${rows.join("") || "<tr><td class='muted'>No snapshot yet</td></tr>"}</table>
</body></html>`;
}

function showPanel(extensionUri: vscode.Uri): void {
  if (!panel) {
    panel = vscode.window.createWebviewPanel(
      "nanoplc.onlineDebug",
      "NanoPLC Online Debug",
      vscode.ViewColumn.Beside,
      { enableScripts: false, retainContextWhenHidden: true }
    );
    panel.onDidDispose(() => {
      panel = undefined;
    });
  }
  panel.webview.html = renderHtml(lastSnap, monitorProc !== undefined);
  panel.reveal(vscode.ViewColumn.Beside, true);
}

function stopMonitor(): void {
  if (monitorProc) {
    monitorProc.kill();
    monitorProc = undefined;
  }
  const bar = ensureStatus();
  bar.text = "$(debug-disconnect) NanoPLC online: stopped";
  bar.show();
  if (panel) {
    panel.webview.html = renderHtml(lastSnap, false);
  }
}

function onLine(line: string, extensionUri: vscode.Uri): void {
  const snap = parseNp1Line(line);
  if (!snap) {
    return;
  }
  lastSnap = snap;
  showPanel(extensionUri);
  const bar = ensureStatus();
  bar.text = `$(debug-alt) NanoPLC online seq ${snap.seq}`;
  bar.show();
}

async function startMonitor(firmwareRoot: string, extensionUri: vscode.Uri): Promise<void> {
  stopMonitor();
  if (!(await ensureToolchainReady())) {
    return;
  }

  const exportScript = resolveExportScriptPath();
  const idfCmd = buildIdfTerminalCommand(firmwareRoot, "monitor");

  let command: string;
  let args: string[];
  if (process.platform === "win32") {
    command = "powershell.exe";
    args = ["-NoProfile", "-Command", idfCmd];
  } else {
    command = "bash";
    args = ["-lc", idfCmd];
  }

  monitorProc = childProcess.spawn(command, args, {
    cwd: firmwareRoot,
    shell: false,
    windowsHide: true,
    env: { ...process.env },
  });

  let buffer = "";
  const feed = (chunk: Buffer | string): void => {
    buffer += String(chunk);
    const parts = buffer.split(/\r?\n/);
    buffer = parts.pop() ?? "";
    for (const line of parts) {
      onLine(line, extensionUri);
    }
  };

  monitorProc.stdout?.on("data", feed);
  monitorProc.stderr?.on("data", feed);
  monitorProc.on("exit", () => {
    monitorProc = undefined;
    const bar = ensureStatus();
    bar.text = "$(debug-disconnect) NanoPLC online: monitor exited";
    bar.show();
    if (panel) {
      panel.webview.html = renderHtml(lastSnap, false);
    }
  });

  showPanel(extensionUri);
  void vscode.window.showInformationMessage(
    `NanoPLC: Online debug attached (export ${quoteShellPath(exportScript)}). Watching for #NP1 frames.`
  );
}

export function registerOnlineDebug(context: vscode.ExtensionContext): vscode.Disposable {
  const bar = ensureStatus();
  bar.text = "$(debug-disconnect) NanoPLC online";
  bar.tooltip = "Attach online debug (UART telemetry)";
  bar.show();

  const disposables = [
    bar,
    vscode.commands.registerCommand("nanoplc.attachOnlineDebug", async () => {
      const location = await pickProjectLocation();
      if (!location) {
        return;
      }
      const project = readJsonFile<NanoPlcProject>(
        path.join(location.rootPath, "nanoplc.project.json")
      );
      const firmwareRoot = resolveProjectFirmwareRoot(location.rootPath, project);
      if (!firmwareRoot) {
        void vscode.window.showErrorMessage(
          "NanoPLC: Firmware tree not found. Init firmware or set firmware_root."
        );
        return;
      }
      await startMonitor(firmwareRoot, context.extensionUri);
    }),
    vscode.commands.registerCommand("nanoplc.detachOnlineDebug", () => {
      stopMonitor();
      void vscode.window.showInformationMessage("NanoPLC: Online debug detached.");
    }),
  ];

  context.subscriptions.push(...disposables);
  return vscode.Disposable.from(...disposables);
}

export function disposeOnlineDebug(): void {
  stopMonitor();
  panel?.dispose();
  panel = undefined;
  status?.dispose();
  status = undefined;
}
