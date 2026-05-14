import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";

const SETTINGS = {
  distRoot: "nanoplc-idf.distRoot",
  idfSetupScript: "nanoplc-idf.idfSetupScript",
} as const;

const MARKER_START = "# NANOPLC_ESP_IDF_PROFILE_BLOCK_START";
const MARKER_END = "# NANOPLC_ESP_IDF_PROFILE_BLOCK_END";

function wsConfig(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration();
}

function defaultDistRoot(): string {
  return path.join(os.homedir(), ".nanoplc");
}

function resolveDistRoot(): string {
  const raw = wsConfig().get<string>(SETTINGS.distRoot);
  if (raw != null && raw.trim() !== "") {
    return raw.trim();
  }
  return defaultDistRoot();
}

export function resolveExportPs1Path(): string {
  const cfg = wsConfig().get<string>(SETTINGS.idfSetupScript);
  if (cfg != null && cfg.trim() !== "") {
    return cfg.trim();
  }
  return path.join(resolveDistRoot(), "esp-idf", "export.ps1");
}

function escapePsSingleQuoted(s: string): string {
  return s.replace(/'/g, "''");
}

export function buildEspIdfProfileBlock(exportPs1Abs: string): string {
  const q = escapePsSingleQuoted(exportPs1Abs);
  return (
    `${MARKER_START}\r\n` +
    `$nanoplcEspIdfExport = '${q}'\r\n` +
    `if (Test-Path -LiteralPath $nanoplcEspIdfExport) {\r\n` +
    `    . $nanoplcEspIdfExport\r\n` +
    `}\r\n` +
    `${MARKER_END}\r\n`
  );
}

function stripExistingBlock(content: string): string {
  const esc = (m: string) => m.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`${esc(MARKER_START)}\\r?\\n[\\s\\S]*?${esc(MARKER_END)}\\r?\\n?`, "g");
  return content.replace(re, "").replace(/(?:\r?\n){3,}/g, "\r\n\r\n");
}

function powershellProfilePaths(): string[] {
  const docs = path.join(os.homedir(), "Documents");
  return [
    path.join(docs, "PowerShell", "Microsoft.PowerShell_profile.ps1"),
    path.join(docs, "WindowsPowerShell", "Microsoft.PowerShell_profile.ps1"),
  ];
}

function upsertProfileFile(profilePath: string, block: string): void {
  const dir = path.dirname(profilePath);
  fs.mkdirSync(dir, { recursive: true });

  let content = "";
  if (fs.existsSync(profilePath)) {
    content = fs.readFileSync(profilePath, "utf8");
  }
  content = stripExistingBlock(content).replace(/\s+$/, "");
  const spacer = content.length === 0 ? "" : "\r\n\r\n";
  fs.writeFileSync(profilePath, content + spacer + block, "utf8");
}

export async function addEspIdfToPowerShellProfiles(): Promise<string[]> {
  const exportPs1 = resolveExportPs1Path();
  if (!fs.existsSync(exportPs1)) {
    throw new Error(
      `export.ps1 not found at ${exportPs1}. Finish ESP-IDF install or set nanoplc-idf.idfSetupScript.`
    );
  }
  const exportAbs = path.resolve(exportPs1);
  const block = buildEspIdfProfileBlock(exportAbs);
  const written: string[] = [];
  for (const p of powershellProfilePaths()) {
    upsertProfileFile(p, block);
    written.push(p);
  }
  return written;
}

export function registerAddEspIdfToPowerShellProfile(): vscode.Disposable {
  return vscode.commands.registerCommand("nanoplc.addEspIdfToPowerShellProfile", async () => {
    if (process.platform !== "win32") {
      void vscode.window.showInformationMessage(
        "NanoPLC: PowerShell profile integration is only available on Windows."
      );
      return;
    }

    const exportPs1 = resolveExportPs1Path();
    const preview = buildEspIdfProfileBlock(path.resolve(exportPs1)).trim();

    const picked = await vscode.window.showWarningMessage(
      "NanoPLC will add or refresh an ESP-IDF snippet in your PowerShell profile(s) under Documents (Windows PowerShell and PowerShell 7). Open a new terminal afterward.",
      { modal: true, detail: preview },
      "Continue",
      "Cancel"
    );
    if (picked !== "Continue") {
      return;
    }

    try {
      const paths = await addEspIdfToPowerShellProfiles();
      void vscode.window.showInformationMessage(
        `NanoPLC: profile(s) updated. Open a new terminal. ${paths.length} file(s) written.`
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      void vscode.window.showErrorMessage(msg);
    }
  });
}
