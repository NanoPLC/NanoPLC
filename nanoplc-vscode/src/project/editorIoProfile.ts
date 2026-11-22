import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";

import {
  findDeviceCatalogEntry,
  listDeviceIoChannels,
  parsePouVariables,
  resolveDeviceTree,
  type DeviceIoChannel,
  type FbdVariable,
  type IoModuleChannels,
  type NanoPlcProject,
} from "@nanoplc/ir-schema";

import { loadProjectIoProfile } from "./projectIoLoader";
import { PROJECT_FILENAME, readJsonFile } from "./projectPaths";

export interface EditorIoProfilePayload {
  di: DeviceIoChannel[];
  do: DeviceIoChannel[];
  ai: DeviceIoChannel[];
  modules: IoModuleChannels[];
  source: "catalog" | "io-map" | "none";
}

export interface PouCatalogItem {
  id: string;
  name: string;
  /** `fb` is a function-block template, not a PROGRAM language. */
  language: "fbd" | "st" | "lad" | "fb";
  variables: FbdVariable[];
}

function attachModuleMeta(
  channels: DeviceIoChannel[],
  moduleId: string,
  moduleName: string
): DeviceIoChannel[] {
  return channels.map((ch) => ({ ...ch, moduleId, moduleName }));
}

function catalogModuleProfile(
  project: NanoPlcProject,
  entryLabel: string,
  channels: { di: DeviceIoChannel[]; do: DeviceIoChannel[]; ai: DeviceIoChannel[] }
): EditorIoProfilePayload {
  const { modules } = resolveDeviceTree(project);
  const mod = modules[0];
  const moduleId = mod?.id ?? "device";
  const moduleName = mod?.name ?? entryLabel;
  const di = attachModuleMeta(channels.di, moduleId, moduleName);
  const doList = attachModuleMeta(channels.do, moduleId, moduleName);
  const ai = attachModuleMeta(channels.ai, moduleId, moduleName);
  return {
    di,
    do: doList,
    ai,
    modules: [{ id: moduleId, name: moduleName, di, do: doList, ai }],
    source: "catalog",
  };
}

/** I/O lists for the FBD editor and simulator (module → local channel). */
export function loadEditorIoProfile(projectRoot: string): EditorIoProfilePayload {
  try {
    const project = readJsonFile<NanoPlcProject>(path.join(projectRoot, PROJECT_FILENAME));
    const merged = loadProjectIoProfile(projectRoot, project);
    if (merged.di.length > 0 || merged.do.length > 0 || merged.ai.length > 0) {
      const hasExpansion = (project.modules?.length ?? 0) > 1;
      return {
        di: merged.di,
        do: merged.do,
        ai: merged.ai,
        modules: merged.modules,
        source: hasExpansion ? "io-map" : project.device?.catalog_id ? "catalog" : "io-map",
      };
    }

    const catalogId = project.device?.catalog_id;
    if (catalogId) {
      const entry = findDeviceCatalogEntry(catalogId);
      if (entry) {
        const channels = listDeviceIoChannels(entry.io);
        return catalogModuleProfile(project, entry.label, channels);
      }
    }
  } catch {
    // Ignore unreadable project / I/O files.
  }

  return { di: [], do: [], ai: [], modules: [], source: "none" };
}

function readProgramText(rootPath: string, source: string): string | undefined {
  const abs = path.normalize(path.join(rootPath, source));
  const open = vscode.workspace.textDocuments.find((d) => path.normalize(d.uri.fsPath) === abs);
  if (open) {
    return open.getText();
  }
  if (!fs.existsSync(abs)) {
    return undefined;
  }
  try {
    return fs.readFileSync(abs, "utf8");
  } catch {
    return undefined;
  }
}

/** PROGRAM variable declarations from FBD sources (unsaved editor buffers win). */
export function loadProjectPouCatalog(rootPath: string, project: NanoPlcProject): PouCatalogItem[] {
  const items: PouCatalogItem[] = project.programs.map((p) => {
    let variables: FbdVariable[] = [];
    if (p.language === "fbd") {
      const text = readProgramText(rootPath, p.source);
      if (text) {
        try {
          const raw = JSON.parse(text) as { variables?: unknown };
          variables = parsePouVariables(raw.variables).variables;
        } catch {
          variables = [];
        }
      }
    }
    return {
      id: p.id,
      name: p.name,
      language: p.language,
      variables,
    };
  });
  for (const fb of project.function_blocks ?? []) {
    let variables: FbdVariable[] = [];
    if (fb.language === "fbd") {
      const text = readProgramText(rootPath, fb.source);
      if (text) {
        try {
          const raw = JSON.parse(text) as { variables?: unknown };
          variables = parsePouVariables(raw.variables).variables;
        } catch {
          variables = [];
        }
      }
    }
    items.push({ id: fb.id, name: fb.name, language: "fb", variables });
  }
  return items;
}

export function ioCapacityFromProfile(profile: EditorIoProfilePayload): {
  di: number;
  do: number;
  ai: number;
} {
  const maxLen = (chs: DeviceIoChannel[]): number =>
    chs.reduce((m, c) => Math.max(m, c.index + 1), 0);
  return {
    di: maxLen(profile.di),
    do: maxLen(profile.do),
    ai: maxLen(profile.ai),
  };
}
