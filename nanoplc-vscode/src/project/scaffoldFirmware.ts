import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";

import type { NanoPlcProject } from "@nanoplc/ir-schema";

import { resolveProjectFirmwareRoot } from "./projectFirmware";

let extensionPath: string | undefined;

export function setExtensionPathForFirmware(p: string): void {
  extensionPath = p;
}

function resolveFirmwareTemplateRoot(): string | undefined {
  const candidates: string[] = [];
  if (extensionPath) {
    candidates.push(path.join(extensionPath, "firmware-template"));
  }
  candidates.push(path.join(__dirname, "..", "..", "firmware-template"));
  candidates.push(path.join(__dirname, "..", "..", "..", "firmware"));

  for (const root of candidates) {
    if (fs.existsSync(path.join(root, "CMakeLists.txt"))) {
      return root;
    }
  }
  return undefined;
}

function copyDirRecursive(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, ent.name);
    const to = path.join(dest, ent.name);
    if (ent.isDirectory()) {
      copyDirRecursive(from, to);
    } else {
      fs.copyFileSync(from, to);
    }
  }
}

/** Patch known template drift in firmware trees created before IDF 5.3 fixes. */
export function patchExistingFirmwareTree(firmwareRoot: string): string[] {
  const patches: string[] = [];

  const runtimeCmake = path.join(firmwareRoot, "components", "nanoplc_runtime", "CMakeLists.txt");
  if (fs.existsSync(runtimeCmake)) {
    const text = fs.readFileSync(runtimeCmake, "utf8");
    if (text.includes("esp_task_wdt")) {
      fs.writeFileSync(runtimeCmake, text.replace(/\besp_task_wdt\b/g, "esp_system"), "utf8");
      patches.push("nanoplc_runtime: esp_task_wdt → esp_system");
    }
  }

  const sdkDefaults = path.join(firmwareRoot, "sdkconfig.defaults");
  if (fs.existsSync(sdkDefaults)) {
    let text = fs.readFileSync(sdkDefaults, "utf8");
    if (!/CONFIG_IDF_TARGET=/m.test(text)) {
      text = text.replace(
        /(# NanoPLC defaults[^\n]*\n\n)/,
        '$1CONFIG_IDF_TARGET="esp32s3"\n\n'
      );
      if (!/CONFIG_IDF_TARGET=/m.test(text)) {
        text = `CONFIG_IDF_TARGET="esp32s3"\n\n${text}`;
      }
      fs.writeFileSync(sdkDefaults, text, "utf8");
      patches.push("sdkconfig.defaults: default target esp32s3");
    }
  }

  const template = resolveFirmwareTemplateRoot();
  if (template) {
    const stamplcSrc = path.join(template, "components", "m5_stamplc_io");
    const stamplcDest = path.join(firmwareRoot, "components", "m5_stamplc_io");
    if (fs.existsSync(stamplcSrc) && !fs.existsSync(stamplcDest)) {
      copyDirRecursive(stamplcSrc, stamplcDest);
      patches.push("added m5_stamplc_io component");
    }

    const aw9523Src = path.join(template, "components", "m5_aw9523");
    const aw9523Dest = path.join(firmwareRoot, "components", "m5_aw9523");
    if (fs.existsSync(aw9523Src) && !fs.existsSync(aw9523Dest)) {
      copyDirRecursive(aw9523Src, aw9523Dest);
      patches.push("added m5_aw9523 component");
    }

    const stamplcAcSrc = path.join(template, "components", "m5_stamplc_ac");
    const stamplcAcDest = path.join(firmwareRoot, "components", "m5_stamplc_ac");
    if (fs.existsSync(stamplcAcSrc) && !fs.existsSync(stamplcAcDest)) {
      copyDirRecursive(stamplcAcSrc, stamplcAcDest);
      patches.push("added m5_stamplc_ac component");
    }

    for (const rel of [
      path.join("components", "nanoplc_hal", "nanoplc_hal.c"),
      path.join("components", "nanoplc_hal", "include", "nanoplc_hal.h"),
      path.join("components", "nanoplc_generated", "CMakeLists.txt"),
    ]) {
      const from = path.join(template, rel);
      const to = path.join(firmwareRoot, rel);
      if (fs.existsSync(from) && fs.existsSync(to)) {
        const srcText = fs.readFileSync(from, "utf8");
        const dstText = fs.readFileSync(to, "utf8");
        if (srcText !== dstText) {
          fs.copyFileSync(from, to);
          patches.push(`updated ${rel.replace(/\\/g, "/")}`);
        }
      }
    }
  }

  return patches;
}

export interface EnsureFirmwareTreeResult {
  ok: boolean;
  message: string;
  firmwareRoot?: string;
  created?: boolean;
  patched?: string[];
}

export function ensureProjectFirmwareTree(
  projectRoot: string,
  project: NanoPlcProject
): EnsureFirmwareTreeResult {
  const relRoot = project.firmware_root?.trim() || "firmware";
  const destRoot = path.resolve(projectRoot, relRoot);

  const existing = resolveProjectFirmwareRoot(projectRoot, project);
  if (existing) {
    const patches = patchExistingFirmwareTree(existing);
    const patchNote = patches.length ? ` (patched: ${patches.join(", ")})` : "";
    return {
      ok: true,
      message: `Firmware tree at ${existing}${patchNote}`,
      firmwareRoot: existing,
      created: false,
      patched: patches,
    };
  }

  if (fs.existsSync(path.join(destRoot, "CMakeLists.txt"))) {
    const patches = patchExistingFirmwareTree(destRoot);
    const patchNote = patches.length ? ` (patched: ${patches.join(", ")})` : "";
    return {
      ok: true,
      message: `Firmware tree at ${destRoot}${patchNote}`,
      firmwareRoot: destRoot,
      created: false,
      patched: patches,
    };
  }

  const template = resolveFirmwareTemplateRoot();
  if (!template) {
    return {
      ok: false,
      message:
        "Firmware template missing in the extension. Reinstall NanoPLC or run compile from the monorepo.",
    };
  }

  copyDirRecursive(template, destRoot);
  return {
    ok: true,
    message: `Created ESP-IDF firmware tree at ${relRoot}/`,
    firmwareRoot: destRoot,
    created: true,
  };
}

export function registerInitFirmwareTree(): vscode.Disposable {
  return vscode.commands.registerCommand("nanoplc.initFirmwareTree", async () => {
    const { pickProjectLocation, readJsonFile } = await import("./projectPaths");
    const location = await pickProjectLocation();
    if (!location) {
      return;
    }

    const project = readJsonFile<NanoPlcProject>(path.join(location.rootPath, "nanoplc.project.json"));
    const result = ensureProjectFirmwareTree(location.rootPath, project);
    if (result.ok) {
      void vscode.window.showInformationMessage(`NanoPLC: ${result.message}`);
    } else {
      void vscode.window.showErrorMessage(`NanoPLC: ${result.message}`);
    }
  });
}
