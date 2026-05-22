import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";

import type { NanoPlcProject } from "@nanoplc/ir-schema";

import { buildIdfTerminalCommand, resolveExportScriptPath, resolveFirmwareRoot } from "../idfPaths";
import { ensureProjectFirmwareTree } from "./scaffoldFirmware";

export function resolveProjectFirmwareRoot(
  projectRoot: string,
  project: NanoPlcProject
): string | undefined {
  const candidates: string[] = [];

  if (project.firmware_root) {
    candidates.push(path.resolve(projectRoot, project.firmware_root));
  }

  const wsFirmware = resolveFirmwareRoot();
  if (wsFirmware) {
    candidates.push(wsFirmware);
  }

  for (const fwRoot of candidates) {
    if (fs.existsSync(path.join(fwRoot, "CMakeLists.txt"))) {
      return fwRoot;
    }
  }

  return undefined;
}

export function resolveProjectIdfTarget(project: NanoPlcProject): string {
  const fromProject = project.device.idf_target?.trim();
  if (fromProject) {
    return fromProject;
  }
  return vscode.workspace.getConfiguration("nanoplc-idf").get<string>("buildTarget", "esp32s3");
}

export function readSdkconfigTarget(firmwareRoot: string): string | undefined {
  const sdkconfig = path.join(firmwareRoot, "sdkconfig");
  if (!fs.existsSync(sdkconfig)) {
    return undefined;
  }
  const text = fs.readFileSync(sdkconfig, "utf8");
  const match = text.match(/^CONFIG_IDF_TARGET="([^"]+)"/m);
  return match?.[1];
}

export function buildIdfSteps(idfTarget: string, firmwareRoot: string): string[] {
  const steps: string[] = [];
  const current = readSdkconfigTarget(firmwareRoot);
  if (current !== idfTarget) {
    steps.push(`set-target ${idfTarget}`);
  }
  steps.push("build");
  return steps;
}

export function buildIdfPipelineCommand(firmwareRoot: string, idfSteps: string[]): string {
  const sep = process.platform === "win32" ? "; " : " && ";
  const idfCalls = idfSteps.map((args) => `idf.py ${args}`).join(sep);
  const exportScript = resolveExportScriptPath();
  const q = (p: string) => `"${p.replace(/"/g, '\\"')}"`;

  if (process.platform === "win32") {
    return `. ${q(exportScript)}; Set-Location ${q(firmwareRoot)}; ${idfCalls}`;
  }
  return `. ${q(exportScript)} && cd ${q(firmwareRoot)} && ${idfCalls}`;
}

export function runIdfPipelineInTerminal(
  terminalName: string,
  firmwareRoot: string,
  idfSteps: string[]
): vscode.Terminal {
  const term =
    vscode.window.terminals.find((t) => t.name === terminalName) ??
    vscode.window.createTerminal({ name: terminalName, cwd: firmwareRoot });
  term.show();
  term.sendText(buildIdfPipelineCommand(firmwareRoot, idfSteps));
  return term;
}

export function tryBuildFirmwareAfterCompile(
  projectRoot: string,
  project: NanoPlcProject
): { ok: boolean; message: string; idfSteps?: string[]; firmwareRoot?: string; idfTarget?: string } {
  const enabled = vscode.workspace
    .getConfiguration("nanoplc")
    .get<boolean>("buildFirmwareOnCompile", true);
  if (!enabled) {
    return { ok: true, message: "Firmware build skipped (nanoplc.buildFirmwareOnCompile is false)." };
  }

  const firmwareRoot = resolveProjectFirmwareRoot(projectRoot, project);
  if (!firmwareRoot) {
    const tree = ensureProjectFirmwareTree(projectRoot, project);
    if (!tree.ok || !tree.firmwareRoot) {
      return {
        ok: false,
        message: tree.message,
      };
    }
  }

  const resolvedRoot = resolveProjectFirmwareRoot(projectRoot, project);
  if (!resolvedRoot) {
    return {
      ok: false,
      message: "Firmware tree not found after init.",
    };
  }

  const exportScript = resolveExportScriptPath();
  if (!fs.existsSync(exportScript)) {
    return {
      ok: false,
      message: `ESP-IDF export script not found at ${exportScript}. Run NanoPLC: Setup ESP-IDF toolchain.`,
    };
  }

  const idfTarget = resolveProjectIdfTarget(project);
  const idfSteps = buildIdfSteps(idfTarget, resolvedRoot);
  runIdfPipelineInTerminal("NanoPLC Build", resolvedRoot, idfSteps);

  const deviceLabel = project.device.model ?? project.device.board;
  const stepSummary = idfSteps.join(", ");
  return {
    ok: true,
    message: `Building firmware for ${deviceLabel} (${idfTarget}): ${stepSummary}`,
    idfSteps,
    firmwareRoot: resolvedRoot,
    idfTarget,
  };
}

/** Legacy single-step idf.py command (workspace firmware root only). */
export function runIdfInTerminal(
  terminalName: string,
  idfArgs: string,
  firmwareRoot: string
): vscode.Terminal {
  const term =
    vscode.window.terminals.find((t) => t.name === terminalName) ??
    vscode.window.createTerminal({ name: terminalName, cwd: firmwareRoot });
  term.show();
  term.sendText(buildIdfTerminalCommand(firmwareRoot, idfArgs));
  return term;
}
