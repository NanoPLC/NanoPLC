import * as childProcess from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";

import { clearToolchainOnboardingDismiss } from "./toolchainOnboarding";

const SETTINGS = {
  distRoot: "nanoplc-idf.distRoot",
  idfRelease: "nanoplc-idf.idfRelease",
  idfSetupScript: "nanoplc-idf.idfSetupScript",
  buildTarget: "nanoplc-idf.buildTarget",
} as const;

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

export function registerSetupToolchain(
  context: vscode.ExtensionContext
): vscode.Disposable {
  return vscode.commands.registerCommand("nanoplc.setupToolchain", async () => {
    const cfg = wsConfig();
    const distRoot = resolveDistRoot();
    const idfRelease = cfg.get<string>(SETTINGS.idfRelease) ?? "v5.3.3";
    const buildTarget = cfg.get<string>(SETTINGS.buildTarget) ?? "esp32s3";

    const ps1 = path.join(context.extensionPath, "scripts", "bootstrap-idf.ps1");
    const sh = path.join(context.extensionPath, "scripts", "bootstrap-idf.sh");

    if (process.platform === "win32") {
      if (!fs.existsSync(ps1)) {
        void vscode.window.showErrorMessage(`NanoPLC: bootstrap script missing: ${ps1}`);
        return;
      }
    } else {
      if (!fs.existsSync(sh)) {
        void vscode.window.showErrorMessage(`NanoPLC: bootstrap script missing: ${sh}`);
        return;
      }
    }

    const picked = await vscode.window.showWarningMessage(
      "NanoPLC will clone ESP-IDF and run Espressif install scripts. Expect large downloads over the internet (several GB) and lengthy execution. Proceed?",
      { modal: true },
      "Continue"
    );
    if (picked !== "Continue") {
      return;
    }

    try {
      fs.mkdirSync(distRoot, { recursive: true });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      void vscode.window.showErrorMessage(
        `NanoPLC: could not create toolchain directory "${distRoot}": ${msg}`
      );
      return;
    }

    const term = vscode.window.createTerminal({
      name: "NanoPLC ESP-IDF setup",
      cwd: distRoot,
    });
    term.show();

    const q = (p: string) => `"${p.replace(/"/g, '\\"')}"`;

    void clearToolchainOnboardingDismiss();

    if (process.platform === "win32") {
      const cmd =
        `powershell -NoProfile -ExecutionPolicy Bypass -File ${q(ps1)} ` +
        `-InstallRoot ${q(distRoot)} -IdfTag ${q(idfRelease)} -Target ${q(buildTarget)}`;
      term.sendText(cmd);
      return;
    }

    /** Run bundled shell script explicitly with bash — packaged files may lose executable bits */
    term.sendText(
      `mkdir -p ${q(distRoot)} && bash ${q(sh)} ${q(distRoot)} ${q(idfRelease)} ${q(buildTarget)}`
    );
  });
}

/** Validates whether `idf.py` resolves on PATH (typically after exporting the ESP-IDF environment). */
export function registerCheckToolchain(): vscode.Disposable {
  return vscode.commands.registerCommand("nanoplc.checkToolchain", () => {
    const proc = childProcess.spawn("idf.py", ["--version"], {
      shell: true,
      windowsHide: true,
    });
    let out = "";
    proc.stdout?.on("data", (c) => {
      out += String(c);
    });
    proc.stderr?.on("data", (c) => {
      out += String(c);
    });
    proc.on("close", (code) => {
      void (async () => {
        const setup = wsConfig().get<string>(SETTINGS.idfSetupScript) ?? "(unset)";
        const hint =
          '\nCannot find idf.py. Run "NanoPLC: Setup ESP-IDF toolchain" again or manually source the script stored in nanoplc-idf.idfSetupScript ' +
          `(currently: ${setup}).`;
        if (code === 0) {
          await vscode.window.showInformationMessage(`idf.py: ${out.trim() || "OK"}`);
        } else {
          const addProfile =
            process.platform === "win32"
              ? "Add ESP-IDF to PowerShell profile"
              : undefined;
          const choice = await vscode.window.showWarningMessage(
            `idf.py is missing or failed (exit ${code}).${hint}`,
            { modal: true },
            ...(addProfile ? [addProfile] : [])
          );
          if (choice === addProfile) {
            await vscode.commands.executeCommand("nanoplc.addEspIdfToPowerShellProfile");
          }
        }
      })();
    });
  });
}
