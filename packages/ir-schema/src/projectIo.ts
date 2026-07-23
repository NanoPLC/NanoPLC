import type { DeviceIoChannel } from "./deviceCatalog";
import { listIoChannelsFromMap } from "./deviceCatalog";
import { IO_MAP_SCHEMA_VERSION } from "./constants";
import type { ModuleConfig } from "./moduleCatalog";
import { resolveDeviceTree } from "./projectTreeDefaults";
import type { IoMap, IoMapEntry, NanoPlcProject } from "./types";

/** Read module config from disk JSON (supports legacy bare IoMap). */
export function parseModuleConfig(raw: unknown): ModuleConfig | undefined {
  if (!raw || typeof raw !== "object") {
    return undefined;
  }
  const obj = raw as Record<string, unknown>;
  if (obj.io_map && typeof obj.io_map === "object") {
    const ioMap = obj.io_map as IoMap;
    return {
      schema_version: 1,
      catalog_id: typeof obj.catalog_id === "string" ? obj.catalog_id : undefined,
      i2c_address: typeof obj.i2c_address === "number" ? obj.i2c_address : undefined,
      outputs: Array.isArray(obj.outputs) ? (obj.outputs as ModuleConfig["outputs"]) : undefined,
      io_map: ioMap,
    };
  }
  if (Array.isArray(obj.entries)) {
    return {
      schema_version: 1,
      io_map: { schema_version: IO_MAP_SCHEMA_VERSION, entries: obj.entries as IoMapEntry[] },
    };
  }
  return undefined;
}

export function moduleConfigEntries(config: ModuleConfig | IoMap): IoMapEntry[] {
  if ("io_map" in config) {
    return config.io_map.entries;
  }
  return config.entries;
}

/** Merge io-map entries from all project modules (module order in project file). */
export function mergeProjectIoEntries(moduleEntries: IoMapEntry[][]): IoMapEntry[] {
  const merged: IoMapEntry[] = [];
  for (const group of moduleEntries) {
    merged.push(...group);
  }
  merged.sort((a, b) => ioKindRank(a.kind) - ioKindRank(b.kind) || a.index - b.index);
  return merged;
}

export function buildMergedIoMap(entries: IoMapEntry[]): IoMap {
  return { schema_version: IO_MAP_SCHEMA_VERSION, entries };
}

export interface IoModuleChannels {
  id: string;
  name: string;
  di: DeviceIoChannel[];
  do: DeviceIoChannel[];
  ai: DeviceIoChannel[];
}

export interface ProjectIoProfile {
  di: DeviceIoChannel[];
  do: DeviceIoChannel[];
  ai: DeviceIoChannel[];
  ioMap: IoMap;
  /** Per-module channel lists for the FBD editor (module → local channel). */
  modules: IoModuleChannels[];
}

function pushModuleChannels(
  target: DeviceIoChannel[],
  moduleId: string,
  moduleName: string,
  entries: IoMapEntry[],
  kind: IoMapEntry["kind"]
): void {
  const sorted = entries.filter((e) => e.kind === kind).sort((a, b) => a.index - b.index);
  for (let i = 0; i < sorted.length; i++) {
    const entry = sorted[i];
    target.push({
      channel: i + 1,
      symbol: entry.symbol,
      index: entry.index,
      moduleId,
      moduleName,
    });
  }
}

/** Build editor channel lists for one hardware module (local 1-based channel per kind). */
export function listIoChannelsFromModuleEntries(
  moduleId: string,
  moduleName: string,
  entries: IoMapEntry[]
): { di: DeviceIoChannel[]; do: DeviceIoChannel[]; ai: DeviceIoChannel[] } {
  const di: DeviceIoChannel[] = [];
  const doList: DeviceIoChannel[] = [];
  const ai: DeviceIoChannel[] = [];
  pushModuleChannels(di, moduleId, moduleName, entries, "DI");
  pushModuleChannels(ai, moduleId, moduleName, entries, "AI");
  pushModuleChannels(doList, moduleId, moduleName, entries, "DO");
  return { di, do: doList, ai };
}

function ioKindRank(kind: IoMapEntry["kind"]): number {
  switch (kind) {
    case "DI":
      return 0;
    case "AI":
      return 1;
    case "DO":
      return 2;
    default:
      return 3;
  }
}

/** Build FBD channel lists from merged module io-map entries. */
export function projectIoProfileFromEntries(entries: IoMapEntry[]): ProjectIoProfile {
  const ioMap = buildMergedIoMap(entries);
  const channels = listIoChannelsFromMap(ioMap);
  return { di: channels.di, do: channels.do, ai: channels.ai, ioMap, modules: [] };
}

/** Resolve merged I/O from in-memory module configs (extension passes file contents). */
export function resolveProjectIoProfileFromConfigs(
  project: NanoPlcProject,
  configs: Map<string, ModuleConfig | IoMap | undefined>
): ProjectIoProfile {
  const { modules } = resolveDeviceTree(project);
  const groups: IoMapEntry[][] = [];
  const moduleProfiles: IoModuleChannels[] = [];
  const allDi: DeviceIoChannel[] = [];
  const allDo: DeviceIoChannel[] = [];
  const allAi: DeviceIoChannel[] = [];

  for (const mod of modules) {
    if (!mod.config) {
      continue;
    }
    const config = configs.get(mod.config);
    if (!config) {
      continue;
    }
    const entries = moduleConfigEntries(config);
    groups.push(entries);
    const channels = listIoChannelsFromModuleEntries(mod.id, mod.name, entries);
    if (channels.di.length > 0 || channels.do.length > 0 || channels.ai.length > 0) {
      moduleProfiles.push({
        id: mod.id,
        name: mod.name,
        di: channels.di,
        do: channels.do,
        ai: channels.ai,
      });
      allDi.push(...channels.di);
      allDo.push(...channels.do);
      allAi.push(...channels.ai);
    }
  }

  return {
    di: allDi,
    do: allDo,
    ai: allAi,
    ioMap: buildMergedIoMap(mergeProjectIoEntries(groups)),
    modules: moduleProfiles,
  };
}
