import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";

import { codegenFirmware, type IoMap, type NanoPlcProject, type PlcIr } from "@nanoplc/ir-schema";

import { readJsonFile } from "./projectPaths";
import { ensureProjectFirmwareTree } from "./scaffoldFirmware";
import { resolveProjectFirmwareRoot } from "./projectFirmware";

export const CODEGEN_CLI_VERSION = "0.1.0";

export function resolveCodegenOutputDir(projectRoot: string, project: NanoPlcProject): string | undefined {
  const fwRoot = resolveProjectFirmwareRoot(projectRoot, project);
  if (!fwRoot) {
    return undefined;
  }

  const gen = path.join(fwRoot, "components", "nanoplc_generated");
  const plc = path.join(gen, "plc_program.c");
  if (fs.existsSync(path.dirname(plc))) {
    return gen;
  }

  return undefined;
}

export function loadIoMap(projectRoot: string): IoMap | undefined {
  const ioMapPath = path.join(projectRoot, "src", "io-map.json");
  if (!fs.existsSync(ioMapPath)) {
    return undefined;
  }
  return readJsonFile<IoMap>(ioMapPath);
}

export function writeGeneratedFirmware(
  outputDir: string,
  ir: PlcIr,
  irSha256: string,
  ioMap?: IoMap
): { plcPath: string; halPath: string; magic: number } {
  const result = codegenFirmware(ir, irSha256, ioMap);
  const plcPath = path.join(outputDir, "plc_program.c");
  const halPath = path.join(outputDir, "io_hal_config.c");
  fs.writeFileSync(plcPath, result.plc_program_c, "utf8");
  fs.writeFileSync(halPath, result.io_hal_config_c, "utf8");
  return { plcPath, halPath, magic: result.magic };
}

export function tryCodegenAfterCompile(
  projectRoot: string,
  project: NanoPlcProject,
  ir: PlcIr,
  irSha256: string
): { ok: boolean; message: string } {
  const enabled = vscode.workspace.getConfiguration("nanoplc").get<boolean>("codegenOnCompile", true);
  if (!enabled) {
    return { ok: true, message: "Codegen skipped (nanoplc.codegenOnCompile is false)." };
  }

  const tree = ensureProjectFirmwareTree(projectRoot, project);
  if (!tree.ok) {
    return { ok: false, message: tree.message };
  }

  const outDir = resolveCodegenOutputDir(projectRoot, project);
  if (!outDir) {
    return {
      ok: false,
      message: "Firmware tree not found. Set project firmware_root or nanoplc.firmwareRoot.",
    };
  }

  const { plcPath, halPath, magic } = writeGeneratedFirmware(outDir, ir, irSha256, loadIoMap(projectRoot));
  return {
    ok: true,
    message: `Generated ${path.basename(plcPath)} + ${path.basename(halPath)} (magic 0x${magic.toString(16)}) → ${outDir}`,
  };
}

export async function codegenFirmwareForProject(projectRoot: string): Promise<void> {
  const projectPath = path.join(projectRoot, "nanoplc.project.json");
  const irPath = path.join(projectRoot, "build", "ir.json");
  const manifestPath = path.join(projectRoot, "build", "generated.manifest.json");

  if (!fs.existsSync(irPath)) {
    void vscode.window.showErrorMessage("NanoPLC: build/ir.json missing. Compile the project first.");
    return;
  }

  const project = readJsonFile<NanoPlcProject>(projectPath);
  const ir = readJsonFile<PlcIr>(irPath);
  let irSha256 = "";
  if (fs.existsSync(manifestPath)) {
    const manifest = readJsonFile<{ ir_sha256?: string }>(manifestPath);
    irSha256 = manifest.ir_sha256 ?? "";
  }
  if (!irSha256) {
    irSha256 = crypto.createHash("sha256").update(JSON.stringify(ir)).digest("hex");
  }

  const result = tryCodegenAfterCompile(projectRoot, project, ir, irSha256);
  if (result.ok) {
    void vscode.window.showInformationMessage(`NanoPLC: ${result.message}`);
  } else {
    void vscode.window.showWarningMessage(`NanoPLC: ${result.message}`);
  }
}

export function registerCodegenFirmware(): vscode.Disposable {
  return vscode.commands.registerCommand("nanoplc.codegenFirmware", async () => {
    const { pickProjectLocation } = await import("./projectPaths");
    const loc = await pickProjectLocation();
    if (!loc) {
      return;
    }
    await codegenFirmwareForProject(loc.rootPath);
  });
}
