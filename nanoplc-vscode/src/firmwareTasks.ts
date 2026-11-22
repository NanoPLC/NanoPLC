import * as childProcess from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";

import type { NanoPlcProject } from "@nanoplc/ir-schema";

import { resolveExportScriptPath, resolveFirmwareRoot } from "./idfPaths";
import {
  pickProjectLocation,
  readJsonFile,
} from "./project/projectPaths";
import { ensureProjectFirmwareTree } from "./project/scaffoldFirmware";
import {
  buildIdfSteps,
  resolveProjectFirmwareRoot,
  resolveProjectIdfTarget,
  runIdfInTerminal,
  runIdfPipelineInTerminal,
} from "./project/projectFirmware";
import { compileProjectAt } from "./project/compileProgram";
import {
  flushPendingFbdDocumentEdits,
  saveDirtyFbdDocuments,
} from "./fbdEditor/fbdEditorProvider";
import { ensureToolchainReady } from "./toolchainOnboarding";

const OUTPUT_CHANNEL = "NanoPLC Firmware";

interface FirmwareContext {
  firmwareRoot: string;
  projectRoot?: string;
  project?: NanoPlcProject;
}

function output(): vscode.OutputChannel {
  return vscode.window.createOutputChannel(OUTPUT_CHANNEL);
}

async function resolveFirmwareContext(useProject: boolean): Promise<FirmwareContext | undefined> {
  if (!vscode.workspace.workspaceFolders?.length) {
    void vscode.window.showErrorMessage("NanoPLC: Open a workspace folder before building firmware.");
    return undefined;
  }

  if (useProject) {
    const location = await pickProjectLocation();
    if (!location) {
      return undefined;
    }

    const project = readJsonFile<NanoPlcProject>(path.join(location.rootPath, "nanoplc.project.json"));
    let firmwareRoot = resolveProjectFirmwareRoot(location.rootPath, project);
    if (!firmwareRoot) {
      const tree = ensureProjectFirmwareTree(location.rootPath, project);
      if (!tree.ok || !tree.firmwareRoot) {
        void vscode.window.showErrorMessage(`NanoPLC: ${tree.message}`);
        return undefined;
      }
      firmwareRoot = tree.firmwareRoot;
      if (tree.created) {
        void vscode.window.showInformationMessage(`NanoPLC: ${tree.message}`);
      }
    }

    if (!(await ensureToolchainReady())) {
      return undefined;
    }

    return { firmwareRoot, projectRoot: location.rootPath, project };
  }

  const firmwareRoot = resolveFirmwareRoot();
  if (!firmwareRoot) {
    void vscode.window.showErrorMessage(
      `NanoPLC: Firmware folder not found. Check nanoplc.firmwareRoot or add firmware_root to the project.`
    );
    return undefined;
  }

  if (!(await ensureToolchainReady())) {
    return undefined;
  }

  return { firmwareRoot };
}

function logIdfVersion(channel: vscode.OutputChannel): void {
  const proc = childProcess.spawn("idf.py", ["--version"], {
    shell: true,
    windowsHide: true,
  });
  let text = "";
  proc.stdout?.on("data", (c) => {
    text += String(c);
  });
  proc.stderr?.on("data", (c) => {
    text += String(c);
  });
  proc.on("close", (code) => {
    channel.appendLine(
      code === 0
        ? `[idf.py --version] ${text.trim()}`
        : `[idf.py --version] failed (exit ${code}). Activate ESP-IDF export in the terminal first.`
    );
    channel.show(true);
  });
}

function registerIdfCommand(
  commandId: string,
  terminalName: string,
  idfArgs: string,
  useProject = false
): vscode.Disposable {
  return vscode.commands.registerCommand(commandId, async () => {
    const ctx = await resolveFirmwareContext(useProject);
    if (!ctx) {
      return;
    }
    runIdfInTerminal(terminalName, idfArgs, ctx.firmwareRoot);
  });
}

export function registerFirmwareTasks(_context: vscode.ExtensionContext): vscode.Disposable {
  const channel = output();

  const disposables: vscode.Disposable[] = [
    vscode.commands.registerCommand("nanoplc.firmwareBuild", async () => {
      const ctx = await resolveFirmwareContext(true);
      if (!ctx?.project || !ctx.projectRoot) {
        return;
      }

      // Persist the open FBD graph, then compile (I/O channel checks included).
      await flushPendingFbdDocumentEdits();
      await saveDirtyFbdDocuments(ctx.projectRoot);
      const compiled = await compileProjectAt(ctx.projectRoot, {
        buildFirmware: false,
        quietSuccess: true,
      });
      if (!compiled) {
        return;
      }

      const idfTarget = resolveProjectIdfTarget(ctx.project);
      const idfSteps = buildIdfSteps(idfTarget, ctx.firmwareRoot);
      runIdfPipelineInTerminal("NanoPLC Build", ctx.firmwareRoot, idfSteps);

      const deviceLabel = ctx.project.device.model ?? ctx.project.device.board;
      void vscode.window.showInformationMessage(
        `NanoPLC: Building firmware for ${deviceLabel} (${idfTarget}): ${idfSteps.join(", ")}`
      );
    }),
    registerIdfCommand("nanoplc.firmwareFlash", "NanoPLC Flash", "flash", true),
    registerIdfCommand("nanoplc.firmwareMonitor", "NanoPLC Monitor", "monitor", true),
    vscode.commands.registerCommand("nanoplc.firmwareFlashMonitor", async () => {
      const ctx = await resolveFirmwareContext(true);
      if (!ctx) {
        return;
      }
      runIdfInTerminal("NanoPLC Flash+Monitor", "flash monitor", ctx.firmwareRoot);
    }),
    vscode.commands.registerCommand("nanoplc.firmwareSetTarget", async () => {
      const ctx = await resolveFirmwareContext(true);
      if (!ctx?.project) {
        return;
      }
      const target = resolveProjectIdfTarget(ctx.project);
      runIdfInTerminal("NanoPLC Set target", `set-target ${target}`, ctx.firmwareRoot);
    }),
    vscode.commands.registerCommand("nanoplc.firmwareDiagnose", () => {
      channel.clear();
      channel.appendLine("NanoPLC firmware environment");
      channel.appendLine(`  workspace firmware root: ${resolveFirmwareRoot() ?? "(not found)"}`);
      channel.appendLine(`  export script: ${resolveExportScriptPath()}`);
      channel.appendLine(
        `  export exists: ${fs.existsSync(resolveExportScriptPath()) ? "yes" : "no"}`
      );
      logIdfVersion(channel);
    }),
  ];

  return vscode.Disposable.from(...disposables);
}
