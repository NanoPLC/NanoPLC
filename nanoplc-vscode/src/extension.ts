import "./modulePaths";
import * as vscode from "vscode";

import * as fbdEditor from "./fbdEditor/fbdEditorProvider";
import * as firmwareTasks from "./firmwareTasks";
import * as powershellProfileEspIdf from "./powershellProfileEspIdf";
import * as compileProgram from "./project/compileProgram";
import * as deviceTreeCommands from "./project/deviceTreeCommands";
import * as taskCommands from "./project/taskCommands";
import * as codegenFirmware from "./project/codegenFirmware";
import * as scaffoldFirmware from "./project/scaffoldFirmware";
import * as projectTree from "./project/projectTree";
import * as simulatorPanel from "./simulator/simulatorPanel";
import * as setupToolchain from "./setupToolchain";
import {
  maybePromptToolchainOnActivate,
  setToolchainOnboardingContext,
} from "./toolchainOnboarding";

const CONFIG_SECTION = "nanoplc";

export function activate(context: vscode.ExtensionContext): void {
  scaffoldFirmware.setExtensionPathForFirmware(context.extensionPath);
  setToolchainOnboardingContext(context);
  maybePromptToolchainOnActivate(context);

  const disposable = vscode.commands.registerCommand("nanoplc.showTargetInfo", () => {
    const cfg = vscode.workspace.getConfiguration(CONFIG_SECTION);
    const target = cfg.get<string>("targetChip", "esp32-s3");
    const detail =
      `Target chip (setting ${CONFIG_SECTION}.targetChip): ${target}.\n\n` +
      "Hook up an ST/LAD/FBD transpiler to C and your toolchain (ESP-IDF, Arduino, Zephyr, etc.) here.";

    void vscode.window.showInformationMessage("NanoPLC", { modal: true, detail });
  });

  context.subscriptions.push(
    compileProgram.registerCreateProject(),
    disposable,
    setupToolchain.registerSetupToolchain(context),
    setupToolchain.registerCheckToolchain(),
    powershellProfileEspIdf.registerAddEspIdfToPowerShellProfile(),
    firmwareTasks.registerFirmwareTasks(context),
    compileProgram.registerCompileProgram(context),
    projectTree.registerProjectTree(context),
    deviceTreeCommands.registerDeviceTreeCommands(context),
    taskCommands.registerTaskCommands(context),
    simulatorPanel.registerSimulator(context),
    codegenFirmware.registerCodegenFirmware(),
    scaffoldFirmware.registerInitFirmwareTree(),
    fbdEditor.registerFbdEditor(context)
  );
}

export function deactivate(): void {
  simulatorPanel.disposeSimulator();
}
