import { IO_MAP_SCHEMA_VERSION } from "./constants";
import {
  deviceDoChannels,
  listDeviceIoChannels,
  type DeviceIoProfile,
} from "./deviceCatalog";
import type { IoMap, IoMapEntry, NanoPlcDriverRef, NanoPlcModuleRef } from "./types";

export interface ModuleCatalogEntry {
  id: string;
  vendor: string;
  model: string;
  label: string;
  description: string;
  docs_url?: string;
  /** Host device catalog ids; omit or empty = compatible with any host. */
  compatible_hosts?: string[];
  io: DeviceIoProfile;
  module: {
    type: string;
    /** Display name template; `{n}` is replaced with the instance number. */
    nameTemplate: string;
  };
  driver: {
    type: string;
    name: string;
  };
  /** Default fields stored in the per-module config file (e.g. I2C address). */
  default_config?: Record<string, unknown>;
}

/** Per-module config on disk (`src/modules/<id>.json` or legacy `src/io-map.json`). */
export interface ModuleConfig {
  schema_version: 1;
  catalog_id?: string;
  /** I2C 7-bit address (StamPLC IO: 0x20–0x2F via DIP switch). */
  i2c_address?: number;
  /** StamPLC IO digital output roles aligned with io_map DO entries. */
  outputs?: { id: string; role: string }[];
  io_map: IoMap;
}

export const M5STACK_STAMPLC_IO: ModuleCatalogEntry = {
  id: "m5stack.stamplc_io",
  vendor: "M5Stack",
  model: "StamPLC IO",
  label: "M5Stack StamPLC IO",
  description:
    "Isolated expansion: 2 analog monitor inputs (0–10 V / 0–20 mA), 2 SSR outputs, 1 mechanical relay. I2C 0x20–0x2F (DIP switch).",
  docs_url: "https://docs.m5stack.com/en/stamplc/StamPLC_IO",
  compatible_hosts: ["m5stack.stamplc_k141"],
  io: {
    di_count: 0,
    do_count: 3,
    ai_count: 2,
    di_symbol_prefix: "DI_",
    do_symbol_prefix: "DO_",
    ai_symbol_prefix: "AI_",
    do_channels: [1, 2, 3],
    ai_channels: [1, 2],
  },
  module: {
    type: "m5_stamplc_io_expansion",
    nameTemplate: "StamPLC IO",
  },
  driver: {
    type: "m5_stamplc_io",
    name: "StamPLC IO I2C driver",
  },
  default_config: {
    i2c_address: 0x20,
    outputs: [
      { id: "relay", role: "relay_trig_0" },
      { id: "ssr1", role: "ex_ctr_1" },
      { id: "ssr2", role: "ex_ctr_2" },
    ],
  },
};

export const M5STACK_STAMPLC_AC: ModuleCatalogEntry = {
  id: "m5stack.stamplc_ac",
  vendor: "M5Stack",
  model: "StamPLC AC",
  label: "M5Stack StamPLC AC",
  description:
    "AC relay expansion: 1× AC 240V@10A contact relay, optional system power (AC 100–240V → DC 12V), RGB status LED. PI4IOE5V6408 I2C @ 0x44.",
  docs_url: "https://docs.m5stack.com/en/stamplc/StamPLC_AC",
  compatible_hosts: ["m5stack.stamplc_k141"],
  io: {
    di_count: 0,
    do_count: 1,
    di_symbol_prefix: "DI_",
    do_symbol_prefix: "DO_",
    do_channels: [1],
  },
  module: {
    type: "m5_stamplc_ac_expansion",
    nameTemplate: "StamPLC AC",
  },
  driver: {
    type: "m5_stamplc_ac",
    name: "StamPLC AC I2C driver",
  },
  default_config: {
    i2c_address: 0x44,
    outputs: [{ id: "relay", role: "rel_en" }],
  },
};

export const MODULE_CATALOG: ModuleCatalogEntry[] = [M5STACK_STAMPLC_IO, M5STACK_STAMPLC_AC];

export function findModuleCatalogEntry(id: string): ModuleCatalogEntry | undefined {
  return MODULE_CATALOG.find((m) => m.id === id);
}

export function moduleCatalogLabel(entry: ModuleCatalogEntry): string {
  const parts: string[] = [entry.label];
  if (entry.io.di_count > 0) {
    parts.push(`${entry.io.di_count} DI`);
  }
  if (entry.io.do_count > 0) {
    parts.push(`${entry.io.do_count} DO`);
  }
  if ((entry.io.ai_count ?? 0) > 0) {
    parts.push(`${entry.io.ai_count} AI`);
  }
  return parts.join(" — ");
}

