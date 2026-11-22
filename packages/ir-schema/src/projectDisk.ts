/** Node-only helpers that load a NanoPLC project folder from disk (CLI, CI, tests, extension). */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { CodegenIoContext } from "./codegen/codegenFirmware";
import { compileProjectToIr } from "./compileFbd";
import type { ModuleConfig } from "./moduleCatalog";
import { parseModuleConfig, resolveProjectIoProfileFromConfigs, type ProjectIoProfile } from "./projectIo";
import { resolveDeviceTree } from "./projectTreeDefaults";
import { entryProgram } from "./tasks";
import type { CompileDiagnostic, CompileResult, IoMap, NanoPlcProject, NanoPlcProgramRef } from "./types";
import { validateProject } from "./validate";

function readModuleConfigFile(absPath: string): ModuleConfig | IoMap | undefined {
  if (!existsSync(absPath)) {
    return undefined;
  }
  try {
    const raw = JSON.parse(readFileSync(absPath, "utf8")) as unknown;
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
    if (mod.config) {
      configs.set(mod.config, readModuleConfigFile(join(projectRoot, mod.config)));
    }
  }
  return resolveProjectIoProfileFromConfigs(project, configs);
}

/** Load per-module config files referenced by the project tree. */
export function loadProjectModuleConfigs(projectRoot: string, project: NanoPlcProject): Map<string, ModuleConfig> {
  const { modules } = resolveDeviceTree(project);
  const configs = new Map<string, ModuleConfig>();
  for (const mod of modules) {
    if (!mod.config) {
      continue;
    }
    const parsed = readModuleConfigFile(join(projectRoot, mod.config));
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

/** Read every FBD program source of the project (unreadable files are left out). */
export function loadProjectFbdSourcesFromDisk(projectRoot: string, project: NanoPlcProject): Map<string, unknown> {
  const sources = new Map<string, unknown>();
  for (const prog of project.programs) {
    if (prog.language !== "fbd") {
      continue;
    }
    try {
      sources.set(prog.id, JSON.parse(readFileSync(join(projectRoot, prog.source), "utf8")));
    } catch {
      // compileProjectToIr reports a missing source.
    }
  }
  return sources;
}

export interface CompileProjectDirResult extends CompileResult {
  project?: NanoPlcProject;
  program?: NanoPlcProgramRef;
}

/**
 * Compile the entry PROGRAM of the primary cyclic task of the project at `projectRoot`,
 * the same way the IDE's **Compile PLC program** does (without writing any files).
 */
export function compileProjectDir(projectRoot: string): CompileProjectDirResult {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(projectRoot, "nanoplc.project.json"), "utf8"));
  } catch (e) {
    const message = `Cannot read nanoplc.project.json: ${e instanceof Error ? e.message : String(e)}`;
    return { ok: false, diagnostics: [{ code: "NP-0100", message, severity: "error" }] };
  }
  const { project, diagnostics: projectDiags } = validateProject(raw);
  if (!project) {
    return { ok: false, diagnostics: projectDiags };
  }
  const program = entryProgram(project);
  if (!program) {
    const missing: CompileDiagnostic = { code: "NP-0105", message: "No program defined in project.", severity: "error" };
    return { ok: false, project, diagnostics: [...projectDiags, missing] };
  }
  const ioMap = loadProjectIoProfile(projectRoot, project).ioMap;
  const result = compileProjectToIr(
    project,
    loadProjectFbdSourcesFromDisk(projectRoot, project),
    program.id,
    ioMap.entries.length > 0 ? ioMap : undefined
  );
  return {
    ...result,
    ok: result.ok && !projectDiags.some((d) => d.severity === "error"),
    diagnostics: [...projectDiags, ...result.diagnostics],
    project,
    program,
  };
}
