import * as fs from "fs";
import * as vscode from "vscode";

import { resolveExportScriptPath } from "./idfPaths";

const DISMISSED_KEY = "nanoplc.toolchainOnboarding.dismissed";
const ACTIVATION_PROMPTED_KEY = "nanoplc.toolchainOnboarding.activationPrompted";

let extensionContext: vscode.ExtensionContext | undefined;

export function setToolchainOnboardingContext(context: vscode.ExtensionContext): void {
  extensionContext = context;
}

export function isEspIdfExportReady(): boolean {
  return fs.existsSync(resolveExportScriptPath());
}

/**
 * Gate firmware build/flash/monitor: if the ESP-IDF export script is missing,
 * offer Setup or Open Settings. Returns true when the toolchain looks ready.
 */
export async function ensureToolchainReady(): Promise<boolean> {
  if (isEspIdfExportReady()) {
    return true;
  }

  const exportScript = resolveExportScriptPath();
  const setup = "Setup ESP-IDF toolchain";
  const openSettings = "Open Settings";
  const choice = await vscode.window.showWarningMessage(
    `NanoPLC: ESP-IDF export script not found at ${exportScript}. Set up the toolchain before building firmware, or point nanoplc-idf.idfSetupScript at an existing export.ps1 / export.sh.`,
    { modal: true },
    setup,
    openSettings
  );

  if (choice === setup) {
    await vscode.commands.executeCommand("nanoplc.setupToolchain");
    return isEspIdfExportReady();
  }
  if (choice === openSettings) {
    await vscode.commands.executeCommand(
      "workbench.action.openSettings",
      "nanoplc-idf.idfSetupScript"
    );
  }
  return false;
}

/**
 * One soft prompt after activation when the toolchain is missing (not every reload
 * after the user chooses Later).
 */
export function maybePromptToolchainOnActivate(context: vscode.ExtensionContext): void {
  if (isEspIdfExportReady()) {
    return;
  }
  if (context.globalState.get<boolean>(DISMISSED_KEY)) {
    return;
  }
  if (context.globalState.get<boolean>(ACTIVATION_PROMPTED_KEY)) {
    return;
  }

  void context.globalState.update(ACTIVATION_PROMPTED_KEY, true);
  void vscode.window
    .showInformationMessage(
      "NanoPLC: ESP-IDF toolchain is not set up yet. You will need it to build or flash firmware.",
      "Setup now",
      "Later"
    )
    .then(async (choice) => {
      if (choice === "Setup now") {
        await vscode.commands.executeCommand("nanoplc.setupToolchain");
        return;
      }
      if (choice === "Later") {
        await context.globalState.update(DISMISSED_KEY, true);
      }
    });
}

/** Clear dismiss flags after a successful setup so future missing installs prompt again. */
export async function clearToolchainOnboardingDismiss(): Promise<void> {
  if (!extensionContext) {
    return;
  }
  await extensionContext.globalState.update(DISMISSED_KEY, false);
  await extensionContext.globalState.update(ACTIVATION_PROMPTED_KEY, false);
}