export function isModuleCompatibleWithHost(
  entry: ModuleCatalogEntry,
  hostCatalogId?: string
): boolean {
  if (!entry.compatible_hosts?.length) {
    return true;
  }
  if (!hostCatalogId) {
    return false;
  }
  return entry.compatible_hosts.includes(hostCatalogId);
}

export function listCompatibleModules(hostCatalogId?: string): ModuleCatalogEntry[] {
  return MODULE_CATALOG.filter((entry) => isModuleCompatibleWithHost(entry, hostCatalogId));
}

/** Count existing process-image rows so expansion modules append without overlap. */
export function ioMapIndexOffsets(entries: IoMapEntry[]): { di: number; do: number; ai: number } {
  let di = 0;
  let doCount = 0;
  let ai = 0;
  for (const entry of entries) {
    if (entry.kind === "DI") {
      di = Math.max(di, entry.index + 1);
    } else if (entry.kind === "DO") {
      doCount = Math.max(doCount, entry.index + 1);
    } else if (entry.kind === "AI") {
      ai = Math.max(ai, entry.index + 1);
    }
  }
  return { di, do: doCount, ai };
}

/** Build io-map entries for a catalog module at the given process-image offsets. */
export function buildModuleIoMapEntries(
  entry: ModuleCatalogEntry,
  offsets: { di: number; do: number; ai: number }
): IoMapEntry[] {
  const rows: IoMapEntry[] = [];
  const { di, do: doList, ai: aiList } = listDeviceIoChannels(entry.io);

  for (const ch of di) {
    rows.push({
      symbol: ch.symbol,
      kind: "DI",
      index: offsets.di + ch.index,
      active_high: true,
    });
  }

  for (const ch of aiList) {
    rows.push({
      symbol: `${entry.io.ai_symbol_prefix ?? "AI_"}${offsets.ai + ch.channel}`,
      kind: "AI",
      index: offsets.ai + ch.index,
    });
  }

  const doChannels = deviceDoChannels(entry.io);
  for (const ch of doList) {
    rows.push({
      symbol: `${entry.io.do_symbol_prefix}${offsets.do + ch.channel}`,
      kind: "DO",
      index: offsets.do + ch.index,
      active_high: true,
    });
  }

  return rows;
}

export function buildModuleConfig(
  entry: ModuleCatalogEntry,
  offsets: { di: number; do: number; ai: number }
): ModuleConfig {
  const entries = buildModuleIoMapEntries(entry, offsets);
  const config: ModuleConfig = {
    schema_version: 1,
    catalog_id: entry.id,
    io_map: { schema_version: IO_MAP_SCHEMA_VERSION, entries },
  };

  if (entry.default_config?.i2c_address !== undefined) {
    config.i2c_address = entry.default_config.i2c_address as number;
  }
  if (Array.isArray(entry.default_config?.outputs)) {
    config.outputs = entry.default_config.outputs as ModuleConfig["outputs"];
  }

  return config;
}

export function moduleConfigRelativePath(moduleId: string): string {
  return `src/modules/${moduleId}.json`;
}

export function buildModuleAndDriverRefs(
  entry: ModuleCatalogEntry,
  moduleId: string,
  instanceNumber: number
): { module: NanoPlcModuleRef; driver: NanoPlcDriverRef } {
  const name = entry.module.nameTemplate.replace("{n}", String(instanceNumber));
  const driverId = `${moduleId}_drv`;
  return {
    module: {
      id: moduleId,
      name,
      type: entry.module.type,
      config: moduleConfigRelativePath(moduleId),
    },
    driver: {
      id: driverId,
      name: entry.driver.name,
      type: entry.driver.type,
      binds: moduleId,
    },
  };
}

export function nextStamPlcIoInstanceNumber(existingModuleIds: string[]): number {
  let max = 0;
  for (const id of existingModuleIds) {
    const match = /^stamplc_io_exp(\d+)$/.exec(id);
    if (match) {
      max = Math.max(max, Number(match[1]));
    }
  }
  return max + 1;
}

export function nextStamPlcIoModuleId(existingModuleIds: string[]): string {
  return `stamplc_io_exp${nextStamPlcIoInstanceNumber(existingModuleIds)}`;
}

export function nextStamPlcAcInstanceNumber(existingModuleIds: string[]): number {
  let max = 0;
  for (const id of existingModuleIds) {
    const match = /^stamplc_ac_exp(\d+)$/.exec(id);
    if (match) {
      max = Math.max(max, Number(match[1]));
    }
  }
  return max + 1;
}

export function nextStamPlcAcModuleId(existingModuleIds: string[]): string {
  return `stamplc_ac_exp${nextStamPlcAcInstanceNumber(existingModuleIds)}`;
}
