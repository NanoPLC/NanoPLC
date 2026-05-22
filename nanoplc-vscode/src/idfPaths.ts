import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";

const SETTINGS = {
  firmwareRoot: "nanoplc.firmwareRoot",
  distRoot: "nanoplc-idf.distRoot",
  idfSetupScript: "nanoplc-idf.idfSetupScript",
} as const;

function wsConfig(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration();
}

export function defaultDistRoot(): string {
  return path.join(os.homedir(), ".nanoplc");
}

export function resolveDistRoot(): string {
  const raw = wsConfig().get<string>(SETTINGS.distRoot);
  if (raw != null && raw.trim() !== "") {
    return raw.trim();
  }
  return defaultDistRoot();
}

/** Absolute path to export.ps1 (Windows) or export.sh (Unix). */
export function resolveExportScriptPath(): string {
  const cfg = wsConfig().get<string>(SETTINGS.idfSetupScript);
  if (cfg != null && cfg.trim() !== "") {
    return cfg.trim();
  }
  const scriptName = process.platform === "win32" ? "export.ps1" : "export.sh";
  return path.join(resolveDistRoot(), "esp-idf", scriptName);
}

/** Workspace-relative firmware folder (default `firmware`). */
export function firmwareRootSetting(): string {
  return wsConfig().get<string>(SETTINGS.firmwareRoot, "firmware").trim() || "firmware";
}

/**
 * Absolute path to the ESP-IDF app root under the first workspace folder.
 * Returns undefined when no folder is open or the path is missing on disk.
 */
export function resolveFirmwareRoot(): string | undefined {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    return undefined;
  }
  const abs = path.join(folder.uri.fsPath, firmwareRootSetting());
  if (!fs.existsSync(abs)) {
    return undefined;
  }
  return abs;
}

export function quoteShellPath(p: string): string {
  return `"${p.replace(/"/g, '\\"')}"`;
}

/** One line to source ESP-IDF export script and run idf.py with args in firmwareRoot. */
export function buildIdfTerminalCommand(firmwareRoot: string, idfArgs: string): string {
  const exportScript = resolveExportScriptPath();
  const q = quoteShellPath;

  if (process.platform === "win32") {
    return `. ${q(exportScript)}; Set-Location ${q(firmwareRoot)}; idf.py ${idfArgs}`;
  }
  return `. ${q(exportScript)} && cd ${q(firmwareRoot)} && idf.py ${idfArgs}`;
}
