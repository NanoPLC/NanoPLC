import * as vscode from "vscode";

import * as powershellProfileEspIdf from "./powershellProfileEspIdf";
import * as setupToolchain from "./setupToolchain";

const CONFIG_SECTION = "nanoplc";

export function activate(context: vscode.ExtensionContext): void {
  const disposable = vscode.commands.registerCommand("nanoplc.showTargetInfo", () => {
    const cfg = vscode.workspace.getConfiguration(CONFIG_SECTION);
    const target = cfg.get<string>("targetChip", "esp32-s3");
    const detail =
      `Target chip (setting ${CONFIG_SECTION}.targetChip): ${target}.\n\n` +
      "Hook up an ST/LAD/FBD transpiler to C and your toolchain (ESP-IDF, Arduino, Zephyr, etc.) here.";

    void vscode.window.showInformationMessage("NanoPLC", { modal: true, detail });
  });

  context.subscriptions.push(
    disposable,
    setupToolchain.registerSetupToolchain(context),
    setupToolchain.registerCheckToolchain(),
    powershellProfileEspIdf.registerAddEspIdfToPowerShellProfile()
  );
}

export function deactivate(): void {}
