import * as fs from "fs";
import * as path from "path";

import {
  parseModuleConfig,
  resolveDeviceTree,
  resolveProjectIoProfileFromConfigs,
  type CodegenIoContext,
  type IoMap,
  type ModuleConfig,
  type NanoPlcProject,
  type ProjectIoProfile,
} from "@nanoplc/ir-schema";

function readModuleConfigFile(absPath: string): ModuleConfig | IoMap | undefined {
  if (!fs.existsSync(absPath)) {
    return undefined;
  }
  try {
    const raw = JSON.parse(fs.readFileSync(absPath, "utf8")) as unknown;
    return parseModuleConfig(raw) ?? (raw as IoMap);
  } catch {
    return undefined;
  }
}

/** Load and merge I/O from all module config files on disk. */
export function loadProjectIoProfile(projectRoot: string, project: NanoPlcProject): ProjectIoProfile {
  const { modules } = resolveDeviceTree(project);
  const configs = new Map<string, ModuleConfig | IoMap | undefined>();

  for (const mod of modules) {
    if (!mod.config) {
      continue;
    }
    configs.set(mod.config, readModuleConfigFile(path.join(projectRoot, mod.config)));
  }

  return resolveProjectIoProfileFromConfigs(project, configs);
}

/** Load per-module config files referenced by the project tree. */
export function loadProjectModuleConfigs(
  projectRoot: string,
  project: NanoPlcProject
): Map<string, ModuleConfig> {
  const { modules } = resolveDeviceTree(project);
  const configs = new Map<string, ModuleConfig>();

  for (const mod of modules) {
    if (!mod.config) {
      continue;
    }
    const parsed = readModuleConfigFile(path.join(projectRoot, mod.config));
    if (parsed && "io_map" in parsed) {
      configs.set(mod.config, parsed);
    }
  }

  return configs;
}

/** Build codegen I/O context (merged io-map + module configs). */
export function buildCodegenIoContext(projectRoot: string, project: NanoPlcProject): CodegenIoContext {
  const profile = loadProjectIoProfile(projectRoot, project);
  return {
    ioMap: profile.ioMap.entries.length > 0 ? profile.ioMap : undefined,
    project,
    moduleConfigs: loadProjectModuleConfigs(projectRoot, project),
  };
}
